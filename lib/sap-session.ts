import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { cookies } from "next/headers"

import type { AuthSession } from "@/lib/auth/session"
import { SAP_SESSION_COOKIE_PREFIX, sapSessionCookieName } from "@/lib/sap/constants"

/**
 * Encrypted HttpOnly cookie vault for SAP sessions.
 *
 * One cookie per SAP system, `sap_sess_<sapSystemId>`, holding AES-256-GCM
 * encrypted JSON with the Basic Auth header and the cookies SAP set
 * (SAP_SESSIONID_*, sap-usercontext, MYSAPSSO2). Nothing of it reaches the
 * database, localStorage or JavaScript in the browser.
 *
 * Each cookie is bound to the Better Auth user AND the Better Auth session it
 * was created in. On read both must match the current session, otherwise the
 * cookie is deleted (where the request may still change cookies) and treated
 * as missing. Signing out or signing in as someone else therefore ends every
 * SAP session, even before the sign-out hook clears the cookies.
 *
 * Needs SAP_COOKIE_SECRET: 64 hex characters (32 bytes), or any long random
 * string, which is hashed into a key.
 */

export type SapSessionPayload = {
  v: 1
  userId: string
  /** Better Auth session ID; ties the SAP session to one sign-in. */
  authSessionId: string
  sapSystemId: string
  /** "Basic …" header, or null when only SAP session cookies are kept. */
  authHeader: string | null
  /** Cookies SAP set, by name. */
  sapCookies: Record<string, string>
  createdAt: number
}

const ALGORITHM = "aes-256-gcm"
const FORMAT = "v1"

function getKey(): Buffer {
  const raw = process.env.SAP_COOKIE_SECRET?.trim()
  if (!raw) {
    throw new Error(
      "SAP_COOKIE_SECRET is not set. Add a random 32-byte key (64 hex characters) to .env, for example with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    )
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
  return createHash("sha256").update(raw, "utf8").digest()
}

function seal(payload: SapSessionPayload): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  // The cookie name is authenticated data: a value copied into another
  // system's cookie does not decrypt.
  cipher.setAAD(Buffer.from(sapSessionCookieName(payload.sapSystemId)))
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".")
}

function open(sapSystemId: string, value: string): SapSessionPayload | null {
  const [format, iv, tag, data] = value.split(".")
  if (format !== FORMAT || !iv || !tag || !data) return null
  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, "base64url"))
    decipher.setAAD(Buffer.from(sapSessionCookieName(sapSystemId)))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    const json = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
    const payload = JSON.parse(json) as SapSessionPayload
    return payload.v === 1 && payload.sapSystemId === sapSystemId ? payload : null
  } catch {
    return null // wrong key, tampered or truncated
  }
}

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  // No maxAge or expires: a browser session cookie. It is also bound to the
  // Better Auth session (authSessionId), so it ends with that sign-in.
}

/** Deletes a cookie where the current context allows it (Route Handler, Server Action). */
async function tryDelete(name: string) {
  try {
    ;(await cookies()).delete({ name, path: "/" })
  } catch {
    // Server Components cannot change cookies; the stale value is ignored instead.
  }
}

/**
 * The SAP session for this system, or null when there is none or it does not
 * belong to the signed-in user and sign-in. A cookie that fails the checks is
 * deleted.
 */
export async function readSapSession(sapSystemId: string, authSession: AuthSession): Promise<SapSessionPayload | null> {
  const name = sapSessionCookieName(sapSystemId)
  const value = (await cookies()).get(name)?.value
  if (!value) return null

  const payload = open(sapSystemId, value)
  if (!payload || payload.userId !== authSession.user.id || payload.authSessionId !== authSession.session.id) {
    await tryDelete(name)
    return null
  }
  return payload
}

/** Stores the SAP session. Only in Route Handlers and Server Actions. */
export async function writeSapSession(
  authSession: AuthSession,
  sapSystemId: string,
  values: { authHeader: string | null; sapCookies: Record<string, string>; createdAt?: number }
): Promise<SapSessionPayload> {
  const payload: SapSessionPayload = {
    v: 1,
    userId: authSession.user.id,
    authSessionId: authSession.session.id,
    sapSystemId,
    authHeader: values.authHeader,
    sapCookies: values.sapCookies,
    createdAt: values.createdAt ?? Date.now(),
  }
  ;(await cookies()).set(sapSessionCookieName(sapSystemId), seal(payload), cookieOptions)
  return payload
}

/** Ends the SAP session for one system (the system configuration stays). */
export async function deleteSapSession(sapSystemId: string) {
  ;(await cookies()).delete({ name: sapSessionCookieName(sapSystemId), path: "/" })
}

/** Ends every SAP session in this browser. */
export async function deleteAllSapSessions() {
  const store = await cookies()
  for (const cookie of store.getAll()) {
    if (cookie.name.startsWith(SAP_SESSION_COOKIE_PREFIX)) store.delete({ name: cookie.name, path: "/" })
  }
}

/** IDs of the given systems that have a valid SAP session. For status display; changes no cookies. */
export async function connectedSapSystemIds(sapSystemIds: string[], authSession: AuthSession): Promise<Set<string>> {
  const store = await cookies()
  const connected = new Set<string>()
  for (const id of sapSystemIds) {
    const value = store.get(sapSessionCookieName(id))?.value
    const payload = value ? open(id, value) : null
    if (payload && payload.userId === authSession.user.id && payload.authSessionId === authSession.session.id) connected.add(id)
  }
  return connected
}
