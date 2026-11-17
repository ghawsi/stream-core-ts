import { Suspense } from "react"
import { notFound } from "next/navigation"
import { connection } from "next/server"

import { getChatMessages } from "@/app/actions/chat"
import { getActiveModelSummary } from "@/lib/ai/active-model"
import { getAuthSession } from "@/lib/auth/session"
import { prisma } from "@/lib/db"
import type { AssistantMessageMetadata } from "@/lib/sap/agent-types"
import { loadChangePlanViews } from "@/lib/sap/change-plans"
import { loadChatSapSystems } from "@/lib/sap/systems"
import { ChatCanvasSkeleton } from "../_components/chat-skeletons"
import type { ChatUIMessage } from "../_components/chat-thread"
import { ChatView } from "../_components/chat-view"

export default function ChatSessionPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<ChatCanvasSkeleton />}>
      <ChatSession params={params} />
    </Suspense>
  )
}

function parseMetadata(value: string | null): AssistantMessageMetadata {
  if (!value) return {}
  try {
    return JSON.parse(value) as AssistantMessageMetadata
  } catch {
    return {}
  }
}

async function ChatSession({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await connection()

  const session = await prisma.chatSession.findUnique({ where: { id }, select: { id: true, title: true, sapSystemId: true } })
  if (!session) notFound()

  const [messages, activeModel, authSession] = await Promise.all([getChatMessages(session.id), getActiveModelSummary(), getAuthSession()])
  const userId = authSession?.user.id ?? null
  const sap = userId ? await loadChatSapSystems(userId) : null

  const metadata = new Map(messages.map((message) => [message.id, parseMetadata(message.metadata)]))
  // Change plans are shown with their current status, and only to their owner.
  const plans = await loadChangePlanViews(
    [...metadata.values()].flatMap((item) => item.changePlanIds ?? []),
    userId
  )

  const initialMessages: ChatUIMessage[] = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const meta = metadata.get(message.id) ?? {}
      return {
        id: message.id,
        role: message.role as ChatUIMessage["role"],
        content: message.content,
        status: "done",
        modelUsed: message.modelUsed,
        toolRuns: meta.toolRuns,
        changePlans: (meta.changePlanIds ?? []).flatMap((planId) => {
          const plan = plans.get(planId)
          return plan ? [plan] : []
        }),
      }
    })

  const boundSystem = sap?.systems.find((system) => system.id === session.sapSystemId) ?? null

  return (
    <ChatView
      key={session.id}
      sessionId={session.id}
      title={session.title}
      initialMessages={initialMessages}
      activeModel={activeModel}
      sapSystems={sap?.systems ?? null}
      initialSapSystemId={boundSystem?.id ?? null}
    />
  )
}
