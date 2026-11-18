import { streamAgentTurn, type AgentMessage, type AgentToolCall, type AgentTurnEvent } from "@/lib/ai/agent"
import type { ProviderRequestConfig } from "@/lib/ai/providers"
import {
  executeSapTool,
  isSapToolName,
  readToolArguments,
  SAP_TOOL_DEFINITIONS,
  toolLabel,
  type SapToolContext,
} from "@/lib/ai/tools/sap-odata"
import { parseLooseJson } from "@/lib/sap/odata-query"
import type { ChangePlanView, ToolRun } from "@/lib/sap/agent-types"

/** Tool rounds per user message; after them the model must answer with what it has. */
export const MAX_TOOL_ROUNDS = 6

export type SapAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; run: ToolRun }
  | { type: "tool_end"; run: ToolRun }
  | { type: "change_plan"; plan: ChangePlanView }
  | { type: "sap_auth_required" }

export type SapAgentResult = {
  text: string
  toolRuns: ToolRun[]
  changePlanIds: string[]
  sessionExpired: boolean
}

// ---------- tool calls written as text ----------

/** Where a tool call written as text may begin. */
const TEXT_CALL_START = /\{\s*"(?:name|type|function|tool|tool_name)"\s*:|<tool_call>|```(?:json)?\s*\{/

/** The end of the JSON object that starts at `start`, counting braces outside strings. */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === "\\") i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * Tool calls that a model wrote into its answer instead of calling the tool,
 * e.g. {"name": "sap_query_odata", "parameters": {...}} (small Ollama models
 * do this), and the answer without them.
 */
export function extractTextToolCalls(text: string): { calls: { name: string; arguments: string }[]; remaining: string } {
  const calls: { name: string; arguments: string }[] = []
  let remaining = ""
  let index = 0
  while (index < text.length) {
    const start = text.indexOf("{", index)
    if (start === -1) break
    const end = objectEnd(text, start)
    if (end === -1) break
    const parsed = parseLooseJson(text.slice(start, end))
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    const fn = object?.function && typeof object.function === "object" ? (object.function as Record<string, unknown>) : null
    const name = String(fn?.name ?? object?.name ?? object?.tool ?? object?.tool_name ?? "")
    if (object && isSapToolName(name)) {
      const args = fn?.arguments ?? fn?.parameters ?? object.parameters ?? object.arguments ?? object.args ?? object.input ?? object.params ?? {}
      calls.push({ name, arguments: typeof args === "string" ? args : JSON.stringify(args) })
      remaining += text.slice(index, start)
    } else {
      remaining += text.slice(index, end)
    }
    index = end
  }
  remaining += text.slice(index)
  remaining = remaining
    .replace(/```(?:json)?\s*```/g, "")
    .replace(/<tool_call>\s*<\/tool_call>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { calls, remaining }
}

// ---------- invented values ----------

/** Cells of Markdown tables that look like SAP codes or numbers (EF-MAT, FERT, 1010). */
function codeCells(text: string): string[] {
  const rows = text.split("\n").filter((line) => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line))
  return rows.slice(1).flatMap((row) =>
    row
      .split("|")
      .map((cell) => cell.replace(/[*`_]/g, "").trim())
      .filter((cell) => /^[A-Z0-9][A-Z0-9_./-]{1,39}$/.test(cell) && /[A-Z]/.test(cell))
  )
}

/**
 * A table whose codes appear in no SAP result of this answer was most likely
 * invented by the model; the user is told so.
 */
function unverifiedTableNote(text: string, toolOutputs: string[], systemName: string): string | null {
  const cells = codeCells(text)
  if (cells.length < 3) return null
  const data = toolOutputs.join("\n")
  const found = cells.filter((cell) => data.includes(cell)).length
  if (found / cells.length >= 0.5) return null
  return `\n\n> **Not verified:** the values in this table were not read from ${systemName} in this answer. Treat them as unconfirmed and ask again to read them live.`
}

/**
 * Runs one user message through the model with the SAP tools. Calls tools
 * sequentially (writes are only proposed; see sap_propose_change), feeds SAP's
 * answers and errors back, and streams text and progress through `emit`.
 */
