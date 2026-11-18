import { getAuthSession } from "@/lib/auth/session"
import { deleteSapSession, readSapSession, writeSapSession, type SapSessionPayload } from "@/lib/sap-session"
import {
  authRequiredResponse,
  buildSapUrl,
  cookieHeader,
  describeNetworkError,
  isSafeODataPath,
  mergeSetCookies,
  normaliseServicePath,
  plainHttpProblem,
  sapError,
  serviceRootUrl,
  SAP_REQUEST_TIMEOUT_MS,
  type SapSystemTarget,
} from "@/lib/sap/odata"
import { findOwnedSapSystem } from "@/lib/sap/systems"

/**
 * OData V4 BFF proxy: /api/sap/:systemId/<path below the service root>?<query>
 * (/api/sap/:systemId alone is the service root, i.e. the service document).
 *
 * 1. Requires a Better Auth session (401 UNAUTHENTICATED otherwise).
 * 2. Loads the SapSystem and checks it belongs to the user (404 otherwise).
 * 3. Reads sap_sess_<systemId>; without it answers 401 SAP_AUTH_REQUIRED.
 * 4. Forwards the request with sap-client, the stored Authorization header and
 *    SAP cookies. Mutating requests first fetch an x-csrf-token with the same
 *    session. New SAP cookies are written back to the encrypted cookie.
 * 5. 401 from SAP, a 403 that asks for a CSRF token again, or a redirect to a
 *    logon page ends the SAP session: the cookie is deleted and the answer is
 *    401 SAP_AUTH_REQUIRED. Other 403s are SAP authorisation errors and are
 *    passed through.
 */

type Context = { params: Promise<{ systemId: string; odataPath?: string[] }> }

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Request headers the browser may send on to SAP. Cookies and Authorization never pass. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "prefer",
  "odata-version",
  "odata-maxversion",
  "isolation",
]

/** Response headers passed back. Set-Cookie is never passed: SAP cookies stay in the vault. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "odata-version",
  "odata-entityid",
  "preference-applied",
  "location",
  "sap-message",
  "retry-after",
]

class SapSessionEnded extends Error {}

async function handle(request: Request, context: Context): Promise<Response> {
  const authSession = await getAuthSession()
  if (!authSession) return sapError(401, "UNAUTHENTICATED", "Sign in to the application first.")

  const { systemId, odataPath = [] } = await context.params
  const system = await findOwnedSapSystem(systemId, authSession.user.id)
  if (!system) return sapError(404, "SAP_SYSTEM_NOT_FOUND", "This SAP system does not exist.")
  if (!system.isActive) return sapError(403, "SAP_SYSTEM_INACTIVE", `${system.name} is turned off in the SAP system settings.`)
  if (!isSafeODataPath(odataPath)) return sapError(400, "INVALID_REQUEST", "The OData path is not allowed.")
  const transportProblem = plainHttpProblem(system)
  if (transportProblem) return sapError(403, "SAP_PLAIN_HTTP_BLOCKED", transportProblem)

  let session = await readSapSession(system.id, authSession)
  if (!session) return authRequiredResponse(system)

  const method = request.method.toUpperCase()
  const mutating = MUTATING.has(method)
  const target = buildSapUrl(system, odataPath, new URL(request.url).search)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SAP_REQUEST_TIMEOUT_MS)])
  // Buffered so the request can be sent again after a CSRF token refresh.
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer()

  const forwarded = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) forwarded.set(name, value)
  }
  if (!forwarded.has("accept")) forwarded.set("accept", "application/json")

  let cookiesChanged = false
  const sapHeaders = (current: SapSessionPayload, csrfToken?: string) => {
    const headers = new Headers(forwarded)
    if (current.authHeader) headers.set("authorization", current.authHeader)
    const cookie = cookieHeader(current.sapCookies)
    if (cookie) headers.set("cookie", cookie)
    if (csrfToken) headers.set("x-csrf-token", csrfToken)
    return headers
  }
  const absorbCookies = (response: Response) => {
    const merged = mergeSetCookies(session!.sapCookies, response)
    if (merged.changed) {
      session = { ...session!, sapCookies: merged.jar }
      cookiesChanged = true
    }
  }
  const endsSession = (response: Response) =>
    response.status === 401 ||
    (response.status >= 300 && response.status < 400) || // OData does not redirect; a logon page does
    (response.status === 403 && response.headers.get("x-csrf-token")?.toLowerCase() === "required")

  /** GET on the service root with x-csrf-token: Fetch, using the stored session. */
  const fetchCsrfToken = async (): Promise<string> => {
    const response = await fetch(serviceRootUrl(system), {
      method: "GET",
      headers: sapHeaders(session!, "Fetch"),
      redirect: "manual",
      cache: "no-store",
      signal,
    })
    await response.body?.cancel().catch(() => {})
    absorbCookies(response)
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) throw new SapSessionEnded()
    const token = response.headers.get("x-csrf-token")
    if (!token || token.toLowerCase() === "required") throw new SapSessionEnded()
    return token
  }

  try {
    let csrfToken = mutating ? await fetchCsrfToken() : undefined
    let response = await send(target, method, sapHeaders(session, csrfToken), body, signal)
    absorbCookies(response)

    // The token can expire between fetch and use: one fresh token, one retry.
    if (mutating && response.status === 403 && response.headers.get("x-csrf-token")?.toLowerCase() === "required") {
      await response.body?.cancel().catch(() => {})
      csrfToken = await fetchCsrfToken()
      response = await send(target, method, sapHeaders(session, csrfToken), body, signal)
      absorbCookies(response)
    }

    if (endsSession(response)) {
      await response.body?.cancel().catch(() => {})
      throw new SapSessionEnded()
    }

    if (cookiesChanged) await writeSapSession(authSession, system.id, session)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response, system) })
  } catch (error) {
    if (error instanceof SapSessionEnded) {
      await deleteSapSession(system.id)
      return authRequiredResponse(system, `Your session on ${system.name} has ended. Sign in again.`)
    }
    if (request.signal.aborted) return new Response(null, { status: 499 })
    if ((error as Error).name === "TimeoutError") {
      return sapError(504, "SAP_UNREACHABLE", `${system.name} did not answer within ${SAP_REQUEST_TIMEOUT_MS / 1000} seconds.`)
    }
    return sapError(502, "SAP_UNREACHABLE", describeNetworkError(target, error, system.name))
  }
}

function send(url: string, method: string, headers: Headers, body: ArrayBuffer | undefined, signal: AbortSignal) {
  return fetch(url, { method, headers, body, redirect: "manual", cache: "no-store", signal })
}

function responseHeaders(response: Response, system: SapSystemTarget) {
  const headers = new Headers({ "Cache-Control": "no-store" })
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Point Location (201 Created) at the proxy instead of the SAP host.
  const location = headers.get("location")
  if (location) {
    const root = `${system.baseUrl.replace(/\/+$/, "")}${normaliseServicePath(system.servicePath)}/`
    const relative = location.startsWith(root) ? location.slice(root.length) : null
    if (relative !== null) headers.set("location", `/api/sap/${system.id}/${relative}`)
    else headers.delete("location")
  }
  return headers
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
