import { Suspense } from "react"
import type { Metadata } from "next"
import { Skeleton } from "@boilerplate/ui"

import { requireAuthSession } from "@/lib/auth/session"
import { prisma } from "@/lib/db"
import { connectedSapSystemIds } from "@/lib/sap-session"
import { SapSystemsView, type SapSystemRow } from "./_components/sap-systems-view"

export const metadata: Metadata = {
  title: "SAP systems",
  description: "Configure SAP S/4HANA on-premise systems for OData V4 access and manage their sessions.",
}

export default function SapSystemsPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8">
      <div className="grid gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">SAP systems</h2>
        <p className="text-muted-foreground">
          The SAP S/4HANA on-premise systems the chat can work with, each through a released API (OData V4) such as Product
          or Sales Order. Your SAP user and password are asked for only when a request needs them, and are kept in an
          encrypted session cookie, never in the database.
        </p>
      </div>
      <Suspense fallback={<SystemsSkeleton />}>
        <SapSystemsData />
      </Suspense>
    </div>
  )
}

async function SapSystemsData() {
  const authSession = await requireAuthSession("/settings/sap/systems")
  const systems = await prisma.sapSystem.findMany({
    where: { userId: authSession.user.id },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, baseUrl: true, sapClient: true, servicePath: true, environment: true, isActive: true },
  })
  const connected = await connectedSapSystemIds(
    systems.map((system) => system.id),
    authSession
  )
  const rows: SapSystemRow[] = systems.map((system) => ({ ...system, connected: connected.has(system.id) }))
  return <SapSystemsView systems={rows} />
}

function SystemsSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}
