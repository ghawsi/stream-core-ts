/**
 * Shapes shared by the chat server and the chat UI for SAP tool runs and
 * change plans. No server-only imports here.
 */

export type ToolRunRequest = {
  method: string
  /** Path and query relative to the service root (no host, no credentials). */
  path: string
  status: number
  durationMs: number
  error?: string
}

export type ToolRun = {
  id: string
  tool: string
  /** e.g. "Querying SAP S/4HANA: Product('EF-MAT')". */
  label: string
  status: "running" | "ok" | "error"
  args: Record<string, unknown>
  requests: ToolRunRequest[]
  summary?: string
}

export type ChangePlanDiff = { field: string; label?: string; current: string; next: string }

export type ChangePlanStatus = "PENDING" | "EXECUTING" | "REJECTED" | "EXECUTED" | "FAILED" | "EXPIRED"

export type ChangePlanView = {
  id: string
  operation: "UPDATE" | "CREATE" | "FLAG_DELETION" | "DELETE"
  method: string
  entitySet: string
  path: string
  reason: string
  diff: ChangePlanDiff[]
  systemName: string
  sapClient: string
  environment: string
  status: ChangePlanStatus
  resultStatus: number | null
  resultMessage: string | null
  decidedBy: string | null
  decidedAt: string | null
  expiresAt: string
}

/** Stored in ChatMessage.metadata for assistant messages. */
export type AssistantMessageMetadata = {
  toolRuns?: ToolRun[]
  changePlanIds?: string[]
}

export const OPERATION_LABELS: Record<ChangePlanView["operation"], string> = {
  UPDATE: "Update",
  CREATE: "Create",
  FLAG_DELETION: "Flag for deletion",
  DELETE: "Delete",
}
