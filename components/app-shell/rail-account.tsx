"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LogInIcon, LogOutIcon, UserPlusIcon, UserRoundIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@boilerplate/ui"

import { authClient } from "@/lib/auth/auth-client"
import { railButtonClass } from "./rail-styles"

function initials(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
  return letters || "?"
}

/**
 * The rail's account entry: the signed-in user's initials, opening a menu with
 * their name and email, Account and Sign out; when signed out, Sign in and
 * Create account. The session is read in the browser, so the rail itself
 * stays static.
 */
export function RailAccount({ current }: { current: boolean }) {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [signingOut, setSigningOut] = React.useState(false)
  const user = session?.user
  const label = user ? `Account: ${user.name}` : "Account"

  async function signOut() {
    setSigningOut(true)
    const { error } = await authClient.signOut()
    setSigningOut(false)
    if (error) {
      toast.error(error.message ?? "Sign-out failed.")
      return
    }
    toast.success("Signed out.")
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className={railButtonClass(current)}
              aria-label={label}
              aria-current={current ? "page" : undefined}
            >
              {user ? (
                <Avatar size="sm">
                  <AvatarFallback className="text-xs font-medium">{initials(user.name)}</AvatarFallback>
                </Avatar>
              ) : (
                <UserRoundIcon aria-hidden="true" className="size-5" strokeWidth={current ? 2.75 : 2} />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {user ? user.name : "Account"}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-64">
        {user ? (
          <>
            <DropdownMenuLabel className="grid gap-0.5">
              <span className="truncate">{user.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account">
                <UserRoundIcon aria-hidden="true" />
                Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()} disabled={signingOut}>
              <LogOutIcon aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {isPending ? "Checking your session…" : "You are not signed in."}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/sign-in">
                <LogInIcon aria-hidden="true" />
                Sign in
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/sign-up">
                <UserPlusIcon aria-hidden="true" />
                Create account
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
