import { prisma } from "@/lib/db"
import { usesPlainHttp } from "@/lib/sap/odata"

/** The system with this ID if it belongs to the user; null otherwise (also for other users' IDs). */
export async function findOwnedSapSystem(systemId: string, userId: string) {
  if (!systemId || systemId.length > 64) return null
  return prisma.sapSystem.findFirst({ where: { id: systemId, userId } })
}

export type SapSystemOptionRow = {
  id: string
  name: string
  sapClient: string
  environment: string
  isActive: boolean
  /** Tells the chat which business area the connected API covers (products, sales orders…). */
  servicePath: string
  /** Reached over unencrypted http; the host name itself stays on the server. */
  plainHttp: boolean
}

/** The user's SAP systems for the chat's system picker, and the one used in their latest SAP chat. */
export async function loadChatSapSystems(userId: string): Promise<{ systems: SapSystemOptionRow[]; lastUsedId: string | null }> {
  const rows = await prisma.sapSystem.findMany({
    where: { userId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, sapClient: true, environment: true, isActive: true, servicePath: true, baseUrl: true },
  })
  const systems = rows.map(({ baseUrl, ...system }) => ({ ...system, plainHttp: usesPlainHttp(baseUrl) }))
  const active = systems.filter((system) => system.isActive).map((system) => system.id)
  const lastChat =
    active.length > 0
      ? await prisma.chatSession.findFirst({
          where: { sapSystemId: { in: active } },
          orderBy: { updatedAt: "desc" },
          select: { sapSystemId: true },
        })
      : null
  return { systems, lastUsedId: lastChat?.sapSystemId ?? null }
}
