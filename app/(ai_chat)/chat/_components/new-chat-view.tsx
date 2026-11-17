"use client"

import * as React from "react"

import type { ActiveModelSummary } from "@/lib/ai/active-model"
import { ChatView } from "./chat-view"
import { useChatUI } from "./chat-ui-context"
import type { SapSystemOption } from "./claude-prompt-input"

/** The empty chat at /chat. "New chat" changes the key, which resets it. */
export function NewChatView({
  activeModel,
  sapSystems,
  initialSapSystemId,
}: {
  activeModel: ActiveModelSummary | null
  sapSystems: SapSystemOption[] | null
  initialSapSystemId: string | null
}) {
  const { newChatKey } = useChatUI()
  // Next.js keeps visited pages mounted but hidden (React <Activity>). Hiding
  // runs effect cleanups, so a chat that moved on to /chat/<id> leaves a fresh,
  // empty view behind for the next visit to /chat.
  const [visit, setVisit] = React.useState(0)
  React.useEffect(() => () => setVisit((count) => count + 1), [])
  return (
    <ChatView
      key={`${newChatKey}-${visit}`}
      activeModel={activeModel}
      sapSystems={sapSystems}
      initialSapSystemId={initialSapSystemId}
    />
  )
}
