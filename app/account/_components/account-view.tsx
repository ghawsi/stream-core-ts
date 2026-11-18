"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { LogOutIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  Avatar,
  AvatarFallback,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
} from "@boilerplate/ui"

import { authClient } from "@/lib/auth/auth-client"

const MIN_PASSWORD_LENGTH = 8

type AccountUser = { name: string; email: string; createdAt: string }

export function AccountView({ user, sessionStartedAt }: { user: AccountUser; sessionStartedAt: string }) {
  const initials =
    user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?"

  return (
    <>
      <div className="flex items-center gap-4">
        <Avatar size="lg">
          <AvatarFallback className="font-medium">{initials}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 gap-0.5">
          <h2 className="truncate text-2xl font-semibold tracking-tight">{user.name}</h2>
          <p className="truncate text-muted-foreground">{user.email}</p>
        </div>
      </div>
      <ProfileCard user={user} />
      <PasswordCard />
      <SessionCard sessionStartedAt={sessionStartedAt} />
    </>
  )
}

function ProfileCard({ user }: { user: AccountUser }) {
  const router = useRouter()
  const [name, setName] = React.useState(user.name)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const changed = name.trim() !== user.name

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Enter your name.")
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await authClient.updateUser({ name: trimmed })
    setBusy(false)
    if (error) {
      setError(error.message ?? "Your name could not be saved.")
      return
    }
    toast.success("Your name was updated.")
    router.refresh()
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>
            <h3>Profile</h3>
          </CardTitle>
          <CardDescription>Shown in the sidebar and on change plans you approve.</CardDescription>
        </CardHeader>
        <CardContent className="py-6">
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input
                id="account-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                maxLength={100}
                aria-invalid={error ? true : undefined}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-email">Email</FieldLabel>
              <Input id="account-email" value={user.email} readOnly disabled />
              <FieldDescription>Your sign-in address. Member since {new Date(user.createdAt).toLocaleDateString()}.</FieldDescription>
            </Field>
            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button type="submit" disabled={busy || !changed}>
            {busy ? <Spinner aria-hidden="true" /> : null}
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function PasswordCard() {
  const formRef = React.useRef<HTMLFormElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [signOutOthers, setSignOutOthers] = React.useState(true)

  async function change(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get("currentPassword") ?? "")
    const newPassword = String(form.get("newPassword") ?? "")
    const confirm = String(form.get("confirmPassword") ?? "")
    setError(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirm) {
      setError("The new passwords do not match.")
      return
    }
    setBusy(true)
    const { error } = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: signOutOthers })
    setBusy(false)
    if (error) {
      setError(error.message ?? "The password could not be changed.")
      return
    }
    formRef.current?.reset()
    toast.success(signOutOthers ? "Password changed. Other devices were signed out." : "Password changed.")
  }

  return (
    <Card>
      <form ref={formRef} onSubmit={change}>
        <CardHeader>
          <CardTitle>
            <h3>Password</h3>
          </CardTitle>
          <CardDescription>Your password for this application. SAP passwords are entered separately per system.</CardDescription>
        </CardHeader>
        <CardContent className="py-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
              <Input id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" required />
            </Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="account-new-password">New password</FieldLabel>
                <Input
                  id="account-new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                  aria-describedby="account-new-password-description"
                />
                <FieldDescription id="account-new-password-description">At least {MIN_PASSWORD_LENGTH} characters.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="account-confirm-password">Repeat new password</FieldLabel>
                <Input id="account-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required />
              </Field>
            </div>
            <Field orientation="horizontal">
              <Checkbox id="account-sign-out-others" checked={signOutOthers} onCheckedChange={(checked) => setSignOutOthers(checked === true)} />
              <FieldLabel htmlFor="account-sign-out-others" className="font-normal">
                Sign out on all other devices
              </FieldLabel>
            </Field>
            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner aria-hidden="true" /> : null}
            Change password
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function SessionCard({ sessionStartedAt }: { sessionStartedAt: string }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  async function signOut() {
    setBusy(true)
    const { error } = await authClient.signOut()
    setBusy(false)
    if (error) {
      toast.error(error.message ?? "Sign-out failed.")
      return
    }
    toast.success("Signed out.")
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Session</h3>
        </CardTitle>
        <CardDescription>
          Signed in since {new Date(sessionStartedAt).toLocaleString()}. Signing out also ends your sessions on all SAP
          systems in this browser.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button type="button" variant="outline" onClick={signOut} disabled={busy}>
          {busy ? <Spinner aria-hidden="true" /> : <LogOutIcon aria-hidden="true" />}
          Sign out
        </Button>
      </CardFooter>
    </Card>
  )
}
