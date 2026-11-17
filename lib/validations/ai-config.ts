import { z } from "zod"

import { AI_PROVIDERS, API_KEY_OPTIONAL, BASE_URL_REQUIRED } from "@/lib/ai/provider-catalog"

const AI_CONFIG_TOP_P = 1

export const AI_CONFIG_DEFAULTS = {
  temperature: 0.1,
  maxTokens: 4096,
  topP: AI_CONFIG_TOP_P,
  timeoutSeconds: 60,
} as const

const httpUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** Fields that decide how a request reaches the provider. Shared by save and test. */
const connectionShape = {
  provider: z.enum(AI_PROVIDERS, { error: "Choose a provider." }),
  baseUrl: z.string().trim().max(500, "The URL is too long.").default(""),
  apiVersion: z.string().trim().max(40, "The API version is too long.").default(""),
  /** Plain-text key as typed. Empty on edit means "keep the stored key". */
  apiKey: z.string().trim().max(2000, "The API key is too long.").default(""),
  modelName: z.string().trim().min(1, "Enter a model or deployment name.").max(200, "The model name is too long."),
  temperature: z.coerce.number().min(0, "Use a value from 0.0 to 1.0.").max(1, "Use a value from 0.0 to 1.0."),
  topP: z.coerce.number().gt(0, "Use a value above 0 and at most 1.").max(1, "Use a value above 0 and at most 1.").default(AI_CONFIG_TOP_P),
  maxTokens: z.coerce.number().int("Use a whole number.").min(1, "Use at least 1 token.").max(200_000, "Use at most 200,000 tokens."),
  timeoutSeconds: z.coerce.number().int("Use a whole number.").min(5, "Use at least 5 seconds.").max(600, "Use at most 600 seconds."),
}

type ConnectionFields = {
  provider: (typeof AI_PROVIDERS)[number]
  baseUrl: string
  apiVersion: string
  apiKey: string
}

function checkConnection(value: ConnectionFields, ctx: z.RefinementCtx, keyRequired: boolean) {
  if (value.baseUrl && !httpUrl(value.baseUrl)) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter a full URL starting with https:// or http://." })
  } else if (!value.baseUrl && BASE_URL_REQUIRED.has(value.provider)) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "This provider needs a base URL." })
  }
  if (value.provider === "AZURE_OPENAI" && !value.apiVersion) {
    ctx.addIssue({ code: "custom", path: ["apiVersion"], message: "Azure OpenAI needs an API version, for example 2024-10-21." })
  }
  // Ollama and local OpenAI-compatible servers (vLLM, LM Studio) run without a key.
  if (keyRequired && !value.apiKey && !API_KEY_OPTIONAL.has(value.provider)) {
    ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Enter the API key." })
  }
}

/** Create: the key is required. Update: an empty key keeps the stored one. */
export function aiConfigSchema(mode: "create" | "update") {
  return z
    .object({
      name: z.string().trim().min(1, "Enter a name for this configuration.").max(100, "Use at most 100 characters."),
      ...connectionShape,
      isActive: z.boolean().default(false),
    })
    .superRefine((value, ctx) => checkConnection(value, ctx, mode === "create"))
}

export type AiConfigInput = z.input<ReturnType<typeof aiConfigSchema>>
export type AiConfigValues = z.output<ReturnType<typeof aiConfigSchema>>

/**
 * Body of POST /api/settings/ai/test. Works before saving (key typed in the
 * form) and after (configId given and the key left empty: the stored key is used).
 */
export const testConnectionSchema = z
  .object({
    configId: z.string().trim().min(1).max(64).optional(),
    ...connectionShape,
  })
  .superRefine((value, ctx) => checkConnection(value, ctx, !value.configId))

export type TestConnectionInput = z.input<typeof testConnectionSchema>

/**
 * Body of POST /api/settings/ai/models: enough to reach the provider's model
 * list. The key comes from the form, or from the saved configuration (configId).
 */
export const listModelsSchema = z.object({
  configId: z.string().trim().min(1).max(64).optional(),
  provider: connectionShape.provider,
  baseUrl: connectionShape.baseUrl.refine((value) => !value || httpUrl(value), "Enter a full URL starting with https:// or http://."),
  apiKey: connectionShape.apiKey,
})

export type FieldErrors = Partial<Record<string, string[]>>

export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors as FieldErrors
}
