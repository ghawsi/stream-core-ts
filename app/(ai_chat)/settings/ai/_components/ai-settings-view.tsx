"use client"

import * as React from "react"

import type { AiConfigSummary } from "@/app/actions/ai-config"
import { AiConfigForm } from "./ai-config-form"
import { AiConfigList } from "./ai-config-list"

export function AiSettingsView({ configs }: { configs: AiConfigSummary[] }) {
  const [editingId, setEditingId] = React.useState<string | null>(null)
  // A new key resets the "Add a model" form after saving.
  const [formKey, setFormKey] = React.useState(0)
  const formRef = React.useRef<HTMLDivElement>(null)
  const editing = configs.find((config) => config.id === editingId) ?? null
  const hasActive = configs.some((config) => config.isActive)

  function edit(config: AiConfigSummary) {
    setEditingId(config.id)
    // Wait for the form to switch, then bring it into view and focus it.
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true })
    })
  }

  function reset() {
    setEditingId(null)
    setFormKey((key) => key + 1)
  }

  return (
    <div className="grid gap-6">
      <AiConfigList
        configs={configs}
        editingId={editingId}
        onEdit={edit}
        onDeleted={(id) => {
          if (id === editingId) reset()
        }}
      />
      <div ref={formRef} className="scroll-mt-6">
        <AiConfigForm
          // The new-model form also restarts when "is any model active" changes,
          // because that decides whether "Set as active model" starts on. After
          // saving, the refreshed list arrives after the reset.
          key={editing ? `edit-${editing.id}` : `new-${formKey}-${hasActive}`}
          config={editing}
          makeActiveByDefault={!hasActive}
          onDone={reset}
          onCancel={editing ? reset : undefined}
        />
      </div>
    </div>
  )
}
