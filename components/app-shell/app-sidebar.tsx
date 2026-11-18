"use client"

import { Suspense } from "react"
import Link, { useLinkStatus } from "next/link"
import { usePathname } from "next/navigation"
import { BotIcon } from "lucide-react"
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@boilerplate/ui"

import { RailAccount } from "./rail-account"
import { railButtonClass } from "./rail-styles"
import { APP_SECTIONS, appSectionFor, type AppSection, type AppSectionKey } from "./sections"

/**
 * Shown while the page a rail link opens is still being prepared on the
 * server. Always rendered, only its opacity changes, so nothing shifts.
 */
function PendingMark() {
  const { pending } = useLinkStatus()
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -inset-1 rounded-lg border-2 border-ring opacity-0 transition-opacity duration-150",
        pending && "animate-pulse opacity-100"
      )}
    />
  )
}

function RailLink({ section, current }: { section: AppSection; current: boolean }) {
  const Icon = section.icon
  return (
    // The rail has no room for words: the link is named by aria-label and the
    // tooltip repeats the name on hover and keyboard focus.
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon-lg"
          className={railButtonClass(current)}
        >
          <Link href={section.href} aria-label={section.label} aria-current={current ? "page" : undefined}>
            <Icon aria-hidden="true" className="size-5" strokeWidth={current ? 2.75 : 2} />
            <PendingMark />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {section.label}
      </TooltipContent>
    </Tooltip>
  )
}

function RailGroups({ currentKey }: { currentKey: AppSectionKey | undefined }) {
  const group = (name: AppSection["group"]) =>
    APP_SECTIONS.filter((section) => section.group === name).map((section) => (
      <li key={section.key}>
        {section.key === "account" ? (
          <RailAccount current={section.key === currentKey} />
        ) : (
          <RailLink section={section} current={section.key === currentKey} />
        )}
      </li>
    ))

  return (
    <>
      <ul className="m-0 flex list-none flex-col items-center gap-3 p-0">{group("main")}</ul>
      <ul className="m-0 mt-auto flex list-none flex-col items-center gap-3 p-0 pt-5">{group("admin")}</ul>
    </>
  )
}

/** The pathname is request data: it streams in, so the rail itself stays in the static shell. */
function CurrentRailGroups() {
  return <RailGroups currentKey={appSectionFor(usePathname())?.key} />
}

/**
 * The application's collapsed sidebar: an icon rail on every page. Home and
 * chat at the top; account and settings pinned to the foot.
 */
export function AppSidebar() {
  return (
    <div className="sticky top-0 grid h-svh grid-rows-[3.5rem_minmax(0,1fr)] self-start bg-sidebar text-sidebar-foreground">
      {/* The application's mark, the logo for a collapsed sidebar. */}
      <div className="flex items-center justify-center">
        <span
          role="img"
          aria-label="SAP S/4HANA AI Chat"
          className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <BotIcon aria-hidden="true" className="size-5" />
        </span>
      </div>

      <nav aria-label="Main" className="flex min-h-0 flex-col items-center overflow-y-auto pt-4 pb-5">
        <Suspense fallback={<RailGroups currentKey={undefined} />}>
          <CurrentRailGroups />
        </Suspense>
      </nav>
    </div>
  )
}
