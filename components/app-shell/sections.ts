import { MessageSquareIcon, SettingsIcon, type LucideIcon } from "lucide-react"

/**
 * The application's sections, in the order the sidebar rail shows them. One
 * list for the rail and anything else that needs section names, so they never
 * disagree.
 *
 * `main` sits at the top of the rail; `admin` is pinned to its foot, apart
 * from the day-to-day work. `match` is the path prefix that marks a section as
 * current (it can be wider than `href`).
 */
export const APP_SECTIONS = [
  { key: "chat", label: "Chat", href: "/chat", match: "/chat", icon: MessageSquareIcon, group: "main" },
  { key: "settings", label: "Settings", href: "/settings/ai", match: "/settings", icon: SettingsIcon, group: "admin" },
] as const satisfies readonly {
  key: string
  label: string
  href: string
  match: string
  icon: LucideIcon
  group: "main" | "admin"
}[]

export type AppSection = (typeof APP_SECTIONS)[number]
export type AppSectionKey = AppSection["key"]

/** The section a path belongs to: "/chat/abc" -> chat. */
export function appSectionFor(pathname: string): AppSection | undefined {
  return APP_SECTIONS.find((section) => pathname === section.match || pathname.startsWith(`${section.match}/`))
}
