import { getAuthSession } from "@/lib/auth/session"
import { decrypt } from "@/lib/crypto"
import { prisma } from "@/lib/db"
import { listProviderModels, ProviderError } from "@/lib/ai/providers"
import type { ProviderModel } from "@/lib/ai/provider-catalog"
import { listModelsSchema } from "@/lib/validations/ai-config"

export type ListModelsResponse = { ok: true; models: ProviderModel[] } | { ok: false; error: string }

/**
 * POST /api/settings/ai/models { provider, baseUrl, apiKey?, configId? }
 *
 * Lists the models the provider offers: installed models for Ollama
 * (/api/tags), the key's models for OpenAI, Anthropic and OpenAI-compatible
 * servers (/models). An empty apiKey with a configId uses the saved key.
 */
export async function POST(request: Request) {
  if (!(await getAuthSession())) {
    return Response.json({ ok: false, error: "Sign in to manage AI models." } satisfies ListModelsResponse, { status: 401 })
  }
  const parsed = listModelsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." } satisfies ListModelsResponse, {
      status: 400,
    })
  }
  const { configId, provider, baseUrl, apiKey: typedKey } = parsed.data

  let apiKey = typedKey
  if (!apiKey && configId) {
    const saved = await prisma.aiProviderConfig.findUnique({ where: { id: configId }, select: { apiKeyEncrypted: true } })
    if (saved) {
      try {
        apiKey = decrypt(saved.apiKeyEncrypted)
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message } satisfies ListModelsResponse, { status: 500 })
      }
    }
  }

  try {
    const models = await listProviderModels({ provider, baseUrl: baseUrl || null, apiKey, modelName: "" })
    return Response.json({ ok: true, models } satisfies ListModelsResponse)
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json({ ok: false, error: error.message } satisfies ListModelsResponse)
    }
    console.error("[api/settings/ai/models] Unexpected error", error)
    return Response.json({ ok: false, error: "The model list could not be loaded." } satisfies ListModelsResponse, { status: 500 })
  }
}