export async function runSapAgent(options: {
  config: ProviderRequestConfig
  system: string
  history: AgentMessage[]
  toolContext: Omit<SapToolContext, "onChangePlan" | "plansCreated">
  signal: AbortSignal
  emit: (event: SapAgentEvent) => void
}): Promise<SapAgentResult> {
  const { emit } = options
  const messages: AgentMessage[] = [...options.history]
  const toolRuns: ToolRun[] = []
  const changePlanIds: string[] = []
  const toolOutputs: string[] = []
  let text = ""
  let sessionExpired = false
  // Claude and Gemini replay their own tool-call blocks, so only calls made through the API count there.
  const recoverTextCalls = options.config.provider !== "ANTHROPIC" && options.config.provider !== "GEMINI"

  const context: SapToolContext = {
    ...options.toolContext,
    plansCreated: 0,
    onChangePlan: (plan) => {
      changePlanIds.push(plan.id)
      emit({ type: "change_plan", plan })
    },
  }

  const append = (chunk: string) => {
    text += chunk
    emit({ type: "delta", text: chunk })
  }

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const toolChoice = round < MAX_TOOL_ROUNDS && !sessionExpired ? "auto" : "none"
    let startedText = false
    let end: Extract<AgentTurnEvent, { type: "end" }> | null = null
    // Text that may be the start of a tool call written as text is held back until the round ends.
    let pending = ""
    let holding = false

    const show = (chunk: string) => {
      if (!chunk) return
      // Separate the text of successive rounds.
      if (!startedText && text && !text.endsWith("\n\n")) append(text.endsWith("\n") ? "\n" : "\n\n")
      startedText = true
      append(chunk)
    }

    for await (const event of streamAgentTurn({
      config: options.config,
      system: options.system,
      messages,
      tools: SAP_TOOL_DEFINITIONS,
      toolChoice,
      signal: options.signal,
    })) {
      if (event.type !== "text") {
        end = event
        continue
      }
      if (!recoverTextCalls) {
        show(event.text)
        continue
      }
      pending += event.text
      if (holding) continue
      const start = pending.search(TEXT_CALL_START)
      if (start >= 0) {
        show(pending.slice(0, start))
        pending = pending.slice(start)
        holding = true
        continue
      }
      // Keep a short tail that could still become a marker ("{", "<tool", "```").
      const tail = Math.max(pending.lastIndexOf("{"), pending.lastIndexOf("<"), pending.lastIndexOf("`"))
      const cut = tail >= 0 && pending.length - tail < 24 ? tail : pending.length
      show(pending.slice(0, cut))
      pending = pending.slice(cut)
    }
    if (!end) {
      show(pending)
      break
    }

    if (recoverTextCalls && end.message.toolCalls.length === 0 && holding) {
      const recovered = extractTextToolCalls(pending)
      if (recovered.calls.length > 0) {
        show(recovered.remaining)
        const visible = end.message.content.slice(0, Math.max(0, end.message.content.length - pending.length))
        const calls: AgentToolCall[] = recovered.calls.map((call, index) => ({ id: `text_call_${Date.now()}_${index}`, ...call }))
        end = {
          ...end,
          message: { ...end.message, content: `${visible}${recovered.remaining ? `\n${recovered.remaining}` : ""}`.trim(), toolCalls: toolChoice === "auto" ? calls : [] },
        }
        if (toolChoice === "none") show("\n\n_The model wanted to read more SAP data after the request limit. Ask again to continue._")
      } else {
        show(pending)
      }
    } else {
      show(pending)
    }
    messages.push(end.message)

    if (end.message.toolCalls.length === 0 || toolChoice === "none") break
    if (end.stopReason === "max_tokens") {
      // A tool call cut off by the token limit may carry a truncated input: never run it.
      append(`${text ? "\n\n" : ""}_The model ran out of output tokens while preparing an SAP request, so nothing was sent. Raise "Max output tokens" in the AI model settings and try again._`)
      break
    }

    for (const call of end.message.toolCalls) {
      const args = readToolArguments(call.name, call.arguments)
      const run: ToolRun = { id: call.id, tool: call.name, label: toolLabel(call.name, args), status: "running", args, requests: [] }
      toolRuns.push(run)
      emit({ type: "tool_start", run: { ...run } })

      context.client.onRequest = (entry) => {
        run.requests.push({ method: entry.method, path: entry.path, status: entry.status, durationMs: entry.durationMs, error: entry.error })
      }
      const result = await executeSapTool(call.name, call.arguments, context)
      context.client.onRequest = undefined
      if (!result.isError) toolOutputs.push(result.content)

      run.status = result.isError ? "error" : "ok"
      run.summary = result.summary
      emit({ type: "tool_end", run: { ...run, requests: [...run.requests] } })
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: result.isError })

      if (result.sessionExpired && !sessionExpired) {
        sessionExpired = true
        emit({ type: "sap_auth_required" })
      }
    }
  }

  const note = unverifiedTableNote(text, toolOutputs, options.toolContext.system.name)
  if (note) append(note)

  return { text, toolRuns, changePlanIds, sessionExpired }
}
