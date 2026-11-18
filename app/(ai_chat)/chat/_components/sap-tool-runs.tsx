"use client"

import * as React from "react"
import { CheckCircle2Icon, ChevronDownIcon, DatabaseIcon, XCircleIcon } from "lucide-react"
import { Badge, Button, cn, Collapsible, CollapsibleContent, CollapsibleTrigger, Spinner } from "@boilerplate/ui"

import type { ToolRun } from "@/lib/sap/agent-types"

/**
 * One line per SAP lookup in business words ("Reading Product EF-MAT");
 * expands to the technical details (parameters and the exact OData requests)
 * for consultants and support.
 */
export function SapToolRuns({ runs }: { runs: ToolRun[] }) {
  if (runs.length === 0) return null
  return (
    <div className="grid gap-1.5" aria-label="SAP lookups">
      {runs.map((run) => (
        <ToolRunItem key={run.id} run={run} />
      ))}
    </div>
  )
}

function ToolRunItem({ run }: { run: ToolRun }) {
  const [open, setOpen] = React.useState(false)
  const args = Object.entries(run.args).filter(([, value]) => value !== undefined && value !== null && value !== "")

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-muted/40 text-sm">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-3 py-2 text-left font-normal whitespace-normal hover:bg-muted"
          aria-label={`${run.label}. ${run.summary ?? (run.status === "running" ? "Running" : "")}. ${open ? "Hide" : "Show"} technical details`}
        >
          {run.status === "running" ? (
            <Spinner aria-hidden="true" />
          ) : run.status === "ok" ? (
            <CheckCircle2Icon className="text-muted-foreground" aria-hidden="true" />
          ) : (
            <XCircleIcon className="text-destructive" aria-hidden="true" />
          )}
          <DatabaseIcon className="text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{run.label}</span>
          {run.summary ? (
            <span className={cn("hidden shrink-0 text-xs sm:inline", run.status === "error" ? "text-destructive" : "text-muted-foreground")}>
              {run.summary.length > 60 ? `${run.summary.slice(0, 60)}…` : run.summary}
            </span>
          ) : null}
          <ChevronDownIcon className={cn("shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 border-t px-3 py-3">
        {run.summary ? <p className={cn("text-xs", run.status === "error" ? "text-destructive" : "text-muted-foreground")}>{run.summary}</p> : null}
        <p className="text-xs font-medium">Technical details</p>
        {args.length > 0 ? (
          <div className="grid gap-1">
            <p className="text-xs font-medium text-muted-foreground">Parameters</p>
            <dl className="grid gap-1 font-mono text-xs">
              {args.map(([name, value]) => (
                <div key={name} className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">{name}</dt>
                  <dd className="min-w-0 break-all">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        <div className="grid gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            {run.requests.length === 0
              ? "Nothing was sent to SAP (answered from the service description already loaded, or stopped before sending)"
              : "SAP requests"}
          </p>
          {run.requests.map((request, index) => (
            <div key={index} className="flex flex-wrap items-start gap-2 font-mono text-xs">
              <Badge variant="outline" className="font-mono">
                {request.method}
              </Badge>
              <span className="min-w-0 flex-1 break-all">{request.path}</span>
              <Badge variant={request.status >= 200 && request.status < 400 ? "secondary" : "destructive"}>
                {request.status === 0 ? "no answer" : request.status}
              </Badge>
              <span className="text-muted-foreground">{request.durationMs} ms</span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
