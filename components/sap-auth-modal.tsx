"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react"
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Spinner,
} from "@boilerplate/ui"

import { sapSignInStore, type SapSignInRequest } from "@/lib/sap-fetch"

/**
 * Global just-in-time SAP sign-in. Mounted once in the root layout; opens
 * whenever sapFetch() meets SAP_AUTH_REQUIRED, or when code calls
 * requestSapSignIn() directly.
 */
export function SapAuthModal() {
  const request = React.useSyncExternalStore(sapSignInStore.subscribe, sapSignInStore.getSnapshot, sapSignInStore.getServerSnapshot)
  // Keep the last request while the dialog animates closed.
  const [shown, setShown] = React.useState<SapSignInRequest | null>(null)
  if (request && request !== shown) setShown(request)

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && request?.settle(false)}>
      <DialogContent className="sm:max-w-md">
        {shown ? <SignInForm key={shown.systemId} request={shown} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function SignInForm({ request }: { request: SapSignInRequest }) {
  const router = useRouter()
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const id = React.useId()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/sap/${encodeURIComponent(request.systemId)}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      })
      if (response.ok) {
        request.settle(true)
        // Connection badges elsewhere on the page read the new cookie.
        router.refresh()
        return
      }
      const data = (await response.json().catch(() => null)) as { message?: string } | null
      setError(data?.message ?? `Sign-in failed (${response.status}).`)
    } catch {
      setError("The sign-in request failed. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" aria-hidden="true" />
          Sign in to {request.systemName}
        </DialogTitle>
        <DialogDescription>{request.message}</DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-username`}>SAP user</FieldLabel>
          <Input
            id={`${id}-username`}
            name="username"
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={`${id}-password`}
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              aria-describedby={`${id}-hint`}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription id={`${id}-hint`}>
            Kept only in an encrypted, HttpOnly session cookie for this browser session. Never saved in the database.
          </FieldDescription>
        </Field>
      </FieldGroup>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => request.settle(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner aria-hidden="true" /> : null}
          Sign in
        </Button>
      </DialogFooter>
    </form>
  )
}
