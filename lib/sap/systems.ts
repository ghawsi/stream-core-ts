import { prisma } from "@/lib/db"

/** The system with this ID if it belongs to the user; null otherwise (also for other users' IDs). */
export async function findOwnedSapSystem(systemId: string, userId: string) {
  if (!systemId || systemId.length > 64) return null
  return prisma.sapSystem.findFirst({ where: { id: systemId, userId } })
}

export type SapSystemOptionRow = { id: string; name: string; sapClient: string; environment: string; isActive: boolean }

/** The user's SAP systems for the chat's system picker, and the one used in their latest SAP chat. */
export async function loadChatSapSystems(userId: string): Promise<{ systems: SapSystemOptionRow[]; lastUsedId: string | null }> {
  const systems = await prisma.sapSystem.findMany({
    where: { userId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, sapClient: true, environment: true, isActive: true },
  })
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
