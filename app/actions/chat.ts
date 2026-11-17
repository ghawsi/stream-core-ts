"use server"

import { revalidatePath } from "next/cache"

import { prisma } from "@/lib/db"
import { renameChatSessionSchema, sessionIdSchema, type ChatRole } from "@/lib/validations/chat"

export type ChatSessionSummary = {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export type ChatMessageRecord = {
  id: string
  role: ChatRole
  content: string
  modelUsed: string | null
  /** JSON (AssistantMessageMetadata): SAP tool runs and change plan IDs. */
  metadata: string | null
  createdAt: Date
}

export type ActionResult = { ok: true } | { ok: false; error: string }

/** All chats, most recently active first. */
export async function getChatSessions(): Promise<ChatSessionSummary[]> {
  return prisma.chatSession.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  })
}

/** Messages of one chat in the order they were written. Empty if the chat does not exist. */
export async function getChatMessages(sessionId: string): Promise<ChatMessageRecord[]> {
  const id = sessionIdSchema.safeParse(sessionId)
  if (!id.success) return []
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: id.data },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, modelUsed: true, metadata: true, createdAt: true },
  })
  return messages as ChatMessageRecord[]
}

export async function renameChatSession(sessionId: string, title: string): Promise<ActionResult> {
  const parsed = renameChatSessionSchema.safeParse({ sessionId, title })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid title." }

  const existing = await prisma.chatSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { updatedAt: true },
  })
  if (!existing) return { ok: false, error: "This chat no longer exists." }

  await prisma.chatSession.update({
    where: { id: parsed.data.sessionId },
    // Keep updatedAt so that renaming does not move the chat to the top of the list.
    data: { title: parsed.data.title, updatedAt: existing.updatedAt },
  })

  revalidatePath("/chat", "layout")
  return { ok: true }
}

export async function deleteChatSession(sessionId: string): Promise<ActionResult> {
  const id = sessionIdSchema.safeParse(sessionId)
  if (!id.success) return { ok: false, error: "Invalid chat ID." }

  // Messages are removed by the cascade on ChatMessage.sessionId.
  await prisma.chatSession.deleteMany({ where: { id: id.data } })

  revalidatePath("/chat", "layout")
  return { ok: true }
}
