import { streamAgentTurn, type AgentMessage, type AgentTurnEvent } from "@/lib/ai/agent"
import type { ProviderRequestConfig } from "@/lib/ai/providers"
import { executeSapTool, SAP_TOOL_DEFINITIONS, toolLabel, type SapToolContext } from "@/lib/ai/tools/sap-odata"
import type { ChangePlanView, ToolRun } from "@/lib/sap/agent-types"

/** Tool rounds per user message; after them the model must answer with what it has. */
export const MAX_TOOL_ROUNDS = 5

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
  let text = ""
  let sessionExpired = false

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

    for await (const event of streamAgentTurn({
      config: options.config,
      system: options.system,
      messages,
      tools: SAP_TOOL_DEFINITIONS,
      toolChoice,
      signal: options.signal,
    })) {
      if (event.type === "text") {
        // Separate the text of successive rounds.
        if (!startedText && text && !text.endsWith("\n\n")) append(text.endsWith("\n") ? "\n" : "\n\n")
        startedText = true
        append(event.text)
      } else {
        end = event
      }
    }
    if (!end) break
    messages.push(end.message)

    if (end.message.toolCalls.length === 0 || toolChoice === "none") break
    if (end.stopReason === "max_tokens") {
      // A tool call cut off by the token limit may carry a truncated input: never run it.
      append(`${text ? "\n\n" : ""}_The model ran out of output tokens while preparing an SAP request, so nothing was sent. Raise "Max output tokens" in the AI model settings and try again._`)
      break
    }

    for (const call of end.message.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>
      } catch {
        args = { raw: call.arguments }
      }
      const run: ToolRun = { id: call.id, tool: call.name, label: toolLabel(call.name, args), status: "running", args, requests: [] }
      toolRuns.push(run)
      emit({ type: "tool_start", run: { ...run } })

      context.client.onRequest = (entry) => {
        run.requests.push({ method: entry.method, path: entry.path, status: entry.status, durationMs: entry.durationMs, error: entry.error })
      }
      const result = await executeSapTool(call.name, call.arguments, context)
      context.client.onRequest = undefined

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

  return { text, toolRuns, changePlanIds, sessionExpired }
}
