import { readSse } from "@/lib/sse"
import {
  buildGeminiRequest,
  buildRequest,
  ollamaRoot,
  parseJson,
  ProviderError,
  readGeminiStream,
  send,
  type BuiltRequest,
  type GeminiContent,
  type GeminiPart,
  type ProviderRequestConfig,
} from "@/lib/ai/providers"

/**
 * One model turn with tools, for every configured provider:
 * - OpenAI, Azure OpenAI and OpenAI-compatible servers: Chat Completions with
 *   `tools` and streamed `tool_calls`;
 * - Anthropic: Messages API with `tools`; the assistant's content blocks
 *   (thinking with signatures, text, tool_use) are kept unchanged and sent
 *   back on the next round of the same turn;
 * - Gemini: native streamGenerateContent with `functionDeclarations`; the
 *   model's parts (with their thought signatures) are replayed the same way;
 * - Ollama: native /api/chat, the only Ollama endpoint that accepts
 *   options.num_ctx (the agent prompt and tools do not fit Ollama's 4K default).
 */

export type AgentToolCall = {
  id: string
  name: string
  arguments: string
  /**
   * Provider fields on the call that must be sent back unchanged, such as
   * extra_content.google.thought_signature from Gemini behind an OpenAI-compatible URL.
   */
  extra?: Record<string, unknown>
}

export type AgentAssistantMessage = {
  role: "assistant"
  content: string
  toolCalls: AgentToolCall[]
  /** Anthropic content blocks of this turn, replayed unchanged within the tool loop. */
  anthropicBlocks?: Record<string, unknown>[]
  /** Gemini parts of this turn (with thought signatures), replayed unchanged within the tool loop. */
  geminiParts?: GeminiPart[]
}

export type AgentMessage =
  | { role: "user"; content: string }
  | AgentAssistantMessage
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean }

export type AgentToolDefinition = { name: string; description: string; parameters: Record<string, unknown> }

export type AgentTurnEvent =
  | { type: "text"; text: string }
  | { type: "end"; message: AgentAssistantMessage; stopReason: string }

const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 16_384

type TurnOptions = {
  config: ProviderRequestConfig
  system: string
  messages: AgentMessage[]
  tools: readonly AgentToolDefinition[]
  /** "none" lets the model only answer (last round of the loop). */
  toolChoice: "auto" | "none"
  signal: AbortSignal
}

export async function* streamAgentTurn(options: TurnOptions): AsyncGenerator<AgentTurnEvent> {
  const { config } = options
  // Idle timeout: restarts whenever data arrives.
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
    const turn =
      config.provider === "ANTHROPIC"
        ? anthropicTurn(options, signal)
        : config.provider === "GEMINI"
          ? geminiTurn(options, signal)
          : config.provider === "OLLAMA"
            ? ollamaTurn(options, signal)
            : openAiTurn(options, signal)
    for await (const event of turn) {
      touch()
      yield event
    }
  } catch (error) {
    if (idle.signal.aborted && !options.signal.aborted) throw idle.signal.reason
    if (
      error instanceof ProviderError &&
      /does not support tools|tools? (are|is) not supported|tool_choice|function calling is not enabled/i.test(error.message)
    ) {
      throw new ProviderError(
        `${error.message}. This model cannot call tools, so it cannot query SAP. Choose a model with tool support in /settings/ai (for example qwen3 or llama3.1 in Ollama, or any current OpenAI or Claude model).`,
        error.status
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------- OpenAI family ----------

async function* openAiTurn({ config, system, messages, tools, toolChoice }: TurnOptions, signal: AbortSignal): AsyncGenerator<AgentTurnEvent> {
  const converted = messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.content }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
    return {
      role: "assistant",
      content: message.content || (message.toolCalls.length ? null : ""),
      ...(message.toolCalls.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
              ...(call.extra ?? {}),
            })),
          }
        : {}),
    }
  })
  const request: BuiltRequest = buildRequest({ config, system, messages: converted, stream: true })
  // Gemini can also be reached through "Other provider" with its OpenAI-compatible URL.
  const portable = /generativelanguage\.googleapis\.com/i.test(config.baseUrl ?? "")
  request.body.tools = tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: portable ? portableSchema(tool.parameters) : tool.parameters },
  }))
  request.body.tool_choice = toolChoice

  const response = await send(request, signal, true, config)
  if (!response.body) throw new ProviderError("The provider returned an empty response.")

  let content = ""
  let stopReason = "stop"
  const calls: { id: string; name: string; arguments: string; extra?: Record<string, unknown> }[] = []
  for await (const { data } of readSse(response.body)) {
    if (data === "[DONE]") break
    const chunk = parseJson(data) as {
      error?: { message?: string }
      choices?: {
        delta?: {
          content?: string | null
          tool_calls?: ({ index?: number; id?: string; function?: { name?: string; arguments?: string } } & Record<string, unknown>)[]
        }
        finish_reason?: string | null
      }[]
    } | null
    if (!chunk) continue
    if (chunk.error) throw new ProviderError(chunk.error.message ?? "The provider returned an error.")
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) {
      content += choice.delta.content
      yield { type: "text", text: choice.delta.content }
    }
    for (const delta of choice.delta?.tool_calls ?? []) {
      const index = delta.index ?? calls.length
      calls[index] ??= { id: "", name: "", arguments: "" }
      if (delta.id) calls[index].id = delta.id
      if (delta.function?.name) calls[index].name += delta.function.name
      if (delta.function?.arguments) calls[index].arguments += delta.function.arguments
      // Keep provider-specific fields (Gemini thought signatures) to send them back.
      for (const [key, value] of Object.entries(delta)) {
        if (!["index", "id", "type", "function"].includes(key) && value !== undefined && value !== null) {
          calls[index].extra = { ...calls[index].extra, [key]: value }
        }
      }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason
    if (choice.finish_reason === "content_filter") throw new ProviderError("The provider's content filter stopped the response.")
  }

  const toolCalls = calls
    .filter((call) => call && call.name)
    .map((call, index) => ({
      id: call.id || `call_${Date.now()}_${index}`,
      name: call.name,
      arguments: call.arguments || "{}",
      ...(call.extra ? { extra: call.extra } : {}),
    }))
  yield { type: "end", message: { role: "assistant", content, toolCalls }, stopReason }
}

