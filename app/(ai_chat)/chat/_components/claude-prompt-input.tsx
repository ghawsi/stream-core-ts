"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpIcon, ChevronDownIcon, DatabaseIcon, SquareIcon, TriangleAlertIcon } from "lucide-react"
import {
  Badge,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@boilerplate/ui"

import type { ActiveModelSummary } from "@/lib/ai/active-model"
import { businessAreaFor } from "@/lib/sap/business"
import { CHAT_MESSAGE_MAX_LENGTH } from "@/lib/validations/chat"

const MAX_HEIGHT_PX = 240 // about eight lines, then the textarea scrolls
const NO_SYSTEM = "none"

/** An SAP system the chat can query (configured in /settings/sap/systems). */
export type SapSystemOption = {
  id: string
  name: string
  sapClient: string
  environment: string
  isActive: boolean
  servicePath: string
  /** Reached over unencrypted http (test systems only). */
  plainHttp: boolean
}

export type ClaudePromptInputProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (message: string) => void
  onStop: () => void
  isStreaming: boolean
  activeModel: ActiveModelSummary | null
  /** null when signed out: the picker then offers to sign in. */
  sapSystems: SapSystemOption[] | null
  sapSystemId: string | null
  onSapSystemChange: (id: string | null) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

export function ClaudePromptInput({
  value,
  onValueChange,
  onSubmit,
  onStop,
  isStreaming,
  activeModel,
  sapSystems,
  sapSystemId,
  onSapSystemChange,
  placeholder = "Ask about a business process, master data or postings…",
  autoFocus,
  className,
}: ClaudePromptInputProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0 && !isStreaming && activeModel !== null

  // Browsers without `field-sizing: content` (the Textarea default) grow the
  // textarea from its scroll height instead.
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || CSS.supports("field-sizing", "content")) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  function submit() {
    if (!canSend) return
    onSubmit(value.trim())
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form
      className={cn("w-full", className)}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <InputGroup className="rounded-2xl bg-card shadow-md dark:bg-card" style={{ viewTransitionName: "chat-prompt" }}>
        <InputGroupTextarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={activeModel ? placeholder : "Configure an AI model in settings to start chatting"}
          aria-label="Message"
          aria-keyshortcuts="Enter"
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          autoFocus={autoFocus}
          rows={1}
          className="min-h-14 overflow-y-auto px-4 pt-4 text-base"
          style={{ maxHeight: MAX_HEIGHT_PX }}
        />
        <InputGroupAddon align="block-end" className="flex-wrap gap-2 pt-1">
          <SapSystemPicker systems={sapSystems} value={sapSystemId} onChange={onSapSystemChange} disabled={isStreaming} />
          {activeModel ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="max-w-56 truncate">
                  <span className="truncate">{activeModel.modelName}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">
                {activeModel.name} · {activeModel.providerLabel}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant="outline" asChild>
              <Link href="/settings/ai">
                <TriangleAlertIcon className="text-destructive" aria-hidden="true" />
                No active model · Configure
              </Link>
            </Badge>
          )}
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Shift + Enter for a new line</span>
          {isStreaming ? (
            <InputGroupButton size="icon-sm" variant="default" className="ml-auto rounded-full sm:ml-0" aria-label="Stop generating" onClick={onStop}>
              <SquareIcon className="fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full sm:ml-0"
              aria-label="Send message"
              disabled={!canSend}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

/** Chooses the SAP system whose live business data the chat may read and change. */
function SapSystemPicker({
  systems,
  value,
  onChange,
  disabled,
}: {
  systems: SapSystemOption[] | null
  value: string | null
  onChange: (id: string | null) => void
  disabled: boolean
}) {
  const selected = systems?.find((system) => system.id === value) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          size="xs"
          variant={selected ? "secondary" : "ghost"}
          disabled={disabled}
          aria-label={selected ? `SAP system: ${selected.name}. Change` : "Connect an SAP system to this chat"}
          className="max-w-56"
        >
          <DatabaseIcon aria-hidden="true" />
          <span className="truncate">{selected ? `${selected.name} · ${selected.sapClient}` : "No SAP system"}</span>
          <ChevronDownIcon aria-hidden="true" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>SAP system for live business data</DropdownMenuLabel>
        {systems === null ? (
          <DropdownMenuItem asChild>
            <Link href="/sign-in?next=%2Fchat">Sign in to use SAP data</Link>
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuRadioGroup value={value ?? NO_SYSTEM} onValueChange={(next) => onChange(next === NO_SYSTEM ? null : next)}>
              <DropdownMenuRadioItem value={NO_SYSTEM}>None (chat only)</DropdownMenuRadioItem>
              {systems.map((system) => (
                <DropdownMenuRadioItem key={system.id} value={system.id} disabled={!system.isActive}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{system.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {businessAreaFor(system.servicePath).title} · client {system.sapClient} · {system.environment}
                      {system.plainHttp ? " · unencrypted http" : ""}
                      {system.isActive ? "" : " · turned off"}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {systems.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No SAP systems configured yet.</p>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/sap/systems">Manage SAP systems</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
