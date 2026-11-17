import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth/auth"

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

/** The Better Auth session of the current request, or null when signed out. */
export async function getAuthSession(): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: await headers() })
}

/** For pages: sends signed-out visitors to /sign-in and back to `returnTo` afterwards. */
export async function requireAuthSession(returnTo: string): Promise<AuthSession> {
  const session = await getAuthSession()
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`)
  return session
}
