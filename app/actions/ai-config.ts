"use server"

import { revalidatePath } from "next/cache"

import { getAuthSession } from "@/lib/auth/session"
import { decrypt, encrypt, maskApiKey } from "@/lib/crypto"
import { prisma } from "@/lib/db"
import { aiConfigSchema, fieldErrorsOf, type AiConfigInput, type FieldErrors } from "@/lib/validations/ai-config"
import { sessionIdSchema } from "@/lib/validations/chat"

/** A saved configuration as the browser may see it: the key only masked. */
export type AiConfigSummary = {
  id: string
  name: string
  provider: string
  baseUrl: string | null
  apiVersion: string | null
  modelName: string
  temperature: number
  topP: number | null
  maxTokens: number
  timeoutSeconds: number
  isActive: boolean
  maskedApiKey: string
  updatedAt: Date
}

export type AiConfigActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors }

const idSchema = sessionIdSchema // same shape: a cuid of at most 64 characters

function revalidate() {
  revalidatePath("/settings/ai")
  // The chat shows the active model in the sidebar and the input box.
  revalidatePath("/chat", "layout")
}

const SIGNED_OUT: AiConfigActionResult = { ok: false, error: "Sign in to change AI model settings." }

/** AI settings hold API keys for the whole application: only signed-in users may read or change them. */
async function signedIn() {
  return (await getAuthSession()) !== null
}

function failure(error: unknown): AiConfigActionResult {
  return { ok: false, error: error instanceof Error ? error.message : "The configuration could not be saved." }
}

export async function listAiConfigs(): Promise<AiConfigSummary[]> {
  if (!(await signedIn())) return []
  const configs = await prisma.aiProviderConfig.findMany({
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      provider: true,
      baseUrl: true,
      apiVersion: true,
      modelName: true,
      temperature: true,
      topP: true,
      maxTokens: true,
      timeoutSeconds: true,
      isActive: true,
      updatedAt: true,
      apiKeyEncrypted: true,
    },
  })
  return configs.map(({ apiKeyEncrypted, ...config }) => {
    let maskedApiKey: string
    try {
      maskedApiKey = maskApiKey(decrypt(apiKeyEncrypted))
    } catch {
      maskedApiKey = "Cannot be read"
    }
    return { ...config, maskedApiKey }
  })
}

export async function createAiConfig(input: AiConfigInput): Promise<AiConfigActionResult> {
  if (!(await signedIn())) return SIGNED_OUT
  const parsed = aiConfigSchema("create").safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) }
  }
  const { apiKey, baseUrl, apiVersion, ...values } = parsed.data

  try {
    const apiKeyEncrypted = encrypt(apiKey)
    const created = await prisma.$transaction(async (tx) => {
      // Only one configuration can be active.
      if (values.isActive) await tx.aiProviderConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
      return tx.aiProviderConfig.create({
        data: {
          ...values,
          baseUrl: baseUrl || null,
          apiVersion: values.provider === "AZURE_OPENAI" ? apiVersion || null : null,
          apiKeyEncrypted,
        },
        select: { id: true },
      })
    })
    revalidate()
    return { ok: true, id: created.id }
  } catch (error) {
    return failure(error)
  }
}

export async function updateAiConfig(id: string, input: AiConfigInput): Promise<AiConfigActionResult> {
  if (!(await signedIn())) return SIGNED_OUT
  const configId = idSchema.safeParse(id)
  if (!configId.success) return { ok: false, error: "Invalid configuration ID." }
  const parsed = aiConfigSchema("update").safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) }
  }
  const { apiKey, baseUrl, apiVersion, ...values } = parsed.data

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.aiProviderConfig.findUnique({ where: { id: configId.data }, select: { id: true } })
      if (!existing) throw new Error("This configuration no longer exists.")
      if (values.isActive) {
        await tx.aiProviderConfig.updateMany({ where: { isActive: true, NOT: { id: configId.data } }, data: { isActive: false } })
      }
      await tx.aiProviderConfig.update({
        where: { id: configId.data },
        data: {
          ...values,
          baseUrl: baseUrl || null,
          apiVersion: values.provider === "AZURE_OPENAI" ? apiVersion || null : null,
          // The stored key is replaced only when a new one was typed.
          ...(apiKey ? { apiKeyEncrypted: encrypt(apiKey) } : {}),
        },
      })
    })
    revalidate()
    return { ok: true, id: configId.data }
  } catch (error) {
    return failure(error)
  }
}

export async function activateAiConfig(id: string): Promise<AiConfigActionResult> {
  if (!(await signedIn())) return SIGNED_OUT
  const configId = idSchema.safeParse(id)
  if (!configId.success) return { ok: false, error: "Invalid configuration ID." }
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.aiProviderConfig.findUnique({ where: { id: configId.data }, select: { id: true } })
      if (!existing) throw new Error("This configuration no longer exists.")
      await tx.aiProviderConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
      await tx.aiProviderConfig.update({ where: { id: configId.data }, data: { isActive: true } })
    })
    revalidate()
    return { ok: true, id: configId.data }
  } catch (error) {
    return failure(error)
  }
}

export async function deleteAiConfig(id: string): Promise<AiConfigActionResult> {
  if (!(await signedIn())) return SIGNED_OUT
  const configId = idSchema.safeParse(id)
  if (!configId.success) return { ok: false, error: "Invalid configuration ID." }
  await prisma.aiProviderConfig.deleteMany({ where: { id: configId.data } })
  revalidate()
  return { ok: true, id: configId.data }
}
