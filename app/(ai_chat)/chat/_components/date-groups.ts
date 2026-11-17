import * as React from "react"

export type DateGroupLabel = "Today" | "Yesterday" | "Previous 7 Days" | "Older"

const DAY_MS = 24 * 60 * 60 * 1000

function startOfLocalDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function subscribe(onChange: () => void) {
  // Re-group once a minute so that "Today" becomes "Yesterday" after midnight.
  const interval = window.setInterval(onChange, 60_000)
  return () => window.clearInterval(interval)
}

/**
 * Start of the current local day, or null during server rendering. Grouping by
 * day depends on the viewer's time zone, so the server renders an ungrouped
 * list and the client groups it after hydration without a mismatch.
 */
export function useStartOfToday(): number | null {
  return React.useSyncExternalStore(
    subscribe,
    () => startOfLocalDay(Date.now()),
    () => null
  )
}

export function groupByDate<T extends { updatedAt: Date | string }>(
  items: T[],
  startOfToday: number | null
): { label: DateGroupLabel | "Recent"; items: T[] }[] {
  if (startOfToday === null) return items.length ? [{ label: "Recent", items }] : []

  const order: DateGroupLabel[] = ["Today", "Yesterday", "Previous 7 Days", "Older"]
  const groups = new Map<DateGroupLabel, T[]>(order.map((label) => [label, []]))

  for (const item of items) {
    const time = new Date(item.updatedAt).getTime()
    const label: DateGroupLabel =
      time >= startOfToday
        ? "Today"
        : time >= startOfToday - DAY_MS
          ? "Yesterday"
          : time >= startOfToday - 7 * DAY_MS
            ? "Previous 7 Days"
            : "Older"
    groups.get(label)!.push(item)
  }

  return order.map((label) => ({ label, items: groups.get(label)! })).filter((group) => group.items.length > 0)
}
