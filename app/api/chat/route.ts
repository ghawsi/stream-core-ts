import { revalidatePath } from "next/cache"

import { getActiveProviderConfig } from "@/lib/ai/active-model"
import { ProviderError, streamChatCompletion, type ProviderMessage } from "@/lib/ai/providers"
import { runSapAgent } from "@/lib/ai/sap-agent"
import { buildSapAgentPrompt } from "@/lib/ai/sap-agent-prompt"
import { buildBusinessChatPrompt } from "@/lib/ai/system-prompt"
import { getAuthSession } from "@/lib/auth/session"
import { decrypt } from "@/lib/crypto"
import { prisma } from "@/lib/db"
import { readSapSession, type SapSessionPayload } from "@/lib/sap-session"
import type { AssistantMessageMetadata, ToolRun } from "@/lib/sap/agent-types"
import { SapClient } from "@/lib/sap/client"
import { authRequiredResponse } from "@/lib/sap/odata"
import { findOwnedSapSystem } from "@/lib/sap/systems"
import { chatRequestSchema, DEFAULT_CHAT_TITLE, deriveChatTitle, type ChatStreamEvent } from "@/lib/validations/chat"

/** Number of earlier messages sent to the model with each request. */
const HISTORY_LIMIT = 40

function jsonError(status: number, error: string, code: string, extra?: Record<string, unknown>) {
  return Response.json({ error, code, ...extra }, { status })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request.", "INVALID_REQUEST", {
      issues: parsed.error.issues,
    })
  }
  const { sessionId: requestedSessionId, message, sapSystemId } = parsed.data

  const config = await getActiveProviderConfig()
  if (!config) {
    return jsonError(
      400,
      "No active AI model is configured. Add a provider and activate it in /settings/ai.",
      "NO_ACTIVE_PROVIDER"
    )
  }

  let apiKey: string
  try {
    apiKey = decrypt(config.apiKeyEncrypted)
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : "The API key could not be decrypted.", "DECRYPT_FAILED")
  }

  // SAP data tools: only for a signed-in user, on their own active
  // system, with a valid SAP session. Checked before anything is stored, so the
  // browser can sign in to SAP and resend the same message.
  let sap: {
    system: NonNullable<Awaited<ReturnType<typeof findOwnedSapSystem>>>
    sapSession: SapSessionPayload
    userId: string
  } | null = null
  if (sapSystemId) {
    const authSession = await getAuthSession()
    if (!authSession) return jsonError(401, "Sign in to use SAP data in the chat.", "UNAUTHENTICATED")
    const system = await findOwnedSapSystem(sapSystemId, authSession.user.id)
    if (!system) return jsonError(404, "This SAP system does not exist.", "SAP_SYSTEM_NOT_FOUND")
    if (!system.isActive) return jsonError(409, `${system.name} is turned off in the SAP system settings.`, "SAP_SYSTEM_INACTIVE")
    const sapSession = await readSapSession(system.id, authSession)
    if (!sapSession) return authRequiredResponse(system)
    sap = { system, sapSession, userId: authSession.user.id }
  }

  // Load or create the session, then store the user's message.
  let session: { id: string; title: string }
  let isNew = false
  if (requestedSessionId) {
    const existing = await prisma.chatSession.findUnique({
      where: { id: requestedSessionId },
      select: { id: true, title: true, _count: { select: { messages: true } } },
    })
    if (!existing) return jsonError(404, "This chat no longer exists.", "SESSION_NOT_FOUND")
    session = existing
    const retitle = existing._count.messages === 0 && existing.title === DEFAULT_CHAT_TITLE
    if (retitle || sap) {
      session = await prisma.chatSession.update({
        where: { id: existing.id },
        data: { ...(retitle ? { title: deriveChatTitle(message) } : {}), ...(sap ? { sapSystemId: sap.system.id } : {}) },
        select: { id: true, title: true },
      })
    }
  } else {
    session = await prisma.chatSession.create({
      data: { title: deriveChatTitle(message), sapSystemId: sap?.system.id ?? null },
      select: { id: true, title: true },
    })
    isNew = true
  }

  await prisma.$transaction([
    prisma.chatMessage.create({ data: { sessionId: session.id, role: "user", content: message } }),
    prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } }),
  ])

  const history = await prisma.chatMessage.findMany({
    where: { sessionId: session.id, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  })
  const messages = history.reverse().filter((m) => m.content.trim()) as ProviderMessage[]
  // Providers expect the conversation to start with a user turn.
  while (messages.length > 0 && messages[0].role !== "user") messages.shift()

  // The server's local date (YYYY-MM-DD), so "this month" means the user's month.
  const today = new Date().toLocaleDateString("en-CA")
  const upstream = new AbortController()
  const encoder = new TextEncoder()
  let content = ""
  let toolRuns: ToolRun[] = []
  let changePlanIds: string[] = []
  let saved: Promise<string | null> | null = null

  // Stores whatever the model produced, including a partial answer after Stop
  // or a dropped connection. Runs at most once.
  const persistAssistantMessage = () => {
    saved ??= (async () => {
      try {
        let messageId: string | null = null
        if (content.trim() || toolRuns.length > 0) {
          const metadata: AssistantMessageMetadata | null =
            toolRuns.length || changePlanIds.length ? { toolRuns, changePlanIds } : null
          const created = await prisma.chatMessage.create({
            data: {
              sessionId: session.id,
              role: "assistant",
              content,
              modelUsed: config.modelName,
              metadata: metadata ? JSON.stringify(metadata) : null,
            },
            select: { id: true },
          })
          messageId = created.id
        }
        await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
        revalidatePath("/chat", "layout")
        return messageId
      } catch (error) {
        console.error("[api/chat] Failed to store the assistant message", error)
        return null
      }
    })()
    return saved
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: ChatStreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          open = false
        }
      }

      send({ type: "session", sessionId: session.id, title: session.title, isNew })

      try {
        if (sap) {
          const { system } = sap
          // Tool runs are tracked live so that Stop still stores what already happened.
          const liveRuns = new Map<string, ToolRun>()
          const client = new SapClient(system, sap.sapSession, { userId: sap.userId, chatId: session.id }, upstream.signal)
          const result = await runSapAgent({
            config: { ...config, apiKey },
            system: buildSapAgentPrompt(system, today),
            history: messages.map((m) => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content, toolCalls: [] })),
            toolContext: {
              client,
              system: { id: system.id, name: system.name, sapClient: system.sapClient, environment: system.environment },
              userId: sap.userId,
              chatId: session.id,
            },
            signal: upstream.signal,
            emit: (event) => {
              switch (event.type) {
                case "delta":
                  content += event.text
                  send(event)
                  break
                case "tool_start":
                case "tool_end":
                  liveRuns.set(event.run.id, event.run)
                  toolRuns = [...liveRuns.values()]
                  send(event)
                  break
                case "change_plan":
                  changePlanIds = [...changePlanIds, event.plan.id]
                  send(event)
                  break
                case "sap_auth_required":
                  send({ type: "sap_auth_required", systemId: system.id, systemName: system.name })
                  break
              }
            },
          })
          content = result.text
          toolRuns = result.toolRuns
          changePlanIds = result.changePlanIds
        } else {
          for await (const text of streamChatCompletion({
            config: { ...config, apiKey },
            system: buildBusinessChatPrompt(today),
            messages,
            signal: upstream.signal,
          })) {
            content += text
            send({ type: "delta", text })
          }
        }
        const messageId = await persistAssistantMessage()
        send({ type: "done", messageId, modelUsed: config.modelName })
      } catch (error) {
        await persistAssistantMessage()
        if (!upstream.signal.aborted) {
          const message =
            error instanceof ProviderError
              ? error.message
              : "The response could not be generated. Check the provider configuration in /settings/ai."
          if (!(error instanceof ProviderError)) console.error("[api/chat] Streaming failed", error)
          send({ type: "error", message })
        }
      } finally {
        if (open) {
          open = false
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        }
      }
    },
    cancel() {
      // The client pressed Stop or went away: stop the provider request. The
      // loop in start() then stores the partial answer.
      upstream.abort()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
