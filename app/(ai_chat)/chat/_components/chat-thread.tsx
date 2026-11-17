"use client"

import * as React from "react"
import Link from "next/link"
import { CheckIcon, CopyIcon } from "lucide-react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Bubble,
  BubbleContent,
  Button,
  cn,
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@boilerplate/ui"

import type { ChangePlanView, ToolRun } from "@/lib/sap/agent-types"
import { ChangePlanCard } from "./change-plan-card"
import { Markdown } from "./markdown"
import { SapToolRuns } from "./sap-tool-runs"

export type ChatUIMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  status: "done" | "streaming" | "stopped" | "error"
  error?: string
  modelUsed?: string | null
  /** SAP requests made while answering (shown as collapsible status lines). */
  toolRuns?: ToolRun[]
  /** Writes proposed while answering, waiting for (or decided by) the user. */
  changePlans?: ChangePlanView[]
}

export type PlanUpdateHandler = (plan: ChangePlanView, note: { id: string; content: string } | null) => void

export function ChatThread({
  messages,
  isStreaming,
  onPlanUpdated,
  className,
}: {
  messages: ChatUIMessage[]
  isStreaming: boolean
  onPlanUpdated: PlanUpdateHandler
  className?: string
}) {
  return (
    // autoScroll keeps the newest text in view while it streams, and stops
    // following as soon as the user scrolls up.
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className={cn("min-h-0 flex-1", className)}>
        <MessageScrollerViewport role="log" aria-label="Conversation" aria-busy={isStreaming} tabIndex={0} className="px-4">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 pt-6 pb-10">
            {messages.map((message, index) => (
              <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={index === messages.length - 1}>
                {message.role === "user" ? <UserMessage message={message} /> : <AssistantMessage message={message} onPlanUpdated={onPlanUpdated} />}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function UserMessage({ message }: { message: ChatUIMessage }) {
  return (
    <Message align="end">
      <MessageContent>
        <MessageHeader className="sr-only">You</MessageHeader>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="text-sm whitespace-pre-wrap md:text-base">{message.content}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

const StreamingCursor = () => (
  <span aria-hidden="true" className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse rounded-sm bg-foreground" />
)

function AssistantMessage({ message, onPlanUpdated }: { message: ChatUIMessage; onPlanUpdated: PlanUpdateHandler }) {
  const isStreaming = message.status === "streaming"
  const hasContent = message.content.length > 0
  const toolRuns = message.toolRuns ?? []
  const changePlans = message.changePlans ?? []
  const toolRunning = toolRuns.some((run) => run.status === "running")

  return (
    <Message align="start">
      <MessageContent className="gap-3">
        <MessageHeader className="sr-only">Assistant</MessageHeader>

        <SapToolRuns runs={toolRuns} />

        {isStreaming && !hasContent && !toolRunning ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner aria-hidden="true" />
            {toolRuns.length > 0 ? "Working on the SAP data…" : "Thinking…"}
          </div>
        ) : null}

        {hasContent ? <Markdown content={message.content} trailing={isStreaming ? <StreamingCursor /> : null} /> : null}

        {changePlans.map((plan) => (
          <ChangePlanCard key={plan.id} plan={plan} onUpdated={onPlanUpdated} />
        ))}

        {message.status === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>The response could not be completed</AlertTitle>
            <AlertDescription>
              <p>{message.error}</p>
              {message.error?.includes("/settings/ai") ? (
                <Link href="/settings/ai" className="font-medium underline underline-offset-4">
                  Open AI settings
                </Link>
              ) : null}
              {/sign in to use sap/i.test(message.error ?? "") ? (
                <Link href="/sign-in?next=%2Fchat" className="font-medium underline underline-offset-4">
                  Sign in
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {!isStreaming && hasContent ? (
          <MessageFooter className="gap-1 px-0">
            <CopyMessageButton text={message.content} />
            {message.status === "stopped" ? <span>Stopped</span> : null}
            {message.modelUsed ? <span className="truncate">{message.modelUsed}</span> : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timeout)
  }, [copied])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "Response copied" : "Copy response"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  )
}
