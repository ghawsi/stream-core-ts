import type { SapAuthRequiredBody, SapErrorBody } from "@/lib/sap/constants"

/** The parts of a SapSystem row the proxy needs. */
export type SapSystemTarget = {
  id: string
  name: string
  baseUrl: string
  sapClient: string
  servicePath: string
}

export const SAP_REQUEST_TIMEOUT_MS = 60_000

/** "/sap/opu/odata4/.../0001" with one leading and no trailing slash. */
export function normaliseServicePath(path: string) {
  const trimmed = path.trim().replace(/\/+$/, "")
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/**
 * Encodes one OData path segment. Characters that OData uses in resource
 * paths (keys, functions) stay readable: ( ) ' , = $ : @
 */
function encodeSegment(segment: string) {
  return encodeURIComponent(segment).replace(/%(24|28|29|2C|3D|3A|40)/gi, (match) => decodeURIComponent(match))
}

/** Rejects segments that could leave the service root (".." or an encoded "/"). */
export function isSafeODataPath(segments: string[]) {
  return segments.every((segment) => segment !== ".." && segment !== "." && !segment.includes("/") && !segment.includes("\\"))
}

/**
 * Builds the SAP URL: service root + OData path + the original query, with
 * sap-client replaced by the system's client. The raw query is kept as it is,
 * so $filter and other system query options are not re-encoded.
 */
export function buildSapUrl(system: SapSystemTarget, segments: string[], rawSearch = "") {
  const root = `${system.baseUrl.replace(/\/+$/, "")}${normaliseServicePath(system.servicePath)}/`
  const path = segments.map(encodeSegment).join("/")
  const query = rawSearch
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part && !/^sap-client=/i.test(part))
  query.push(`sap-client=${encodeURIComponent(system.sapClient)}`)
  return `${root}${path}?${query.join("&")}`
}

/** URL of the service root, used to sign in and to fetch CSRF tokens. */
export function serviceRootUrl(system: SapSystemTarget) {
  return buildSapUrl(system, [], "")
}

export function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

export function cookieHeader(jar: Record<string, string>) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

/**
 * Applies a response's Set-Cookie headers to the cookie jar. Cookies that SAP
 * deletes (empty value, Max-Age=0 or an expiry in the past) are removed.
 */
export function mergeSetCookies(jar: Record<string, string>, response: Response): { jar: Record<string, string>; changed: boolean } {
  const next = { ...jar }
  let changed = false
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";")
    const separator = pair.indexOf("=")
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    const expired = attributes.some((attribute) => {
      const [key, val = ""] = attribute.split("=").map((part) => part.trim())
      if (/^max-age$/i.test(key)) return Number(val) <= 0
      if (/^expires$/i.test(key)) return Date.parse(val) < Date.now()
      return false
    })
    if (!value || expired) {
      if (name in next) {
        delete next[name]
        changed = true
      }
    } else if (next[name] !== value) {
      next[name] = value
      changed = true
    }
  }
  return { jar: next, changed }
}

export function authRequiredResponse(system: Pick<SapSystemTarget, "id" | "name">, message?: string) {
  const body: SapAuthRequiredBody = {
    code: "SAP_AUTH_REQUIRED",
    systemId: system.id,
    systemName: system.name,
    message: message ?? `Sign in to ${system.name} to continue.`,
  }
  return Response.json(body, { status: 401, headers: { "Cache-Control": "no-store" } })
}

export function sapError(status: number, code: SapErrorBody["code"], message: string) {
  return Response.json({ code, message } satisfies SapErrorBody, { status, headers: { "Cache-Control": "no-store" } })
}

/** "Could not reach host: ECONNREFUSED", for fetch network failures. */
export function describeNetworkError(url: string, error: unknown) {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  return `Could not reach ${host}: ${cause?.code ?? cause?.message ?? (error as Error).message}`
}
