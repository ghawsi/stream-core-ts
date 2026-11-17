"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useSidebar } from "@boilerplate/ui"

export type PendingChatSession = { id: string; title: string; updatedAt: Date }

type ChatUIContextValue = {
  /** Changes every time the user starts a new chat; used as the key of the new-chat view. */
  newChatKey: number
  startNewChat: () => void
  /**
   * A chat created by the request that is streaming now. The sidebar shows it
   * at once; the server list replaces it after the next refresh.
   */
  pendingSession: PendingChatSession | null
  setPendingSession: (session: PendingChatSession | null) => void
}

const ChatUIContext = React.createContext<ChatUIContextValue | null>(null)

/** Lives in the chat layout, inside SidebarProvider, so it survives navigation between chats. */
export function ChatUIProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()
  const [newChatKey, setNewChatKey] = React.useState(0)
  const [pendingSession, setPendingSession] = React.useState<PendingChatSession | null>(null)

  const startNewChat = React.useCallback(() => {
    // A new key resets the view even when the URL is already /chat, for
    // example while the first answer of a new chat is still streaming.
    setNewChatKey((key) => key + 1)
    if (isMobile) setOpenMobile(false)
    router.push("/chat")
  }, [isMobile, router, setOpenMobile])

  const value = React.useMemo(
    () => ({ newChatKey, startNewChat, pendingSession, setPendingSession }),
    [newChatKey, startNewChat, pendingSession]
  )
  return <ChatUIContext.Provider value={value}>{children}</ChatUIContext.Provider>
}

export function useChatUI() {
  const context = React.useContext(ChatUIContext)
  if (!context) throw new Error("useChatUI must be used inside ChatUIProvider.")
  return context
}
