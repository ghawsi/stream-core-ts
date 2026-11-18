import { Suspense } from "react"
import type { Metadata } from "next"
import { connection } from "next/server"
import { SidebarInset, SidebarProvider } from "@boilerplate/ui"

import { getChatSessions } from "@/app/actions/chat"
import { getActiveModelSummary } from "@/lib/ai/active-model"
import { ChatSidebar } from "./_components/chat-sidebar"
import { ChatSidebarSkeleton } from "./_components/chat-skeletons"
import { ChatUIProvider } from "./_components/chat-ui-context"

export const metadata: Metadata = {
  title: "SAP S/4HANA AI Chat",
  description: "Ask about SAP S/4HANA business processes and work with live business data in plain business language.",
}

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    // Boxed inside the app shell's panel: `relative` here and `absolute h-full`
    // on the Sidebar keep the history beside the rail instead of fixed to the
    // viewport edge.
    <SidebarProvider className="relative h-full min-h-0 overflow-hidden">
      <ChatUIProvider>
        <Suspense fallback={<ChatSidebarSkeleton />}>
          <ChatSidebarData />
        </Suspense>
        <SidebarInset className="min-h-0 overflow-hidden">{children}</SidebarInset>
      </ChatUIProvider>
    </SidebarProvider>
  )
}

async function ChatSidebarData() {
  // SQLite queries run synchronously under the hood; connection() makes them
  // run per request instead of being prerendered.
  await connection()
  const [sessions, activeModel] = await Promise.all([getChatSessions(), getActiveModelSummary()])
  return <ChatSidebar sessions={sessions} activeModel={activeModel} />
}
