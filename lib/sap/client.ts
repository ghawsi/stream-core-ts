import { prisma } from "@/lib/db"
import type { SapSessionPayload } from "@/lib/sap-session"
import { cookieHeader, describeNetworkError, mergeSetCookies, normaliseServicePath, plainHttpProblem, type SapSystemTarget } from "@/lib/sap/odata"

/**
 * Server-side OData V4 client for one SAP system, acting with the signed-in
 * user's own SAP session (Basic header and SAP cookies from the encrypted
 * cookie vault). Never runs in the browser.
 *
 * - every request carries sap-client and IEEE754-compatible JSON headers;
 * - writes fetch an x-csrf-token with the same session first and send If-Match;
 * - a 403 "x-csrf-token: Required" gets one fresh token and one retry;
 * - 401 (or a redirect to a logon page) throws SapSessionExpiredError;
 * - network failures and timeouts throw SapTransportError;
 * - every request is written to SapAuditLog (path only: no host, no credentials).
 */

export const SAP_JSON = "application/json;IEEE754Compatible=true"
const TIMEOUT_MS = 60_000
const MAX_RESPONSE_CHARS = 8_000_000

export type SapODataErrorDetail = { code?: string; message: string; target?: string; severity?: number }
export type SapODataError = { code?: string; message: string; target?: string; details: SapODataErrorDetail[] }
export type SapMessage = { code?: string; message: string; target?: string; severity?: string | number }

export type SapResponse = {
  method: string
  /** Path and query relative to the service root, as logged. */
  path: string
  status: number
  ok: boolean
  etag: string | null
  location: string | null
  /** Parsed JSON body, or null for empty / non-JSON bodies. */
  data: unknown
  text: string
  error: SapODataError | null
  /** Warnings and information from the sap-messages header. */
  sapMessages: SapMessage[]
  durationMs: number
}

export class SapSessionExpiredError extends Error {
  constructor() {
    super("The SAP session has ended or the credentials were rejected (401). Sign in to the SAP system again.")
    this.name = "SapSessionExpiredError"
  }
}

export class SapTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SapTransportError"
  }
}

export type SapAuditContext = { userId: string; chatId?: string | null }

type RequestOptions = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  /** Path below the service root, already encoded, e.g. "Product('EF-MAT')/_ProductPlant". */
  path: string
  /** Query options, e.g. { $select: "Product,ProductType", $top: "20" }. sap-client is added. */
  query?: Record<string, string | undefined>
  body?: unknown
  ifMatch?: string
  accept?: string
  /** Tool name for the audit log. */
  toolName: string
  /**
   * Another OData V4 service on the same host and session, for reads only:
   * SAP's code lists for units and currencies that the service's $metadata
   * points to (e.g. /sap/opu/odata4/sap/api_product/default/iwbep/common/0001).
   */
  serviceRoot?: string
}

/** A service root on the same host that a read may use: below /sap/opu/odata4/, without "..". */
export function isAllowedServiceRoot(path: string) {
  return /^\/sap\/opu\/odata4\/[\w/.~-]+$/.test(path) && !path.split("/").includes("..")
}

function encodeQueryValue(value: string) {
  // Keep OData syntax readable in logs; encode everything that would break the query string.
  return encodeURIComponent(value).replace(/%(24|28|29|27|2C|3A|40|2F)/gi, (match) => decodeURIComponent(match))
}

