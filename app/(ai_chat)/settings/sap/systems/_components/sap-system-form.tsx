"use client"

import * as React from "react"
import { XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import {
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
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
} from "@boilerplate/ui"

import { createSapSystem, updateSapSystem } from "@/app/actions/sap-systems"
import { fieldErrorsOf, type FieldErrors } from "@/lib/validations/ai-config"
import { DEFAULT_SERVICE_PATH, SAP_ENVIRONMENTS, sapSystemSchema } from "@/lib/validations/sap-system"

type SapEnvironment = (typeof SAP_ENVIRONMENTS)[number]
import type { SapSystemRow } from "./sap-systems-view"

type FormState = {
  name: string
  description: string
  baseUrl: string
  sapClient: string
  environment: SapEnvironment
  servicePath: string
  isActive: boolean
}

function initialState(system: SapSystemRow | null): FormState {
  return system
    ? {
        name: system.name,
        description: system.description ?? "",
        baseUrl: system.baseUrl,
        sapClient: system.sapClient,
        environment: (SAP_ENVIRONMENTS as readonly string[]).includes(system.environment) ? (system.environment as SapEnvironment) : "DEV",
        servicePath: system.servicePath,
        isActive: system.isActive,
      }
    : { name: "", description: "", baseUrl: "", sapClient: "", servicePath: DEFAULT_SERVICE_PATH, environment: "DEV", isActive: true }
}

export function SapSystemForm({
  system,
  onDone,
  onCancel,
}: {
  system: SapSystemRow | null
  onDone: () => void
  onCancel?: () => void
}) {
  const isEdit = system !== null
  const [form, setForm] = React.useState<FormState>(() => initialState(system))
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [isSaving, startSaving] = React.useTransition()
  const id = React.useId()
  const fieldId = (name: string) => `${id}-${name}`

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }
  const error = (name: keyof FormState) => errors[name]?.[0]
  const describedBy = (name: string, hasDescription: boolean) =>
    [hasDescription ? fieldId(`${name}-description`) : null, error(name as keyof FormState) ? fieldId(`${name}-error`) : null]
      .filter(Boolean)
      .join(" ") || undefined

  const targetChanged =
    isEdit &&
    (form.baseUrl.trim().replace(/\/+$/, "") !== system.baseUrl ||
      form.sapClient.trim() !== system.sapClient ||
      form.servicePath.trim().replace(/\/+$/, "") !== system.servicePath)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    const parsed = sapSystemSchema.safeParse(form)
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error))
      setFormError("Check the highlighted fields.")
      return
    }
    startSaving(async () => {
      const result = isEdit ? await updateSapSystem(system.id, form) : await createSapSystem(form)
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {})
        setFormError(result.error)
        return
      }
      toast.success(isEdit ? `“${form.name.trim()}” was updated.` : `“${form.name.trim()}” was added.`)
      onDone()
    })
  }

  const text = (name: Exclude<keyof FormState, "isActive" | "environment">) => ({
    id: fieldId(name),
    value: form[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(name, event.target.value),
    "aria-invalid": error(name) ? true : undefined,
  })

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-labelledby={fieldId("title")}>
        <CardHeader>
          <CardTitle id={fieldId("title")}>{isEdit ? `Edit “${system.name}”` : "Add an SAP system"}</CardTitle>
          <CardDescription>Connection details only. No SAP user or password is stored with the system.</CardDescription>
        </CardHeader>

        <CardContent className="py-6">
          <FieldGroup>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field data-invalid={error("name") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("name")}>Name</FieldLabel>
                <Input {...text("name")} placeholder="S/4HANA Dev 100" maxLength={100} aria-describedby={describedBy("name", false)} />
                <FieldError id={fieldId("name-error")}>{error("name")}</FieldError>
              </Field>

              <Field data-invalid={error("sapClient") ? true : undefined}>
                <FieldLabel htmlFor={fieldId("sapClient")}>SAP client</FieldLabel>
                <Input
                  {...text("sapClient")}
                  placeholder="100"
                  inputMode="numeric"
                  maxLength={3}
                  className="font-mono"
                  aria-describedby={describedBy("sapClient", true)}
                />
                <FieldDescription id={fieldId("sapClient-description")}>Sent as ?sap-client= on every request.</FieldDescription>
                <FieldError id={fieldId("sapClient-error")}>{error("sapClient")}</FieldError>
              </Field>
            </div>

            <Field data-invalid={error("environment") ? true : undefined}>
              <FieldLabel htmlFor={fieldId("environment")}>Environment</FieldLabel>
              <Select value={form.environment} onValueChange={(value) => set("environment", value as SapEnvironment)}>
                <SelectTrigger id={fieldId("environment")} className="w-56" aria-describedby={fieldId("environment-description")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SAP_ENVIRONMENTS.map((environment) => (
                    <SelectItem key={environment} value={environment}>
                      {environment === "DEV" ? "DEV (development)" : environment === "QAS" ? "QAS (quality assurance)" : "PRD (production)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id={fieldId("environment-description")}>
                Shown on every change plan the chat prepares; production plans carry a warning.
              </FieldDescription>
              <FieldError id={fieldId("environment-error")}>{error("environment")}</FieldError>
            </Field>

            <Field data-invalid={error("baseUrl") ? true : undefined}>
              <FieldLabel htmlFor={fieldId("baseUrl")}>Base URL</FieldLabel>
              <Input
                {...text("baseUrl")}
                type="url"
                inputMode="url"
                placeholder="https://s4dev.company.local:44300"
                spellCheck={false}
                className="font-mono"
                aria-describedby={describedBy("baseUrl", true)}
              />
              <FieldDescription id={fieldId("baseUrl-description")}>
                Scheme, host and port of the SAP web dispatcher or ICM. The app server must be able to reach it.
              </FieldDescription>
              <FieldError id={fieldId("baseUrl-error")}>{error("baseUrl")}</FieldError>
            </Field>

            <Field data-invalid={error("servicePath") ? true : undefined}>
              <FieldLabel htmlFor={fieldId("servicePath")}>OData V4 service path</FieldLabel>
              <Input
                {...text("servicePath")}
                placeholder="/sap/opu/odata4/sap/api_salesorder/srvd_a2x/sap/salesorder/0001"
                spellCheck={false}
                className="font-mono"
                aria-describedby={describedBy("servicePath", true)}
              />
              <FieldDescription id={fieldId("servicePath-description")}>
                The service root below the base URL, as published in /IWFND/V4_ADMIN. Requests to
                /api/sap/&lt;system&gt;/&lt;path&gt; are resolved against it.
              </FieldDescription>
              <FieldError id={fieldId("servicePath-error")}>{error("servicePath")}</FieldError>
            </Field>

            <Field data-invalid={error("description") ? true : undefined}>
              <FieldLabel htmlFor={fieldId("description")}>Description (optional)</FieldLabel>
              <Textarea {...text("description")} rows={2} maxLength={500} aria-describedby={describedBy("description", false)} />
              <FieldError id={fieldId("description-error")}>{error("description")}</FieldError>
            </Field>

            <Field orientation="horizontal" className="rounded-lg border p-4">
              <FieldContent>
                <FieldLabel htmlFor={fieldId("isActive")}>Active</FieldLabel>
                <FieldDescription id={fieldId("isActive-description")}>
                  Inactive systems keep their settings but accept no requests.
                </FieldDescription>
              </FieldContent>
              <Switch
                id={fieldId("isActive")}
                checked={form.isActive}
                onCheckedChange={(checked) => set("isActive", checked)}
                aria-describedby={fieldId("isActive-description")}
              />
            </Field>

            {targetChanged && system.connected ? (
              <Alert role="status">
                <AlertTitle>Saving ends the current SAP session</AlertTitle>
                <AlertDescription>
                  The base URL, client or service path changed, so the stored session is not sent to the new target.
                </AlertDescription>
              </Alert>
            ) : null}

            {formError ? (
              <Alert variant="destructive" role="alert">
                <XCircleIcon aria-hidden="true" />
                <AlertTitle>The system was not saved</AlertTitle>
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
          <Button type="submit" disabled={isSaving}>
            {isSaving ? <Spinner aria-hidden="true" /> : null}
            {isEdit ? "Save changes" : "Add system"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
