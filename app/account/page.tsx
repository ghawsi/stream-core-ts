import { Suspense } from "react"
import type { Metadata } from "next"
import { Skeleton } from "@boilerplate/ui"

import { requireAuthSession } from "@/lib/auth/session"
import { AccountView } from "./_components/account-view"

export const metadata: Metadata = {
  title: "Account",
  description: "Your profile, password and session.",
}

export default function AccountPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b px-4">
        <h1 className="text-sm font-medium">Account</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8">
          <Suspense fallback={<AccountSkeleton />}>
            <AccountData />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

async function AccountData() {
  const { user, session } = await requireAuthSession("/account")
  return (
    <AccountView
      user={{ name: user.name, email: user.email, createdAt: user.createdAt.toISOString() }}
      sessionStartedAt={session.createdAt.toISOString()}
    />
  )
}

function AccountSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  )
}
