import { cn, Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, Skeleton } from "@boilerplate/ui"

// Fixed widths: SidebarMenuSkeleton picks a random width, which Cache
// Components does not allow in a prerendered fallback.
const ROW_WIDTHS = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4", "w-2/5"]

export function ChatSidebarSkeleton() {
  return (
    <Sidebar collapsible="icon" className="absolute h-full" aria-label="Chat history" aria-busy="true">
      <SidebarHeader>
        <Skeleton className="h-8 w-full" />
      </SidebarHeader>
      <SidebarContent className="px-2 group-data-[collapsible=icon]:hidden">
        <SidebarMenu>
          {ROW_WIDTHS.map((width, index) => (
            <SidebarMenuItem key={index} aria-hidden="true" className="flex h-8 items-center px-2">
              <Skeleton className={cn("h-4", width)} />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  )
}

export function ChatCanvasSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Skeleton className="size-7" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
        <Skeleton className="ml-auto h-10 w-2/5 rounded-xl" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </div>
  )
}
