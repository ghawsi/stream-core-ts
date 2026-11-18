import { z } from "zod"

import { prisma } from "@/lib/db"
import { OPERATION_LABELS, type ChangePlanDiff, type ChangePlanView } from "@/lib/sap/agent-types"
import { businessAreaFor, describeODataPath, humanizeName } from "@/lib/sap/business"
import { SapSessionExpiredError, SapTransportError, type SapClient, type SapResponse } from "@/lib/sap/client"
import {
  buildKeyPredicate,
  isStringEncodedNumber,
  isStringType,
  loadCatalog,
  MetadataUnavailableError,
  typeOfSet,
  type EntitySetInfo,
  type EntityTypeInfo,
  type PropertyInfo,
  type ServiceCatalog,
} from "@/lib/sap/metadata"
import {
  andFilters,
  buildConditions,
  buildExpand,
  defaultSelect,
  normalizeFilter,
  normalizeName,
  normalizeOrderby,
  parseCount,
  parseExpandInput,
  parseLooseJson,
  parseObject,
  parsePredicate,
  QueryInputError,
  resolveEntitySet,
  resolveNavigation,
  resolveProperty,
  resolveSelect,
  splitPath,
  toIsoDate,
  toNumberText,
  type ExpandSpec,
} from "@/lib/sap/odata-query"

/**
 * SAP OData V4 tools for the business data agent. Reads run directly;
 * writes only create a Change Plan that the user approves in the chat
 * (app/api/chat/change-plans/[planId]). Every request goes through SapClient,
 * so it uses the user's own SAP session and is audit-logged.
 *
 * The tools are deliberately forgiving about how a model passes arguments
 * (aliases, Python-style lists, labels instead of field names, SQL or V2
 * filter syntax, broken $expand) and strict about what reaches SAP: every
 * name is resolved against the live $metadata and every query option is
 * rebuilt in valid OData V4 syntax (lib/sap/odata-query.ts).
 */

export const QUERY_TOP_DEFAULT = 20
export const QUERY_TOP_MAX = 50
const MAX_TOOL_OUTPUT_CHARS = 12_000
const PLAN_TTL_MS = 30 * 60 * 1000
const MAX_PLANS_PER_TURN = 10

export type SapToolContext = {
  client: SapClient
  system: { id: string; name: string; sapClient: string; environment: string; servicePath: string }
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
  /** Records read from SAP, for the answer check in the agent loop. */
  dataRows?: number
}

// ---------- tool definitions (JSON Schema for the providers) ----------

const keysDescription =
  "Key fields and values as an object, e.g. {\"Product\":\"<product number>\"} or {\"Product\":\"<product number>\",\"Plant\":\"<plant>\"}."

const conditionSchema = {
  type: "object",
  properties: {
    field: { type: "string", description: "Field name (or its label)." },
    operator: {
      type: "string",
      enum: ["eq", "ne", "gt", "ge", "lt", "le", "contains", "startswith", "endswith", "in", "between"],
    },
    value: { type: "string", description: "Plain value (numbers and true/false as text too): no quotes, no OData syntax. * at the start or end works as a wildcard." },
    values: { type: "array", items: { type: "string" }, description: "For in (several values) and between (from, to)." },
  },
  required: ["field", "operator"],
}

const conditionsProperty = {
  type: "array",
  items: conditionSchema,
  description:
    "Filter conditions, combined with AND (or OR with match \"any\"). Preferred over filter: the tool writes correct OData syntax for quotes, numbers, dates and wildcards.",
}

const expandProperty = {
  type: "array",
  items: {
    type: "object",
    properties: {
      navigation: { type: "string", description: "Navigation property, e.g. \"_ProductDescription\" or \"_ProductPlant\"." },
      select: { type: "array", items: { type: "string" } },
      conditions: { type: "array", items: conditionSchema },
      orderby: { type: "string" },
      top: { type: "integer" },
    },
    required: ["navigation"],
  },
  description: "Related records to include (one or two levels), e.g. descriptions or plant data. A plain OData $expand string also works.",
}

