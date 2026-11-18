import type { SapAuthRequiredBody, SapErrorBody } from "@/lib/sap/constants"

/** The parts of a SapSystem row the proxy needs. */
export type SapSystemTarget = {
  id: string
  name: string
  baseUrl: string
  sapClient: string
  servicePath: string
  /** "DEV" | "QAS" | "PRD"; production systems are never contacted over plain http. */
  environment: string
}

export function usesPlainHttp(baseUrl: string) {
  return /^http:\/\//i.test(baseUrl.trim())
}

/**
 * Whether this server may contact SAP systems over plain http at all:
 * SAP_ALLOW_HTTP=true|false, otherwise allowed on a development server only.
 */
export function plainHttpAllowedOnServer() {
  const flag = process.env.SAP_ALLOW_HTTP?.trim().toLowerCase()
  if (flag === "true") return true
  if (flag === "false") return false
  return process.env.NODE_ENV !== "production"
}

/**
 * Why this system must not be contacted, or null. Checked before every
 * request, so a password never leaves the server unencrypted for a
 * production system, whatever is stored in the database.
 */
export function plainHttpProblem(system: Pick<SapSystemTarget, "name" | "baseUrl" | "environment">): string | null {
  if (!usesPlainHttp(system.baseUrl)) return null
  if (system.environment === "PRD") {
    return `${system.name} is a production system on unencrypted http. Production systems need https://; change the base URL in Settings › SAP systems.`
  }
  if (!plainHttpAllowedOnServer()) {
    return `${system.name} uses unencrypted http, which this server does not allow (SAP_ALLOW_HTTP). Use https://.`
  }
  return null
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

export function authRequiredResponse(system: Pick<SapSystemTarget, "id" | "name"> & { baseUrl?: string }, message?: string) {
  const body: SapAuthRequiredBody = {
    code: "SAP_AUTH_REQUIRED",
    systemId: system.id,
    systemName: system.name,
    message: message ?? `Sign in to ${system.name} to continue.`,
    ...(system.baseUrl && usesPlainHttp(system.baseUrl) ? { plainHttp: true } : {}),
  }
  return Response.json(body, { status: 401, headers: { "Cache-Control": "no-store" } })
}

export function sapError(status: number, code: SapErrorBody["code"], message: string) {
  return Response.json({ code, message } satisfies SapErrorBody, { status, headers: { "Cache-Control": "no-store" } })
}

const ADD_COMPANY_CA =
  "Install the company root CA in the operating system's trusted root store, or set TLS_EXTRA_CA_FILE in .env to the CA certificate file, then restart the app server. Never turn certificate checks off."

/** Certificate failures: what happened and what fixes it. */
const TLS_PROBLEMS: Record<string, string> = {
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: `its certificate was issued by a certificate authority this app server does not trust, typically your company's own PKI. ${ADD_COMPANY_CA}`,
  UNABLE_TO_GET_ISSUER_CERT: `its certificate was issued by a certificate authority this app server does not trust. ${ADD_COMPANY_CA}`,
  SELF_SIGNED_CERT_IN_CHAIN: `its certificate chain ends in a root CA this app server does not trust. ${ADD_COMPANY_CA}`,
  DEPTH_ZERO_SELF_SIGNED_CERT:
    "it uses a self-signed certificate. Ask the SAP Basis team for a certificate from the company CA (transaction STRUST), or add this certificate with TLS_EXTRA_CA_FILE.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "it sends its certificate without the intermediate CA certificates. Ask the SAP Basis team to add the full chain to the SSL server PSE (transaction STRUST), or add the intermediate CA with TLS_EXTRA_CA_FILE.",
  CERT_HAS_EXPIRED: "its certificate has expired. The SAP Basis team must renew it (transaction STRUST).",
  CERT_NOT_YET_VALID: "its certificate is not valid yet. Check the clocks of the app server and the SAP system.",
  CERT_REVOKED: "its certificate has been revoked. The SAP Basis team must replace it.",
  ERR_TLS_CERT_ALTNAME_INVALID:
    "its certificate is not issued for this host name. Use the host name the certificate names (not an IP address or alias), or have the certificate reissued with this name.",
}

/**
 * "Could not reach host: ECONNREFUSED" for network failures; for certificate
 * failures what went wrong and how to fix it, without weakening the check.
 */
export function describeNetworkError(url: string, error: unknown, name?: string) {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const target = name ?? host
  const code = cause?.code ?? ""
  const tls = TLS_PROBLEMS[code]
  if (tls) return `${target} could not be verified (${code}): ${tls}`
  return `Could not reach ${target}: ${code || cause?.message || (error as Error).message}`
}
