/**
 * Names and error shapes shared by the SAP server code and the browser.
 * No server-only imports here.
 */

/** Every SAP session cookie is named `sap_sess_<sapSystemId>`. */
export const SAP_SESSION_COOKIE_PREFIX = "sap_sess_"

export function sapSessionCookieName(sapSystemId: string) {
  return `${SAP_SESSION_COOKIE_PREFIX}${sapSystemId}`
}

/** JSON body of a 401 from /api/sap/...: the user must sign in to this SAP system. */
export type SapAuthRequiredBody = {
  code: "SAP_AUTH_REQUIRED"
  systemId: string
  systemName: string
  message: string
  /** The system is reached over unencrypted http: the sign-in dialog warns. */
  plainHttp?: boolean
}

/** JSON body of other errors from /api/sap/... */
export type SapErrorBody = {
  code:
    | "UNAUTHENTICATED"
    | "SAP_SYSTEM_NOT_FOUND"
    | "SAP_SYSTEM_INACTIVE"
    | "SAP_INVALID_CREDENTIALS"
    | "SAP_UNREACHABLE"
    | "SAP_BAD_RESPONSE"
    | "SAP_PLAIN_HTTP_BLOCKED"
    | "INVALID_REQUEST"
  message: string
}

export function isSapAuthRequired(body: unknown): body is SapAuthRequiredBody {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "SAP_AUTH_REQUIRED"
}