/**
 * The subset of JSON Schema that Gemini's function declarations accept: no
 * type lists, no additionalProperties, no numeric bounds, and objects only
 * with named properties. Free-form objects become JSON text; the SAP tools
 * accept keys and changes in that form.
 */
function portableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "minimum" || key === "maximum") continue
    if (key === "type" && Array.isArray(value)) {
      result.type = "string"
    } else if (key === "properties" && value && typeof value === "object") {
      result.properties = Object.fromEntries(
        Object.entries(value as Record<string, Record<string, unknown>>).map(([name, child]) => [name, portableSchema(child)])
      )
    } else if (key === "items" && value && typeof value === "object") {
      result.items = portableSchema(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  if (result.type === "object" && !result.properties) {
    return {
      type: "string",
      description: `${typeof result.description === "string" ? `${result.description} ` : ""}Pass it as JSON text, for example {"Product":"<product number>"}.`,
    }
  }
  return result
}

// ---------- Gemini (native generateContent) ----------

function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  // A function response repeats the call's ID only when Gemini gave the call one.
  const geminiIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.geminiParts ?? []).flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : [])) : []
    )
  )
  const contents: GeminiContent[] = []
  for (const message of messages) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] })
    } else if (message.role === "assistant") {
      const parts: GeminiPart[] = message.geminiParts ?? [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          functionCall: { name: call.name, args: (parseJson(call.arguments) ?? {}) as Record<string, unknown> },
        })),
      ]
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "(no answer)" }] })
    } else {
      // The response must be an object; the tool's JSON goes in "output", or "error" for a failure.
      const value = parseJson(message.content) ?? message.content
      const part: GeminiPart = {
        functionResponse: {
          ...(geminiIds.has(message.toolCallId) ? { id: message.toolCallId } : {}),
          name: message.name,
          response: message.isError ? { error: value } : { output: value },
        },
      }
      // All responses to one model turn go into a single user message.
      const last = contents[contents.length - 1]
      if (last?.role === "user" && last.parts.every((item) => item.functionResponse)) {
        last.parts.push(part)
      } else {
        contents.push({ role: "user", parts: [part] })
      }
    }
  }
  return contents
}

/** Adds a streamed part, joining pieces of plain text; parts with a signature or thought flag stay as they came. */
function appendGeminiPart(parts: GeminiPart[], part: GeminiPart) {
  const plainText = (item: GeminiPart) => typeof item.text === "string" && Object.keys(item).length === 1
  const last = parts[parts.length - 1]
  if (last && plainText(last) && plainText(part)) {
    last.text = `${last.text ?? ""}${part.text ?? ""}`
  } else {
    parts.push({ ...part })
  }
}

