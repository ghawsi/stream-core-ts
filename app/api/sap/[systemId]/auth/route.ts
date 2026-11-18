import { z } from "zod"

import { getAuthSession } from "@/lib/auth/session"
import { deleteSapSession, writeSapSession } from "@/lib/sap-session"
import {
  basicAuthHeader,
  describeNetworkError,
  mergeSetCookies,
  plainHttpProblem,
  sapError,
  serviceRootUrl,
  SAP_REQUEST_TIMEOUT_MS,
} from "@/lib/sap/odata"
import { findOwnedSapSystem } from "@/lib/sap/systems"

type Context = { params: Promise<{ systemId: string }> }

const credentialsSchema = z.object({
  username: z.string().trim().min(1, "Enter your SAP user name.").max(40, "SAP user names have at most 40 characters."),
  password: z.string().min(1, "Enter your SAP password.").max(256, "The password is too long."),
})

/**
 * POST /api/sap/:systemId/auth  { username, password }
 *
 * Checks the credentials against the system's OData V4 service root (GET with
 * x-csrf-token: Fetch and sap-client). On success the Basic Auth header and
 * the session cookies SAP sets are stored, encrypted, in the HttpOnly cookie
 * sap_sess_<systemId>. The request body is never logged or stored elsewhere.
 */
export async function POST(request: Request, context: Context) {
  const authSession = await getAuthSession()
  if (!authSession) return sapError(401, "UNAUTHENTICATED", "Sign in to the application first.")

  const { systemId } = await context.params
  const system = await findOwnedSapSystem(systemId, authSession.user.id)
  if (!system) return sapError(404, "SAP_SYSTEM_NOT_FOUND", "This SAP system does not exist.")
  if (!system.isActive) return sapError(403, "SAP_SYSTEM_INACTIVE", `${system.name} is turned off in the SAP system settings.`)

  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return sapError(400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.")

  // Checked before the password is put on the wire.
  const transportProblem = plainHttpProblem(system)
  if (transportProblem) return sapError(403, "SAP_PLAIN_HTTP_BLOCKED", transportProblem)

  const authHeader = basicAuthHeader(parsed.data.username, parsed.data.password)
  const url = serviceRootUrl(system)

  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, "x-csrf-token": "Fetch", Accept: "application/json" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(SAP_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    return sapError(502, "SAP_UNREACHABLE", describeNetworkError(url, error, system.name))
  }
  // The service document is not needed; free the connection.
  await response.body?.cancel().catch(() => {})

  if (response.status === 401 || response.status === 403) {
    await deleteSapSession(system.id)
    return sapError(
      401,
      "SAP_INVALID_CREDENTIALS",
      response.status === 401
        ? "SAP rejected the user name or password. Repeated failures can lock the SAP user."
        : "SAP accepted the sign-in but this user may not use the OData service (403)."
    )
  }
  if (response.status >= 300 && response.status < 400) {
    return sapError(502, "SAP_BAD_RESPONSE", `SAP redirected the request (${response.status}). Check the base URL and service path.`)
  }
  if (response.status === 404) {
    return sapError(502, "SAP_BAD_RESPONSE", "SAP returned 404 for the service root. Check the service path and that the service is published.")
  }
  if (!response.ok) {
    return sapError(502, "SAP_BAD_RESPONSE", `SAP answered ${response.status} ${response.statusText}.`)
  }

  const { jar } = mergeSetCookies({}, response)
  await writeSapSession(authSession, system.id, { authHeader, sapCookies: jar })
  return Response.json({ ok: true, systemId: system.id }, { headers: { "Cache-Control": "no-store" } })
}

/** DELETE /api/sap/:systemId/auth: ends the SAP session for this system. */
export async function DELETE(_request: Request, context: Context) {
  const authSession = await getAuthSession()
  if (!authSession) return sapError(401, "UNAUTHENTICATED", "Sign in to the application first.")
  const { systemId } = await context.params
  const system = await findOwnedSapSystem(systemId, authSession.user.id)
  if (!system) return sapError(404, "SAP_SYSTEM_NOT_FOUND", "This SAP system does not exist.")
  await deleteSapSession(system.id)
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
}
