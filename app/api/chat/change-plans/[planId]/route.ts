import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getAuthSession } from "@/lib/auth/session"
import { prisma } from "@/lib/db"
import { deleteSapSession, readSapSession, writeSapSession } from "@/lib/sap-session"
import { OPERATION_LABELS, type ChangePlanView } from "@/lib/sap/agent-types"
import { planInclude, toChangePlanView } from "@/lib/sap/change-plans"
import { SapClient, SapSessionExpiredError, SapTransportError } from "@/lib/sap/client"
import { authRequiredResponse, sapError } from "@/lib/sap/odata"

type Context = { params: Promise<{ planId: string }> }

const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]) })

export type ChangePlanDecisionResponse =
  | { ok: true; plan: ChangePlanView; note: { id: string; content: string } | null }
  | { ok: false; error: string; plan?: ChangePlanView }

function json(body: ChangePlanDecisionResponse, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

/**
 * POST /api/chat/change-plans/:planId { decision: "approve" | "reject" }
 *
 * The only place where the chat writes to SAP, and only after the plan's
 * owner approves it. Uses the ETag read when the plan was made (If-Match,
 * never "*"), a fresh CSRF token, and the user's own SAP session. A 412 is
 * reported, not retried. The outcome is added to the chat as a message.
 */
export async function POST(request: Request, context: Context) {
  const authSession = await getAuthSession()
  if (!authSession) return sapError(401, "UNAUTHENTICATED", "Sign in to the application first.")

  const parsed = decisionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ ok: false, error: "decision must be approve or reject." }, 400)

  const { planId } = await context.params
  const plan = await prisma.sapChangePlan.findFirst({
    where: { id: planId, userId: authSession.user.id },
    include: { ...planInclude, sapSystem: true },
  })
  if (!plan) return json({ ok: false, error: "This change plan does not exist." }, 404)
  if (plan.status !== "PENDING") {
    return json({ ok: false, error: "This change plan has already been decided.", plan: toChangePlanView(plan) }, 409)
  }
  if (plan.expiresAt.getTime() < Date.now()) {
    const expired = await prisma.sapChangePlan.update({ where: { id: plan.id }, data: { status: "EXPIRED" }, include: planInclude })
    return json({ ok: false, error: "This change plan has expired. Ask the assistant to prepare it again.", plan: toChangePlanView(expired) }, 410)
  }

  const system = plan.sapSystem
  const approver = `${authSession.user.name} <${authSession.user.email}>`
  const decidedAt = new Date()
  const target = `${OPERATION_LABELS[plan.operation as ChangePlanView["operation"]]} \`${plan.path}\` in ${system.name} (client ${system.sapClient}, ${system.environment})`

  const addNote = async (content: string) => {
    if (!plan.chatId) return null
    const chat = await prisma.chatSession.findUnique({ where: { id: plan.chatId }, select: { id: true } })
    if (!chat) return null
    const note = await prisma.chatMessage.create({
      data: { sessionId: chat.id, role: "assistant", content, modelUsed: "SAP change plan" },
      select: { id: true, content: true },
    })
    await prisma.chatSession.update({ where: { id: chat.id }, data: { updatedAt: new Date() } })
    revalidatePath("/chat", "layout")
    return note
  }

  if (parsed.data.decision === "reject") {
    const rejected = await prisma.sapChangePlan.update({
      where: { id: plan.id },
      data: { status: "REJECTED", decidedBy: approver, decidedAt },
      include: planInclude,
    })
    const note = await addNote(`**Change plan rejected.** ${target} was not sent to SAP. Rejected by ${authSession.user.name} at ${decidedAt.toISOString()}.`)
    return json({ ok: true, plan: toChangePlanView(rejected), note })
  }

  if (!system.isActive) return json({ ok: false, error: `${system.name} is turned off in the SAP system settings.` }, 409)
  const sapSession = await readSapSession(system.id, authSession)
  if (!sapSession) return authRequiredResponse(system)

  // Claim the plan atomically, so a double click cannot write twice.
  const claimed = await prisma.sapChangePlan.updateMany({ where: { id: plan.id, status: "PENDING" }, data: { status: "EXECUTING" } })
  if (claimed.count === 0) return json({ ok: false, error: "This change plan is already being executed." }, 409)

  const client = new SapClient(system, sapSession, { userId: authSession.user.id, chatId: plan.chatId }, request.signal)
  let status: "EXECUTED" | "FAILED" = "FAILED"
  let resultStatus: number | null = null
  let resultMessage: string

  try {
    const response = await client.request({
      method: plan.method as "PATCH" | "POST" | "DELETE",
      path: plan.path,
      body: plan.payload ? (JSON.parse(plan.payload) as unknown) : undefined,
      ifMatch: plan.method === "POST" ? undefined : (plan.etag ?? undefined),
      toolName: "sap_change_plan",
    })
    resultStatus = response.status
    const messages = response.sapMessages.map((message) => `${message.code ? `${message.code}: ` : ""}${message.message}`)
    if (response.ok) {
      status = "EXECUTED"
      resultMessage = [`${plan.method === "POST" ? "Created" : plan.method === "DELETE" ? "Deleted" : "Updated"} (HTTP ${response.status}).`, ...messages].join(" ")
    } else if (response.status === 412) {
      resultMessage =
        "HTTP 412: the record was changed in SAP after this plan was prepared, so nothing was written. Ask the assistant to read the record again and prepare a new plan."
    } else {
      const error = response.error
      const details = error?.details.map((detail) => detail.message).filter(Boolean) ?? []
      resultMessage = [`HTTP ${response.status}${error?.code ? ` ${error.code}` : ""}: ${error?.message ?? "no details"}`, ...details].join(" · ")
    }
  } catch (error) {
    if (error instanceof SapSessionExpiredError) {
      // Rejected at sign-in, so nothing was written: the plan stays pending.
      await prisma.sapChangePlan.update({ where: { id: plan.id }, data: { status: "PENDING" } })
      await deleteSapSession(system.id)
      return authRequiredResponse(system, `Your session on ${system.name} has ended. Sign in again to execute the change.`)
    }
    resultMessage =
      error instanceof SapTransportError
        ? `${error.message} The outcome is unknown: read the record before preparing the change again.`
        : "The change could not be executed."
    if (!(error instanceof SapTransportError)) console.error("[change-plans] Execution failed", error)
  }

  const cookies = client.updatedCookies()
  if (cookies) await writeSapSession(authSession, system.id, { authHeader: sapSession.authHeader, sapCookies: cookies, createdAt: sapSession.createdAt })

  const updated = await prisma.sapChangePlan.update({
    where: { id: plan.id },
    data: { status, resultStatus, resultMessage, decidedBy: approver, decidedAt },
    include: planInclude,
  })

  const view = toChangePlanView(updated)
  const changes = view.diff.map((item) => `- ${item.label ? `${item.label} (\`${item.field}\`)` : `\`${item.field}\``}: ${item.current} → **${item.next}**`).join("\n")
  const note = await addNote(
    status === "EXECUTED"
      ? `**Change applied.** ${target}\n\n${changes}\n\n${resultMessage}\n\nApproved by ${authSession.user.name} at ${decidedAt.toISOString()}. SAP records the change under the signed-in SAP user.`
      : `**Change not applied.** ${target}\n\n${resultMessage}\n\nApproved by ${authSession.user.name} at ${decidedAt.toISOString()}.`
  )
  return json({ ok: true, plan: view, note })
}
