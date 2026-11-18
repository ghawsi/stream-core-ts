"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilIcon, PlugZapIcon, ServerIcon, Trash2Icon, UnplugIcon } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@boilerplate/ui"

import { deleteSapSystem, disconnectAllSapSystems, disconnectSapSystem } from "@/app/actions/sap-systems"
import { businessAreaFor } from "@/lib/sap/business"
import { SapAuthCancelledError, sapFetchJson } from "@/lib/sap-fetch"
import { SapSystemForm } from "./sap-system-form"

export type SapSystemRow = {
  id: string
  name: string
  description: string | null
  baseUrl: string
  sapClient: string
  servicePath: string
  environment: string
  isActive: boolean
  /** A valid encrypted SAP session cookie exists for this system. */
  connected: boolean
}

type ServiceDocument = { value?: { name: string; kind?: string }[] }

export function SapSystemsView({ systems }: { systems: SapSystemRow[] }) {
  const router = useRouter()
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [formKey, setFormKey] = React.useState(0)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [toDelete, setToDelete] = React.useState<SapSystemRow | null>(null)
  const [lastDeleteName, setLastDeleteName] = React.useState("")
  const [isPending, startTransition] = React.useTransition()
  const formRef = React.useRef<HTMLDivElement>(null)
  if (toDelete && toDelete.name !== lastDeleteName) setLastDeleteName(toDelete.name)

  const editing = systems.find((system) => system.id === editingId) ?? null
  const anyConnected = systems.some((system) => system.connected)

  function edit(system: SapSystemRow) {
    setEditingId(system.id)
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true })
    })
  }

  function resetForm() {
    setEditingId(null)
    setFormKey((key) => key + 1)
  }

  /**
   * The sapFetch example: reads the OData V4 service document. Without a SAP
   * session the proxy answers SAP_AUTH_REQUIRED, the sign-in modal opens, and
   * the request is sent again after signing in.
   */
  async function test(system: SapSystemRow) {
    setBusyId(system.id)
    try {
      const document = await sapFetchJson<ServiceDocument>(system.id, "")
      const entitySets = document.value?.filter((item) => !item.kind || item.kind === "EntitySet").length ?? 0
      toast.success(`Connected to ${system.name}. The service offers ${entitySets} entity set${entitySets === 1 ? "" : "s"}.`)
    } catch (error) {
      if (error instanceof SapAuthCancelledError) toast.info(error.message)
      else toast.error(error instanceof Error ? error.message : "The request failed.")
    } finally {
      setBusyId(null)
      router.refresh() // the connection badge reads the session cookie
    }
  }

  function disconnect(system: SapSystemRow) {
    setBusyId(system.id)
    startTransition(async () => {
      const result = await disconnectSapSystem(system.id)
      setBusyId(null)
      if (result.ok) toast.success(`Disconnected from ${system.name}.`)
      else toast.error(result.error)
    })
  }

  function disconnectAll() {
    startTransition(async () => {
      const result = await disconnectAllSapSystems()
      if (result.ok) toast.success("All SAP sessions were ended.")
      else toast.error(result.error)
    })
  }

  function confirmDelete(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    if (!toDelete) return
    const system = toDelete
    startTransition(async () => {
      const result = await deleteSapSystem(system.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setToDelete(null)
      if (system.id === editingId) resetForm()
      toast.success(`“${system.name}” was deleted.`)
    })
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Configured systems</h3>
          </CardTitle>
          <CardDescription>Connection status is per browser session. Signing out ends every SAP session.</CardDescription>
          {anyConnected ? (
            <CardAction>
              <Button type="button" variant="outline" size="sm" onClick={disconnectAll} disabled={isPending}>
                <UnplugIcon aria-hidden="true" />
                Disconnect all
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="pb-6">
          {systems.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No SAP systems yet</EmptyTitle>
                <EmptyDescription>Add a system below with its base URL, SAP client and OData V4 service path.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Base URL</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {systems.map((system) => (
                    <TableRow key={system.id} data-state={system.id === editingId ? "selected" : undefined}>
                      <TableCell className="max-w-64 whitespace-normal">
                        <div className="font-medium">{system.name}</div>
                        {system.description ? <div className="text-xs text-muted-foreground">{system.description}</div> : null}
                        <div className="text-xs">{businessAreaFor(system.servicePath).title}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground" title={system.servicePath}>
                          {system.servicePath}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{system.baseUrl}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {system.sapClient}{" "}
                        <Badge variant={system.environment === "PRD" ? "destructive" : "outline"} className="ml-1">
                          {system.environment}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {!system.isActive ? (
                          <Badge variant="outline">Turned off</Badge>
                        ) : system.connected ? (
                          <Badge>Connected</Badge>
                        ) : (
                          <Badge variant="secondary">Not authenticated</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => test(system)}
                            disabled={!system.isActive || busyId === system.id}
                          >
                            {busyId === system.id ? <Spinner aria-hidden="true" /> : <PlugZapIcon aria-hidden="true" />}
                            {system.connected ? "Test" : "Connect"}
                          </Button>
                          {system.connected ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Disconnect from ${system.name}`}
                                  onClick={() => disconnect(system)}
                                  disabled={isPending}
                                >
                                  <UnplugIcon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Disconnect and clear the session</TooltipContent>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit ${system.name}`} onClick={() => edit(system)}>
                                <PencilIcon />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${system.name}`}
                                onClick={() => setToDelete(system)}
                              >
                                <Trash2Icon />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div ref={formRef} className="scroll-mt-6">
        <SapSystemForm
          key={editing ? `edit-${editing.id}` : `new-${formKey}`}
          system={editing}
          onDone={resetForm}
          onCancel={editing ? resetForm : undefined}
        />
      </div>

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && !isPending && setToDelete(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this SAP system?</AlertDialogTitle>
            <AlertDialogDescription>
              “{toDelete?.name ?? lastDeleteName}” is removed and its SAP session ends. Nothing changes in SAP itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete} disabled={isPending}>
              {isPending ? <Spinner aria-hidden="true" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
