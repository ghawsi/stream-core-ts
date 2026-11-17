import { Suspense } from "react"
import type { Metadata } from "next"
import { Skeleton } from "@boilerplate/ui"

import { listAiConfigs } from "@/app/actions/ai-config"
import { requireAuthSession } from "@/lib/auth/session"
import { AiSettingsView } from "./_components/ai-settings-view"

export const metadata: Metadata = {
  title: "AI model settings",
  description: "Add local Ollama models or remote LLM providers, test them, and choose the model the SAP S/4HANA AI Chat uses.",
}

export default function AiSettingsPage() {
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8">
      <div className="grid gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">AI models</h2>
        <p className="text-muted-foreground">
          Add a model running locally in Ollama or a remote one from OpenAI, Anthropic Claude, Azure OpenAI or an
          OpenAI-compatible endpoint, test it, and choose the model the chat uses.
        </p>
      </div>
      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsData />
      </Suspense>
    </div>
  )
}

async function SettingsData() {
  // API keys for the whole application: signed-in users only.
  await requireAuthSession("/settings/ai")
  const configs = await listAiConfigs()
  return <AiSettingsView configs={configs} />
}

function SettingsSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}
