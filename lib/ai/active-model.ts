import { prisma } from "@/lib/db"
import { isAiProvider, PROVIDER_LABELS } from "@/lib/ai/providers"

/** What the UI may know about the active provider. Never contains the key. */
export type ActiveModelSummary = {
  id: string
  name: string
  modelName: string
  provider: string
  providerLabel: string
}

export async function getActiveProviderConfig() {
  return prisma.aiProviderConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  })
}

export async function getActiveModelSummary(): Promise<ActiveModelSummary | null> {
  const config = await prisma.aiProviderConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, modelName: true, provider: true },
  })
  if (!config) return null
  return {
    ...config,
    providerLabel: isAiProvider(config.provider) ? PROVIDER_LABELS[config.provider] : config.provider,
  }
}