export const SAP_TOOL_DEFINITIONS = [
  {
    name: "sap_list_entities",
    description:
      "Lists the entity sets of the connected SAP OData V4 service (from the live $metadata): names, labels, keys, related data and whether records can be created, updated or deleted. The main (root) entity sets are marked. Call it when you do not know the entity set names yet.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional words to filter by name or label, e.g. \"plant\" or \"description\". Leave out to list everything." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sap_describe_entity",
    description:
      "Describes one entity set from the live $metadata: key fields, every field with its type, maximum length and business label, which fields SAP calculates, and the related data (navigation properties). Use it to map business terms (\"profit center\", \"old material number\") to field names.",
    parameters: {
      type: "object",
      properties: {
        entitySet: { type: "string", description: "Entity set name, e.g. \"Product\" or \"ProductPlant\"." },
        search: { type: "string", description: "Optional words to find fields by name or label, e.g. \"profit center\". Leave out for all fields." },
      },
      required: ["entitySet"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_query_odata",
    description: [
      "Reads records from SAP with a GET request (never changes anything): lists, searches, counts, and dependent data of one record.",
      "Pass plain values; the tool builds the OData query. Examples:",
      '- first 10 products: {"path":"Product","top":10}',
      '- products whose number starts with ABC: {"path":"Product","conditions":[{"field":"Product","operator":"startswith","value":"ABC"}]}',
      '- with their English names: {"path":"Product","select":["Product","ProductType"],"expand":[{"navigation":"_ProductDescription","select":["ProductDescription"],"conditions":[{"field":"Language","operator":"eq","value":"EN"}]}]}',
      '- the plant data of one product: {"path":"Product(\'<product number>\')/_ProductPlant"}',
      '- how many products have type FERT: {"path":"Product","count":true,"conditions":[{"field":"ProductType","operator":"eq","value":"FERT"}]}',
      `Returns at most ${QUERY_TOP_MAX} records per call (default ${QUERY_TOP_DEFAULT}), the total count, field labels and the query that was sent. Page with skip. No records means none match: say so and never invent records.`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Entity set, or the related data of one record: \"Product\", \"ProductDescription\", \"Product('<product number>')/_ProductPlant\".",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Fields to return (names or labels). Leave out to get the main fields.",
        },
        conditions: conditionsProperty,
        match: { type: "string", enum: ["all", "any"], description: "How conditions combine: all (AND, default) or any (OR)." },
        filter: { type: "string", description: "Optional raw OData V4 $filter, only for what conditions cannot express." },
        orderby: { type: "string", description: "Sort order, e.g. \"LastChangeDate desc\"." },
        top: { type: "integer", description: `Number of records, at most ${QUERY_TOP_MAX}.` },
        skip: { type: "integer", description: "Records to skip (paging)." },
        expand: expandProperty,
        count: { type: "boolean", description: "true: return only the number of matching records." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_get_entity_by_key",
    description:
      "Reads one record by its complete key, with all fields (or the selected ones) and its ETag. \"Not found\" means the record does not exist: a finding, not a failure.",
    parameters: {
      type: "object",
      properties: {
        entitySet: { type: "string", description: "Entity set name, e.g. \"Product\" or \"ProductPlant\"." },
        keys: { type: "object", description: keysDescription },
        select: { type: "array", items: { type: "string" }, description: "Fields to return. Leave out for all fields." },
        expand: expandProperty,
      },
      required: ["entitySet", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "sap_propose_change",
    description: [
      "Prepares a change (create, update, flag for deletion, delete) as a Change Plan. It reads the current values and ETag live from SAP, drops unchanged fields and shows the plan to the user with Approve and Reject buttons. NOTHING is written to SAP by this tool; only the user's click executes the plan.",
      '- UPDATE: keys + changes with only the fields to change, e.g. {"operation":"UPDATE","entitySet":"Product","keys":{"Product":"<product number>"},"changes":{"GrossWeight":"12.5"},"reason":"…"}. Never keys, calculated or administrative fields.',
      "- FLAG_DELETION: logical, reversible deletion of a record (for example a product or its plant data); keys only, or changes with the deletion-flag field set to true.",
      "- DELETE: physical deletion of dependent list records only (for example an additional-language description), where the API allows it.",
      '- CREATE: changes holds the new record. For a new dependent record pass parent {"entitySet","keys","navigation"}, e.g. navigation "_ProductPlant". Check the required fields with sap_describe_entity first.',
      "After calling it, tell the user in business terms what will change and that it is waiting for their approval in the card. Never say the change was made.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["UPDATE", "CREATE", "FLAG_DELETION", "DELETE"] },
        entitySet: { type: "string", description: "Entity set of the record to change or create." },
        keys: { type: "object", description: `${keysDescription} Required for UPDATE, FLAG_DELETION and DELETE.` },
        changes: {
          type: "object",
          description: "Field values to set (names or labels), e.g. {\"ProfitCenter\":\"<profit center>\"}. For CREATE the complete new record.",
        },
        parent: {
          type: "object",
          description: "For CREATE of a dependent record: the parent record and the navigation property.",
          properties: {
            entitySet: { type: "string" },
            keys: { type: "object" },
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
const TOOL_NAMES = new Set<string>(SAP_TOOL_DEFINITIONS.map((tool) => tool.name))

export function isSapToolName(name: string): name is SapToolName {
  return TOOL_NAMES.has(name)
}

// ---------- reading arguments (forgiving) ----------

/** Other names models use for the parameters, per tool (keys lower case, without $, _ and -). */
const ALIASES: Record<SapToolName, Record<string, string>> = {
  sap_list_entities: { query: "search", term: "search", keyword: "search", keywords: "search", q: "search", filter: "search", name: "search" },
  sap_describe_entity: {
    entity: "entitySet", entityset: "entitySet", entityname: "entitySet", set: "entitySet", name: "entitySet", table: "entitySet", collection: "entitySet", path: "entitySet",
    query: "search", term: "search", field: "search", fields: "search", keyword: "search",
  },
  sap_query_odata: {
    entity: "path", entityset: "path", entityname: "path", set: "path", collection: "path", table: "path", resource: "path", url: "path",
    fields: "select", columns: "select", properties: "select", attributes: "select",
    where: "filter", filterexpression: "filter",
    filters: "conditions", criteria: "conditions", condition: "conditions",
    sort: "orderby", sortby: "orderby", order: "orderby", orderby: "orderby",
    limit: "top", max: "top", maxrecords: "top", rows: "top", first: "top",
    offset: "skip",
    include: "expand", with: "expand", related: "expand", navigation: "expand",
    countonly: "count", inlinecount: "count",
    keys: "keys", key: "keys", id: "keys",
  },
  sap_get_entity_by_key: {
    entity: "entitySet", entityset: "entitySet", entityname: "entitySet", set: "entitySet", path: "entitySet", collection: "entitySet", table: "entitySet",
    key: "keys", id: "keys", ids: "keys", keyvalues: "keys", primarykey: "keys",
    fields: "select", columns: "select", properties: "select",
    include: "expand", with: "expand", related: "expand",
  },
  sap_propose_change: {
    op: "operation", action: "operation", method: "operation", changetype: "operation",
    entity: "entitySet", entityset: "entitySet", entityname: "entitySet", set: "entitySet", path: "entitySet", collection: "entitySet",
    key: "keys", id: "keys", keyvalues: "keys", primarykey: "keys",
    data: "changes", values: "changes", payload: "changes", updates: "changes", record: "changes", fields: "changes", properties: "changes", newvalues: "changes", body: "changes",
    justification: "reason", comment: "reason", description: "reason", why: "reason",
  },
}

const CANONICAL: Record<SapToolName, string[]> = {
  sap_list_entities: ["search"],
  sap_describe_entity: ["entitySet", "search"],
  sap_query_odata: ["path", "select", "conditions", "match", "filter", "orderby", "top", "skip", "expand", "count", "keys"],
  sap_get_entity_by_key: ["entitySet", "keys", "select", "expand"],
  sap_propose_change: ["operation", "entitySet", "keys", "changes", "parent", "reason"],
}

const aliasKey = (key: string) => key.toLowerCase().replace(/^\$/, "").replace(/[_\s-]/g, "")

/**
 * The arguments of a tool call as an object with the canonical parameter
 * names: JSON or Python-style text, wrapped forms ({"parameters": {...}}),
 * aliases (entity → entitySet, fields → select, limit → top) and empty
 * strings for "not set" are all accepted.
 */
export function readToolArguments(name: string, raw: string | Record<string, unknown>): Record<string, unknown> {
  const args: unknown = typeof raw === "string" ? (raw.trim() ? parseLooseJson(raw) : {}) : raw
  if (!args || typeof args !== "object" || Array.isArray(args)) return {}
  let object = args as Record<string, unknown>
  // {"name": "...", "parameters": {...}} or {"arguments": "{...}"}
  for (let i = 0; i < 2; i++) {
    const inner = parseObject(object.parameters) ?? parseObject(object.arguments) ?? parseObject(object.args) ?? parseObject(object.input)
    if (inner && Object.keys(object).every((key) => ["name", "type", "function", "parameters", "arguments", "args", "input"].includes(key))) object = inner
  }
  if (!isSapToolName(name)) return object
  const canonical = CANONICAL[name]
  const result: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === "" || value === null || value === undefined) continue
    const normalized = aliasKey(key)
    const target = canonical.find((item) => item.toLowerCase() === normalized) ?? ALIASES[name][normalized]
    if (target && result[target] === undefined) result[target] = value
    else if (!target) extra[key] = value
  }
  // Key fields passed at the top level, e.g. {"entitySet":"Product","Product":"ABC"}.
  if ((name === "sap_get_entity_by_key" || name === "sap_propose_change") && result.keys === undefined && Object.keys(extra).length > 0) {
    result.keys = extra
  }
  // Query options written into the path: "Product?$filter=…&$top=10".
  if (name === "sap_query_odata" && typeof result.path === "string" && result.path.includes("?")) {
    const [path, query] = result.path.split(/\?([\s\S]*)/)
    result.path = path
    for (const part of query.split("&")) {
      const [key, ...value] = part.split("=")
      const option = { $select: "select", $filter: "filter", $orderby: "orderby", $top: "top", $skip: "skip", $expand: "expand", $count: "count" }[key.trim()]
      if (option && result[option] === undefined) result[option] = decodeURIComponentSafe(value.join("="))
    }
  }
  return result
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const OPERATION_ALIASES: Record<string, "UPDATE" | "CREATE" | "FLAG_DELETION" | "DELETE"> = {
  update: "UPDATE", patch: "UPDATE", put: "UPDATE", change: "UPDATE", modify: "UPDATE", edit: "UPDATE", set: "UPDATE",
  create: "CREATE", post: "CREATE", insert: "CREATE", add: "CREATE", new: "CREATE",
  flagdeletion: "FLAG_DELETION", flagfordeletion: "FLAG_DELETION", markfordeletion: "FLAG_DELETION", deletionflag: "FLAG_DELETION", flag: "FLAG_DELETION", archive: "FLAG_DELETION",
  delete: "DELETE", remove: "DELETE",
}

const text = (message: string) =>
  z.preprocess((value) => (typeof value === "number" ? String(value) : value), z.string({ error: message }).trim().min(1, message))
const optionalText = z.preprocess((value) => (value === null || value === "" ? undefined : typeof value === "number" ? String(value) : value), z.string().trim().optional())

const schemas = {
  sap_list_entities: z.object({ search: optionalText }),
  sap_describe_entity: z.object({ entitySet: text("entitySet is required, e.g. \"Product\"."), search: optionalText }),
  sap_query_odata: z.object({
    path: text("path is required: the entity set, e.g. \"Product\"."),
    select: z.unknown().optional(),
    conditions: z.unknown().optional(),
    match: z.unknown().optional(),
    filter: z.unknown().optional(),
    orderby: z.unknown().optional(),
    top: z.unknown().optional(),
    skip: z.unknown().optional(),
    expand: z.unknown().optional(),
    count: z.unknown().optional(),
    keys: z.unknown().optional(),
  }),
  sap_get_entity_by_key: z.object({
    entitySet: text("entitySet is required, e.g. \"Product\"."),
    keys: z
      .unknown()
      .optional()
      .refine((value) => value !== undefined && value !== "", "keys is required, e.g. {\"Product\":\"<product number>\"}."),
    select: z.unknown().optional(),
    expand: z.unknown().optional(),
  }),
  sap_propose_change: z.object({
    operation: z.preprocess(
      (value) => (typeof value === "string" ? (OPERATION_ALIASES[aliasKey(value)] ?? value.toUpperCase()) : value),
      z.enum(["UPDATE", "CREATE", "FLAG_DELETION", "DELETE"], { error: "operation is UPDATE, CREATE, FLAG_DELETION or DELETE." })
    ),
    entitySet: text("entitySet is required, e.g. \"Product\"."),
    keys: z.unknown().optional(),
    changes: z.unknown().optional(),
    parent: z.unknown().optional(),
    reason: z.preprocess((value) => (typeof value === "string" && value.trim() ? value : "Requested in the chat."), z.string().trim().max(500)),
  }),
} satisfies Record<SapToolName, z.ZodType>

// ---------- helpers ----------

function output(value: unknown): string {
  const json = JSON.stringify(value, null, 1)
  return json.length <= MAX_TOOL_OUTPUT_CHARS ? json : `${json.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (output truncated; select fewer fields or records)`
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

/** SAP's error body, verbatim, with the query that was sent, so the model can correct it (400) or explain it (403…). */
function sapErrorResult(response: SapResponse, sent?: string, corrections: string[] = []): SapToolResult {
  const error = response.error
  const meaning: Record<number, string> = {
    400: "Bad request: wrong field, value format or syntax, or a business validation error. Correct the arguments only if the fix is certain; prefer conditions and structured expand over raw syntax.",
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
  // "… at position 57 in expand option string" → show the text around that position.
  const position = Number(error?.message.match(/position (\d+)/i)?.[1])
  const decoded = sent ? decodeURIComponentSafe(sent) : undefined
  const near = decoded && Number.isFinite(position) ? decoded.slice(Math.max(0, position - 30), position + 30) : undefined
  return {
    content: output({
      httpStatus: response.status,
      meaning: meaning[response.status],
      sapError: error ? { code: error.code, message: error.message, target: error.target, details: error.details } : undefined,
      ...(decoded ? { sentQuery: decoded } : {}),
      ...(near ? { near } : {}),
      ...(corrections.length ? { corrections } : {}),
    }),
    isError: true,
    summary: `${STATUS_SUMMARY[response.status] ?? `SAP error ${response.status}`}${error?.message ? `: ${error.message}` : ""}`,
  }
}

/** Drops OData annotations (but the ETag) and empty SAP message arrays. */
function cleanRecord(record: unknown): unknown {
  if (Array.isArray(record)) return record.map(cleanRecord)
  if (!record || typeof record !== "object") return record
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("@odata.") && key !== "@odata.etag") continue
    if (key.startsWith("@")) continue
    if (key === "SAP__Messages" && Array.isArray(value) && value.length === 0) continue
    result[key] = cleanRecord(value)
  }
  return result
}

/** Business labels for the fields in the records, also inside expanded related data. */
function fieldLabels(catalog: ServiceCatalog, type: EntityTypeInfo, records: unknown[], depth = 0): Record<string, string> | undefined {
  const labels: Record<string, string> = {}
  const names = new Set<string>()
  const nested = new Map<string, unknown[]>()
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    for (const [name, value] of Object.entries(record)) {
      if (name.startsWith("@") || name === "SAP__Messages") continue
      if (value !== null && typeof value === "object") nested.set(name, [...(nested.get(name) ?? []), ...(Array.isArray(value) ? value : [value])])
      else names.add(name)
    }
  }
  for (const name of names) {
    const label = type.properties.find((property) => property.name === name)?.label ?? humanizeName(name)
    if (label && label !== name) labels[name] = label
  }
  if (depth === 0) {
    for (const [navName, rows] of nested) {
      const nav = type.navigation.find((item) => item.name === navName)
      const target = nav ? catalog.entityTypes.get(nav.targetType) : undefined
      if (!target) continue
      for (const [name, label] of Object.entries(fieldLabels(catalog, target, rows, 1) ?? {})) labels[`${navName}/${name}`] = label
    }
  }
  return Object.keys(labels).length ? labels : undefined
}

/** Key values from any form: object, Python dict text, "Product='A',Plant='B'", or a plain value for single-key entities. */
function normaliseKeys(type: EntityTypeInfo, raw: unknown): Record<string, string | number | boolean> {
  const object = parseObject(raw)
  if (object) {
    const keys: Record<string, string | number | boolean> = {}
    for (const [name, value] of Object.entries(object)) {
      const key =
        type.keys.find((item) => item === name) ??
        type.keys.find((item) => item.toLowerCase() === name.toLowerCase()) ??
        type.keys.find((item) => {
          const property = resolveProperty(type, name, { fuzzy: false })
          return "name" in property && property.name === item
        })
      if (!key) throw new QueryInputError(`${name} is not a key of ${type.name}. Its keys are ${type.keys.join(", ")}.`)
      keys[key] = typeof value === "string" ? value.trim().replace(/^'([\s\S]*)'$/, "$1") : (value as string | number | boolean)
    }
    return keys
  }
  if (typeof raw === "string" || typeof raw === "number") {
    const value = String(raw).trim().replace(/^\(|\)$/g, "")
    return parsePredicate(type, value)
  }
  throw new QueryInputError(`Pass the keys as an object, e.g. {${type.keys.map((key) => `"${key}":"…"`).join(",")}}.`)
}

type Target = { set: EntitySetInfo; type: EntityTypeInfo; path: string; collection: boolean }

/** Resolves "Product", "products", "Product(ABC)/_ProductPlant" … to a canonical path and its entity type. */
function resolveTarget(catalog: ServiceCatalog, rawPath: string, keys?: unknown): Target {
  const segments = splitPath(rawPath.trim())
  if (segments.length === 0) throw new QueryInputError("path is empty. Pass an entity set such as \"Product\".")
  const parse = (segment: string) => {
    const match = segment.match(/^([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\))?$/)
    if (!match) throw new QueryInputError(`"${segment}" is not an entity set or navigation name.`)
    return { name: match[1].split(".").pop()!, predicate: match[2] }
  }
  const first = parse(segments[0])
  const set = resolveEntitySet(catalog, first.name)
  if (!("entityType" in set)) {
    throw new QueryInputError(
      `There is no entity set "${first.name}".${set.suggestions.length ? ` Did you mean ${set.suggestions.join(", ")}?` : ""} Call sap_list_entities to see them.`
    )
  }
  let type = typeOfSet(catalog, set)
  if (!type) throw new QueryInputError(`The type of ${set.name} is missing from $metadata.`)
  let path = set.name
  let collection = true
  if (first.predicate !== undefined && first.predicate.trim() !== "") {
    path += buildKeyPredicate(type, normaliseKeys(type, first.predicate))
    collection = false
  } else if (keys !== undefined && segments.length === 1) {
    path += buildKeyPredicate(type, normaliseKeys(type, keys))
    collection = false
  }
  for (const segment of segments.slice(1)) {
    const next = parse(segment)
    const nav = resolveNavigation(catalog, type, next.name)
    if (!nav) {
      throw new QueryInputError(`${type.name} has no related data "${next.name}". It has: ${type.navigation.map((item) => item.name).join(", ") || "none"}.`)
    }
    const target = catalog.entityTypes.get(nav.targetType)
    if (!target) throw new QueryInputError(`The target type of ${nav.name} is missing from $metadata.`)
    type = target
    path += `/${nav.name}`
    collection = nav.collection
    if (next.predicate !== undefined && next.predicate.trim() !== "") {
      path += buildKeyPredicate(type, normaliseKeys(type, next.predicate))
      collection = false
    }
  }
  return { set, type, path, collection }
}

/** Encodes characters that are not allowed in a URL path, leaving OData syntax intact. */
function encodeModelPath(path: string) {
  return path.replace(/[ #?&+%]/g, (char) => encodeURIComponent(char))
}

function queryText(query: Record<string, string | undefined>) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
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
  if (value === null || (typeof value === "string" && /^null$/i.test(value.trim()))) {
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
    const number = toNumberText(value)
    if (number === undefined) throw new Error(`${property.name} needs a number; got "${String(value)}".`)
    return number
  }
  if (/^Edm\.(Int16|Int32|Byte|SByte|Double|Single)$/.test(type)) {
    const number = Number(toNumberText(value))
    if (!Number.isFinite(number)) throw new Error(`${property.name} needs a number; got "${String(value)}".`)
    return number
  }
  if (type === "Edm.Boolean") {
    if (typeof value === "boolean") return value
    if (/^(true|x|yes|1)$/i.test(String(value).trim())) return true
    if (/^(false|no|0|)$/i.test(String(value).trim())) return false
    throw new Error(`${property.name} needs true or false.`)
  }
  if (type === "Edm.Date") {
    const date = toIsoDate(String(value))
    if (!date) throw new Error(`${property.name} needs a date like 2026-11-17.`)
    return date
  }
  return value
}

/** Text literals that only differ from their upper-case form: a likely reason for an empty result. */
function lowerCaseLiterals(filter: string | undefined) {
  return [...(filter ?? "").matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]).filter((value) => /[a-z]/.test(value) && value !== value.toUpperCase())
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

/** Words in a search that say nothing about which entity set is meant. */
const SEARCH_NOISE = new Set(["data", "master", "list", "all", "show", "the", "and", "for", "level", "client", "record", "records", "entity", "entities", "set", "sets", "table", "info", "information", "details", "general", "basic", "api"])

async function listEntities(args: z.infer<(typeof schemas)["sap_list_entities"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  // Root sets: their type is not reached through another set's navigation.
  const targets = new Set([...catalog.entityTypes.values()].flatMap((type) => type.navigation.map((nav) => nav.targetType)))
  const isMain = (set: EntitySetInfo) => !targets.has(set.entityType) && (typeOfSet(catalog, set)?.navigation.length ?? 0) > 0
  const words = (args.search ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !SEARCH_NOISE.has(word))
  let sets = catalog.entitySets.filter((set) => {
    if (words.length === 0) return true
    const haystack = `${normalizeName(set.name)} ${normalizeName(set.label ?? "")}`
    return words.some((word) => haystack.includes(word))
  })
  let note: string | undefined
  if (sets.length === 0) {
    note = `No entity set matches "${args.search}"; all ${catalog.entitySets.length} are listed.`
    sets = catalog.entitySets
  }
  const listed = [...sets]
    .sort((a, b) => Number(isMain(b)) - Number(isMain(a)))
    .slice(0, 80)
    .map((set) => {
      const type = typeOfSet(catalog, set)
      return {
        entitySet: set.name,
        label: set.label ?? type?.label,
        ...(isMain(set) ? { main: true } : {}),
        keys: type?.keys ?? [],
        related: type?.navigation.map((nav) => nav.name) ?? [],
        insertable: set.insertable,
        updatable: set.updatable,
        deletable: set.deletable,
      }
    })
  return {
    content: output({
      system: ctx.system.name,
      ...(note ? { note } : {}),
      hint: "Query a main entity set to list its records; use related data (expand or a navigation path) for dependent data.",
      entitySets: listed,
      total: catalog.entitySets.length,
    }),
    isError: false,
    summary: `${listed.length} kind${listed.length === 1 ? "" : "s"} of business data`,
  }
}

async function describeEntity(args: z.infer<(typeof schemas)["sap_describe_entity"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const set = resolveEntitySet(catalog, args.entitySet)
  if (!("entityType" in set)) {
    return errorResult(`There is no entity set "${args.entitySet}".${set.suggestions.length ? ` Did you mean ${set.suggestions.join(", ")}?` : ""} Call sap_list_entities.`)
  }
  const type = typeOfSet(catalog, set)
  if (!type) return errorResult(`The type of ${set.name} is missing from $metadata.`)

  const words = args.search?.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) ?? []
  const properties = type.properties
    .filter((property) => {
      if (words.length === 0) return true
      const haystack = `${property.name} ${property.label ?? ""}`.toLowerCase()
      return words.every((word) => haystack.includes(word)) || words.some((word) => word.length >= 4 && property.name.toLowerCase().includes(word))
    })
    .slice(0, 200)
    .map((property) => ({
      name: property.name,
      type: property.type,
      ...(property.maxLength ? { maxLength: property.maxLength } : {}),
      ...(property.label ? { label: property.label } : {}),
      ...(type.keys.includes(property.name) ? { key: true } : {}),
      ...(property.computed ? { calculatedBySap: true } : {}),
      ...(property.immutable ? { immutable: true } : {}),
    }))
  const deletionFlags = type.properties.filter((property) => DELETION_FLAG.test(property.name)).map((property) => property.name)
  const readOnly = businessAreaFor(ctx.system.servicePath).readOnlyFields?.filter((rule) => rule.entitySet === set.name)

  return {
    content: output({
      entitySet: set.name,
      label: set.label ?? type.label,
      keys: type.keys,
      insertable: set.insertable,
      updatable: set.updatable,
      deletable: set.deletable,
      fields: properties,
      ...(words.length && properties.length === 0 ? { note: `No field matches "${args.search}". This API may not include it.` } : {}),
      related: type.navigation.map((nav) => ({
        navigation: nav.name,
        target: catalog.entityTypes.get(nav.targetType)?.name ?? nav.targetType,
        label: catalog.entityTypes.get(nav.targetType)?.label,
        many: nav.collection,
      })),
      ...(deletionFlags.length ? { deletionFlagFields: deletionFlags } : {}),
      ...(readOnly?.length ? { notChangeable: readOnly.map((rule) => ({ field: rule.field, reason: rule.reason })) } : {}),
    }),
    isError: false,
    summary: `${properties.length} field${properties.length === 1 ? "" : "s"} of ${humanizeName(set.name)}`,
  }
}

async function queryOData(args: z.infer<(typeof schemas)["sap_query_odata"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const corrections: string[] = []
  let target: Target
  let query: Record<string, string | undefined>
  const countOnly = args.count === true || String(args.count).toLowerCase() === "true"
  try {
    target = resolveTarget(catalog, args.path, args.keys)
    const select = resolveSelect(catalog, target.type, args.select, corrections)
    const expandSpecs: ExpandSpec[] = [
      ...parseExpandInput(args.expand),
      ...select.navigationPaths.map((item) => ({ navigation: item.navigation, select: item.field || undefined })),
    ]
    let fields = select.names
    if (fields.length === 0) fields = defaultSelect(target.type)
    if (target.collection) for (const key of [...target.type.keys].reverse()) if (!fields.includes(key)) fields.unshift(key)
    const expand = buildExpand(catalog, target.type, expandSpecs, corrections)
    if (target.collection) {
      const filter = andFilters(normalizeFilter(target.type, args.filter, corrections), buildConditions(target.type, args.conditions, args.match, corrections))
      const orderby = normalizeOrderby(target.type, args.orderby, corrections)
      const top = Math.min(Math.max(parseCount(args.top) ?? QUERY_TOP_DEFAULT, 1), QUERY_TOP_MAX)
      const skip = Math.max(parseCount(args.skip) ?? 0, 0)
      if ((parseCount(args.top) ?? 0) > QUERY_TOP_MAX) corrections.push(`top is at most ${QUERY_TOP_MAX} per call; page with skip.`)
      query = countOnly
        ? { $filter: filter, $top: "0", $count: "true" }
        : { $select: fields.join(","), $filter: filter, $orderby: orderby, $expand: expand, $top: String(top), $skip: skip ? String(skip) : undefined, $count: "true" }
    } else {
      if (args.filter || args.conditions || args.orderby) corrections.push("Left out filter and order: the path addresses one record.")
      query = { $select: fields.join(","), $expand: expand }
    }
  } catch (error) {
    if (error instanceof QueryInputError || (error instanceof Error && /key|characters/i.test(error.message))) {
      return errorResult(error.message, "Request not sent: check the arguments")
    }
    throw error
  }

  const sent = queryText(query)
  const response = await ctx.client.request({ method: "GET", path: encodeModelPath(target.path), query, toolName: "sap_query_odata" })
  if (!response.ok) return sapErrorResult(response, sent, corrections)

  const data = response.data as { value?: unknown[]; "@odata.count"?: number | string; "@odata.nextLink"?: string } | null
  if (!target.collection || !Array.isArray(data?.value)) {
    if (response.status === 404) return { content: output({ found: false, path: target.path }), isError: false, summary: "Not found" }
    return {
      content: output({ fieldLabels: fieldLabels(catalog, target.type, [data]), record: cleanRecord(data), etag: response.etag, query: sent, ...(corrections.length ? { corrections } : {}) }),
      isError: false,
      summary: "1 record",
      dataRows: 1,
    }
  }
  const total = data["@odata.count"] === undefined ? undefined : Number(data["@odata.count"])
  if (countOnly) {
    return {
      content: output({ totalCount: total, query: sent, ...(corrections.length ? { corrections } : {}) }),
      isError: false,
      summary: `${total ?? "?"} matching record${total === 1 ? "" : "s"}`,
      dataRows: 1,
    }
  }
  const returned = data.value.length
  const skip = parseCount(query.$skip) ?? 0
  const more = total !== undefined ? skip + returned < total : Boolean(data["@odata.nextLink"])
  const caseHint = returned === 0 ? lowerCaseLiterals(query.$filter) : []
  return {
    content: output({
      totalCount: total,
      returned,
      ...(more ? { moreAvailable: true, nextSkip: skip + returned } : {}),
      ...(returned === 0
        ? {
            note: `No records match. Report that no data was found; do not invent records.${
              caseHint.length ? ` SAP compares text exactly (case-sensitive); numbers and codes are usually upper case, so try ${caseHint.map((value) => `'${value.toUpperCase()}'`).join(", ")}.` : ""
            }`,
          }
        : {}),
      ...(response.sapMessages.length ? { sapMessages: response.sapMessages } : {}),
      query: sent,
      ...(corrections.length ? { corrections } : {}),
      fieldLabels: fieldLabels(catalog, target.type, data.value),
      records: cleanRecord(data.value),
    }),
    isError: false,
    summary: `${returned} of ${total ?? "?"} record${total === 1 ? "" : "s"}`,
    dataRows: returned,
  }
}

async function getEntityByKey(args: z.infer<(typeof schemas)["sap_get_entity_by_key"]>, ctx: SapToolContext): Promise<SapToolResult> {
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const corrections: string[] = []
  let target: Target
  let query: Record<string, string | undefined>
  let keys: Record<string, string | number | boolean>
  try {
    const set = resolveEntitySet(catalog, args.entitySet)
    if (!("entityType" in set)) {
      throw new QueryInputError(`There is no entity set "${args.entitySet}".${set.suggestions.length ? ` Did you mean ${set.suggestions.join(", ")}?` : ""} Call sap_list_entities.`)
    }
    const type = typeOfSet(catalog, set)
    if (!type) throw new QueryInputError(`The type of ${set.name} is missing from $metadata.`)
    keys = normaliseKeys(type, args.keys)
    target = { set, type, path: `${set.name}${buildKeyPredicate(type, keys)}`, collection: false }
    const select = resolveSelect(catalog, type, args.select, corrections)
    const expand = buildExpand(
      catalog,
      type,
      [...parseExpandInput(args.expand), ...select.navigationPaths.map((item) => ({ navigation: item.navigation, select: item.field || undefined }))],
      corrections
    )
    query = { $select: select.names.length ? select.names.join(",") : undefined, $expand: expand }
  } catch (error) {
    if (error instanceof QueryInputError || (error instanceof Error && /key|characters/i.test(error.message))) {
      return errorResult(error.message, "Request not sent: check the arguments")
    }
    throw error
  }

  const sent = queryText(query)
  const response = await ctx.client.request({ method: "GET", path: target.path, query, toolName: "sap_get_entity_by_key" })
  if (response.status === 404) {
    return {
      content: output({ found: false, message: `${target.set.name} ${JSON.stringify(keys)} does not exist in ${ctx.system.name}.` }),
      isError: false,
      summary: "Not found",
    }
  }
  if (!response.ok) return sapErrorResult(response, sent, corrections)
  return {
    content: output({
      found: true,
      etag: response.etag,
      ...(response.sapMessages.length ? { sapMessages: response.sapMessages } : {}),
      ...(sent ? { query: sent } : {}),
      ...(corrections.length ? { corrections } : {}),
      fieldLabels: fieldLabels(catalog, target.type, [response.data]),
      record: cleanRecord(response.data),
    }),
    isError: false,
    summary: "1 record",
    dataRows: 1,
  }
}

/** A change field: exact name or label only (writes never guess), and never one the API keeps read-only. */
function changeProperty(type: EntityTypeInfo, setName: string, name: string, ctx: SapToolContext): PropertyInfo {
  const property = resolveProperty(type, name, { fuzzy: false })
  if (!("name" in property)) {
    throw new QueryInputError(
      `${setName} has no field "${name}".${property.suggestions.length ? ` Similar: ${property.suggestions.join(", ")}.` : ""} Call sap_describe_entity to see the fields.`
    )
  }
  const rule = businessAreaFor(ctx.system.servicePath).readOnlyFields?.find((item) => item.entitySet === setName && item.field === property.name)
  if (rule) throw new QueryInputError(rule.reason)
  return property
}

async function proposeChange(args: z.infer<(typeof schemas)["sap_propose_change"]>, ctx: SapToolContext): Promise<SapToolResult> {
  if (ctx.plansCreated >= MAX_PLANS_PER_TURN) {
    return errorResult(`At most ${MAX_PLANS_PER_TURN} change plans per message. Ask the user to approve these first.`)
  }
  const catalog = await catalogOrError(ctx)
  if (isResult(catalog)) return catalog
  const resolvedSet = resolveEntitySet(catalog, args.entitySet)
  if (!("entityType" in resolvedSet)) {
    return errorResult(`There is no entity set "${args.entitySet}".${resolvedSet.suggestions.length ? ` Did you mean ${resolvedSet.suggestions.join(", ")}?` : ""} Call sap_list_entities.`)
  }
  const set = resolvedSet
  const type = typeOfSet(catalog, set)
  if (!type) return errorResult(`The type of ${set.name} is missing from $metadata.`)

  let method: "PATCH" | "POST" | "DELETE"
  let path: string
  let etag: string | null = null
  let payload: Record<string, unknown> | null = null
  let diff: ChangePlanDiff[] = []
  const label = (name: string) => type.properties.find((property) => property.name === name)?.label
  const rawChanges = args.changes === undefined ? undefined : parseObject(args.changes)
  if (args.changes !== undefined && !rawChanges) return errorResult("changes must be an object of field names and values, e.g. {\"GrossWeight\":\"12.5\"}.")

  try {
    let keys: Record<string, string | number | boolean> | undefined
    if (args.operation === "UPDATE" || args.operation === "FLAG_DELETION" || args.operation === "DELETE") {
      if (args.keys === undefined) return errorResult(`${args.operation} needs the keys of the record: ${type.keys.join(", ")}.`)
      keys = normaliseKeys(type, args.keys)
      path = `${set.name}${buildKeyPredicate(type, keys)}`
    } else {
      path = set.name
    }

    if (args.operation === "UPDATE" || args.operation === "FLAG_DELETION") {
      if (!set.updatable) return errorResult(`${set.name} cannot be updated through this API ($metadata: Updatable=false).`)
      let changes: Record<string, unknown> = { ...(rawChanges ?? {}) }
      // Key fields repeated in changes are not changes.
      for (const key of type.keys) if (keys && String(changes[key] ?? "") === String(keys[key])) delete changes[key]
      if (args.operation === "FLAG_DELETION" && Object.keys(changes).length === 0) {
        const flags = type.properties.filter((property) => DELETION_FLAG.test(property.name) && property.type === "Edm.Boolean")
        if (flags.length !== 1) {
          return errorResult(
            flags.length === 0
              ? `${set.name} has no deletion-flag field. Deletion is not possible through this API for this data.`
              : `${set.name} has several deletion-flag candidates (${flags.map((f) => f.name).join(", ")}); pass the right one in changes.`
          )
        }
        changes = { [flags[0].name]: true }
      }
      if (Object.keys(changes).length === 0) return errorResult("changes is empty: name the fields to change and their new values.")

      const converted: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(changes)) {
        const property = changeProperty(type, set.name, name, ctx)
        if (type.keys.includes(property.name)) return errorResult(`${property.name} is a key and cannot be changed.`)
        if (property.computed || property.immutable || ADMIN_FIELD.test(property.name)) {
          return errorResult(`${property.name} is maintained by SAP (calculated, immutable or administrative) and cannot be changed.`)
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
      if (current.status === 404) return errorResult(`${describeODataPath(path)} does not exist in ${ctx.system.name}.`, "Record not found")
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
      if (current.status === 404) return errorResult(`${describeODataPath(path)} does not exist in ${ctx.system.name}.`, "Record not found")
      if (!current.ok) return sapErrorResult(current)
      if (!current.etag) return errorResult("SAP returned no ETag for this record, so it cannot be deleted safely.")
      etag = current.etag

      // D3: never delete the last remaining description of a product.
      if (/description/i.test(set.name) && keys && "Product" in keys) {
        const product = String(keys.Product).replace(/'/g, "''")
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
      const changes = rawChanges ?? {}
      if (Object.keys(changes).length === 0) return errorResult("changes must hold the new record.")
      const parent = args.parent === undefined ? undefined : parseObject(args.parent)
      if (args.parent !== undefined && !parent) return errorResult("parent must be an object: {\"entitySet\",\"keys\",\"navigation\"}.")
      if (parent) {
        const parentSet = resolveEntitySet(catalog, String(parent.entitySet ?? parent.entity ?? ""))
        const parentType = "entityType" in parentSet ? typeOfSet(catalog, parentSet) : undefined
        if (!("entityType" in parentSet) || !parentType) return errorResult(`There is no entity set "${String(parent.entitySet)}".`)
        const nav = resolveNavigation(catalog, parentType, String(parent.navigation ?? set.name))
        if (!nav) return errorResult(`${parentType.name} has no related data "${String(parent.navigation)}". It has ${parentType.navigation.map((n) => n.name).join(", ")}.`)
        const parentPath = `${parentSet.name}${buildKeyPredicate(parentType, normaliseKeys(parentType, parent.keys))}`
        const found = await ctx.client.request({ method: "GET", path: parentPath, query: { $select: parentType.keys.join(",") }, toolName: "sap_propose_change" })
        if (found.status === 404) return errorResult(`The parent ${describeODataPath(parentPath)} does not exist.`)
        if (!found.ok) return sapErrorResult(found)
        path = `${parentPath}/${nav.name}`
      } else if (!set.insertable) {
        return errorResult(`${set.name} does not allow inserts ($metadata: Insertable=false).`)
      }

      payload = {}
      for (const [name, value] of Object.entries(changes)) {
        const nav = resolveNavigation(catalog, type, name)
        if (nav && !("name" in resolveProperty(type, name, { fuzzy: false }))) {
          payload[nav.name] = value
          diff.push({ field: nav.name, current: "—", next: display(value) })
          continue
        }
        const property = changeProperty(type, set.name, name, ctx)
        payload[property.name] = convertValue(property, value)
        diff.push({ field: property.name, label: property.label, current: "—", next: display(payload[property.name]) })
      }

      // C0(c): the target must not exist yet (root records with a complete key).
      if (!parent && type.keys.every((key) => key in payload!)) {
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

/** One line for the chat, in business words, from the call's arguments (any form). */
export function toolLabel(name: string, rawArgs: Record<string, unknown>): string {
  const args = readToolArguments(name, rawArgs)
  const keys = (raw: unknown) => {
    const object = parseObject(raw)
    return object ? Object.values(object).map(String).join(", ") : raw ? String(raw) : ""
  }
  const operation = OPERATION_LABELS[String(args.operation).toUpperCase() as keyof typeof OPERATION_LABELS] ?? "Change"
  switch (name) {
    case "sap_list_entities":
      return "Checking which business data is available"
    case "sap_describe_entity":
      return `Looking up the fields of ${humanizeName(String(args.entitySet ?? "the data"))}`
    case "sap_query_odata":
      return args.count === true || args.count === "true"
        ? `Counting ${describeODataPath(String(args.path ?? "records").split("?")[0])}`
        : `Looking up ${describeODataPath(String(args.path ?? "data").split("?")[0])}`
    case "sap_get_entity_by_key":
      return `Reading ${humanizeName(String(args.entitySet ?? ""))} ${keys(args.keys)}`.trim()
    case "sap_propose_change":
      return `Preparing a change for your approval: ${operation} ${humanizeName(String(args.entitySet ?? ""))} ${keys(args.keys)}`.trim()
    default:
      return name
  }
}

export async function executeSapTool(name: string, rawArguments: string, ctx: SapToolContext): Promise<SapToolResult> {
  if (!isSapToolName(name)) return errorResult(`Unknown tool "${name}". The tools are ${[...TOOL_NAMES].join(", ")}.`)
  if (rawArguments.trim() && parseLooseJson(rawArguments) === undefined) {
    return errorResult(`The arguments are not valid JSON: ${rawArguments.slice(0, 300)}`, "Invalid arguments")
  }
  const parsed = schemas[name].safeParse(readToolArguments(name, rawArguments))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ")
    return errorResult(`Invalid arguments: ${issues}`, "Invalid arguments")
  }

  try {
    switch (name) {
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