async function* geminiTurn({ config, system, messages, tools, toolChoice }: TurnOptions, signal: AbortSignal): AsyncGenerator<AgentTurnEvent> {
  const request = buildGeminiRequest({ config, system, contents: toGeminiContents(messages), stream: true })
  request.body.tools = [
    {
      functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: portableSchema(tool.parameters) })),
    },
  ]
  // NONE keeps the declarations (earlier rounds refer to them) but lets the model only answer.
  request.body.toolConfig = { functionCallingConfig: { mode: toolChoice === "auto" ? "AUTO" : "NONE" } }

  const response = await send(request, signal, true, config)
  if (!response.body) throw new ProviderError("Gemini returned an empty response.")

  let content = ""
  let stopReason = "stop"
  const parts: GeminiPart[] = []
  for await (const chunk of readGeminiStream(response.body)) {
    for (const part of chunk.parts) {
      if (typeof part.text === "string" && part.text && !part.thought) {
        content += part.text
        yield { type: "text", text: part.text }
      }
      appendGeminiPart(parts, part)
    }
    if (chunk.finishReason === "MALFORMED_FUNCTION_CALL" || chunk.finishReason === "UNEXPECTED_TOOL_CALL") {
      throw new ProviderError(`Gemini produced an invalid tool call (${chunk.finishReason}). Send the message again, or choose another Gemini model.`)
    }
    if (chunk.finishReason) stopReason = chunk.finishReason === "MAX_TOKENS" ? "max_tokens" : chunk.finishReason.toLowerCase()
  }

  const toolCalls = parts.flatMap((part, index) =>
    part.functionCall?.name
      ? [{ id: part.functionCall.id ?? `call_${Date.now()}_${index}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) }]
      : []
  )
  yield {
    type: "end",
    message: { role: "assistant", content, toolCalls: toolChoice === "auto" ? toolCalls : [], geminiParts: parts },
    stopReason,
  }
}

// ---------- Anthropic ----------

async function* anthropicTurn({ config, system, messages, tools, toolChoice }: TurnOptions, signal: AbortSignal): AsyncGenerator<AgentTurnEvent> {
  const converted: { role: "user" | "assistant"; content: unknown }[] = []
  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content })
    } else if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: message.anthropicBlocks ?? [{ type: "text", text: message.content || "(no answer)" }],
      })
    } else {
      // All tool results of one assistant turn go into a single user message.
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }
      const last = converted[converted.length - 1]
      if (last?.role === "user" && Array.isArray(last.content) && (last.content as { type?: string }[]).every((item) => item.type === "tool_result")) {
        ;(last.content as unknown[]).push(block)
      } else {
        converted.push({ role: "user", content: [block] })
      }
    }
  }

  const request = buildRequest({ config, system, messages: converted, stream: true })
  // Fine-grained tool input streaming on the Claude API itself (proxies may not accept the field).
  const directApi = !config.baseUrl || /^https:\/\/api\.anthropic\.com/i.test(config.baseUrl)
  request.body.tools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(directApi ? { eager_input_streaming: true } : {}),
  }))
  request.body.tool_choice = { type: toolChoice }

  const response = await send(request, signal, true, config)
  if (!response.body) throw new ProviderError("The provider returned an empty response.")

  const blocks: Record<string, unknown>[] = []
  const partialJson = new Map<number, string>()
  let stopReason = "end_turn"

  for await (const { data } of readSse(response.body)) {
    const event = parseJson(data) as {
      type?: string
      index?: number
      content_block?: Record<string, unknown>
      delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null }
      error?: { type?: string; message?: string }
    } | null
    if (!event) continue
    const index = event.index ?? 0

    switch (event.type) {
      case "content_block_start": {
        const block = { ...(event.content_block ?? {}) }
        blocks[index] = block
        if (block.type === "tool_use") partialJson.set(index, "")
        if (block.type === "text" && typeof block.text === "string" && block.text) yield { type: "text", text: block.text }
        break
      }
      case "content_block_delta": {
        const block = blocks[index]
        const delta = event.delta
        if (!block || !delta) break
        if (delta.type === "text_delta" && delta.text) {
          block.text = `${(block.text as string | undefined) ?? ""}${delta.text}`
          yield { type: "text", text: delta.text }
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          block.thinking = `${(block.thinking as string | undefined) ?? ""}${delta.thinking}`
        } else if (delta.type === "signature_delta" && delta.signature) {
          block.signature = delta.signature
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          partialJson.set(index, (partialJson.get(index) ?? "") + delta.partial_json)
        }
        break
      }
      case "content_block_stop": {
        const block = blocks[index]
        if (block?.type === "tool_use") {
          const raw = partialJson.get(index) ?? ""
          block.input = raw ? (parseJson(raw) ?? {}) : (block.input ?? {})
        }
        break
      }
      case "message_delta":
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
        break
      case "error":
        throw new ProviderError(`${event.error?.type ?? "error"}: ${event.error?.message ?? "The provider returned an error."}`)
    }
  }

  if (stopReason === "refusal") throw new ProviderError("The model declined to continue this response.")

  const ordered = blocks.filter(Boolean)
  const content = ordered
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
  const toolCalls = blocks.flatMap((block, index) => {
    if (block?.type !== "tool_use") return []
    const raw = partialJson.get(index)
    return [{ id: String(block.id), name: String(block.name), arguments: raw && raw.trim() ? raw : JSON.stringify(block.input ?? {}) }]
  })
  yield { type: "end", message: { role: "assistant", content, toolCalls, anthropicBlocks: ordered }, stopReason }
}

// ---------- Ollama (native /api/chat) ----------

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield parseJson(line)
      }
    }
    if (buffer.trim()) yield parseJson(buffer.trim())
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function* ollamaTurn({ config, system, messages, tools, toolChoice }: TurnOptions, signal: AbortSignal): AsyncGenerator<AgentTurnEvent> {
  const converted = [
    { role: "system", content: system },
    ...messages.map((message) => {
      if (message.role === "user") return { role: "user", content: message.content }
      if (message.role === "tool") return { role: "tool", content: message.content, tool_name: message.name }
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls.length
          ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: parseJson(call.arguments) ?? {} } })) }
          : {}),
      }
    }),
  ]
  const request: BuiltRequest = {
    url: `${ollamaRoot(config.baseUrl)}/api/chat`,
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: {
      model: config.modelName,
      messages: converted,
      stream: true,
      // Ollama has no tool_choice: on the last round the tools are simply not offered.
      ...(toolChoice === "auto" ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}),
      options: {
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: config.maxTokens,
        temperature: config.temperature,
        ...(config.topP != null ? { top_p: config.topP } : {}),
      },
    },
  }
  const response = await send(request, signal, true, config)
  if (!response.body) throw new ProviderError("Ollama returned an empty response.")

  let content = ""
  let stopReason = "stop"
  let inThink = false
  const toolCalls: AgentToolCall[] = []

  for await (const line of readNdjson(response.body)) {
    const chunk = line as {
      error?: string
      message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }
      done?: boolean
      done_reason?: string
    } | null
    if (!chunk) continue
    if (chunk.error) throw new ProviderError(chunk.error)

    let text = chunk.message?.content ?? ""
    // Older Ollama versions put a reasoning model's thinking inline in <think> tags.
    if (text) {
      let visible = ""
      while (text) {
        if (inThink) {
          const end = text.indexOf("</think>")
          if (end === -1) {
            text = ""
          } else {
            inThink = false
            text = text.slice(end + "</think>".length)
          }
        } else {
          const start = text.indexOf("<think>")
          if (start === -1) {
            visible += text
            text = ""
          } else {
            visible += text.slice(0, start)
            inThink = true
            text = text.slice(start + "<think>".length)
          }
        }
      }
      if (visible) {
        const trimmed = content ? visible : visible.replace(/^\s+/, "")
        if (trimmed) {
          content += trimmed
          yield { type: "text", text: trimmed }
        }
      }
    }
    for (const call of chunk.message?.tool_calls ?? []) {
      if (!call.function?.name) continue
      const args = call.function.arguments
      toolCalls.push({
        id: call.id ?? `call_${Date.now()}_${toolCalls.length}`,
        name: call.function.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      })
    }
    if (chunk.done) {
      stopReason = chunk.done_reason === "length" ? "max_tokens" : (chunk.done_reason ?? "stop")
      break
    }
  }
  yield { type: "end", message: { role: "assistant", content, toolCalls: toolChoice === "auto" ? toolCalls : [] }, stopReason }
}
