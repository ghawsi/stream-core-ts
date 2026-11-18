"use client"

import * as React from "react"
import { CpuIcon, PencilIcon, Trash2Icon } from "lucide-react"
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

import { activateAiConfig, deleteAiConfig, type AiConfigSummary } from "@/app/actions/ai-config"
import { providerDisplayName } from "@/lib/ai/provider-catalog"

export function AiConfigList({
  configs,
  editingId,
  onEdit,
  onDeleted,
}: {
  configs: AiConfigSummary[]
  editingId: string | null
  onEdit: (config: AiConfigSummary) => void
  onDeleted: (id: string) => void
}) {
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [isPending, startTransition] = React.useTransition()
  const [toDelete, setToDelete] = React.useState<AiConfigSummary | null>(null)
  const [lastDeleteName, setLastDeleteName] = React.useState("")
  if (toDelete && toDelete.name !== lastDeleteName) setLastDeleteName(toDelete.name)

  function activate(config: AiConfigSummary) {
    setPendingId(config.id)
    startTransition(async () => {
      const result = await activateAiConfig(config.id)
      setPendingId(null)
      if (result.ok) toast.success(`“${config.name}” is now the active model.`)
      else toast.error(result.error)
    })
  }

  function confirmDelete(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault() // keep the dialog open until the action finishes
    if (!toDelete) return
    const config = toDelete
    startTransition(async () => {
      const result = await deleteAiConfig(config.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setToDelete(null)
      onDeleted(config.id)
      toast.success(`“${config.name}” was deleted.`)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Saved configurations</h3>
        </CardTitle>
        <CardDescription>The active configuration answers every chat message.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        {configs.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CpuIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No models yet</EmptyTitle>
              <EmptyDescription>Add a provider below. The first one you add becomes the active model.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>API key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {configs.map((config) => (
                  <TableRow key={config.id} data-state={config.id === editingId ? "selected" : undefined}>
                    <TableCell className="font-medium">{config.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{providerDisplayName(config.provider, config.baseUrl)}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{config.modelName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{config.maskedApiKey}</TableCell>
                    <TableCell>
                      {config.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {!config.isActive ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => activate(config)}
                            disabled={isPending}
                          >
                            {pendingId === config.id ? <Spinner aria-hidden="true" /> : null}
                            Activate
                          </Button>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Edit ${config.name}`}
                              onClick={() => onEdit(config)}
                            >
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
                              aria-label={`Delete ${config.name}`}
                              onClick={() => setToDelete(config)}
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

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && !isPending && setToDelete(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this configuration?</AlertDialogTitle>
            <AlertDialogDescription>
              “{toDelete?.name ?? lastDeleteName}” and its encrypted API key are removed.
              {toDelete?.isActive ? " The chat has no active model until you activate another one." : ""} This cannot be
              undone.
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
    </Card>
  )
}
