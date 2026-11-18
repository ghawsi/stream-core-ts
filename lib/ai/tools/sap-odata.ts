import { z } from "zod"

import { prisma } from "@/lib/db"
import { OPERATION_LABELS, type ChangePlanDiff, type ChangePlanView } from "@/lib/sap/agent-types"
import { describeODataPath, humanizeName } from "@/lib/sap/business"
import { SapSessionExpiredError, SapTransportError, type SapClient, type SapResponse } from "@/lib/sap/client"
import {
  buildKeyPredicate,
  findEntitySet,
  isStringEncodedNumber,
  isStringType,
  loadCatalog,
  MetadataUnavailableError,
  resolvePathType,
  typeOfSet,
  type EntityTypeInfo,
  type PropertyInfo,
  type ServiceCatalog,
} from "@/lib/sap/metadata"

/**
 * SAP OData V4 tools for the business data agent. Reads run directly;
 * writes only create a Change Plan that the user approves in the chat
 * (app/api/chat/change-plans/[planId]). Every request goes through SapClient,
 * so it uses the user's own SAP session and is audit-logged.
 */

export const QUERY_TOP_DEFAULT = 20
export const QUERY_TOP_MAX = 50
const MAX_TOOL_OUTPUT_CHARS = 12_000
const PLAN_TTL_MS = 30 * 60 * 1000
const MAX_PLANS_PER_TURN = 10

export type SapToolContext = {
  client: SapClient
  system: { id: string; name: string; sapClient: string; environment: string }
  userId: string
  chatId: string
  /** Called when a change plan has been stored, so the chat can show its card. */
  onChangePlan: (plan: ChangePlanView) => void
  plansCreated: number
}

export type SapToolResult = {
  /** Text returned to the model. */
  content: string
  isError: boolean
  /** One line for the chat UI. */
  summary: string
  /** True when SAP rejected the session; the user must sign in again. */
  sessionExpired?: boolean
}

// ---------- tool definitions (JSON Schema for the providers) ----------

const keysDescription =
  "Key properties and values, e.g. {\"Product\":\"EF-MAT\"} or {\"Product\":\"EF-MAT\",\"Plant\":\"1010\"}. Use the key names from sap_describe_entity."

