/**
 * Provider metadata shared by the server (requests) and the settings form
 * (labels, defaults, presets). No server-only imports here.
 */
export const AI_PROVIDERS = ["OLLAMA", "OPENAI", "ANTHROPIC", "GEMINI", "AZURE_OPENAI", "CUSTOM_OPENAI_COMPATIBLE"] as const
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
  GEMINI: "Google Gemini",
  AZURE_OPENAI: "Azure OpenAI",
  CUSTOM_OPENAI_COMPATIBLE: "Other provider",
}

export const PROVIDER_DESCRIPTIONS: Record<AiProvider, string> = {
  OLLAMA: "Models running on your machine with Ollama. No API key needed.",
  OPENAI: "GPT and o-series models from the OpenAI API.",
  ANTHROPIC: "Claude models from the Anthropic API.",
  GEMINI: "Gemini models with an API key from Google AI Studio, including the free tier.",
  AZURE_OPENAI: "A deployment in your Azure OpenAI resource.",
  CUSTOM_OPENAI_COMPATIBLE: "DeepSeek, Mistral, Groq, OpenRouter, xAI, LM Studio and any other OpenAI-compatible API.",
}

/** Base URL filled in when the provider is chosen. Azure and custom endpoints have none. */
export const DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  OLLAMA: "http://localhost:11434",
  OPENAI: "https://api.openai.com/v1",
  ANTHROPIC: "https://api.anthropic.com",
  GEMINI: "https://generativelanguage.googleapis.com/v1beta",
  AZURE_OPENAI: "",
  CUSTOM_OPENAI_COMPATIBLE: "",
}

export const BASE_URL_PLACEHOLDERS: Record<AiProvider, string> = {
  OLLAMA: "http://localhost:11434",
  OPENAI: "https://api.openai.com/v1",
  ANTHROPIC: "https://api.anthropic.com",
  GEMINI: "https://generativelanguage.googleapis.com/v1beta",
  AZURE_OPENAI: "https://my-resource.openai.azure.com",
  CUSTOM_OPENAI_COMPATIBLE: "https://api.example.com/v1",
}

/** Providers for which the base URL must be entered. */
export const BASE_URL_REQUIRED: ReadonlySet<AiProvider> = new Set(["AZURE_OPENAI", "CUSTOM_OPENAI_COMPATIBLE"])

/** Providers that work without an API key. */
export const API_KEY_OPTIONAL: ReadonlySet<AiProvider> = new Set(["OLLAMA", "CUSTOM_OPENAI_COMPATIBLE"])

/** Providers whose model list can be loaded from the server (Azure deployments cannot be listed with an API key). */
export const MODEL_LIST_SUPPORTED: ReadonlySet<AiProvider> = new Set(["OLLAMA", "OPENAI", "ANTHROPIC", "GEMINI", "CUSTOM_OPENAI_COMPATIBLE"])

/**
 * Quick-select model names, shown until the real list is loaded. Any other
 * model string (or Azure deployment name) can be typed instead. The first one
 * is filled in when the provider is chosen.
 *
 * Gemini uses Google's family aliases: Google moves them to the current model
 * of each family, while numbered versions (gemini-2.5-flash) are withdrawn
 * from new users over time.
 */
export const MODEL_PRESETS: Record<AiProvider, readonly string[]> = {
  OLLAMA: ["llama3.1", "qwen2.5", "mistral"],
  OPENAI: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  ANTHROPIC: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  GEMINI: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"],
  AZURE_OPENAI: [],
  CUSTOM_OPENAI_COMPATIBLE: [],
}

/** Timeout suggested when the provider is chosen. Local models first load into memory, which can take minutes. */
export const DEFAULT_TIMEOUT_SECONDS: Record<AiProvider, number> = {
  OLLAMA: 180,
  OPENAI: 60,
  ANTHROPIC: 60,
  GEMINI: 120,
  AZURE_OPENAI: 60,
  CUSTOM_OPENAI_COMPATIBLE: 120,
}

export const DEFAULT_AZURE_API_VERSION = "2024-10-21"

