import type { CSSProperties, ReactNode } from "react"

import { AppSidebar } from "./app-sidebar"

/**
 * The application frame: an icon rail at the inline-start edge and the page in
 * one panel beside it. Use it in the layout of every signed-in area (chat,
 * settings) so the rail stays mounted while the user moves between them.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-app-shell
      style={{ "--app-rail-width": "3.75rem" } as CSSProperties}
      className="grid h-svh grid-cols-[var(--app-rail-width)_minmax(0,1fr)] overflow-hidden bg-sidebar"
    >
      <AppSidebar />

      <div data-app-column className="flex min-h-0 min-w-0 flex-col py-2 pe-2">
        <div data-app-panel className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
          {children}
        </div>
      </div>
    </div>
  )
}
