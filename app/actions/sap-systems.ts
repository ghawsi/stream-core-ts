"use server"

import { revalidatePath } from "next/cache"

import { getAuthSession } from "@/lib/auth/session"
import { prisma } from "@/lib/db"
import { deleteAllSapSessions, deleteSapSession } from "@/lib/sap-session"
import { sapSystemSchema, type SapSystemInput } from "@/lib/validations/sap-system"
import { fieldErrorsOf, type FieldErrors } from "@/lib/validations/ai-config"

export type SapSystemActionResult = { ok: true; id?: string } | { ok: false; error: string; fieldErrors?: FieldErrors }

const PAGE = "/settings/sap/systems"
const signedOut: SapSystemActionResult = { ok: false, error: "Your session has ended. Sign in again." }
const notFound: SapSystemActionResult = { ok: false, error: "This SAP system no longer exists." }

export async function createSapSystem(input: SapSystemInput): Promise<SapSystemActionResult> {
  const authSession = await getAuthSession()
  if (!authSession) return signedOut
  const parsed = sapSystemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) }

  const created = await prisma.sapSystem.create({
    data: { ...parsed.data, userId: authSession.user.id },
    select: { id: true },
  })
  revalidatePath(PAGE)
  return { ok: true, id: created.id }
}

export async function updateSapSystem(id: string, input: SapSystemInput): Promise<SapSystemActionResult> {
  const authSession = await getAuthSession()
  if (!authSession) return signedOut
  const parsed = sapSystemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) }

  const existing = await prisma.sapSystem.findFirst({ where: { id, userId: authSession.user.id } })
  if (!existing) return notFound

  await prisma.sapSystem.update({ where: { id: existing.id }, data: parsed.data })

  // A session belongs to one target. When the target changes, the stored
  // credentials must not be sent to the new host or client.
  const targetChanged =
    existing.baseUrl !== parsed.data.baseUrl ||
    existing.sapClient !== parsed.data.sapClient ||
    existing.servicePath !== parsed.data.servicePath
  if (targetChanged || !parsed.data.isActive) await deleteSapSession(existing.id)

  revalidatePath(PAGE)
  return { ok: true, id: existing.id }
}

export async function deleteSapSystem(id: string): Promise<SapSystemActionResult> {
  const authSession = await getAuthSession()
  if (!authSession) return signedOut
  const { count } = await prisma.sapSystem.deleteMany({ where: { id, userId: authSession.user.id } })
  if (count === 0) return notFound
  await deleteSapSession(id)
  revalidatePath(PAGE)
  return { ok: true }
}

/** Ends the SAP session of one system; the system configuration stays. */
export async function disconnectSapSystem(id: string): Promise<SapSystemActionResult> {
  const authSession = await getAuthSession()
  if (!authSession) return signedOut
  const system = await prisma.sapSystem.findFirst({ where: { id, userId: authSession.user.id }, select: { id: true } })
  if (!system) return notFound
  await deleteSapSession(system.id)
  revalidatePath(PAGE)
  return { ok: true }
}

/** Ends every SAP session in this browser. */
export async function disconnectAllSapSystems(): Promise<SapSystemActionResult> {
  const authSession = await getAuthSession()
  if (!authSession) return signedOut
  await deleteAllSapSessions()
  revalidatePath(PAGE)
  return { ok: true }
}
