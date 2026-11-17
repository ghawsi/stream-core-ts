"use client"

import * as React from "react"
import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@boilerplate/ui"

import type { ChangePlanDecisionResponse } from "@/app/api/chat/change-plans/[planId]/route"
import { OPERATION_LABELS, type ChangePlanView } from "@/lib/sap/agent-types"
import { fetchWithSapSignIn, SapAuthCancelledError } from "@/lib/sap-fetch"

const STATUS: Record<ChangePlanView["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PENDING: { label: "Waiting for approval", variant: "outline" },
  EXECUTING: { label: "Sending to SAP", variant: "secondary" },
  EXECUTED: { label: "Applied in SAP", variant: "default" },
  REJECTED: { label: "Rejected", variant: "secondary" },
  FAILED: { label: "Failed", variant: "destructive" },
  EXPIRED: { label: "Expired", variant: "secondary" },
}

/**
 * Human-in-the-loop confirmation for a write the model proposed. Shows the
 * target system, the exact request and every field's current and new value.
 * Nothing reaches SAP unless the user presses Approve.
 */
export function ChangePlanCard({
  plan,
  onUpdated,
}: {
  plan: ChangePlanView
  onUpdated: (plan: ChangePlanView, note: { id: string; content: string } | null) => void
}) {
  const [busy, setBusy] = React.useState<"approve" | "reject" | null>(null)
  const production = plan.environment === "PRD"
  const pending = plan.status === "PENDING"
  const status = STATUS[plan.status]

  async function decide(decision: "approve" | "reject") {
    setBusy(decision)
    try {
      const response = await fetchWithSapSignIn(`/api/chat/change-plans/${encodeURIComponent(plan.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      })
      const data = (await response.json().catch(() => null)) as ChangePlanDecisionResponse | { message?: string } | null
      if (data && "ok" in data && data.ok) {
        onUpdated(data.plan, data.note)
        if (data.plan.status === "EXECUTED") toast.success("The change was applied in SAP.")
        else if (data.plan.status === "FAILED") toast.error("SAP did not apply the change.")
      } else {
        if (data && "plan" in data && data.plan) onUpdated(data.plan, null)
        toast.error((data && "error" in data && data.error) || (data && "message" in data && data.message) || `The request failed (${response.status}).`)
      }
    } catch (error) {
      if (error instanceof SapAuthCancelledError) toast.info("SAP sign-in was cancelled; nothing was sent.")
      else toast.error("The request failed. Check your connection.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="gap-4 py-4" aria-label={`Change plan: ${OPERATION_LABELS[plan.operation]} ${plan.path}`}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          Change plan · {OPERATION_LABELS[plan.operation]} <code className="font-mono text-xs">{plan.entitySet}</code>
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span>{plan.systemName}</span>
          <span aria-hidden="true">·</span>
          <span>client {plan.sapClient}</span>
          <Badge variant={production ? "destructive" : "outline"}>{plan.environment}</Badge>
        </CardDescription>
        <CardAction>
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-3 px-4">
        {production && pending ? (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>Production system</AlertTitle>
            <AlertDescription>This writes directly to production data. The API has no test mode; prove new changes in DEV or QAS first.</AlertDescription>
          </Alert>
        ) : null}

        <p className="text-sm">{plan.reason}</p>
        <p className="font-mono text-xs break-all text-muted-foreground">
          {plan.method} {plan.path}
        </p>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>New</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.diff.map((item) => (
                <TableRow key={item.field}>
                  <TableCell className="whitespace-normal">
                    <div className="font-medium">{item.label ?? item.field}</div>
                    {item.label ? <div className="font-mono text-xs text-muted-foreground">{item.field}</div> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-all text-muted-foreground">{item.current}</TableCell>
                  <TableCell className="font-mono text-xs font-medium whitespace-normal break-all">{item.next}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {plan.resultMessage ? (
          <Alert variant={plan.status === "FAILED" ? "destructive" : "default"} role="status">
            {plan.status === "FAILED" ? <XIcon aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}
            <AlertTitle>{plan.status === "EXECUTED" ? "SAP accepted the change" : "SAP did not apply the change"}</AlertTitle>
            <AlertDescription>{plan.resultMessage}</AlertDescription>
          </Alert>
        ) : null}

        {plan.decidedBy && plan.decidedAt ? (
          <p className="text-xs text-muted-foreground">
            {plan.status === "REJECTED" ? "Rejected" : "Approved"} by {plan.decidedBy} at {new Date(plan.decidedAt).toLocaleString()}
          </p>
        ) : pending ? (
          <p className="text-xs text-muted-foreground">
            Uses the ETag read just now; if someone changes the record in the meantime, SAP refuses the change. Expires at{" "}
            {new Date(plan.expiresAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </CardContent>

      {pending ? (
        <CardFooter className="flex flex-wrap justify-end gap-2 px-4">
          <Button type="button" variant="outline" size="sm" onClick={() => decide("reject")} disabled={busy !== null}>
            {busy === "reject" ? <Spinner aria-hidden="true" /> : <XIcon aria-hidden="true" />}
            Reject
          </Button>
          <Button type="button" size="sm" variant={production ? "destructive" : "default"} onClick={() => decide("approve")} disabled={busy !== null}>
            {busy === "approve" ? <Spinner aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}
            Approve and send to SAP
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}
