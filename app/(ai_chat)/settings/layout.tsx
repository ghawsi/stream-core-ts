import { Separator } from "@boilerplate/ui"

import { SettingsNav } from "./_components/settings-nav"

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-sm font-medium">Settings</h1>
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        <SettingsNav />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
