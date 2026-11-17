import { readSse } from "@/lib/sse"
import { DEFAULT_BASE_URLS, isAiProvider, type AiProvider, type ProviderModel } from "@/lib/ai/provider-catalog"

export { AI_PROVIDERS, PROVIDER_LABELS, isAiProvider, type AiProvider } from "@/lib/ai/provider-catalog"

/** The fields of AiProviderConfig that a request needs, with the key already decrypted. */
export type ProviderRequestConfig = {
  provider: string
  baseUrl: string | null
  modelName: string
  apiVersion: string | null
  temperature: number
  maxTokens: number
  topP: number | null
  timeoutSeconds: number
  apiKey: string
}

export type ProviderMessage = { role: "user" | "assistant"; content: string }

export class ProviderError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "ProviderError"
    this.status = status
  }
}

export const ANTHROPIC_VERSION = "2023-06-01"

type RequestOptions = {
  config: ProviderRequestConfig
  system: string
  /** Provider-formatted messages; plain text messages for the simple chat. */
  messages: ReadonlyArray<unknown>
  stream: boolean
  /** Overrides config.maxTokens, for example for the connection test. */
  maxTokens?: number
}

export type BuiltRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export function trimSlashes(url: string) {
  return url.trim().replace(/\/+$/, "")
}

/** Ollama's server root ("http://localhost:11434"), whether the user typed it with /v1, /api or neither. */
export function ollamaRoot(baseUrl: string | null) {
  return trimSlashes(baseUrl || DEFAULT_BASE_URLS.OLLAMA).replace(/\/(v1|api)$/, "")
}

function assertProvider(provider: string): AiProvider {
  if (!isAiProvider(provider)) {
    throw new ProviderError(`Unknown provider "${provider}". Check the configuration in /settings/ai.`)
  }
  return provider
}

/** URL, headers and body for one request, built the same way for chat and for the connection test. */
export function buildRequest({ config, system, messages, stream, maxTokens }: RequestOptions): BuiltRequest {
  const provider = assertProvider(config.provider)
  const tokens = maxTokens ?? config.maxTokens

  if (provider === "ANTHROPIC") {
    const base = trimSlashes(config.baseUrl || "https://api.anthropic.com")
    const url = base.endsWith("/v1/messages") ? base : base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`
    // temperature and top_p are not sent: current Claude models reject sampling
    // parameters, so the configured values apply to OpenAI-style providers only.
    // `thinking` is left out so that each model uses its own default.
    return {
      url,
      headers: { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: { model: config.modelName, max_tokens: tokens, system, messages, stream },
    }
  }

  const body: Record<string, unknown> = {
    model: config.modelName,
    stream,
    temperature: config.temperature,
    messages: [{ role: "system", content: system }, ...messages],
  }
  if (config.topP != null) body.top_p = config.topP

  switch (provider) {
    case "OLLAMA": {
      // Ollama's OpenAI-compatible endpoint streams the same SSE format as OpenAI.
      body.max_tokens = tokens
      return {
        url: `${ollamaRoot(config.baseUrl)}/v1/chat/completions`,
        // Ollama needs no key; one is sent only for a proxy in front of it.
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        body,
      }
    }
    case "OPENAI": {
      const base = trimSlashes(config.baseUrl || "https://api.openai.com/v1")
      // Current OpenAI models take max_completion_tokens; max_tokens is deprecated there.
      body.max_completion_tokens = tokens
      return { url: `${base}/chat/completions`, headers: { Authorization: `Bearer ${config.apiKey}` }, body }
    }
    case "AZURE_OPENAI": {
      if (!config.baseUrl) throw new ProviderError("Azure OpenAI needs a base URL (the resource endpoint). Set it in /settings/ai.")
      if (!config.apiVersion) throw new ProviderError("Azure OpenAI needs an API version, for example 2024-10-21. Set it in /settings/ai.")
      const base = trimSlashes(config.baseUrl)
      const path = /\/openai\/deployments\//.test(base)
        ? base.replace(/\/chat\/completions$/, "")
        : `${base}/openai/deployments/${encodeURIComponent(config.modelName)}`
      body.max_tokens = tokens
      delete body.model // the deployment in the URL selects the model
      return {
        url: `${path}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`,
        headers: { "api-key": config.apiKey },
        body,
      }
    }
    case "CUSTOM_OPENAI_COMPATIBLE": {
      if (!config.baseUrl) throw new ProviderError("An OpenAI-compatible provider needs a base URL. Set it in /settings/ai.")
      const base = trimSlashes(config.baseUrl)
      body.max_tokens = tokens
      return {
        url: base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
        // Local servers such as Ollama need no key.
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        body,
      }
    }
  }
}

/** Adds what to do next to errors that local Ollama setups commonly hit. */
export function withHints(error: ProviderError, config: Pick<ProviderRequestConfig, "provider" | "modelName">): ProviderError {
  if (config.provider !== "OLLAMA") return error
  if (error.status === undefined && /ECONNREFUSED|Could not reach/i.test(error.message)) {
    return new ProviderError(`${error.message}. Is Ollama running? Start it with \`ollama serve\` or open the Ollama app.`)
  }
  if (error.status === 404 && /not found/i.test(error.message)) {
    return new ProviderError(`${error.message}. Download it with \`ollama pull ${config.modelName}\`.`, 404)
  }
  return error
}

