import { isSapAuthRequired } from "@/lib/sap/constants"

/**
 * Browser helper for SAP OData V4 calls through the BFF proxy.
 *
 *   const response = await sapFetch(systemId, "A_SalesOrder?$top=10")
 *
 * When the proxy answers 401 SAP_AUTH_REQUIRED, the global <SapAuthModal />
 * asks for the SAP user name and password of that system; after a successful
 * sign-in the original request is sent again. Calls that run at the same
 * time for the same system share one prompt.
 *
 * Request bodies must be re-sendable (string, Blob, FormData, URLSearchParams),
 * not a ReadableStream, because the request may be sent twice.
 */

export class SapAuthCancelledError extends Error {
  constructor(readonly systemId: string, readonly systemName: string) {
    super(`Sign-in to ${systemName} was cancelled.`)
    this.name = "SapAuthCancelledError"
  }
}

export type SapSignInRequest = {
  systemId: string
  systemName: string
  message: string
  /** The system is reached over unencrypted http; the modal warns before the password is typed. */
  plainHttp?: boolean
  /** Called by the modal: true after a successful sign-in, false when cancelled. */
  settle: (signedIn: boolean) => void
}

// ---- Prompt queue, read by <SapAuthModal /> through useSyncExternalStore ----

let queue: SapSignInRequest[] = []
const listeners = new Set<() => void>()
const pendingBySystem = new Map<string, Promise<boolean>>()

function emit() {
  for (const listener of listeners) listener()
}

export const sapSignInStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** The prompt to show now, or null. */
  getSnapshot(): SapSignInRequest | null {
    return queue[0] ?? null
  },
  getServerSnapshot(): SapSignInRequest | null {
    return null
  },
}

/** Opens the SAP sign-in modal for a system. Resolves true once signed in, false if cancelled. */
export function requestSapSignIn(info: { systemId: string; systemName: string; message?: string; plainHttp?: boolean }): Promise<boolean> {
  const pending = pendingBySystem.get(info.systemId)
  if (pending) return pending

  const promise = new Promise<boolean>((resolve) => {
    const request: SapSignInRequest = {
      systemId: info.systemId,
      systemName: info.systemName,
      message: info.message ?? `Sign in to ${info.systemName} to continue.`,
      plainHttp: info.plainHttp,
      settle: (signedIn) => {
        pendingBySystem.delete(info.systemId)
        queue = queue.filter((item) => item !== request)
        emit()
        resolve(signedIn)
      },
    }
    queue = [...queue, request]
    emit()
  })
  pendingBySystem.set(info.systemId, promise)
  return promise
}

// ---- Fetch ----

export type SapFetchOptions = RequestInit & {
  /** How many times to prompt for SAP credentials before giving up. Default 2. */
  maxSignInAttempts?: number
}

/**
 * fetch() for `/api/sap/<systemId>/<odataPath>`. `odataPath` is relative to
 * the system's service root and may include a query, e.g.
 * "A_SalesOrder('1')?$expand=to_Item". An empty path is the service document.
 *
 * Returns the proxy's Response (check `response.ok`). Throws
 * SapAuthCancelledError when the user closes the sign-in prompt.
 */
export async function sapFetch(systemId: string, odataPath = "", options: SapFetchOptions = {}): Promise<Response> {
  const path = odataPath.replace(/^\/+/, "")
  return fetchWithSapSignIn(`/api/sap/${encodeURIComponent(systemId)}${path ? `/${path}` : ""}`, options)
}

/**
 * fetch() for any app endpoint that may answer 401 SAP_AUTH_REQUIRED (the
 * OData proxy, the chat, change-plan approval): opens the SAP sign-in modal
 * and sends the same request again after a successful sign-in.
 */
export async function fetchWithSapSignIn(url: string, options: SapFetchOptions = {}): Promise<Response> {
  const { maxSignInAttempts = 2, ...init } = options
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, credentials: "same-origin" })
    if (response.status !== 401) return response

    const body: unknown = await response.clone().json().catch(() => null)
    if (!isSapAuthRequired(body) || attempt >= maxSignInAttempts) return response

    const signedIn = await requestSapSignIn({ systemId: body.systemId, systemName: body.systemName, message: body.message, plainHttp: body.plainHttp })
    if (!signedIn) throw new SapAuthCancelledError(body.systemId, body.systemName)
  }
}

/** sapFetch + JSON parsing. Throws with SAP's error message for non-2xx answers. */
export async function sapFetchJson<T>(systemId: string, odataPath = "", options: SapFetchOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  const response = await sapFetch(systemId, odataPath, { ...options, headers })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      (data as { error?: { message?: string } } | null)?.error?.message ?? // OData V4 error body
      (data as { message?: string } | null)?.message ?? // proxy error body
      `SAP answered ${response.status}.`
    throw new Error(message)
  }
  return data as T
}
