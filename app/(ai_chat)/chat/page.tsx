import { Suspense } from "react"
import { connection } from "next/server"

import { getActiveModelSummary } from "@/lib/ai/active-model"
import { getAuthSession } from "@/lib/auth/session"
import { loadChatSapSystems } from "@/lib/sap/systems"
import { ChatCanvasSkeleton } from "./_components/chat-skeletons"
import { NewChatView } from "./_components/new-chat-view"

export default function NewChatPage() {
  return (
    <Suspense fallback={<ChatCanvasSkeleton />}>
      <NewChat />
    </Suspense>
  )
}

async function NewChat() {
  await connection()
  const [activeModel, authSession] = await Promise.all([getActiveModelSummary(), getAuthSession()])
  const sap = authSession ? await loadChatSapSystems(authSession.user.id) : null
  return (
    <NewChatView activeModel={activeModel} sapSystems={sap?.systems ?? null} initialSapSystemId={sap?.lastUsedId ?? null} />
  )
}