export async function send(
  request: BuiltRequest,
  signal: AbortSignal,
  stream: boolean,
  config: Pick<ProviderRequestConfig, "provider" | "modelName">
): Promise<Response> {
  try {
    return await sendRaw(request, signal, stream)
  } catch (error) {
    throw error instanceof ProviderError ? withHints(error, config) : error
  }
}

async function sendRaw(request: BuiltRequest, signal: AbortSignal, stream: boolean): Promise<Response> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const host = (() => {
      try {
        return new URL(request.url).host
      } catch {
        return request.url
      }
    })()
    throw new ProviderError(`Could not reach ${host}: ${cause?.code ?? cause?.message ?? (error as Error).message}`)
  }
  if (!response.ok) throw await httpError(response)
  return response
}

/**
 * Streams the assistant's reply as text chunks. Throws ProviderError for
 * configuration and HTTP errors, and an AbortError when `signal` aborts.
 */
export async function* streamChatCompletion(options: {
  config: ProviderRequestConfig
  system: string
  messages: ProviderMessage[]
  signal: AbortSignal
}): AsyncGenerator<string> {
  const { config } = options
  const request = buildRequest({ ...options, stream: true })

  // The timeout is an idle timeout: it restarts whenever data arrives, so long
  // answers that keep streaming are not cut off.
  const idle = new AbortController()
  const timeoutMs = Math.max(1, config.timeoutSeconds) * 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(new ProviderError(`The provider did not respond within ${config.timeoutSeconds} seconds.`, 504)), timeoutMs)
  }
  const signal = AbortSignal.any([options.signal, idle.signal])

  try {
    touch()
    const response = await send(request, signal, true, config)
    if (!response.body) throw new ProviderError("The provider returned an empty response.")
    const chunks = config.provider === "ANTHROPIC" ? readAnthropicStream(response.body) : readOpenAiStream(response.body)
    for await (const chunk of chunks) {
      touch()
      yield chunk
    }
  } catch (error) {
    if (idle.signal.aborted && !options.signal.aborted) throw idle.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sends a minimal ping ("Reply with OK", at most 5 output tokens) with the
 * exact URL, headers and model of the configuration. Resolves with the round
 * trip time; throws ProviderError with the provider's own error otherwise.
 */
export async function testProviderConnection(config: ProviderRequestConfig): Promise<{ latencyMs: number; reply: string }> {
  const request = buildRequest({
    config,
    system: "You are a connection test.",
    messages: [{ role: "user", content: "Reply with OK" }],
    stream: false,
    maxTokens: 5,
  })
  const signal = AbortSignal.timeout(Math.max(1, config.timeoutSeconds) * 1000)
  const started = performance.now()
  try {
    const response = await send(request, signal, false, config)
    const data = (await response.json().catch(() => null)) as {
      content?: { type?: string; text?: string }[]
      choices?: { message?: { content?: string | null } }[]
    } | null
    const latencyMs = Math.round(performance.now() - started)
    const reply =
      config.provider === "ANTHROPIC"
        ? (data?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("")
        : (data?.choices?.[0]?.message?.content ?? "")
    return { latencyMs, reply: reply.trim() }
  } catch (error) {
    if (signal.aborted && !(error instanceof ProviderError)) {
      throw new ProviderError(`No response within ${config.timeoutSeconds} seconds.`, 504)
    }
    throw error
  }
}

/** OpenAI models that cannot answer chat requests (embeddings, audio, images, moderation, legacy completions). */
const NON_CHAT_OPENAI_MODEL = /embedding|tts|whisper|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|computer-use/i

function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/**
 * The models the provider offers with this configuration: installed models
 * for Ollama, the models the key may use for OpenAI, Anthropic and
 * OpenAI-compatible servers. Azure deployments cannot be listed with an API key.
 */
export async function listProviderModels(
  config: Pick<ProviderRequestConfig, "provider" | "baseUrl" | "apiKey" | "modelName">
): Promise<ProviderModel[]> {
  const provider = assertProvider(config.provider)
  const getJson = async (url: string, headers: Record<string, string>) => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      })
      if (!response.ok) throw await httpError(response)
      return (await response.json()) as unknown
    } catch (error) {
      if (error instanceof ProviderError) throw withHints(error, config)
      if ((error as Error).name === "TimeoutError") throw new ProviderError(`${new URL(url).host} did not answer within 15 seconds.`)
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      throw withHints(new ProviderError(`Could not reach ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (error as Error).message}`), config)
    }
  }
  const bearer: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}

  switch (provider) {
    case "OLLAMA": {
      const data = (await getJson(`${ollamaRoot(config.baseUrl)}/api/tags`, bearer)) as {
        models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[]
      }
      return (data.models ?? [])
        .map((model) => ({
          id: model.name,
          detail: [model.details?.parameter_size, model.details?.quantization_level, model.size ? formatBytes(model.size) : null]
            .filter(Boolean)
            .join(" · "),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    case "ANTHROPIC": {
      const base = trimSlashes(config.baseUrl || "https://api.anthropic.com").replace(/\/v1(\/messages)?$/, "")
      const data = (await getJson(`${base}/v1/models?limit=100`, {
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      })) as { data?: { id: string; display_name?: string }[] }
      return (data.data ?? []).map((model) => ({ id: model.id, label: model.display_name }))
    }
    case "OPENAI":
    case "CUSTOM_OPENAI_COMPATIBLE": {
      if (provider === "CUSTOM_OPENAI_COMPATIBLE" && !config.baseUrl) {
        throw new ProviderError("Enter the base URL first.")
      }
      const base = trimSlashes(config.baseUrl || "https://api.openai.com/v1").replace(/\/chat\/completions$/, "")
      const data = (await getJson(`${base}/models`, bearer)) as { data?: { id: string }[] }
      return (data.data ?? [])
        .filter((model) => provider !== "OPENAI" || !NON_CHAT_OPENAI_MODEL.test(model.id))
        .map((model) => ({ id: model.id }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    case "AZURE_OPENAI":
      throw new ProviderError(
        "Azure OpenAI deployments cannot be listed with an API key. Type the deployment name shown in Azure AI Foundry."
      )
  }
}

async function* readOpenAiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const { data } of readSse(body)) {
    if (data === "[DONE]") return
    const chunk = parseJson(data) as {
      error?: { message?: string }
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]
    } | null
    if (!chunk) continue
    if (chunk.error) throw new ProviderError(chunk.error.message ?? "The provider returned an error.")
    // Azure sends chunks with an empty choices array (content filter results).
    const choice = chunk.choices?.[0]
    if (choice?.delta?.content) yield choice.delta.content
    if (choice?.finish_reason === "content_filter") {
      throw new ProviderError("The provider's content filter stopped the response.")
    }
  }
}

async function* readAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const { data } of readSse(body)) {
    const event = parseJson(data) as {
      type?: string
      delta?: { type?: string; text?: string; stop_reason?: string | null }
      error?: { type?: string; message?: string }
    } | null
    if (!event) continue

    switch (event.type) {
      case "content_block_delta":
        // Thinking blocks also arrive as deltas; only the visible text is shown.
        if (event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text
        break
      case "message_delta":
        if (event.delta?.stop_reason === "refusal") {
          throw new ProviderError("The model declined to continue this response.")
        }
        break
      case "error":
        throw new ProviderError(`${event.error?.type ?? "error"}: ${event.error?.message ?? "The provider returned an error."}`)
      case "message_stop":
        return
    }
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function httpError(response: Response): Promise<ProviderError> {
  const text = await response.text().catch(() => "")
  const parsed = parseJson(text) as { error?: { message?: string } | string; message?: string } | null
  const detail =
    (typeof parsed?.error === "object" ? parsed.error?.message : typeof parsed?.error === "string" ? parsed.error : undefined) ??
    parsed?.message ??
    (text.slice(0, 300) || "No details")
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
  return new ProviderError(`${status}: ${detail}`, response.status)
}
