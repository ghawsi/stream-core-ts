import { getAuthSession } from "@/lib/auth/session"
import { decrypt } from "@/lib/crypto"
import { prisma } from "@/lib/db"
import { ProviderError, testProviderConnection } from "@/lib/ai/providers"
import { fieldErrorsOf, testConnectionSchema } from "@/lib/validations/ai-config"

export type TestConnectionResponse =
  | { ok: true; latencyMs: number; reply: string; message: string }
  | { ok: false; error: string; status?: number; fieldErrors?: Partial<Record<string, string[]>> }

/**
 * POST /api/settings/ai/test: sends "Reply with OK" (5 output tokens at most)
 * with the configuration from the form. The key comes from the form, or, when
 * the form leaves it empty while editing, from the saved configuration.
 */
export async function POST(request: Request) {
  // The test sends requests to any URL from the server: signed-in users only.
  if (!(await getAuthSession())) {
    return Response.json({ ok: false, error: "Sign in to test AI models." } satisfies TestConnectionResponse, { status: 401 })
  }
  const body = await request.json().catch(() => null)
  const parsed = testConnectionSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) } satisfies TestConnectionResponse,
      { status: 400 }
    )
  }
  const { configId, apiKey: typedKey, ...connection } = parsed.data

  let apiKey = typedKey
  try {
    if (!apiKey && configId) {
      const saved = await prisma.aiProviderConfig.findUnique({ where: { id: configId }, select: { apiKeyEncrypted: true } })
      if (!saved) {
        return Response.json({ ok: false, error: "This configuration no longer exists." } satisfies TestConnectionResponse, { status: 404 })
      }
      apiKey = decrypt(saved.apiKeyEncrypted)
    }
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "The saved key could not be read." } satisfies TestConnectionResponse,
      { status: 500 }
    )
  }

  try {
    const { latencyMs, reply } = await testProviderConnection({
      ...connection,
      baseUrl: connection.baseUrl || null,
      apiVersion: connection.apiVersion || null,
      apiKey,
    })
    return Response.json({
      ok: true,
      latencyMs,
      reply,
      message: `Connected successfully in ${latencyMs}ms`,
    } satisfies TestConnectionResponse)
  } catch (error) {
    if (error instanceof ProviderError) {
      // 200 with ok: false: the test itself worked; the provider refused.
      return Response.json({ ok: false, error: error.message, status: error.status } satisfies TestConnectionResponse)
    }
    console.error("[api/settings/ai/test] Unexpected error", error)
    return Response.json({ ok: false, error: "The test could not be run." } satisfies TestConnectionResponse, { status: 500 })
  }
}
