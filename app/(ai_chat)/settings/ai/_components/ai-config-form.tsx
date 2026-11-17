"use client"

import * as React from "react"
import { CheckCircle2Icon, ChevronDownIcon, EyeIcon, EyeOffIcon, PlugZapIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Label,
  RadioGroup,
  RadioGroupItem,
  Slider,
  Spinner,
  Switch,
} from "@boilerplate/ui"

import { createAiConfig, updateAiConfig, type AiConfigSummary } from "@/app/actions/ai-config"
import type { ListModelsResponse } from "@/app/api/settings/ai/models/route"
import type { TestConnectionResponse } from "@/app/api/settings/ai/test/route"
import {
  AI_PROVIDERS,
  API_KEY_OPTIONAL,
  BASE_URL_PLACEHOLDERS,
  BASE_URL_REQUIRED,
  DEFAULT_AZURE_API_VERSION,
  DEFAULT_BASE_URLS,
  DEFAULT_TIMEOUT_SECONDS,
  isAiProvider,
  MODEL_LIST_SUPPORTED,
  MODEL_PRESETS,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_LABELS,
  type AiProvider,
  type ProviderModel,
} from "@/lib/ai/provider-catalog"
import { AI_CONFIG_DEFAULTS, aiConfigSchema, fieldErrorsOf, type FieldErrors } from "@/lib/validations/ai-config"

type FormState = {
  name: string
  provider: AiProvider
  baseUrl: string
  apiVersion: string
  apiKey: string
  modelName: string
  temperature: number
  // Number inputs keep the typed text; the schema converts and checks it.
  topP: string
  maxTokens: string
  timeoutSeconds: string
  isActive: boolean
}

function initialState(config: AiConfigSummary | null, makeActive: boolean): FormState {
  if (config) {
    const provider = isAiProvider(config.provider) ? config.provider : "OPENAI"
    return {
      name: config.name,
      provider,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URLS[provider],
      apiVersion: config.apiVersion ?? (provider === "AZURE_OPENAI" ? DEFAULT_AZURE_API_VERSION : ""),
      apiKey: "",
      modelName: config.modelName,
      temperature: config.temperature,
      topP: String(config.topP ?? AI_CONFIG_DEFAULTS.topP),
      maxTokens: String(config.maxTokens),
      timeoutSeconds: String(config.timeoutSeconds),
      isActive: config.isActive,
    }
  }
  return {
    name: "",
    provider: "OLLAMA",
    baseUrl: DEFAULT_BASE_URLS.OLLAMA,
    apiVersion: "",
    apiKey: "",
    modelName: "",
    temperature: AI_CONFIG_DEFAULTS.temperature,
    topP: String(AI_CONFIG_DEFAULTS.topP),
    maxTokens: String(AI_CONFIG_DEFAULTS.maxTokens),
    timeoutSeconds: String(DEFAULT_TIMEOUT_SECONDS.OLLAMA),
    isActive: makeActive,
  }
}

type TestResult = { ok: true; message: string; reply: string } | { ok: false; message: string }