/** Where to create an API key, per provider. */
export const API_KEY_LINKS: Partial<Record<AiProvider, { label: string; url: string }>> = {
  GEMINI: { label: "Google AI Studio", url: "https://aistudio.google.com/apikey" },
  OPENAI: { label: "OpenAI platform", url: "https://platform.openai.com/api-keys" },
  ANTHROPIC: { label: "Claude Console", url: "https://platform.claude.com/settings/keys" },
}

/** A model offered by the provider, as returned by the model-list endpoint. */
export type ProviderModel = {
  id: string
  /** Display name when it differs from the ID (Anthropic, Gemini). */
  label?: string
  /** Short facts, e.g. "8B · Q4_K_M · 4.9 GB" for Ollama. */
  detail?: string
}

// ---------- services behind "Other provider" (OpenAI-compatible APIs) ----------

export type CompatibleService = {
  id: string
  label: string
  /** Base URL before /chat/completions; empty for a custom endpoint. */
  baseUrl: string
  description: string
  /** Where to create an API key, if the service needs one. */
  keyUrl?: string
  /** Runs on this machine or network; usually no API key. */
  local?: boolean
  /** A few well-known model names; "Load models" gets the full list. */
  models: readonly string[]
}

export const COMPATIBLE_SERVICES: readonly CompatibleService[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", description: "DeepSeek's chat and reasoning models.", keyUrl: "https://platform.deepseek.com/api_keys", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "mistral", label: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", description: "Mistral and Codestral models.", keyUrl: "https://console.mistral.ai/api-keys", models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"] },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", description: "Open models on Groq's fast inference hardware, with a free tier.", keyUrl: "https://console.groq.com/keys", models: [] },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", description: "Hundreds of models from many vendors, some free, behind one key.", keyUrl: "https://openrouter.ai/keys", models: [] },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", description: "Grok models.", keyUrl: "https://console.x.ai", models: [] },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", description: "Open models such as Llama, Qwen and DeepSeek.", models: [] },
  { id: "fireworks", label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", description: "Open models on Fireworks.", models: [] },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", description: "Open models on Cerebras hardware.", models: [] },
  { id: "moonshot", label: "Moonshot AI (Kimi)", baseUrl: "https://api.moonshot.ai/v1", description: "Kimi models.", models: [] },
  { id: "qwen", label: "Alibaba Cloud (Qwen)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", description: "Qwen models through Model Studio (international).", models: [] },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", description: "Models served by Hugging Face Inference Providers.", keyUrl: "https://huggingface.co/settings/tokens", models: [] },
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", description: "Models hosted on NVIDIA's API catalog.", models: [] },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", description: "Models loaded in LM Studio on your machine.", local: true, models: [] },
  { id: "vllm", label: "vLLM (local)", baseUrl: "http://localhost:8000/v1", description: "A vLLM server on your machine or network.", local: true, models: [] },
  { id: "custom", label: "Custom endpoint", baseUrl: "", description: "Any other server with an OpenAI-compatible /chat/completions API, such as an SAP AI Core proxy.", models: [] },
]

/** The known service a base URL belongs to, or the custom entry. */
export function detectCompatibleService(baseUrl: string | null | undefined): CompatibleService {
  const custom = COMPATIBLE_SERVICES[COMPATIBLE_SERVICES.length - 1]
  if (!baseUrl) return custom
  let host = ""
  let port = ""
  try {
    const url = new URL(baseUrl)
    host = url.hostname
    port = url.port
  } catch {
    return custom
  }
  return (
    COMPATIBLE_SERVICES.find((service) => {
      if (!service.baseUrl) return false
      const known = new URL(service.baseUrl)
      return known.hostname === host && (!service.local || known.port === port)
    }) ?? custom
  )
}

/** Name to show for a configuration: the service for "Other provider" (e.g. "DeepSeek"), else the provider. */
export function providerDisplayName(provider: string, baseUrl: string | null | undefined): string {
  if (provider === "CUSTOM_OPENAI_COMPATIBLE") {
    const service = detectCompatibleService(baseUrl)
    return service.id === "custom" ? "OpenAI-compatible" : service.label
  }
  return isAiProvider(provider) ? PROVIDER_LABELS[provider] : provider
}
