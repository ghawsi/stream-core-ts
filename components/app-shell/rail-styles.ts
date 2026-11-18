import { cn } from "@boilerplate/ui"

/**
 * Rail button look. Current page: three signals, never colour alone: the
 * selected fill, a visible border, and (set by the caller) a heavier glyph.
 */
export function railButtonClass(current: boolean) {
  return cn(
    "relative border-2",
    current
      ? "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent"
      : "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
  )
}