export function buildQueryString(query: Record<string, string | undefined> | undefined, sapClient: string) {
  const parts = Object.entries(query ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}=${encodeQueryValue(value)}`)
  parts.push(`sap-client=${encodeURIComponent(sapClient)}`)
  return parts.join("&")
}

function parseODataError(data: unknown, fallback: string): SapODataError {
  const error = (data as { error?: { code?: string; message?: string | { value?: string }; target?: string; details?: unknown } } | null)
    ?.error
  if (!error) return { message: fallback, details: [] }
  const message = typeof error.message === "string" ? error.message : (error.message?.value ?? fallback)
  const details = Array.isArray(error.details)
    ? (error.details as { code?: string; message?: string; target?: string; "@Common.numericSeverity"?: number; severity?: number }[]).map(
        (detail) => ({
          code: detail.code,
          message: detail.message ?? "",
          target: detail.target,
          severity: detail["@Common.numericSeverity"] ?? detail.severity,
        })
      )
    : []
  return { code: error.code, message, target: error.target, details }
}

function parseSapMessages(header: string | null): SapMessage[] {
  if (!header) return []
  try {
    const parsed: unknown = JSON.parse(header)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        code: typeof item.code === "string" ? item.code : undefined,
        message: typeof item.message === "string" ? item.message : JSON.stringify(item),
        target: typeof item.target === "string" ? item.target : undefined,
        severity: (item.numericSeverity ?? item.severity) as string | number | undefined,
      }))
  } catch {
    return [{ message: header }]
  }
}

export type SapRequestLogEntry = { toolName: string; method: string; path: string; status: number; durationMs: number; error?: string }

export class SapClient {
  /** Called after every request (for the execution log shown in the chat). */
  onRequest?: (entry: SapRequestLogEntry) => void
  private jar: Record<string, string>
  private cookiesChanged = false
  private csrfToken: string | null = null

  constructor(
    readonly system: SapSystemTarget & { environment?: string },
    private readonly session: SapSessionPayload,
    private readonly audit: SapAuditContext,
    private readonly signal?: AbortSignal
  ) {
    this.jar = { ...session.sapCookies }
  }

  /** Cookies after this client's requests, to write back to the vault where the context allows it. */
  updatedCookies(): Record<string, string> | null {
    return this.cookiesChanged ? this.jar : null
  }

  private root() {
    return `${this.system.baseUrl.replace(/\/+$/, "")}${normaliseServicePath(this.system.servicePath)}/`
  }

  private headers(extra: Record<string, string>) {
    const headers = new Headers(extra)
    if (this.session.authHeader) headers.set("authorization", this.session.authHeader)
    const cookie = cookieHeader(this.jar)
    if (cookie) headers.set("cookie", cookie)
    return headers
  }

  private absorb(response: Response) {
    const merged = mergeSetCookies(this.jar, response)
    if (merged.changed) {
      this.jar = merged.jar
      this.cookiesChanged = true
    }
  }

  private async log(entry: {
    toolName: string
    method: string
    path: string
    payload?: string
    status: number
    error?: string
    durationMs: number
  }) {
    this.onRequest?.({
      toolName: entry.toolName,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      durationMs: entry.durationMs,
      error: entry.error,
    })
    try {
      await prisma.sapAuditLog.create({
        data: {
          userId: this.audit.userId,
          chatId: this.audit.chatId ?? null,
          sapSystemId: this.system.id,
          toolName: entry.toolName,
          httpMethod: entry.method,
          requestUrl: entry.path.slice(0, 2000),
          requestPayload: entry.payload ? entry.payload.slice(0, 10_000) : null,
          responseStatus: entry.status,
          errorMessage: entry.error ? entry.error.slice(0, 2000) : null,
          durationMs: entry.durationMs,
        },
      })
    } catch (error) {
      console.error("[sap] Could not write the audit log", error)
    }
  }

  private async raw(method: string, relativePath: string, headers: Headers, body: string | undefined, toolName: string, serviceRoot?: string) {
    const url = `${serviceRoot ? `${this.system.baseUrl.replace(/\/+$/, "")}${normaliseServicePath(serviceRoot)}/` : this.root()}${relativePath}`
    const started = performance.now()
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    // Checked before every request: credentials and data never go to a production system unencrypted.
    const transportProblem = plainHttpProblem(this.system)
    if (transportProblem) {
      await this.log({ toolName, method, path: relativePath, payload: body, status: 0, error: transportProblem, durationMs: 0 })
      throw new SapTransportError(transportProblem)
    }
    let response: Response
    try {
      response = await fetch(url, { method, headers, body, redirect: "manual", cache: "no-store", signal })
    } catch (error) {
      const durationMs = Math.round(performance.now() - started)
      const message =
        (error as Error).name === "TimeoutError"
          ? `${this.system.name} did not answer within ${TIMEOUT_MS / 1000} seconds. For a write the outcome is unknown: read the record before trying again.`
          : describeNetworkError(url, error, this.system.name)
      await this.log({ toolName, method, path: relativePath, payload: body, status: 0, error: message, durationMs })
      if (this.signal?.aborted) throw error
      throw new SapTransportError(message)
    }
    this.absorb(response)
    const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS)
    return { response, text, durationMs: Math.round(performance.now() - started) }
  }

  /** GET on the service root with x-csrf-token: Fetch (bootstrap step 1). */
  async fetchCsrfToken(): Promise<string> {
    const path = `?${buildQueryString(undefined, this.system.sapClient)}`
    const { response, durationMs } = await this.raw(
      "GET",
      path,
      this.headers({ accept: SAP_JSON, "x-csrf-token": "Fetch" }),
      undefined,
      "csrf_fetch"
    )
    const token = response.headers.get("x-csrf-token")
    await this.log({ toolName: "csrf_fetch", method: "GET", path, status: response.status, durationMs })
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) throw new SapSessionExpiredError()
    if (!token || token.toLowerCase() === "required") {
      throw new SapTransportError(`${this.system.name} did not return a CSRF token (HTTP ${response.status}).`)
    }
    this.csrfToken = token
    return token
  }

  async request(options: RequestOptions): Promise<SapResponse> {
    const query = buildQueryString(options.query, this.system.sapClient)
    const writing = options.method !== "GET"
    if (options.serviceRoot && (writing || !isAllowedServiceRoot(options.serviceRoot))) {
      throw new SapTransportError(`Only reads below /sap/opu/odata4/ may use another service root (${options.serviceRoot}).`)
    }
    // The audit log shows which service a code-list read went to.
    const path = `${options.serviceRoot ? `[${options.serviceRoot}] ` : ""}${options.path}?${query}`
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)

    const send = async () => {
      const headers: Record<string, string> = { accept: options.accept ?? SAP_JSON }
      if (body !== undefined) headers["content-type"] = SAP_JSON
      if (options.ifMatch) headers["if-match"] = options.ifMatch
      if (writing) headers["x-csrf-token"] = this.csrfToken ?? (await this.fetchCsrfToken())
      return this.raw(options.method, `${options.path}?${query}`, this.headers(headers), body, options.toolName, options.serviceRoot)
    }

    let { response, text, durationMs } = await send()
    // A CSRF token can expire between fetch and use: one fresh token, one retry.
    if (writing && response.status === 403 && response.headers.get("x-csrf-token")?.toLowerCase() === "required") {
      await this.log({ toolName: options.toolName, method: options.method, path, payload: body, status: 403, error: "CSRF token required", durationMs })
      this.csrfToken = null
      ;({ response, text, durationMs } = await send())
    }

    const contentType = response.headers.get("content-type") ?? ""
    let data: unknown = null
    if (text && contentType.includes("json")) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    const error = response.ok ? null : parseODataError(data, text.slice(0, 500) || `${response.status} ${response.statusText}`)
    await this.log({
      toolName: options.toolName,
      method: options.method,
      path,
      payload: body,
      status: response.status,
      error: error?.message,
      durationMs,
    })

    const sessionEnded =
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      (response.status === 403 && response.headers.get("x-csrf-token")?.toLowerCase() === "required")
    if (sessionEnded) throw new SapSessionExpiredError()

    return {
      method: options.method,
      path,
      status: response.status,
      ok: response.ok,
      etag: response.headers.get("etag") ?? (data as { "@odata.etag"?: string } | null)?.["@odata.etag"] ?? null,
      location: response.headers.get("location"),
      data,
      text,
      error,
      sapMessages: parseSapMessages(response.headers.get("sap-messages")),
      durationMs,
    }
  }
}
