import { prisma } from "@/lib/db"
import type { ChangePlanDiff, ChangePlanStatus, ChangePlanView } from "@/lib/sap/agent-types"

type PlanRow = {
  id: string
  operation: string
  method: string
  entitySet: string
  path: string
  reason: string
  diff: string
  status: string
  resultStatus: number | null
  resultMessage: string | null
  decidedBy: string | null
  decidedAt: Date | null
  expiresAt: Date
  sapSystem: { name: string; sapClient: string; environment: string }
}

/** Plan rows and warnings as stored in SapChangePlan.diff: {rows, warnings}, or a plain row array (older plans). */
export function serializePlanDiff(rows: ChangePlanDiff[], warnings: string[]) {
  return JSON.stringify(warnings.length ? { rows, warnings } : rows)
}

export function toChangePlanView(plan: PlanRow): ChangePlanView {
  let diff: ChangePlanDiff[] = []
  let warnings: string[] = []
  try {
    const stored = JSON.parse(plan.diff) as ChangePlanDiff[] | { rows?: ChangePlanDiff[]; warnings?: string[] }
    if (Array.isArray(stored)) diff = stored
    else {
      diff = stored.rows ?? []
      warnings = stored.warnings ?? []
    }
  } catch {
    diff = []
  }
  // A pending plan past its expiry is shown as expired even before anyone acts on it.
  const status = (plan.status === "PENDING" && plan.expiresAt.getTime() < Date.now() ? "EXPIRED" : plan.status) as ChangePlanStatus
  return {
    id: plan.id,
    operation: plan.operation as ChangePlanView["operation"],
    method: plan.method,
    entitySet: plan.entitySet,
    path: plan.path,
    reason: plan.reason,
    diff,
    warnings,
    systemName: plan.sapSystem.name,
    sapClient: plan.sapSystem.sapClient,
    environment: plan.sapSystem.environment,
    status,
    resultStatus: plan.resultStatus,
    resultMessage: plan.resultMessage,
    decidedBy: plan.decidedBy,
    decidedAt: plan.decidedAt?.toISOString() ?? null,
    expiresAt: plan.expiresAt.toISOString(),
  }
}

export const planInclude = { sapSystem: { select: { name: true, sapClient: true, environment: true } } } as const

/** Plans by ID that belong to the user, keyed by ID. */
export async function loadChangePlanViews(ids: string[], userId: string | null): Promise<Map<string, ChangePlanView>> {
  if (!userId || ids.length === 0) return new Map()
  const plans = await prisma.sapChangePlan.findMany({ where: { id: { in: ids }, userId }, include: planInclude })
  return new Map(plans.map((plan) => [plan.id, toChangePlanView(plan)]))
}