export const SAP_TOOL_DEFINITIONS = [
  {
    name: "sap_list_entities",
    description:
      "Lists the entity sets of the connected SAP OData V4 service (from the live $metadata), with their key properties, navigation properties and whether they can be created, updated or deleted. Call this first when you do not yet know the exact entity set names.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to filter entity set names and labels, e.g. \"plant\" or \"description\"." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sap_describe_entity",
    description:
      "Describes one entity set from the live $metadata: key properties, every property with its Edm type, MaxLength and human-readable label, computed/immutable flags, and navigation properties. Use it to map business terms (for example \"profit center\" or \"old material number\") to exact property names before querying or changing data. Never guess property names.",
    parameters: {
      type: "object",
      properties: {
        entitySet: { type: "string", description: "Entity set name exactly as listed, e.g. \"Product\" or \"ProductPlant\"." },
        search: {
          type: "string",
          description: "Optional words to filter properties by name or label, e.g. \"profit center\". Leave out to get all properties.",
        },
      },
      required: ["entitySet"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_query_odata",
    description: [
      "Reads data with a GET request (never changes anything). Strict OData V4 syntax:",
      "- strings in single quotes, a quote inside a value doubled: Plant eq '1010', Name eq 'O''NEIL';",
      "- text search with contains(Field,'value'), startswith(...), endswith(...); never substringof;",
      "- dates and numbers unquoted: LastChangeDate ge 2026-01-01; never datetime'...';",
      "- combine with and / or, compare with eq ne gt ge lt le.",
      `Returns at most ${QUERY_TOP_MAX} records per call (default ${QUERY_TOP_DEFAULT}); use skip for further pages. The total count is returned. An empty result means no matching records exist: say so, never invent records.`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Entity set, or a navigation path from one entity: \"Product\", \"ProductDescription\", \"Product('EF-MAT')/_ProductPlant\".",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Properties to return (required; request only what you need), e.g. [\"Product\",\"ProductType\"].",
        },
        filter: { type: "string", description: "OData V4 $filter expression, e.g. \"ProductType eq 'FERT' and contains(Product,'PUMP')\"." },
        orderby: { type: "string", description: "e.g. \"Product asc\"." },
        top: { type: "integer", minimum: 1, maximum: QUERY_TOP_MAX, description: `Number of records, at most ${QUERY_TOP_MAX}.` },
        skip: { type: "integer", minimum: 0, description: "Records to skip (paging)." },
        expand: {
          type: "string",
          description:
            "Optional $expand with nested options separated by ';', at most two levels, e.g. \"_ProductDescription($select=Language,ProductDescription;$filter=Language eq 'EN')\".",
        },
      },
      required: ["path", "select"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_get_entity_by_key",
    description:
      "Reads one record by its complete key, including its ETag. A \"not found\" result means the record does not exist (a finding, not a failure).",
    parameters: {
      type: "object",
      properties: {
        entitySet: { type: "string", description: "Entity set name, e.g. \"Product\" or \"ProductPlant\"." },
        keys: { type: "object", description: keysDescription, additionalProperties: { type: ["string", "number", "boolean"] } },
        select: { type: "array", items: { type: "string" }, description: "Properties to return. Leave out for all properties." },
        expand: { type: "string", description: "Optional $expand, same rules as in sap_query_odata." },
      },
      required: ["entitySet", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_propose_change",
    description: [
      "Prepares a write (create, update, flag for deletion, delete) as a Change Plan. It reads the current values and ETag live from SAP, drops unchanged fields, and shows the plan to the user with Approve and Reject buttons. NOTHING is written to SAP by this tool; only the user's click executes the plan.",
      "- UPDATE: keys + changes with only the properties to change (never keys, computed or administrative fields).",
      "- FLAG_DELETION: logical, reversible deletion of a record (for example a product or its plant data); keys (+ changes with the deletion-flag property set to true if you know its name).",
      "- DELETE: physical deletion of list-type dependent records only (for example an additional-language description), where $metadata allows it.",
      "- CREATE: changes holds the new record. For a new dependent record pass parent {entitySet, keys, navigation}, e.g. navigation \"_ProductPlant\" or \"_Item\". Check the required fields with sap_describe_entity first.",
      "After calling it, tell the user in business terms what will change and that it is waiting for their approval in the card. Never say the change was made.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["UPDATE", "CREATE", "FLAG_DELETION", "DELETE"] },
        entitySet: { type: "string", description: "Entity set of the record to change or create." },
        keys: { type: "object", description: `${keysDescription} Required for UPDATE, FLAG_DELETION and DELETE.`, additionalProperties: { type: ["string", "number", "boolean"] } },
        changes: {
          type: "object",
          description: "Property values to set, e.g. {\"ProfitCenter\":\"YB101\"}. For CREATE the complete new record.",
          additionalProperties: true,
        },
        parent: {
          type: "object",
          description: "For CREATE of a dependent record: the parent record and the navigation property.",
          properties: {
            entitySet: { type: "string" },
            keys: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
            navigation: { type: "string", description: "e.g. \"_ProductPlant\" or \"_ProductDescription\"." },
          },
          required: ["entitySet", "keys", "navigation"],
        },
        reason: { type: "string", description: "Why, in the user's words; shown on the plan." },
      },
      required: ["operation", "entitySet", "reason"],
      additionalProperties: false,
    },
  },
] as const

export type SapToolName = (typeof SAP_TOOL_DEFINITIONS)[number]["name"]

// ---------- argument validation (lenient with common model mistakes) ----------

const stringList = z.preprocess(
  (value) => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value),
  z.array(z.string().trim().min(1)).min(1)
)
/** JSON text for objects, as models with a reduced schema (Gemini) send it. */
const parseJsonText = (value: unknown) => {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
const keyValues = z.preprocess(parseJsonText, z.union([z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), z.string()]))
const optionalText = z.preprocess((value) => (value === null || value === "" ? undefined : value), z.string().trim().optional())
const optionalInt = (max?: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : typeof value === "string" ? Number(value) : value),
    max === undefined ? z.number().int().min(0).optional() : z.number().int().min(1).max(max).optional()
  )

const schemas = {
  sap_list_entities: z.object({ search: optionalText }),
  sap_describe_entity: z.object({ entitySet: z.string().trim().min(1), search: optionalText }),
  sap_query_odata: z.object({
    path: z.string().trim().min(1),
    select: stringList,
    filter: optionalText,
    orderby: optionalText,
    top: optionalInt(QUERY_TOP_MAX),
    skip: optionalInt(),
    expand: optionalText,
  }),
  sap_get_entity_by_key: z.object({
    entitySet: z.string().trim().min(1),
    keys: keyValues,
    select: z.preprocess((value) => (value === null ? undefined : value), stringList.optional()),
    expand: optionalText,
  }),
  sap_propose_change: z.object({
    operation: z.enum(["UPDATE", "CREATE", "FLAG_DELETION", "DELETE"]),
    entitySet: z.string().trim().min(1),
    keys: keyValues.optional(),
    changes: z.preprocess(parseJsonText, z.record(z.string(), z.unknown()).optional()),
    parent: z.object({ entitySet: z.string().trim().min(1), keys: keyValues, navigation: z.string().trim().min(1) }).optional(),
    reason: z.string().trim().min(1).max(500),
  }),
} satisfies Record<SapToolName, z.ZodType>

// ---------- helpers ----------

function output(value: unknown): string {
  const text = JSON.stringify(value, null, 1)
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (output truncated; select fewer properties or records)`
}

function errorResult(message: string, summary = message): SapToolResult {
  return { content: output({ error: message }), isError: true, summary }
}

/** One line for the chat, in business words. */
const STATUS_SUMMARY: Record<number, string> = {
  400: "SAP refused the request",
  401: "Not signed in to SAP",
  403: "No authorization",
  404: "Not found",
  405: "Not supported by this API",
  409: "Conflict with existing data",
  412: "Changed by someone else",
  429: "SAP is busy",
  500: "SAP error",
  501: "Not supported by this API",
  503: "SAP is busy or unavailable",
}

/** SAP's error body, verbatim, so the model can correct the request (400) or explain it (403…). */
function sapErrorResult(response: SapResponse, hint?: string): SapToolResult {
  const error = response.error
  const meaning: Record<number, string> = {
    400: "Bad request: wrong property, value format or syntax, or a business validation error. Correct the request only if the fix is certain.",
    403: "Missing SAP authorization for this API or for the organizational unit (for example plant, company code or sales organization). Explain SAP's message in business terms; do not retry.",
    404: "Not found.",
    405: "Operation not supported by this API. Do not retry.",
    409: "Conflict, e.g. the record already exists.",
    412: "The record was changed by someone else since it was read.",
    428: "If-Match is missing.",
    429: "SAP is overloaded; try again later.",
    500: "SAP server error.",
    501: "Operation not supported by this API. Do not retry.",
    503: "SAP is overloaded or unavailable; try again later.",
  }
  return {
    content: output({
      httpStatus: response.status,
      meaning: meaning[response.status],
      sapError: error ? { code: error.code, message: error.message, target: error.target, details: error.details } : undefined,
      hint,
    }),
    isError: true,
    summary: `${STATUS_SUMMARY[response.status] ?? `SAP error ${response.status}`}${error?.message ? `: ${error.message}` : ""}`,
  }
}

/**
 * Business labels for the fields in the records ("ProductType" → "Product
 * Type"), from the metadata labels, so that answers use business headings.
 */
function fieldLabels(type: EntityTypeInfo, records: unknown[]): Record<string, string> | undefined {
  const names = new Set<string>()
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    for (const [name, value] of Object.entries(record)) {
      if (!name.startsWith("@") && value !== null && value !== "") names.add(name)
    }
  }
  const labels: Record<string, string> = {}
  for (const name of names) {
    const label = type.properties.find((property) => property.name === name)?.label ?? humanizeName(name)
    if (label && label !== name) labels[name] = label
  }
  return Object.keys(labels).length ? labels : undefined
}

function cleanRecord(record: unknown): unknown {
  if (Array.isArray(record)) return record.map(cleanRecord)
  if (!record || typeof record !== "object") return record
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("@odata.") && key !== "@odata.etag") continue
    result[key] = cleanRecord(value)
  }
  return result
}

function normaliseKeys(type: EntityTypeInfo, keys: Record<string, string | number | boolean> | string): Record<string, string | number | boolean> {
  if (typeof keys !== "string") return keys
  // "EF-MAT", "'EF-MAT'" or "Product='EF-MAT',Plant='1010'"
  const pairs = [...keys.matchAll(/(\w+)\s*=\s*('(?:[^']|'')*'|[^,]+)/g)]
  if (pairs.length > 0) {
    return Object.fromEntries(pairs.map(([, name, value]) => [name, value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value.trim()]))
  }
  if (type.keys.length === 1) return { [type.keys[0]]: keys.replace(/^'(.*)'$/, "$1") }
  throw new Error(`${type.name} has the keys ${type.keys.join(", ")}; pass them as an object.`)
}

/** Exact property names; fixes case only, otherwise reports close matches. */
function checkProperties(type: EntityTypeInfo, names: string[]): { names: string[] } | { error: string } {
  const fixed: string[] = []
  for (const name of names) {
    const exact = type.properties.find((property) => property.name === name)
    const nav = type.navigation.find((item) => item.name === name)
    if (exact || nav) {
      fixed.push(name)
      continue
    }
    const caseInsensitive = type.properties.find((property) => property.name.toLowerCase() === name.toLowerCase())
    if (caseInsensitive) {
      fixed.push(caseInsensitive.name)
      continue
    }
    const needle = name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const similar = type.properties
      .filter((property) => {
        const candidate = `${property.name} ${property.label ?? ""}`.toLowerCase().replace(/[^a-z0-9 ]/g, "")
        return candidate.includes(needle.slice(0, 6)) || needle.includes(property.name.toLowerCase().slice(0, 6))
      })
      .slice(0, 8)
      .map((property) => property.name)
    return {
      error: `${type.name} has no property "${name}".${similar.length ? ` Similar: ${similar.join(", ")}.` : ""} Call sap_describe_entity to see all properties.`,
    }
  }
  return { names: fixed }
}

function v2SyntaxProblem(text: string | undefined): string | null {
  if (!text) return null
  if (/substringof\s*\(/i.test(text)) return "substringof is OData V2. Use contains(Field,'value') in OData V4."
  if (/datetime(offset)?'/i.test(text)) return "datetime'…' is OData V2. Write dates unquoted in OData V4, e.g. LastChangeDate ge 2026-01-01."
  if (/guid'/i.test(text)) return "guid'…' is OData V2. Write GUIDs unquoted in OData V4."
  if (/"/.test(text)) return "OData V4 string literals use single quotes, not double quotes."
  return null
}

function expandTooDeep(expand: string | undefined) {
  if (!expand) return false
  return (expand.match(/\$expand=/g) ?? []).length > 1
}

/** Encodes characters that are not allowed in a URL path, leaving OData syntax intact. */
function encodeModelPath(path: string) {
  return path.replace(/[ #?&+%]/g, (char) => encodeURIComponent(char))
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Equal for the purpose of a change: "12.500" equals "12.5" for decimals; empty equals null. */
function sameValue(before: unknown, next: unknown) {
  if (display(before) === display(next)) return true
  const numeric = (value: unknown) => (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) ? Number(value) : null)
  const a = numeric(before)
  const b = numeric(next)
  return a !== null && b !== null && a === b
}

const ADMIN_FIELD = /^(CreatedBy|CreationDate|CreationTime|CreationDateTime|CreatedByUser|LastChangedBy|LastChangeDate|LastChangeTime|LastChangeDateTime|LastChangedByUser|LastChangedDateTime)$/i
const DELETION_FLAG = /(MarkedForDeletion|DeletionIndicator|DeletionFlag|IsDeleted)/i

/** Converts a value to the JSON form SAP expects for the Edm type (IEEE754Compatible=true). */
function convertValue(property: PropertyInfo, value: unknown): unknown {
  if (value === null) {
    if (!property.nullable) throw new Error(`${property.name} cannot be empty.`)
    return null
  }
  const type = property.type
  if (isStringType(type)) {
    const text = String(value)
    if (property.maxLength && text.length > property.maxLength) {
      throw new Error(`${property.name} has at most ${property.maxLength} characters; the new value has ${text.length}.`)
    }
    return text
  }
  if (isStringEncodedNumber(type)) {
    const text = String(value).trim()
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`${property.name} needs a number; got "${text}".`)
    return text
  }
  if (/^Edm\.(Int16|Int32|Byte|SByte|Double|Single)$/.test(type)) {
    const number = typeof value === "number" ? value : Number(value)
    if (!Number.isFinite(number)) throw new Error(`${property.name} needs a number; got "${String(value)}".`)
    return number
  }
  if (type === "Edm.Boolean") {
    if (typeof value === "boolean") return value
    if (value === "true" || value === "X") return true
    if (value === "false" || value === "") return false
    throw new Error(`${property.name} needs true or false.`)
  }
  if (type === "Edm.Date") {
    const text = String(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${property.name} needs a date like 2026-11-17.`)
    return text
  }
  return value
}

