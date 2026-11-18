"use client"

import * as React from "react"
import { flushSync } from "react-dom"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, cn, prefersReducedMotion, Separator, SidebarTrigger } from "@boilerplate/ui"

import type { ActiveModelSummary } from "@/lib/ai/active-model"
import type { ToolRun } from "@/lib/sap/agent-types"
import { businessAreaFor } from "@/lib/sap/business"
import { fetchWithSapSignIn, requestSapSignIn, SapAuthCancelledError } from "@/lib/sap-fetch"
import { readSse } from "@/lib/sse"
import { DEFAULT_CHAT_TITLE, type ChatStreamEvent } from "@/lib/validations/chat"
import { ChatThread, type ChatUIMessage, type PlanUpdateHandler } from "./chat-thread"
import { useChatUI } from "./chat-ui-context"
import { ClaudePromptInput, type SapSystemOption } from "./claude-prompt-input"

/** Questions business users ask, across finance, sales, procurement, production and master data. */
const STARTER_PROMPTS = [
  "Walk me through the month-end closing steps",
  "How does a sales order become an invoice?",
  "What do I need to set up a new cost center?",
  "What is the difference between a bill of material and a routing?",
  "How do I create a new supplier?",
]

type ChatViewProps = {
  sessionId?: string
  title?: string
  initialMessages?: ChatUIMessage[]
  activeModel: ActiveModelSummary | null
  /** The signed-in user's SAP systems; null when signed out. */
  sapSystems: SapSystemOption[] | null
  initialSapSystemId: string | null
}

function upsertRun(runs: ToolRun[] | undefined, run: ToolRun) {
  const list = runs ?? []
  return list.some((item) => item.id === run.id) ? list.map((item) => (item.id === run.id ? run : item)) : [...list, run]
}

let localIdCounter = 0
const localId = (prefix: string) => `${prefix}-${Date.now()}-${++localIdCounter}`

