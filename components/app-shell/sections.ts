import { HomeIcon, MessageSquareIcon, SettingsIcon, UserRoundIcon, type LucideIcon } from "lucide-react"

/**
 * The application's sections, in the order the sidebar rail shows them. One
 * list for the rail and anything else that needs section names, so they never
 * disagree.
 *
 * `main` sits at the top of the rail; `admin` is pinned to its foot, apart
 * from the day-to-day work. `match` is the path prefix that marks a section as
 * current (it can be wider than `href`); "/" matches the home page only.
 * The account entry opens a menu (sign in, account, sign out) instead of
 * linking directly.
 */
export const APP_SECTIONS = [
  { key: "home", label: "Home", href: "/", match: "/", icon: HomeIcon, group: "main" },
  { key: "chat", label: "Chat", href: "/chat", match: "/chat", icon: MessageSquareIcon, group: "main" },
  { key: "account", label: "Account", href: "/account", match: "/account", icon: UserRoundIcon, group: "admin" },
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

/** The section a path belongs to: "/chat/abc" -> chat, "/" -> home. */
export function appSectionFor(pathname: string): AppSection | undefined {
  return APP_SECTIONS.find((section) =>
    section.match === "/" ? pathname === "/" : pathname === section.match || pathname.startsWith(`${section.match}/`)
  )
}
