import { z } from "zod"

import type { ChangePlanView, ToolRun } from "@/lib/sap/agent-types"

export const CHAT_TITLE_MAX_LENGTH = 100
export const CHAT_MESSAGE_MAX_LENGTH = 32_000
export const DEFAULT_CHAT_TITLE = "New Chat"

export const chatRoleSchema = z.enum(["user", "assistant", "system"])
export type ChatRole = z.infer<typeof chatRoleSchema>

export const sessionIdSchema = z.string().trim().min(1, "A chat ID is required.").max(64)

/** Body of POST /api/chat. Omit sessionId to start a new chat. */
export const chatRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  message: z
    .string()
    .trim()
    .min(1, "The message is empty.")
    .max(CHAT_MESSAGE_MAX_LENGTH, `The message is longer than ${CHAT_MESSAGE_MAX_LENGTH} characters.`),
  /** SAP system whose product-data tools the model may use; null or absent for a plain chat. */
  sapSystemId: sessionIdSchema.nullish(),
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

export const renameChatSessionSchema = z.object({
  sessionId: sessionIdSchema,
  title: z
    .string()
    .trim()
    .min(1, "The title cannot be empty.")
    .max(CHAT_TITLE_MAX_LENGTH, `The title can have at most ${CHAT_TITLE_MAX_LENGTH} characters.`),
})

/**
 * Events sent by POST /api/chat as Server-Sent Events, one JSON object per
 * `data:` line.
 */
export type ChatStreamEvent =
  | { type: "session"; sessionId: string; title: string; isNew: boolean }
  | { type: "delta"; text: string }
  | { type: "done"; messageId: string | null; modelUsed: string }
  | { type: "error"; message: string }
  | { type: "tool_start"; run: ToolRun }
  | { type: "tool_end"; run: ToolRun }
  | { type: "change_plan"; plan: ChangePlanView }
  | { type: "sap_auth_required"; systemId: string; systemName: string; plainHttp?: boolean }

/** Title for a new chat: the first 50 characters of the first message, on one line. */
export function deriveChatTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim()
  if (!singleLine) return DEFAULT_CHAT_TITLE
  return singleLine.length > 50 ? `${singleLine.slice(0, 50).trimEnd()}…` : singleLine
}