export function ChatView({
  sessionId: initialSessionId,
  title: initialTitle,
  initialMessages = [],
  activeModel,
  sapSystems,
  initialSapSystemId,
}: ChatViewProps) {
  const router = useRouter()
  const { setPendingSession } = useChatUI()
  const [messages, setMessages] = React.useState<ChatUIMessage[]>(initialMessages)
  const [input, setInput] = React.useState("")
  const [isStreaming, setIsStreaming] = React.useState(false)
  const [title, setTitle] = React.useState(initialTitle ?? DEFAULT_CHAT_TITLE)
  // Follow renames from the sidebar, which arrive as a new prop after revalidation.
  const [previousInitialTitle, setPreviousInitialTitle] = React.useState(initialTitle)
  if (initialTitle !== previousInitialTitle) {
    setPreviousInitialTitle(initialTitle)
    if (initialTitle) setTitle(initialTitle)
  }
  const [sapSystemId, setSapSystemId] = React.useState<string | null>(initialSapSystemId)
  const sapSystem = sapSystems?.find((system) => system.id === sapSystemId) ?? null
  const area = sapSystem ? businessAreaFor(sapSystem.servicePath) : null
  const sessionIdRef = React.useRef(initialSessionId ?? null)
  const abortRef = React.useRef<AbortController | null>(null)
  const isEmpty = messages.length === 0

  // Leaving the chat (another chat, new chat) stops the request; the server
  // keeps whatever was generated so far.
  React.useEffect(() => () => abortRef.current?.abort(), [])

  const updateAssistant = React.useCallback((id: string, update: (message: ChatUIMessage) => ChatUIMessage) => {
    setMessages((current) => current.map((message) => (message.id === id ? update(message) : message)))
  }, [])

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim()
      if (!message || abortRef.current) return

      const assistantId = localId("assistant")
      const addMessages = () => {
        setMessages((current) => [
          ...current,
          { id: localId("user"), role: "user", content: message, status: "done" },
          { id: assistantId, role: "assistant", content: "", status: "streaming" },
        ])
        setInput("")
        setIsStreaming(true)
      }

      // The first message moves the prompt box from the centre to the bottom.
      if (messages.length === 0 && typeof document.startViewTransition === "function" && !prefersReducedMotion()) {
        document.startViewTransition(() => flushSync(addMessages))
      } else {
        addMessages()
      }

      const controller = new AbortController()
      abortRef.current = controller

      try {
        // With an SAP system, the server first checks the SAP session; without one
        // the sign-in dialog opens and the same message is sent again.
        const response = await fetchWithSapSignIn("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current ?? undefined, message, sapSystemId }),
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(data?.error ?? `The request failed with status ${response.status}.`)
        }

        for await (const { data } of readSse(response.body)) {
          const event = JSON.parse(data) as ChatStreamEvent
          switch (event.type) {
            case "session":
              setTitle(event.title)
              if (event.isNew) {
                sessionIdRef.current = event.sessionId
                setPendingSession({ id: event.sessionId, title: event.title, updatedAt: new Date() })
                // Give the chat its own URL without remounting the view mid-stream.
                window.history.replaceState(null, "", `/chat/${event.sessionId}`)
              }
              break
            case "delta":
              updateAssistant(assistantId, (m) => ({ ...m, content: m.content + event.text }))
              break
            case "done":
              updateAssistant(assistantId, (m) => ({ ...m, id: event.messageId ?? m.id, status: "done", modelUsed: event.modelUsed }))
              break
            case "error":
              updateAssistant(assistantId, (m) => ({ ...m, status: "error", error: event.message }))
              break
            case "tool_start":
            case "tool_end":
              updateAssistant(assistantId, (m) => ({ ...m, toolRuns: upsertRun(m.toolRuns, event.run) }))
              break
            case "change_plan":
              updateAssistant(assistantId, (m) => ({ ...m, changePlans: [...(m.changePlans ?? []), event.plan] }))
              break
            case "sap_auth_required":
              // The SAP session ended mid-answer: clear it and ask for the password,
              // so the next message works.
              void fetch(`/api/sap/${encodeURIComponent(event.systemId)}/auth`, { method: "DELETE" }).finally(() => {
                void requestSapSignIn({
                  systemId: event.systemId,
                  systemName: event.systemName,
                  message: `Your session on ${event.systemName} has ended. Sign in again, then resend your request.`,
                })
              })
              break
          }
        }
      } catch (error) {
        if (error instanceof SapAuthCancelledError) {
          updateAssistant(assistantId, (m) => ({
            ...m,
            status: "error",
            error: `Sign-in to ${error.systemName} was cancelled, so nothing was sent. Sign in, or choose "None" in the SAP system menu for a chat without SAP data.`,
          }))
        } else if (controller.signal.aborted) {
          updateAssistant(assistantId, (m) => ({ ...m, status: "stopped" }))
        } else {
          updateAssistant(assistantId, (m) => ({
            ...m,
            status: "error",
            error: error instanceof Error ? error.message : "The response could not be loaded.",
          }))
        }
      } finally {
        // A stream that ended without "done" (for example a dropped connection).
        setMessages((current) =>
          current.map((m) => (m.id === assistantId && m.status === "streaming" ? { ...m, status: "stopped" } : m))
        )
        abortRef.current = null
        setIsStreaming(false)
        // Refresh the history list (new chat, new order). After Stop the
        // server stores the partial answer once the request is cancelled, so
        // wait briefly for that. The optimistic sidebar entry stays until the
        // refreshed list contains the chat; the sidebar then ignores it.
        if (controller.signal.aborted) window.setTimeout(() => router.refresh(), 400)
        else router.refresh()
      }
    },
    [messages.length, router, sapSystemId, setPendingSession, updateAssistant]
  )

  const stop = React.useCallback(() => abortRef.current?.abort(), [])

  /** A change plan was approved or rejected: update its card and add SAP's outcome to the chat. */
  const onPlanUpdated = React.useCallback<PlanUpdateHandler>(
    (plan, note) => {
      setMessages((current) => {
        const updated = current.map((message) =>
          message.changePlans?.some((item) => item.id === plan.id)
            ? { ...message, changePlans: message.changePlans.map((item) => (item.id === plan.id ? plan : item)) }
            : message
        )
        return note
          ? [...updated, { id: note.id, role: "assistant", content: note.content, status: "done", modelUsed: "SAP change plan" }]
          : updated
      })
      if (note) router.refresh()
    },
    [router]
  )

  const changeSapSystem = (id: string | null) => {
    setSapSystemId(id)
    const system = sapSystems?.find((item) => item.id === id)
    if (system && !isEmpty) {
      toast.info(`Questions about ${businessAreaFor(system.servicePath).data} now go to ${system.name} (client ${system.sapClient}).`)
    }
  }

  const starters = area ? area.starters : STARTER_PROMPTS

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger aria-label="Toggle chat history" />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <h1 className="truncate text-sm font-medium">{isEmpty ? "New chat" : title}</h1>
      </header>

      <div className={cn("flex min-h-0 flex-1 flex-col", isEmpty && "items-center justify-center gap-6 overflow-y-auto px-4 pb-24")}>
        {isEmpty ? (
          <div className="grid gap-2 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">What can I help you with in SAP today?</h2>
            <p className="text-muted-foreground">
              {sapSystem && area
                ? `Look up and update ${area.data} in ${sapSystem.name} (client ${sapSystem.sapClient}, ${sapSystem.environment}). Every change needs your approval.`
                : "Ask about business processes, master data, orders and postings in plain business language. Pick an SAP system below to look up and change live data."}
            </p>
          </div>
        ) : (
          <ChatThread messages={messages} isStreaming={isStreaming} onPlanUpdated={onPlanUpdated} />
        )}

        {/* The same element in both states, so focus and the typed text survive the transition. */}
        <div className={cn("w-full max-w-3xl", !isEmpty && "mx-auto shrink-0 px-4 pb-4")}>
          <ClaudePromptInput
            value={input}
            onValueChange={setInput}
            onSubmit={send}
            onStop={stop}
            isStreaming={isStreaming}
            activeModel={activeModel}
            sapSystems={sapSystems}
            sapSystemId={sapSystemId}
            onSapSystemChange={changeSapSystem}
            placeholder={sapSystem && area ? `Ask about ${area.data} in ${sapSystem.name}…` : undefined}
            autoFocus
          />
          {!isEmpty ? (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Answers can be wrong. Check important details against your SAP system and documentation.
            </p>
          ) : null}
        </div>

        {isEmpty ? (
          <div className="flex max-w-3xl flex-wrap justify-center gap-2">
            {starters.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={!activeModel}
                onClick={() => send(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
