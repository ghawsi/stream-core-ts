"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Button } from "@boilerplate/ui"

const LINKS = [
  { href: "/settings/ai", label: "AI models" },
  { href: "/settings/sap/systems", label: "SAP systems" },
] as const

function Links({ pathname }: { pathname: string | null }) {
  return (
    <ul className="m-0 flex list-none gap-1 p-0">
      {LINKS.map((link) => {
        const current = pathname === link.href || pathname?.startsWith(`${link.href}/`)
        return (
          <li key={link.href}>
            <Button asChild variant={current ? "secondary" : "ghost"} size="sm">
              <Link href={link.href} aria-current={current ? "page" : undefined}>
                {link.label}
              </Link>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

function CurrentLinks() {
  return <Links pathname={usePathname()} />
}

export function SettingsNav() {
  return (
    <nav aria-label="Settings">
      {/* The pathname is request data: the links render in the static shell and the highlight streams in. */}
      <Suspense fallback={<Links pathname={null} />}>
        <CurrentLinks />
      </Suspense>
    </nav>
  )
}
