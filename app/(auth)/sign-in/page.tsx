"use client"

import * as React from "react"
import Link from "next/link"
import {
  Alert, AlertDescription, Button, Card, CardContent, CardDescription,
  CardFooter, CardHeader, CardTitle, Input, Label, Spinner,
} from "@boilerplate/ui"

import { authClient } from "@/lib/auth/auth-client"

const SignIn = () => {
  const { data: session, isPending } = authClient.useSession()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function handleSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setBusy(true)
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    })
    setBusy(false)
    if (error) setError(error.message ?? "Sign-in failed. Check your email and password.")
  }

  async function handleSignOut() {
    setBusy(true)
    await authClient.signOut()
    setBusy(false)
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {isPending ? (
          <CardContent className="flex justify-center py-8">
            <Spinner />
          </CardContent>
        ) : session ? (
          <>
            <CardHeader>
              <CardTitle>
                <h1>Signed in</h1>
              </CardTitle>
              <CardDescription>
                You are signed in as {session.user.name} ({session.user.email}).
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button variant="outline" className="w-full" onClick={handleSignOut} disabled={busy}>
                {busy ? "Signing out" : "Sign out"}
              </Button>
            </CardFooter>
          </>
        ) : (
          <form onSubmit={handleSignIn}>
            <CardHeader>
              <CardTitle>
                <h1>Sign in</h1>
              </CardTitle>
              <CardDescription>Enter your email and password.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 py-6">
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </div>
            </CardContent>
            <CardFooter className="grid gap-3">
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in" : "Sign in"}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                No account yet?{" "}
                <Link href="/sign-up" className="text-foreground underline underline-offset-4">
                  Sign up
                </Link>
              </p>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  )
}

export default SignIn