export function AiConfigForm({
  config,
  makeActiveByDefault,
  onDone,
  onCancel,
}: {
  /** The configuration being edited, or null to add a new one. */
  config: AiConfigSummary | null
  /** New configurations start as active when none is active yet. */
  makeActiveByDefault: boolean
  onDone: () => void
  onCancel?: () => void
}) {
  const isEdit = config !== null
  const [form, setForm] = React.useState<FormState>(() => initialState(config, makeActiveByDefault))
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [showKey, setShowKey] = React.useState(false)
  const [testResult, setTestResult] = React.useState<TestResult | null>(null)
  const [isTesting, setIsTesting] = React.useState(false)
  const [isSaving, startSaving] = React.useTransition()
  const [models, setModels] = React.useState<ProviderModel[] | null>(null)
  const [modelsError, setModelsError] = React.useState<string | null>(null)
  const [isLoadingModels, setIsLoadingModels] = React.useState(false)
  const modelsRequest = React.useRef(0)
  const id = React.useId()
  const fieldId = (name: string) => `${id}-${name}`

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
    setTestResult(null)
  }

  function changeProvider(next: AiProvider) {
    setForm((current) => {
      const previous = current.provider
      // Replace values the user has not changed: the old default URL and the old presets.
      const baseUrl = !current.baseUrl || current.baseUrl === DEFAULT_BASE_URLS[previous] ? DEFAULT_BASE_URLS[next] : current.baseUrl
      const modelName =
        !current.modelName || MODEL_PRESETS[previous].includes(current.modelName) ? (MODEL_PRESETS[next][0] ?? "") : current.modelName
      const apiVersion = next === "AZURE_OPENAI" ? current.apiVersion || DEFAULT_AZURE_API_VERSION : current.apiVersion
      // Local models need longer: the first request loads the model into memory.
      const timeoutSeconds =
        current.timeoutSeconds === String(DEFAULT_TIMEOUT_SECONDS[previous]) ? String(DEFAULT_TIMEOUT_SECONDS[next]) : current.timeoutSeconds
      return { ...current, provider: next, baseUrl, modelName, apiVersion, timeoutSeconds }
    })
    setErrors({})
    setTestResult(null)
    setModels(null)
    setModelsError(null)
  }

  const configId = config?.id
  /** Loads the provider's model list (installed models for Ollama). */
  const loadModels = React.useCallback(
    async (target: { provider: AiProvider; baseUrl: string; apiKey: string }) => {
      const request = ++modelsRequest.current
      setIsLoadingModels(true)
      setModelsError(null)
      try {
        const response = await fetch("/api/settings/ai/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...target, configId }),
        })
        const data = (await response.json()) as ListModelsResponse
        if (request !== modelsRequest.current) return // a newer request is running
        if (data.ok) {
          setModels(data.models)
          // Replace an empty or untouched preset name with the first model that really exists.
          setForm((current) =>
            data.models.length > 0 &&
            (!current.modelName || MODEL_PRESETS[current.provider].includes(current.modelName)) &&
            !data.models.some((model) => model.id === current.modelName)
              ? { ...current, modelName: data.models[0].id }
              : current
          )
        } else {
          setModels(null)
          setModelsError(data.error)
        }
      } catch {
        if (request === modelsRequest.current) setModelsError("The model list could not be loaded.")
      } finally {
        if (request === modelsRequest.current) setIsLoadingModels(false)
      }
    },
    [configId]
  )

  // Ollama needs no key, so its installed models are listed as soon as it is chosen
  // (and again when its URL changes).
  const ollamaUrl = form.provider === "OLLAMA" ? form.baseUrl : null
  React.useEffect(() => {
    if (ollamaUrl === null) return
    const timeout = window.setTimeout(() => loadModels({ provider: "OLLAMA", baseUrl: ollamaUrl, apiKey: "" }), 400)
    return () => window.clearTimeout(timeout)
  }, [ollamaUrl, loadModels])

  const payload = () => ({
    name: form.name,
    provider: form.provider,
    baseUrl: form.baseUrl,
    apiVersion: form.provider === "AZURE_OPENAI" ? form.apiVersion : "",
    apiKey: form.apiKey,
    modelName: form.modelName,
    temperature: form.temperature,
    topP: form.topP,
    maxTokens: form.maxTokens,
    timeoutSeconds: form.timeoutSeconds,
    isActive: form.isActive,
  })

  async function testConnection() {
    const values = payload()
    const connection = {
      provider: values.provider,
      baseUrl: values.baseUrl,
      apiVersion: values.apiVersion,
      apiKey: values.apiKey,
      modelName: values.modelName,
      temperature: values.temperature,
      topP: values.topP,
      maxTokens: values.maxTokens,
      timeoutSeconds: values.timeoutSeconds,
    }
    setIsTesting(true)
    setTestResult(null)
    try {
      const response = await fetch("/api/settings/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...connection, configId: config?.id }),
      })
      const data = (await response.json()) as TestConnectionResponse
      if (data.ok) {
        setTestResult({ ok: true, message: data.message, reply: data.reply })
        toast.success(data.message)
      } else {
        if (data.fieldErrors) setErrors(data.fieldErrors)
        setTestResult({ ok: false, message: data.error })
        toast.error(data.error)
      }
    } catch {
      const message = "The test request failed. Check that the app server is running."
      setTestResult({ ok: false, message })
      toast.error(message)
    } finally {
      setIsTesting(false)
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    const values = payload()
    const parsed = aiConfigSchema(isEdit ? "update" : "create").safeParse(values)
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error))
      setFormError("Check the highlighted fields.")
      return
    }
    startSaving(async () => {
      const result = isEdit ? await updateAiConfig(config.id, values) : await createAiConfig(values)
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {})
        setFormError(result.error)
        return
      }
      toast.success(isEdit ? `“${values.name.trim()}” was updated.` : `“${values.name.trim()}” was added.`)
      onDone()
    })
  }

  const error = (name: keyof FormState) => errors[name]?.[0]
  const describedBy = (name: string, hasDescription = true) =>
    [hasDescription ? fieldId(`${name}-description`) : null, error(name as keyof FormState) ? fieldId(`${name}-error`) : null]
      .filter(Boolean)
      .join(" ") || undefined
  const presets = MODEL_PRESETS[form.provider]
  const baseUrlRequired = BASE_URL_REQUIRED.has(form.provider)
  const keyOptional = API_KEY_OPTIONAL.has(form.provider)
  const canListModels = MODEL_LIST_SUPPORTED.has(form.provider)
  const isOllama = form.provider === "OLLAMA"

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-labelledby={fieldId("title")}>
        <CardHeader>
          <CardTitle id={fieldId("title")}>{isEdit ? `Edit “${config.name}”` : "Add a model"}</CardTitle>
          <CardDescription>
            A model running locally in Ollama, or a remote model from a cloud provider. API keys are encrypted on the
            server and never sent back to the browser.
          </CardDescription>
        </CardHeader>

        <CardContent className="py-6">
          <FieldGroup>
            {/* Section A */}
            <FieldSet>
              <FieldLegend>Provider and connection</FieldLegend>

              <Field data-invalid={error("name") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("name")}>Configuration name</FieldLabel>
                <Input
                  id={fieldId("name")}
                  value={form.name}
                  onChange={(event) => set("name", event.target.value)}
                  placeholder="SAP Finance Assistant LLM"
                  maxLength={100}
                  aria-invalid={error("name") ? true : undefined}
                  aria-describedby={describedBy("name", false)}
                />
                <FieldError id={fieldId("name-error")}>{error("name")}</FieldError>
              </Field>

              <Field>
                <FieldLabel id={fieldId("provider-label")}>AI provider</FieldLabel>
                <RadioGroup
                  value={form.provider}
                  onValueChange={(value) => isAiProvider(value) && changeProvider(value)}
                  aria-labelledby={fieldId("provider-label")}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {AI_PROVIDERS.map((provider) => (
                    <Label
                      key={provider}
                      htmlFor={fieldId(`provider-${provider}`)}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent"
                    >
                      <RadioGroupItem
                        value={provider}
                        id={fieldId(`provider-${provider}`)}
                        aria-labelledby={fieldId(`provider-${provider}-label`)}
                        aria-describedby={fieldId(`provider-${provider}-description`)}
                        className="mt-0.5"
                      />
                      <span className="grid gap-1">
                        <span id={fieldId(`provider-${provider}-label`)} className="text-sm font-medium">
                          {PROVIDER_LABELS[provider]}
                        </span>
                        <span id={fieldId(`provider-${provider}-description`)} className="text-sm text-muted-foreground">
                          {PROVIDER_DESCRIPTIONS[provider]}
                        </span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              </Field>

              <Field data-invalid={error("baseUrl") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("baseUrl")}>
                  {isOllama ? "Ollama URL" : `API endpoint / base URL${baseUrlRequired ? "" : " (optional)"}`}
                </FieldLabel>
                <Input
                  id={fieldId("baseUrl")}
                  type="url"
                  inputMode="url"
                  value={form.baseUrl}
                  onChange={(event) => set("baseUrl", event.target.value)}
                  placeholder={BASE_URL_PLACEHOLDERS[form.provider]}
                  required={baseUrlRequired}
                  aria-invalid={error("baseUrl") ? true : undefined}
                  aria-describedby={describedBy("baseUrl")}
                />
                <FieldDescription id={fieldId("baseUrl-description")}>
                  {isOllama
                    ? "Where Ollama listens. The app server must reach it; from a Docker container use http://host.docker.internal:11434."
                    : form.provider === "AZURE_OPENAI"
                      ? "The endpoint of your Azure OpenAI resource."
                      : form.provider === "CUSTOM_OPENAI_COMPATIBLE"
                        ? "The URL before /chat/completions, for example http://localhost:1234/v1 for LM Studio."
                        : "Filled in for you. Change it only to use a proxy or gateway."}
                </FieldDescription>
                <FieldError id={fieldId("baseUrl-error")}>{error("baseUrl")}</FieldError>
              </Field>

              {form.provider === "AZURE_OPENAI" ? (
                <Field data-invalid={error("apiVersion") ? true : undefined}>
                  <FieldLabel htmlFor={fieldId("apiVersion")}>API version</FieldLabel>
                  <Input
                    id={fieldId("apiVersion")}
                    value={form.apiVersion}
                    onChange={(event) => set("apiVersion", event.target.value)}
                    placeholder={DEFAULT_AZURE_API_VERSION}
                    required
                    aria-invalid={error("apiVersion") ? true : undefined}
                    aria-describedby={describedBy("apiVersion")}
                  />
                  <FieldDescription id={fieldId("apiVersion-description")}>
                    Sent as the api-version query parameter.
                  </FieldDescription>
                  <FieldError id={fieldId("apiVersion-error")}>{error("apiVersion")}</FieldError>
                </Field>
              ) : null}

              <Field data-invalid={error("apiKey") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("apiKey")}>
                  API key{keyOptional ? " (optional)" : ""}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={fieldId("apiKey")}
                    type={showKey ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) => set("apiKey", event.target.value)}
                    placeholder={isEdit ? config.maskedApiKey : keyOptional ? "Not needed" : "sk-…"}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={error("apiKey") ? true : undefined}
                    aria-describedby={describedBy("apiKey")}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      aria-pressed={showKey}
                      onClick={() => setShowKey((value) => !value)}
                    >
                      {showKey ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription id={fieldId("apiKey-description")}>
                  {isOllama
                    ? "Ollama needs no key. Enter one only if a proxy in front of Ollama asks for it."
                    : isEdit
                      ? "Leave empty to keep the saved key. A new value replaces it."
                      : "Stored encrypted with AES-256-GCM."}
                </FieldDescription>
                <FieldError id={fieldId("apiKey-error")}>{error("apiKey")}</FieldError>
              </Field>
            </FieldSet>

            {/* Section B */}
            <FieldSet>
              <FieldLegend>Model</FieldLegend>
              <Field data-invalid={error("modelName") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("modelName")}>
                  {form.provider === "AZURE_OPENAI" ? "Deployment name" : "Model name"}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={fieldId("modelName")}
                    value={form.modelName}
                    onChange={(event) => set("modelName", event.target.value)}
                    placeholder={form.provider === "AZURE_OPENAI" ? "my-gpt-4o-deployment" : (models?.[0]?.id ?? presets[0] ?? "model-name")}
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={error("modelName") ? true : undefined}
                    aria-describedby={describedBy("modelName")}
                  />
                  {canListModels || presets.length > 0 ? (
                    <InputGroupAddon align="inline-end">
                      {canListModels ? (
                        <InputGroupButton
                          size="icon-xs"
                          aria-label={isOllama ? "Reload installed models" : "Load available models"}
                          title={isOllama ? "Reload installed models" : "Load available models"}
                          onClick={() => loadModels({ provider: form.provider, baseUrl: form.baseUrl, apiKey: form.apiKey })}
                          disabled={isLoadingModels}
                        >
                          {isLoadingModels ? <Spinner /> : <RefreshCwIcon />}
                        </InputGroupButton>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <InputGroupButton size="xs" variant="secondary">
                            {models && models.length > 0 ? `Models (${models.length})` : "Presets"}
                            <ChevronDownIcon aria-hidden="true" />
                          </InputGroupButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
                          {models && models.length > 0 ? (
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>{isOllama ? "Installed in Ollama" : `Available from ${PROVIDER_LABELS[form.provider]}`}</DropdownMenuLabel>
                              {models.map((model) => (
                                <DropdownMenuItem key={model.id} onSelect={() => set("modelName", model.id)} className="flex-col items-start gap-0">
                                  <span className="font-mono">{model.id}</span>
                                  {model.label || model.detail ? (
                                    <span className="text-xs text-muted-foreground">{[model.label, model.detail].filter(Boolean).join(" · ")}</span>
                                  ) : null}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>
                          ) : null}
                          {models && models.length > 0 && presets.length > 0 ? <DropdownMenuSeparator /> : null}
                          {presets.length > 0 ? (
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>{isOllama ? "Popular (pull first)" : "Presets"}</DropdownMenuLabel>
                              {presets.map((preset) => (
                                <DropdownMenuItem key={preset} className="font-mono" onSelect={() => set("modelName", preset)}>
                                  {preset}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>
                          ) : null}
                          {(!models || models.length === 0) && presets.length === 0 ? (
                            <DropdownMenuLabel className="font-normal text-muted-foreground">
                              Load the model list or type a name.
                            </DropdownMenuLabel>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
                <FieldDescription id={fieldId("modelName-description")}>
                  {form.provider === "AZURE_OPENAI"
                    ? "The name you gave the deployment in Azure, not the model family."
                    : isOllama
                      ? isLoadingModels
                        ? "Looking for installed models…"
                        : models && models.length === 0
                          ? "Ollama is running but has no models yet. Download one, for example with: ollama pull llama3.1"
                          : models
                            ? `${models.length} model${models.length === 1 ? "" : "s"} installed. Pick one or type a name.`
                            : "Pick an installed model or type a name."
                      : models
                        ? `${models.length} model${models.length === 1 ? "" : "s"} available with this key. Pick one or type any name.`
                        : "Pick a preset, load the models your key can use, or type any model name."}
                </FieldDescription>
                {modelsError ? (
                  <p className="text-sm text-destructive" role="status">
                    {modelsError}
                  </p>
                ) : null}
                <FieldError id={fieldId("modelName-error")}>{error("modelName")}</FieldError>
              </Field>
            </FieldSet>

            {/* Section C */}
            <FieldSet>
              <FieldLegend>Inference</FieldLegend>
              <Accordion
                type="single"
                collapsible
                defaultValue={errors.temperature || errors.topP || errors.maxTokens || errors.timeoutSeconds ? "advanced" : undefined}
                className="rounded-lg border px-4"
              >
                <AccordionItem value="advanced" className="border-b-0">
                  <AccordionTrigger>Advanced settings</AccordionTrigger>
                  <AccordionContent>
                    <FieldGroup className="pt-1">
                      <Field data-invalid={error("temperature") ? true : undefined}>
                        <FieldLabel id={fieldId("temperature-label")} htmlFor={fieldId("temperature")}>
                          Temperature
                        </FieldLabel>
                        <div className="flex items-center gap-4">
                          <Slider
                            value={[form.temperature]}
                            onValueChange={([value]) => set("temperature", Math.round((value ?? 0) * 10) / 10)}
                            min={0}
                            max={1}
                            step={0.1}
                            aria-labelledby={fieldId("temperature-label")}
                            className="flex-1"
                          />
                          <Input
                            id={fieldId("temperature")}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={1}
                            step={0.1}
                            value={form.temperature}
                            onChange={(event) => set("temperature", event.target.valueAsNumber)}
                            className="w-20 tabular-nums"
                            aria-invalid={error("temperature") ? true : undefined}
                            aria-describedby={describedBy("temperature")}
                          />
                        </div>
                        <FieldDescription id={fieldId("temperature-description")}>
                          Lower values (0.0–0.2) are recommended for strict SAP S/4HANA rule adherence and OData JSON
                          analysis. Claude models ignore this setting.
                        </FieldDescription>
                        <FieldError id={fieldId("temperature-error")}>{error("temperature")}</FieldError>
                      </Field>

                      <div className="grid gap-6 sm:grid-cols-3">
                        <Field data-invalid={error("topP") ? true : undefined}>
                          <FieldLabel htmlFor={fieldId("topP")}>Top P</FieldLabel>
                          <Input
                            id={fieldId("topP")}
                            type="number"
                            inputMode="decimal"
                            min={0.05}
                            max={1}
                            step={0.05}
                            value={form.topP}
                            onChange={(event) => set("topP", event.target.value)}
                            className="tabular-nums"
                            aria-invalid={error("topP") ? true : undefined}
                            aria-describedby={describedBy("topP")}
                          />
                          <FieldDescription id={fieldId("topP-description")}>
                            Nucleus sampling. Keep 1.0 and tune temperature instead. Claude models ignore it.
                          </FieldDescription>
                          <FieldError id={fieldId("topP-error")}>{error("topP")}</FieldError>
                        </Field>

                        <Field data-invalid={error("maxTokens") ? true : undefined}>
                          <FieldLabel htmlFor={fieldId("maxTokens")}>Max output tokens</FieldLabel>
                          <Input
                            id={fieldId("maxTokens")}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step={1}
                            value={form.maxTokens}
                            onChange={(event) => set("maxTokens", event.target.value)}
                            className="tabular-nums"
                            aria-invalid={error("maxTokens") ? true : undefined}
                            aria-describedby={describedBy("maxTokens")}
                          />
                          <FieldDescription id={fieldId("maxTokens-description")}>
                            Maximum length of the AI response.
                          </FieldDescription>
                          <FieldError id={fieldId("maxTokens-error")}>{error("maxTokens")}</FieldError>
                        </Field>

                        <Field data-invalid={error("timeoutSeconds") ? true : undefined}>
                          <FieldLabel htmlFor={fieldId("timeoutSeconds")}>Request timeout (seconds)</FieldLabel>
                          <Input
                            id={fieldId("timeoutSeconds")}
                            type="number"
                            inputMode="numeric"
                            min={5}
                            max={600}
                            step={1}
                            value={form.timeoutSeconds}
                            onChange={(event) => set("timeoutSeconds", event.target.value)}
                            className="tabular-nums"
                            aria-invalid={error("timeoutSeconds") ? true : undefined}
                            aria-describedby={describedBy("timeoutSeconds")}
                          />
                          <FieldDescription id={fieldId("timeoutSeconds-description")}>
                            Increase if analyzing large SAP OData V4 payloads. Local models need longer for the first answer
                            while they load.
                          </FieldDescription>
                          <FieldError id={fieldId("timeoutSeconds-error")}>{error("timeoutSeconds")}</FieldError>
                        </Field>
                      </div>
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <Field orientation="horizontal" className="rounded-lg border p-4">
                <FieldContent>
                  <FieldLabel htmlFor={fieldId("isActive")}>Set as active model</FieldLabel>
                  <FieldDescription id={fieldId("isActive-description")}>
                    The chat uses this configuration. Any other active configuration is turned off.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id={fieldId("isActive")}
                  checked={form.isActive}
                  onCheckedChange={(checked) => set("isActive", checked)}
                  aria-describedby={fieldId("isActive-description")}
                />
              </Field>
            </FieldSet>

            {testResult ? (
              <Alert variant={testResult.ok ? "default" : "destructive"} role="status">
                {testResult.ok ? <CheckCircle2Icon aria-hidden="true" /> : <XCircleIcon aria-hidden="true" />}
                <AlertTitle>{testResult.ok ? testResult.message : "The connection test failed"}</AlertTitle>
                <AlertDescription>
                  {testResult.ok
                    ? testResult.reply
                      ? `The model replied: “${testResult.reply}”`
                      : "The provider accepted the request."
                    : testResult.message}
                </AlertDescription>
              </Alert>
            ) : null}

            {formError ? (
              <Alert variant="destructive" role="alert">
                <XCircleIcon aria-hidden="true" />
                <AlertTitle>The configuration was not saved</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>

        <CardFooter className="flex flex-wrap justify-end gap-2 border-t pt-6">
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
              Cancel
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={testConnection} disabled={isTesting || isSaving}>
            {isTesting ? <Spinner aria-hidden="true" /> : <PlugZapIcon aria-hidden="true" />}
            Test connection
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? <Spinner aria-hidden="true" /> : null}
            {isEdit ? "Save changes" : "Add model"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
