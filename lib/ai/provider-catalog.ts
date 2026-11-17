/**
 * Provider metadata shared by the server (requests) and the settings form
 * (labels, defaults, presets). No server-only imports here.
 */
export const AI_PROVIDERS = ["OLLAMA", "OPENAI", "ANTHROPIC", "AZURE_OPENAI", "CUSTOM_OPENAI_COMPATIBLE"] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value)
}

/** Providers that run on this machine or network rather than a cloud API. */
export const LOCAL_PROVIDERS: ReadonlySet<AiProvider> = new Set(["OLLAMA"])

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  OLLAMA: "Ollama (local)",
  OPENAI: "OpenAI",
  ANTHROPIC: "Anthropic Claude",
  AZURE_OPENAI: "Azure OpenAI",
  CUSTOM_OPENAI_COMPATIBLE: "OpenAI-compatible",
}

export const PROVIDER_DESCRIPTIONS: Record<AiProvider, string> = {
  OLLAMA: "Models running on your machine with Ollama. No API key needed.",
  OPENAI: "GPT and o-series models from the OpenAI API.",
  ANTHROPIC: "Claude models from the Anthropic API.",
  AZURE_OPENAI: "A deployment in your Azure OpenAI resource.",
  CUSTOM_OPENAI_COMPATIBLE: "vLLM, LM Studio, an SAP AI Core proxy or any /chat/completions endpoint.",
}

/** Base URL filled in when the provider is chosen. Azure and custom endpoints have none. */
export const DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  OLLAMA: "http://localhost:11434",
  OPENAI: "https://api.openai.com/v1",
  ANTHROPIC: "https://api.anthropic.com",
  AZURE_OPENAI: "",
  CUSTOM_OPENAI_COMPATIBLE: "",
}

export const BASE_URL_PLACEHOLDERS: Record<AiProvider, string> = {
  OLLAMA: "http://localhost:11434",
  OPENAI: "https://api.openai.com/v1",
  ANTHROPIC: "https://api.anthropic.com",
  AZURE_OPENAI: "https://my-resource.openai.azure.com",
  CUSTOM_OPENAI_COMPATIBLE: "http://localhost:1234/v1",
}

/** Providers for which the base URL must be entered. */
export const BASE_URL_REQUIRED: ReadonlySet<AiProvider> = new Set(["AZURE_OPENAI", "CUSTOM_OPENAI_COMPATIBLE"])

/** Providers that work without an API key. */
export const API_KEY_OPTIONAL: ReadonlySet<AiProvider> = new Set(["OLLAMA", "CUSTOM_OPENAI_COMPATIBLE"])

/** Providers whose model list can be loaded from the server (Azure deployments cannot be listed with an API key). */
export const MODEL_LIST_SUPPORTED: ReadonlySet<AiProvider> = new Set(["OLLAMA", "OPENAI", "ANTHROPIC", "CUSTOM_OPENAI_COMPATIBLE"])

/**
 * Quick-select model names, shown until the real list is loaded. Any other
 * model string (or Azure deployment name) can be typed instead.
 */
export const MODEL_PRESETS: Record<AiProvider, readonly string[]> = {
  OLLAMA: ["llama3.1", "qwen2.5", "mistral"],
  OPENAI: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  ANTHROPIC: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  AZURE_OPENAI: [],
  CUSTOM_OPENAI_COMPATIBLE: [],
}

/** Timeout suggested when the provider is chosen. Local models first load into memory, which can take minutes. */
export const DEFAULT_TIMEOUT_SECONDS: Record<AiProvider, number> = {
  OLLAMA: 180,
  OPENAI: 60,
  ANTHROPIC: 60,
  AZURE_OPENAI: 60,
  CUSTOM_OPENAI_COMPATIBLE: 120,
}

export const DEFAULT_AZURE_API_VERSION = "2024-10-21"

/** A model offered by the provider, as returned by the model-list endpoint. */
export type ProviderModel = {
  id: string
  /** Display name when it differs from the ID (Anthropic). */
  label?: string
  /** Short facts, e.g. "8B · Q4_K_M · 4.9 GB" for Ollama. */
  detail?: string
}