// ---------- executors ----------

async function catalogOrError(ctx: SapToolContext): Promise<ServiceCatalog | SapToolResult> {
  try {
    return await loadCatalog(ctx.client)
  } catch (error) {
    if (error instanceof MetadataUnavailableError) return errorResult(error.message, "Service metadata unavailable")
    throw error
  }
}

const isResult = (value: unknown): value is SapToolResult =>
  typeof value === "object" && value !== null && "content" in value && "isError" in value

async function listEntities(args: z.infer<(typeof schemas)["sap_list_entities"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const search = args.search?.toLowerCase()
  const sets = catalog.entitySets
    .filter((set) => !search || set.name.toLowerCase().includes(search) || set.label?.toLowerCase().includes(search))
    .slice(0, 80)
    .map((set) => {
      const type = typeOfSet(catalog, set)
      return {
        entitySet: set.name,
        label: set.label ?? type?.label,
        keys: type?.keys ?? [],
        navigation: type?.navigation.map((nav) => nav.name) ?? [],
        insertable: set.insertable,
        updatable: set.updatable,
        deletable: set.deletable,
      }
    })
  return {
    content: output({ system: ctx.system.name, entitySets: sets, total: catalog.entitySets.length }),
    isError: false,
    summary: `${sets.length} kind${sets.length === 1 ? "" : "s"} of business data`,
  }
}

async function describeEntity(args: z.infer<(typeof schemas)["sap_describe_entity"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const set = findEntitySet(catalog, args.entitySet)
  if (!set) return errorResult(`There is no entity set "${args.entitySet}". Call sap_list_entities.`)
  const type = typeOfSet(catalog, set)
  if (!type) return errorResult(`The type of ${set.name} is missing from $metadata.`)

  const words = args.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const properties = type.properties
    .filter((property) => {
      if (words.length === 0) return true
      const haystack = `${property.name} ${property.label ?? ""}`.toLowerCase()
      return words.every((word) => haystack.includes(word)) || words.some((word) => property.name.toLowerCase().includes(word))
    })
    .slice(0, 200)
    .map((property) => ({
      name: property.name,
      type: property.type,
      ...(property.maxLength ? { maxLength: property.maxLength } : {}),
      ...(property.label ? { label: property.label } : {}),
      ...(type.keys.includes(property.name) ? { key: true } : {}),
      ...(property.computed ? { computed: true } : {}),
      ...(property.immutable ? { immutable: true } : {}),
    }))
  const deletionFlags = type.properties.filter((property) => DELETION_FLAG.test(property.name)).map((property) => property.name)

  return {
    content: output({
      entitySet: set.name,
      keys: type.keys,
      insertable: set.insertable,
      updatable: set.updatable,
      deletable: set.deletable,
      properties,
      ...(words.length && properties.length === 0 ? { note: `No property matches "${args.search}". This field may not be exposed by this API.` } : {}),
      navigation: type.navigation.map((nav) => ({
        name: nav.name,
        target: catalog.entityTypes.get(nav.targetType)?.name ?? nav.targetType,
        collection: nav.collection,
      })),
      ...(deletionFlags.length ? { deletionFlagProperties: deletionFlags } : {}),
    }),
    isError: false,
    summary: `${properties.length} field${properties.length === 1 ? "" : "s"} of ${humanizeName(set.name)}`,
  }
}

async function queryOData(args: z.infer<(typeof schemas)["sap_query_odata"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  if (/\$/.test(args.path.split("?")[0]) || args.path.includes("?")) {
    return errorResult("The path holds the entity set or navigation only; pass $select, $filter and the other options as separate arguments.")
  }
  const resolved = resolvePathType(catalog, args.path)
  if ("error" in resolved) return errorResult(resolved.error)
  const selected = checkProperties(resolved.type, args.select)
  if ("error" in selected) return errorResult(selected.error)
  const syntax = v2SyntaxProblem(args.filter) ?? v2SyntaxProblem(args.expand)
  if (syntax) return errorResult(syntax)
  if (expandTooDeep(args.expand)) return errorResult("Keep $expand to at most two levels; query the dependent entity set directly instead.")

  const top = Math.min(args.top ?? QUERY_TOP_DEFAULT, QUERY_TOP_MAX)
  const response = await ctx.client.request({
    method: "GET",
    path: encodeModelPath(args.path),
    query: {
      $select: selected.names.join(","),
      $filter: args.filter,
      $orderby: args.orderby,
      $expand: args.expand,
      ...(resolved.collection ? { $top: String(top), $skip: args.skip ? String(args.skip) : undefined, $count: "true" } : {}),
    },
    toolName: "sap_query_odata",
  })
  if (!response.ok) return sapErrorResult(response)

  const data = response.data as { value?: unknown[]; "@odata.count"?: number | string; "@odata.nextLink"?: string } | null
  if (!resolved.collection || !Array.isArray(data?.value)) {
    return {
      content: output({ fieldLabels: fieldLabels(resolved.type, [data]), record: cleanRecord(data), etag: response.etag }),
      isError: false,
      summary: "1 record",
    }
  }
  const total = data["@odata.count"] === undefined ? undefined : Number(data["@odata.count"])
  const returned = data.value.length
  const skip = args.skip ?? 0
  const more = total !== undefined ? skip + returned < total : Boolean(data["@odata.nextLink"])
  return {
    content: output({
      totalCount: total,
      returned,
      ...(more ? { moreAvailable: true, nextSkip: skip + returned } : {}),
      ...(returned === 0 ? { note: "No records match. Report that no data was found; do not invent records." } : {}),
      ...(response.sapMessages.length ? { sapMessages: response.sapMessages } : {}),
      fieldLabels: fieldLabels(resolved.type, data.value),
      records: cleanRecord(data.value),
    }),
    isError: false,
    summary: `${returned} of ${total ?? "?"} record${total === 1 ? "" : "s"}`,
  }
}

async function getEntityByKey(args: z.infer<(typeof schemas)["sap_get_entity_by_key"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const set = findEntitySet(catalog, args.entitySet)
  if (!set) return errorResult(`There is no entity set "${args.entitySet}". Call sap_list_entities.`)
  const type = typeOfSet(catalog, set)
  if (!type) return errorResult(`The type of ${set.name} is missing from $metadata.`)

  let predicate: string
  let keys: Record<string, string | number | boolean>
  try {
    keys = normaliseKeys(type, args.keys)
    predicate = buildKeyPredicate(type, keys)
  } catch (error) {
    return errorResult((error as Error).message)
  }
  let select: string[] | undefined
  if (args.select) {
    const checked = checkProperties(type, args.select)
    if ("error" in checked) return errorResult(checked.error)
    select = checked.names
  }
  const syntax = v2SyntaxProblem(args.expand)
  if (syntax) return errorResult(syntax)
  if (expandTooDeep(args.expand)) return errorResult("Keep $expand to at most two levels.")

  const response = await ctx.client.request({
    method: "GET",
    path: `${set.name}${predicate}`,
    query: { $select: select?.join(","), $expand: args.expand },
    toolName: "sap_get_entity_by_key",
  })
  if (response.status === 404) {
    return {
      content: output({ found: false, message: `${set.name} ${JSON.stringify(keys)} does not exist in ${ctx.system.name}.` }),
      isError: false,
      summary: "Not found",
    }
  }
  if (!response.ok) return sapErrorResult(response)
  return {
    content: output({
      found: true,
      etag: response.etag,
      ...(response.sapMessages.length ? { sapMessages: response.sapMessages } : {}),
      fieldLabels: fieldLabels(type, [response.data]),
      record: cleanRecord(response.data),
    }),
    isError: false,
    summary: "1 record",
  }
}

async function proposeChange(args: z.infer<(typeof schemas)["sap_propose_change"]>, ctx: SapToolContext): Promise<SapToolResult> {
  if (ctx.plansCreated >= MAX_PLANS_PER_TURN) {
    return errorResult(`At most ${MAX_PLANS_PER_TURN} change plans per message. Ask the user to approve these first.`)
  }
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const set = findEntitySet(catalog, args.entitySet)
  if (!set) return errorResult(`There is no entity set "${args.entitySet}". Call sap_list_entities.`)
  const type = typeOfSet(catalog, set)
  if (!type) return errorResult(`The type of ${set.name} is missing from $metadata.`)

  let method: "PATCH" | "POST" | "DELETE"
  let path: string
  let etag: string | null = null
  let payload: Record<string, unknown> | null = null
  let diff: ChangePlanDiff[] = []
  const label = (name: string) => type.properties.find((property) => property.name === name)?.label

  try {
    if (args.operation === "UPDATE" || args.operation === "FLAG_DELETION" || args.operation === "DELETE") {
      if (!args.keys) return errorResult(`${args.operation} needs the keys of the record.`)
      const keys = normaliseKeys(type, args.keys)
      path = `${set.name}${buildKeyPredicate(type, keys)}`
    } else {
      path = set.name
    }

    if (args.operation === "UPDATE" || args.operation === "FLAG_DELETION") {
      if (!set.updatable) return errorResult(`${set.name} cannot be updated through this API ($metadata: Updatable=false).`)
      let changes = { ...(args.changes ?? {}) }
      if (args.operation === "FLAG_DELETION" && Object.keys(changes).length === 0) {
        const flags = type.properties.filter((property) => DELETION_FLAG.test(property.name) && property.type === "Edm.Boolean")
        if (flags.length !== 1) {
          return errorResult(
            flags.length === 0
              ? `${set.name} has no deletion-flag property. Deletion is not possible through this API for this entity.`
              : `${set.name} has several deletion-flag candidates (${flags.map((f) => f.name).join(", ")}); pass the right one in changes.`
          )
        }
        changes = { [flags[0].name]: true }
      }
      if (Object.keys(changes).length === 0) return errorResult("changes is empty: name the properties to change.")

      const converted: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(changes)) {
        const property = type.properties.find((item) => item.name === name) ?? type.properties.find((item) => item.name.toLowerCase() === name.toLowerCase())
        if (!property) return errorResult(`${set.name} has no property "${name}". Call sap_describe_entity.`)
        if (type.keys.includes(property.name)) return errorResult(`${property.name} is a key and cannot be changed.`)
        if (property.computed || property.immutable || ADMIN_FIELD.test(property.name)) {
          return errorResult(`${property.name} is maintained by SAP (computed, immutable or administrative) and cannot be changed.`)
        }
        converted[property.name] = convertValue(property, value)
      }

      // U1: read immediately before writing, capture the ETag.
      const current = await ctx.client.request({
        method: "GET",
        path,
        query: { $select: [...type.keys, ...Object.keys(converted)].join(",") },
        toolName: "sap_propose_change",
      })
      if (current.status === 404) return errorResult(`${path} does not exist in ${ctx.system.name}.`, "Record not found")
      if (!current.ok) return sapErrorResult(current)
      if (!current.etag) return errorResult("SAP returned no ETag for this record, so it cannot be updated safely.")
      etag = current.etag
      const record = (current.data ?? {}) as Record<string, unknown>

      // U2: keep only real changes.
      payload = {}
      for (const [name, next] of Object.entries(converted)) {
        const before = record[name]
        if (sameValue(before, next)) continue
        payload[name] = next
        diff.push({ field: name, label: label(name), current: display(before), next: display(next) })
      }
      if (diff.length === 0) {
        return {
          content: output({ status: "NO_CHANGE_REQUIRED", message: "The record already has these values. Nothing needs to be sent.", current: cleanRecord(record) }),
          isError: false,
          summary: "No change required",
        }
      }
      method = "PATCH"
    } else if (args.operation === "DELETE") {
      if (!set.deletable) {
        return errorResult(`${set.name} cannot be deleted through this API ($metadata: Deletable=false). Offer FLAG_DELETION instead.`)
      }
      const current = await ctx.client.request({ method: "GET", path, query: { $select: type.keys.join(",") }, toolName: "sap_propose_change" })
      if (current.status === 404) return errorResult(`${path} does not exist in ${ctx.system.name}.`, "Record not found")
      if (!current.ok) return sapErrorResult(current)
      if (!current.etag) return errorResult("SAP returned no ETag for this record, so it cannot be deleted safely.")
      etag = current.etag

      // D3: never delete the last remaining description of a product.
      if (/description/i.test(set.name) && args.keys && typeof args.keys !== "string" && "Product" in args.keys) {
        const product = String(args.keys.Product).replace(/'/g, "''")
        const siblings = await ctx.client.request({
          method: "GET",
          path: set.name,
          query: { $filter: `Product eq '${product}'`, $count: "true", $top: "0" },
          toolName: "sap_propose_change",
        })
        const count = Number((siblings.data as { "@odata.count"?: number | string } | null)?.["@odata.count"] ?? 2)
        if (siblings.ok && count <= 1) return errorResult("This is the product's last description. A product needs at least one description.")
      }
      diff = [{ field: "(record)", current: "exists", next: "deleted" }]
      method = "DELETE"
    } else {
      // CREATE
      const changes = args.changes ?? {}
      if (Object.keys(changes).length === 0) return errorResult("changes must hold the new record.")
      if (args.parent) {
        const parentSet = findEntitySet(catalog, args.parent.entitySet)
        const parentType = parentSet ? typeOfSet(catalog, parentSet) : undefined
        if (!parentSet || !parentType) return errorResult(`There is no entity set "${args.parent.entitySet}".`)
        const nav = parentType.navigation.find((item) => item.name === args.parent!.navigation)
        if (!nav) return errorResult(`${parentType.name} has no navigation "${args.parent.navigation}". It has ${parentType.navigation.map((n) => n.name).join(", ")}.`)
        const parentPath = `${parentSet.name}${buildKeyPredicate(parentType, normaliseKeys(parentType, args.parent.keys))}`
        const parent = await ctx.client.request({ method: "GET", path: parentPath, query: { $select: parentType.keys.join(",") }, toolName: "sap_propose_change" })
        if (parent.status === 404) return errorResult(`The parent ${parentPath} does not exist.`)
        if (!parent.ok) return sapErrorResult(parent)
        path = `${parentPath}/${nav.name}`
      } else if (!set.insertable) {
        return errorResult(`${set.name} does not allow inserts ($metadata: Insertable=false).`)
      }

      payload = {}
      for (const [name, value] of Object.entries(changes)) {
        const property = type.properties.find((item) => item.name === name)
        const nav = type.navigation.find((item) => item.name === name)
        if (!property && !nav) return errorResult(`${set.name} has no property or navigation "${name}". Call sap_describe_entity.`)
        payload[name] = property ? convertValue(property, value) : value
        diff.push({ field: name, label: property?.label, current: "—", next: display(payload[name]) })
      }

      // C0(c): the target must not exist yet (root records with a complete key).
      if (!args.parent && type.keys.every((key) => key in payload!)) {
        const keyValues = Object.fromEntries(type.keys.map((key) => [key, payload![key] as string]))
        const existing = await ctx.client.request({
          method: "GET",
          path: `${set.name}${buildKeyPredicate(type, keyValues)}`,
          query: { $select: type.keys.join(",") },
          toolName: "sap_propose_change",
        })
        if (existing.ok) return errorResult(`${set.name} ${JSON.stringify(keyValues)} already exists. Offer an UPDATE instead.`, "Already exists")
      }
      method = "POST"
    }
  } catch (error) {
    if (error instanceof SapSessionExpiredError || error instanceof SapTransportError) throw error
    return errorResult((error as Error).message)
  }

  const expiresAt = new Date(Date.now() + PLAN_TTL_MS)
  const plan = await prisma.sapChangePlan.create({
    data: {
      userId: ctx.userId,
      sapSystemId: ctx.system.id,
      chatId: ctx.chatId,
      operation: args.operation,
      method,
      entitySet: set.name,
      path,
      etag,
      payload: payload ? JSON.stringify(payload) : null,
      diff: JSON.stringify(diff),
      reason: args.reason,
      expiresAt,
    },
  })
  ctx.plansCreated += 1
  ctx.onChangePlan({
    id: plan.id,
    operation: args.operation,
    method,
    entitySet: set.name,
    path,
    reason: args.reason,
    diff,
    systemName: ctx.system.name,
    sapClient: ctx.system.sapClient,
    environment: ctx.system.environment,
    status: "PENDING",
    resultStatus: null,
    resultMessage: null,
    decidedBy: null,
    decidedAt: null,
    expiresAt: expiresAt.toISOString(),
  })

  return {
    content: output({
      status: "AWAITING_USER_APPROVAL",
      planId: plan.id,
      operation: args.operation,
      request: `${method} ${path}`,
      changes: diff,
      note: "Nothing has been sent to SAP. The user approves or rejects this Change Plan with the buttons shown in the app. Tell them it is waiting for their approval; do not claim the change was made and do not ask them to type APPROVE.",
    }),
    isError: false,
    summary: `Waiting for your approval (${diff.length} field${diff.length === 1 ? "" : "s"})`,
  }
}

// ---------- dispatch ----------

export function toolLabel(name: string, args: Record<string, unknown>): string {
  const keys = (raw: unknown) => {
    const value = parseJsonText(raw)
    return value && typeof value === "object" ? Object.values(value as Record<string, unknown>).map(String).join(", ") : value ? String(value) : ""
  }
  const operation = OPERATION_LABELS[String(args.operation) as keyof typeof OPERATION_LABELS] ?? "Change"
  switch (name) {
    case "sap_list_entities":
      return "Checking which business data is available"
    case "sap_describe_entity":
      return `Looking up the fields of ${humanizeName(String(args.entitySet ?? "the data"))}`
    case "sap_query_odata":
      return `Looking up ${describeODataPath(String(args.path ?? "data"))}`
    case "sap_get_entity_by_key":
      return `Reading ${humanizeName(String(args.entitySet ?? ""))} ${keys(args.keys)}`.trim()
    case "sap_propose_change":
      return `Preparing a change for your approval: ${operation} ${humanizeName(String(args.entitySet ?? ""))} ${keys(args.keys)}`.trim()
    default:
      return name
  }
}

export async function executeSapTool(name: string, rawArguments: string, ctx: SapToolContext): Promise<SapToolResult> {
  if (!(name in schemas)) return errorResult(`Unknown tool "${name}".`)
  let parsedJson: unknown
  try {
    parsedJson = rawArguments.trim() ? JSON.parse(rawArguments) : {}
  } catch {
    return errorResult(`The arguments are not valid JSON: ${rawArguments.slice(0, 300)}`, "Invalid arguments")
  }
  const parsed = schemas[name as SapToolName].safeParse(parsedJson)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")
    return errorResult(`Invalid arguments: ${issues}`, "Invalid arguments")
  }

  try {
    switch (name as SapToolName) {
      case "sap_list_entities":
        return await listEntities(parsed.data as z.infer<(typeof schemas)["sap_list_entities"]>, ctx)
      case "sap_describe_entity":
        return await describeEntity(parsed.data as z.infer<(typeof schemas)["sap_describe_entity"]>, ctx)
      case "sap_query_odata":
        return await queryOData(parsed.data as z.infer<(typeof schemas)["sap_query_odata"]>, ctx)
      case "sap_get_entity_by_key":
        return await getEntityByKey(parsed.data as z.infer<(typeof schemas)["sap_get_entity_by_key"]>, ctx)
      case "sap_propose_change":
        return await proposeChange(parsed.data as z.infer<(typeof schemas)["sap_propose_change"]>, ctx)
    }
  } catch (error) {
    if (error instanceof SapSessionExpiredError) {
      return { ...errorResult(`${error.message} Tell the user to sign in to ${ctx.system.name} again and resend the request.`, "SAP session ended"), sessionExpired: true }
    }
    if (error instanceof SapTransportError) {
      return errorResult(`${error.message} Report that ${ctx.system.name} is not reachable; do not guess any data.`, "SAP not reachable")
    }
    throw error
  }
  return errorResult(`Unknown tool "${name}".`)
}
