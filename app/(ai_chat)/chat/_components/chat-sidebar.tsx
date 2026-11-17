"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { CpuIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
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
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  Spinner,
  useSidebar,
} from "@boilerplate/ui"

import { deleteChatSession, renameChatSession, type ChatSessionSummary } from "@/app/actions/chat"
import type { ActiveModelSummary } from "@/lib/ai/active-model"
import { CHAT_TITLE_MAX_LENGTH } from "@/lib/validations/chat"
import { useChatUI } from "./chat-ui-context"
import { groupByDate, useStartOfToday } from "./date-groups"

type PendingAction = { kind: "rename" | "delete"; session: ChatSessionSummary } | null

export function ChatSidebar({
  sessions,
  activeModel,
}: {
  sessions: ChatSessionSummary[]
  activeModel: ActiveModelSummary | null
}) {
  const pathname = usePathname()
  const activeSessionId = pathname.startsWith("/chat/") ? decodeURIComponent(pathname.slice("/chat/".length)) : null
  const startOfToday = useStartOfToday()
  const { startNewChat, pendingSession } = useChatUI()
  const allSessions =
    pendingSession && !sessions.some((session) => session.id === pendingSession.id)
      ? [{ ...pendingSession, createdAt: pendingSession.updatedAt }, ...sessions]
      : sessions
  const groups = groupByDate(allSessions, startOfToday)
  const { isMobile, setOpenMobile } = useSidebar()
  const [pending, setPending] = React.useState<PendingAction>(null)

  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      <Sidebar collapsible="icon" className="absolute h-full" aria-label="Chat history">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex h-8 items-center gap-2 px-2 group-data-[collapsible=icon]:hidden">
                <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="truncate text-sm font-semibold">SAP S/4HANA Assistant</span>
              </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton variant="outline" tooltip="New chat" onClick={startNewChat}>
                <PlusIcon aria-hidden="true" />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {groups.length === 0 ? (
            <p className="px-4 py-2 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
              Your chats will appear here.
            </p>
          ) : (
            groups.map((group) => (
              <SidebarGroup key={group.label} className="group-data-[collapsible=icon]:hidden">
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((session) => (
                      <SidebarMenuItem key={session.id}>
                        <SidebarMenuButton asChild isActive={session.id === activeSessionId}>
                          <Link href={`/chat/${session.id}`} onClick={closeOnMobile} title={session.title}>
                            <span className="truncate">{session.title}</span>
                          </Link>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction showOnHover aria-label={`Options for ${session.title}`}>
                              <MoreHorizontalIcon />
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-40">
                            <DropdownMenuItem onSelect={() => setPending({ kind: "rename", session })}>
                              <PencilIcon aria-hidden="true" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setPending({ kind: "delete", session })}>
                              <Trash2Icon aria-hidden="true" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))
          )}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                size="lg"
                tooltip={activeModel ? `Active model: ${activeModel.modelName}` : "No active model configured"}
              >
                <Link href="/settings/ai" onClick={closeOnMobile}>
                  {activeModel ? (
                    <CpuIcon aria-hidden="true" />
                  ) : (
                    <TriangleAlertIcon className="text-destructive" aria-hidden="true" />
                  )}
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">
                      {activeModel ? activeModel.modelName : "No active model"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {activeModel ? `${activeModel.name} · ${activeModel.providerLabel}` : "Configure one in AI settings"}
                    </span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <RenameChatDialog
        session={pending?.kind === "rename" ? pending.session : null}
        onClose={() => setPending(null)}
      />
      <DeleteChatDialog
        session={pending?.kind === "delete" ? pending.session : null}
        isActive={pending?.kind === "delete" && pending.session.id === activeSessionId}
        onClose={() => setPending(null)}
      />
    </>
  )
}

function RenameChatDialog({ session, onClose }: { session: ChatSessionSummary | null; onClose: () => void }) {
  const [isPending, startTransition] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return
    const title = String(new FormData(event.currentTarget).get("title") ?? "")
    startTransition(async () => {
      const result = await renameChatSession(session.id, title)
      if (result.ok) {
        setError(null)
        onClose()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>The new title is shown in the chat history.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="chat-title">Title</Label>
            <Input
              id="chat-title"
              name="title"
              key={session?.id}
              defaultValue={session?.title}
              maxLength={CHAT_TITLE_MAX_LENGTH}
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "chat-title-error" : undefined}
            />
            {error ? (
              <p id="chat-title-error" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Spinner aria-hidden="true" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteChatDialog({
  session,
  isActive,
  onClose,
}: {
  session: ChatSessionSummary | null
  isActive: boolean
  onClose: () => void
}) {
  const { startNewChat, pendingSession, setPendingSession } = useChatUI()
  const [isPending, startTransition] = React.useTransition()
  // Keep the title visible while the dialog animates closed.
  const [lastTitle, setLastTitle] = React.useState("")
  if (session && session.title !== lastTitle) setLastTitle(session.title)

  function handleDelete(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault() // keep the dialog open until the action finishes
    if (!session) return
    startTransition(async () => {
      const result = await deleteChatSession(session.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (pendingSession?.id === session.id) setPendingSession(null)
      onClose()
      // The action revalidates the layout, so the list updates without a manual refresh.
      if (isActive) startNewChat()
      toast.success("Chat deleted.")
    })
  }

  return (
    <AlertDialog open={session !== null} onOpenChange={(open) => !open && !isPending && onClose()}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            “{session?.title ?? lastTitle}” and all its messages are removed. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={isPending}>
            {isPending ? <Spinner aria-hidden="true" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
