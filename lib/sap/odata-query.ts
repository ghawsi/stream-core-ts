import type { EntitySetInfo, EntityTypeInfo, NavigationInfo, PropertyInfo, ServiceCatalog } from "./metadata"

/**
 * Builds correct OData V4 query options from what a language model sends.
 *
 * Models, small local ones above all, send lists as Python text
 * ("['A', 'B']"), use labels or wrong casing for field names, write SQL or
 * OData V2 syntax, use * as a wildcard and nest $expand parentheses wrongly.
 * Everything here accepts those forms, resolves names against the live
 * $metadata and writes valid syntax, so a request is either correct or
 * rejected before it reaches SAP with a message the model can act on.
 *
 * Pure functions, no imports at runtime.
 */

/** Thrown for input that cannot be turned into a valid request; the message is for the model. */
export class QueryInputError extends Error {}

// ---------- lenient parsing ----------

/** JSON, or Python-style dicts and lists (single quotes, True/False/None, trailing commas, bare keys). */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to the lenient form
  }
  if (!/^[[{]/.test(trimmed)) return undefined
  let out = ""
  for (let i = 0; i < trimmed.length; ) {
    const char = trimmed[i]
    if (char === '"' || char === "'") {
      let j = i + 1
      let value = ""
      while (j < trimmed.length && trimmed[j] !== char) {
        if (trimmed[j] === "\\" && j + 1 < trimmed.length) {
          value += trimmed[j + 1]
          j += 2
          continue
        }
        value += trimmed[j]
        j += 1
      }
      out += JSON.stringify(value)
      i = j + 1
      continue
    }
    // Outside strings: Python literals and bare keys.
    const rest = trimmed.slice(i)
    const word = rest.match(/^(True|False|None)\b/)
    if (word) {
      out += word[1] === "True" ? "true" : word[1] === "False" ? "false" : "null"
      i += word[1].length
      continue
    }
    const bareKey = rest.match(/^([A-Za-z_$][\w$]*)(\s*:)/)
    if (bareKey && /[{,]\s*$/.test(out)) {
      out += `"${bareKey[1]}"${bareKey[2]}`
      i += bareKey[0].length
      continue
    }
    out += char
    i += 1
  }
  out = out.replace(/,\s*([}\]])/g, "$1")
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

/** An object from an object or from (loose) JSON text; otherwise undefined. */
export function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === "string") {
    const parsed = parseLooseJson(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  return undefined
}

/** A list of names from an array, JSON or Python list text, or "A, B; C". */
export function parseNameList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (Array.isArray(value)) {
    const names = value.flatMap((item) => parseNameList(item) ?? [])
    return names.length ? names : undefined
  }
  if (typeof value === "string") {
    if (/^\s*\[/.test(value)) {
      const parsed = parseLooseJson(value)
      if (Array.isArray(parsed)) return parseNameList(parsed)
    }
    const names = value
      .replace(/^[\s[]+|[\s\]]+$/g, "")
      .split(/[,;]/)
      .map((item) => item.trim().replace(/^['"`]+|['"`]+$/g, "").trim())
      .filter(Boolean)
    return names.length ? names : undefined
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)]
  return undefined
}

/** A whole number from a number or numeric text. */
export function parseCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const number = typeof value === "number" ? value : Number(String(value).trim())
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

// ---------- names ----------

export const normalizeName = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")

function similar(candidates: { name: string; label?: string }[], wanted: string, limit = 6) {
  const needle = normalizeName(wanted)
  if (!needle) return []
  return candidates
    .filter((candidate) => {
      const name = normalizeName(candidate.name)
      const label = normalizeName(candidate.label ?? "")
      return (
        name.includes(needle) ||
        needle.includes(name) ||
        (label && (label.includes(needle) || needle.includes(label))) ||
        name.slice(0, 5) === needle.slice(0, 5)
      )
    })
    .slice(0, limit)
    .map((candidate) => candidate.name)
}

/**
 * The property a model means: exact name, any casing, the name without
 * separators, or the business label ("Product Type", "gross weight"). For
 * reads (`fuzzy`), also the one property whose name ends with it
 * ("Description" → ProductDescription); writes never guess.
 */
export function resolveProperty(type: EntityTypeInfo, wanted: string, { fuzzy = true } = {}): PropertyInfo | { suggestions: string[] } {
  const name = wanted.trim().replace(/^['"`]+|['"`]+$/g, "")
  const exact = type.properties.find((property) => property.name === name)
  if (exact) return exact
  const lower = name.toLowerCase()
  const byCase = type.properties.find((property) => property.name.toLowerCase() === lower)
  if (byCase) return byCase
  const normalized = normalizeName(name)
  const byNormalized = type.properties.filter((property) => normalizeName(property.name) === normalized)
  if (byNormalized.length === 1) return byNormalized[0]
  const byLabel = type.properties.filter((property) => property.label && normalizeName(property.label) === normalized)
  if (byLabel.length === 1) return byLabel[0]
  if (fuzzy && normalized.length >= 4) {
    const bySuffix = type.properties.filter((property) => normalizeName(property.name).endsWith(normalized))
    if (bySuffix.length === 1) return bySuffix[0]
  }
  return { suggestions: similar(type.properties, name) }
}

/** The navigation property a model means: "_ProductDescription", "ProductDescription", "description". */
export function resolveNavigation(catalog: ServiceCatalog, type: EntityTypeInfo, wanted: string): NavigationInfo | undefined {
  const name = wanted.trim()
  const byName = type.navigation.find((nav) => nav.name === name) ?? type.navigation.find((nav) => nav.name.toLowerCase() === name.toLowerCase())
  if (byName) return byName
  const normalized = normalizeName(name)
  const candidates = type.navigation.filter((nav) => {
    const target = catalog.entityTypes.get(nav.targetType)
    const targetName = normalizeName((target?.name ?? "").replace(/Type$/, ""))
    return normalizeName(nav.name) === normalized || targetName === normalized || normalizeName(target?.label ?? "") === normalized
  })
  if (candidates.length === 1) return candidates[0]
  // "Description" → _ProductDescription, when only one navigation contains it.
  const containing = type.navigation.filter((nav) => normalized.length >= 4 && normalizeName(nav.name).includes(normalized))
  return containing.length === 1 ? containing[0] : undefined
}

/** The entity set a model means: "Product", "products", "A_Product", "Product Plant". */
export function resolveEntitySet(catalog: ServiceCatalog, wanted: string): EntitySetInfo | { suggestions: string[] } {
  const name = wanted.trim().replace(/^['"`]+|['"`]+$/g, "")
  const exact = catalog.entitySets.find((set) => set.name === name) ?? catalog.entitySets.find((set) => set.name.toLowerCase() === name.toLowerCase())
  if (exact) return exact
  const normalized = normalizeName(name.replace(/^A_/, ""))
  const singular = normalized.replace(/(ies)$/, "y").replace(/(es|s)$/, "")
  const matches = catalog.entitySets.filter((set) => {
    const setName = normalizeName(set.name.replace(/^A_/, ""))
    const label = normalizeName(set.label ?? "")
    return setName === normalized || setName === singular || (label && (label === normalized || label === singular))
  })
  if (matches.length === 1) return matches[0]
  return { suggestions: similar(catalog.entitySets.map((set) => ({ name: set.name, label: set.label })), name) }
}

// ---------- literals ----------

const NUMBER_TYPES = /^Edm\.(Int16|Int32|Int64|Byte|SByte|Decimal|Double|Single)$/

function unquote(value: string) {
  const trimmed = value.trim()
  if (/^'[\s\S]*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'")
  if (/^"[\s\S]*"$/.test(trimmed)) return trimmed.slice(1, -1)
  return trimmed
}

/** "2026-11-17", "17.11.2026", "20261117" or an ISO timestamp → "2026-11-17". */
export function toIsoDate(value: string): string | undefined {
  const text = value.trim()
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`
  match = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  return undefined
}

/** A number as OData writes it; "12,5" (decimal comma, no dot) becomes 12.5. */
export function toNumberText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  const text = String(value).trim().replace(/^'|'$/g, "")
  if (/^-?\d+(\.\d+)?$/.test(text)) return text
  if (/^-?\d+,\d+$/.test(text)) return text.replace(",", ".")
  return undefined
}

/** The OData V4 literal for a value of this property: quoted strings, bare numbers, dates and booleans. */
export function formatLiteral(property: PropertyInfo, raw: unknown): string {
  if (raw === null || (typeof raw === "string" && /^null$/i.test(raw.trim()))) return "null"
  const text = typeof raw === "string" ? unquote(raw) : String(raw)
  const type = property.type
  if (type === "Edm.Boolean") {
    if (raw === true || /^(true|x|yes|1)$/i.test(text)) return "true"
    if (raw === false || /^(false|no|0|)$/i.test(text)) return "false"
    throw new QueryInputError(`${property.name} is true or false; got "${text}".`)
  }
  if (NUMBER_TYPES.test(type)) {
    const number = toNumberText(text)
    if (number === undefined) throw new QueryInputError(`${property.name} is a number; got "${text}".`)
    return number
  }
  if (type === "Edm.Date") {
    const date = toIsoDate(text)
    if (!date) throw new QueryInputError(`${property.name} is a date (YYYY-MM-DD); got "${text}".`)
    return date
  }
  if (type === "Edm.DateTimeOffset") {
    const date = toIsoDate(text)
    if (!date) throw new QueryInputError(`${property.name} is a timestamp (YYYY-MM-DDThh:mm:ssZ); got "${text}".`)
    if (!/T\d{2}:\d{2}/.test(text)) return `${date}T00:00:00Z`
    return /(Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`
  }
  if (type === "Edm.TimeOfDay") {
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) throw new QueryInputError(`${property.name} is a time (hh:mm:ss); got "${text}".`)
    return text.length === 5 ? `${text}:00` : text
  }
  if (type === "Edm.Guid") {
    if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(text)) {
      throw new QueryInputError(`${property.name} is a GUID; got "${text}".`)
    }
    return text
  }
  if (property.maxLength && text.replace(/[*%]/g, "").length > property.maxLength) {
    throw new QueryInputError(`${property.name} has at most ${property.maxLength} characters; "${text}" has ${text.length}.`)
  }
  return `'${text.replace(/'/g, "''")}'`
}

const isTextProperty = (property: PropertyInfo) => property.type === "Edm.String"

/** "ABC*" → startswith, "*ABC" → endswith, "*ABC*" → contains (also % as in SQL LIKE); null without a wildcard. */
function wildcardExpression(property: PropertyInfo, value: string, notes: string[]): string | null {
  const text = unquote(value)
  if (!/[*%]/.test(text) || !isTextProperty(property)) return null
  const leading = /^[*%]/.test(text)
  const trailing = /[*%]$/.test(text)
  const core = text.replace(/^[*%]+|[*%]+$/g, "")
  if (/[*%]/.test(core)) throw new QueryInputError(`Use one wildcard at the start or end of "${text}" only.`)
  const literal = `'${core.replace(/'/g, "''")}'`
  const fn = leading && trailing ? "contains" : trailing ? "startswith" : "endswith"
  notes.push(`"${text}" on ${property.name} became ${fn}(${property.name},${literal}): OData has no * wildcard.`)
  return core ? `${fn}(${property.name},${literal})` : `${property.name} ne null`
}

// ---------- conditions ----------

export type Condition = { field: string; operator?: string; value?: unknown; values?: unknown }

const OPERATORS: Record<string, string> = {
  eq: "eq", "=": "eq", "==": "eq", equals: "eq", equal: "eq", is: "eq",
  ne: "ne", "!=": "ne", "<>": "ne", notequals: "ne", not: "ne", isnot: "ne",
  gt: "gt", ">": "gt", greaterthan: "gt", after: "gt",
  ge: "ge", ">=": "ge", greaterorequal: "ge", atleast: "ge", from: "ge",
  lt: "lt", "<": "lt", lessthan: "lt", before: "lt",
  le: "le", "<=": "le", lessorequal: "le", atmost: "le", to: "le", until: "le",
  contains: "contains", includes: "contains", substringof: "contains",
  startswith: "startswith", beginswith: "startswith", prefix: "startswith",
  endswith: "endswith", suffix: "endswith",
  like: "like", matches: "like",
  in: "in", oneof: "in", anyof: "in",
  between: "between", range: "between",
}

function conditionExpression(type: EntityTypeInfo, condition: Condition, notes: string[]): string {
  const property = resolveProperty(type, String(condition.field ?? ""))
  if (!("name" in property)) {
    throw new QueryInputError(
      `${type.name} has no field "${condition.field}".${property.suggestions.length ? ` Similar: ${property.suggestions.join(", ")}.` : ""} Call sap_describe_entity to see all fields.`
    )
  }
  const key = String(condition.operator ?? "eq").toLowerCase().replace(/[\s_-]/g, "")
  const operator = OPERATORS[key]
  if (!operator) throw new QueryInputError(`Unknown operator "${condition.operator}". Use eq, ne, gt, ge, lt, le, contains, startswith, endswith, in or between.`)
  const list = Array.isArray(condition.values)
    ? condition.values
    : typeof condition.values === "string"
      ? (parseNameList(condition.values) ?? [])
      : Array.isArray(condition.value)
        ? condition.value
        : undefined

  if (operator === "in") {
    const values = list ?? parseNameList(condition.value) ?? []
    if (values.length === 0) throw new QueryInputError(`"in" on ${property.name} needs values, e.g. ["A","B"].`)
    return `(${values.map((value) => `${property.name} eq ${formatLiteral(property, value)}`).join(" or ")})`
  }
  if (operator === "between") {
    const range = condition.value && typeof condition.value === "object" && !Array.isArray(condition.value) ? (condition.value as Record<string, unknown>) : undefined
    const [from, to] = list ?? (range ? [range.from ?? range.start ?? range.low, range.to ?? range.end ?? range.high] : [])
    if (from === undefined || to === undefined) throw new QueryInputError(`"between" on ${property.name} needs two values, e.g. values ["2026-01-01","2026-01-31"].`)
    return `(${property.name} ge ${formatLiteral(property, from)} and ${property.name} le ${formatLiteral(property, to)})`
  }
  const value = condition.value ?? list?.[0]
  if (value === undefined) throw new QueryInputError(`The condition on ${property.name} needs a value.`)
  if (operator === "contains" || operator === "startswith" || operator === "endswith" || operator === "like") {
    if (!isTextProperty(property)) throw new QueryInputError(`${operator} works on text fields only; ${property.name} is ${property.type}. Use eq, gt, ge, lt or le.`)
    const text = unquote(String(value)).replace(/^[*%]+|[*%]+$/g, (match) => (operator === "like" ? match : ""))
    if (operator === "like") {
      const expression = wildcardExpression(property, text, notes)
      return expression ?? `${property.name} eq ${formatLiteral(property, text)}`
    }
    return `${operator}(${property.name},'${text.replace(/'/g, "''")}')`
  }
  if (typeof value === "string" && (operator === "eq" || operator === "ne")) {
    const expression = wildcardExpression(property, value, notes)
    if (expression) return operator === "eq" ? expression : `not ${expression}`
  }
  return `${property.name} ${operator} ${formatLiteral(property, value)}`
}

/** Conditions as one $filter expression, joined with and (match "all") or or ("any"). */
export function buildConditions(type: EntityTypeInfo, raw: unknown, match: unknown, notes: string[]): string | undefined {
  let conditions: unknown = raw
  if (typeof raw === "string") conditions = parseLooseJson(raw)
  if (conditions && !Array.isArray(conditions) && typeof conditions === "object") {
    const object = conditions as Record<string, unknown>
    // {"field":..,"operator":..} or {"Product":"ABC*","ProductType":"FERT"}
    conditions = "field" in object ? [object] : Object.entries(object).map(([field, value]) => ({ field, operator: "eq", value }))
  }
  if (!Array.isArray(conditions) || conditions.length === 0) return undefined
  const parts = conditions.map((item) => {
    const condition = parseObject(item)
    if (!condition) throw new QueryInputError(`Each condition is an object such as {"field":"Product","operator":"startswith","value":"ABC"}.`)
    return conditionExpression(type, {
      field: String(condition.field ?? condition.property ?? condition.name ?? condition.column ?? ""),
      operator: (condition.operator ?? condition.op ?? condition.comparison) as string | undefined,
      value: condition.value ?? condition.val,
      values: condition.values,
    }, notes)
  })
  const joiner = String(match ?? "all").toLowerCase() === "any" ? " or " : " and "
  return parts.length === 1 ? parts[0] : parts.map((part) => (part.includes(" or ") && joiner === " and " ? `(${part})` : part)).join(joiner)
}

// ---------- raw $filter ----------

/** Applies `fn` to the parts of an expression outside single-quoted literals. */
function outsideLiterals(text: string, fn: (part: string) => string) {
  return text
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 === 1 ? part : fn(part)))
    .join("")
}

const FILTER_KEYWORDS = new Set(["and", "or", "not", "eq", "ne", "gt", "ge", "lt", "le", "true", "false", "null", "has", "in"])

const SQL_OPERATORS: Record<string, string> = { "==": "eq", "=": "eq", "!=": "ne", "<>": "ne", ">=": "ge", "<=": "le", ">": "gt", "<": "lt" }

/**
 * Repairs and checks a $filter written by a model: SQL operators and double
 * quotes, OData V2 functions and datetime'…' literals, * wildcards, field
 * names in any casing or as labels, and literals in the wrong form for the
 * field's type.
 */
export function normalizeFilter(type: EntityTypeInfo, raw: unknown, notes: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined
  let filter = String(raw).trim()
  if (!filter) return undefined
  if (/^\$filter\s*=/i.test(filter)) filter = filter.replace(/^\$filter\s*=\s*/i, "")
  const original = filter

  // Double-quoted strings → single-quoted literals.
  filter = filter.replace(/"((?:[^"\\]|\\.)*)"/g, (_, value: string) => `'${value.replace(/\\"/g, '"').replace(/'/g, "''")}'`)
  // V2 literals and functions.
  filter = filter.replace(/\bdatetime(?:offset)?'([^']*)'/gi, "$1").replace(/\bguid'([^']*)'/gi, "$1")
  filter = filter.replace(/\bsubstringof\(\s*('(?:[^']|'')*')\s*,\s*([A-Za-z_]\w*)\s*\)(\s+eq\s+true)?/gi, "contains($2,$1)")
  // SQL and C-style operators.
  filter = outsideLiterals(filter, (part) =>
    part
      .replace(/&&/g, " and ")
      .replace(/\|\|/g, " or ")
      .replace(/\s*(==|!=|<>|>=|<=|=|>|<)\s*/g, (_, op: string) => ` ${SQL_OPERATORS[op]} `)
      .replace(/\b(AND|OR|NOT|EQ|NE|GT|GE|LT|LE)\b/g, (word) => word.toLowerCase())
  )
  // field like 'abc%'
  filter = filter.replace(/\b([A-Za-z_]\w*)\s+like\s+('(?:[^']|'')*')/gi, (match, field: string, literal: string) => {
    const property = resolveProperty(type, field)
    if (!("name" in property)) return match
    return wildcardExpression(property, literal, notes) ?? `${property.name} eq ${literal}`
  })

  const unknown: string[] = []
  const resolveField = (field: string) => {
    if (FILTER_KEYWORDS.has(field.toLowerCase())) return null
    const property = resolveProperty(type, field)
    if ("name" in property) return property
    unknown.push(`"${field}"${property.suggestions.length ? ` (similar: ${property.suggestions.join(", ")})` : ""}`)
    return null
  }

  // contains/startswith/endswith(Field, 'value'): resolve the field, quote the value, drop wildcards.
  filter = filter.replace(/\b(contains|startswith|endswith)\(\s*([A-Za-z_]\w*)\s*,\s*('(?:[^']|'')*'|[^)]*?)\s*\)/gi, (match, fn: string, field: string, value: string) => {
    const property = resolveField(field)
    if (!property) return match
    let text = unquote(value)
    const lowerFn = fn.toLowerCase()
    if (/^[*%]|[*%]$/.test(text)) {
      const expression = wildcardExpression(property, text, notes)
      if (expression && lowerFn === "contains") return expression
      text = text.replace(/^[*%]+|[*%]+$/g, "")
    }
    return `${lowerFn}(${property.name},'${text.replace(/'/g, "''")}')`
  })

  // Field op value: resolve the field and write the literal for its type.
  filter = filter.replace(/\b([A-Za-z_]\w*)\s+(eq|ne|gt|ge|lt|le)\s+('(?:[^']|'')*'|[^\s()]+)/g, (match, field: string, op: string, value: string) => {
    const property = resolveField(field)
    if (!property) return match
    if (!value.startsWith("'") && "name" in resolveProperty(type, value)) return `${property.name} ${op} ${value}` // field vs field
    if (value.startsWith("'") && (op === "eq" || op === "ne")) {
      const expression = wildcardExpression(property, value, notes)
      if (expression) return op === "eq" ? expression : `not ${expression}`
    }
    return `${property.name} ${op} ${formatLiteral(property, value)}`
  })

  if (unknown.length) {
    throw new QueryInputError(`${type.name} has no field ${unknown.join(", ")}. Call sap_describe_entity to see all fields, or use conditions.`)
  }
  let depth = 0
  for (const char of outsideLiterals(filter, (part) => part).replace(/'(?:[^']|'')*'/g, "")) {
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) break
  }
  if (depth !== 0) throw new QueryInputError(`The filter has unbalanced parentheses: ${original}`)
  filter = filter.replace(/\s+/g, " ").trim()
  if (filter !== original.replace(/\s+/g, " ").trim()) notes.push(`$filter corrected to: ${filter}`)
  return filter
}

/** Combines filter parts with and. */
export function andFilters(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part && part.trim()))
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return present.map((part) => (/\sor\s/i.test(part) && !/^\(.*\)$/.test(part) ? `(${part})` : part)).join(" and ")
}

// ---------- $select and $orderby ----------

export type SelectResult = { names: string[]; navigationPaths: { navigation: string; field: string }[]; ignored: string[] }

/** Resolves select names; "_Nav/Field" entries are returned for expansion, unknown names reported. */
export function resolveSelect(catalog: ServiceCatalog, type: EntityTypeInfo, raw: unknown, notes: string[]): SelectResult {
  const names = parseNameList(raw) ?? []
  const result: SelectResult = { names: [], navigationPaths: [], ignored: [] }
  for (const name of names) {
    if (name === "*") continue
    if (name.includes("/")) {
      const [navName, field] = name.split("/")
      const nav = resolveNavigation(catalog, type, navName)
      if (nav) {
        result.navigationPaths.push({ navigation: nav.name, field })
        continue
      }
    }
    const property = resolveProperty(type, name)
    if ("name" in property) {
      if (!result.names.includes(property.name)) result.names.push(property.name)
      continue
    }
    const nav = resolveNavigation(catalog, type, name)
    if (nav) {
      result.navigationPaths.push({ navigation: nav.name, field: "" })
      notes.push(`"${name}" is related data, not a field of ${type.name}: included it through ${nav.name}.`)
      continue
    }
    result.ignored.push(name)
    notes.push(
      `Left out "${name}": ${type.name} has no such field.${property.suggestions.length ? ` Similar: ${property.suggestions.join(", ")}.` : ""}`
    )
  }
  return result
}

const ADMIN_FIELD = /^(Creat|LastChang|Changed|LastChanged)/i

/** The fields to read when the model names none: keys, then the first business fields in $metadata order. */
export function defaultSelect(type: EntityTypeInfo, limit = 12): string[] {
  const keys = type.keys
  const business = type.properties.filter((property) => !keys.includes(property.name) && !ADMIN_FIELD.test(property.name) && !/ISOUnit$/.test(property.name))
  return [...keys, ...business.slice(0, Math.max(0, limit - keys.length)).map((property) => property.name)]
}

/** "LastChangeDate desc, Product" or ["Product asc"] or [{"field":…,"direction":…}] → valid $orderby. */
export function normalizeOrderby(type: EntityTypeInfo, raw: unknown, notes: string[]): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  let items: unknown[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === "string") items = /^\s*\[/.test(raw) ? ((parseLooseJson(raw) as unknown[]) ?? []) : raw.replace(/^\$orderby\s*=\s*/i, "").split(",")
  else if (typeof raw === "object") items = [raw]
  const parts: string[] = []
  for (const item of items) {
    const object = parseObject(item)
    const text = object ? `${object.field ?? object.property ?? object.name ?? ""} ${object.direction ?? object.order ?? ""}` : String(item)
    const words = text.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    let direction = "asc"
    const last = words[words.length - 1].toLowerCase()
    if (/^(asc|ascending|desc|descending)$/.test(last)) {
      direction = last.startsWith("desc") ? "desc" : "asc"
      words.pop()
    }
    const property = resolveProperty(type, words.join(" "))
    if (!("name" in property)) {
      notes.push(`Left out ordering by "${words.join(" ")}": ${type.name} has no such field.`)
      continue
    }
    parts.push(`${property.name} ${direction}`)
  }
  return parts.length ? parts.join(",") : undefined
}

// ---------- $expand ----------

export type ExpandSpec = {
  navigation: string
  select?: unknown
  filter?: unknown
  conditions?: unknown
  match?: unknown
  orderby?: unknown
  top?: unknown
  skip?: unknown
  expand?: ExpandSpec[]
}

/** Splits at separators outside quotes and parentheses; a stray ")" never makes the depth negative. */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let quoted = false
  for (const char of text) {
    if (char === "'") quoted = !quoted
    if (!quoted) {
      if (char === "(") depth += 1
      if (char === ")") depth = Math.max(0, depth - 1)
      if (depth === 0 && separators.includes(char)) {
        parts.push(current)
        current = ""
        continue
      }
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Removes ")" that close nothing (outside quotes), e.g. "a;)$filter=…". */
function dropUnbalancedClosers(text: string): string {
  let out = ""
  let depth = 0
  let quoted = false
  for (const char of text) {
    if (char === "'") quoted = !quoted
    if (!quoted && char === "(") depth += 1
    if (!quoted && char === ")") {
      if (depth === 0) continue
      depth -= 1
    }
    out += char
  }
  return out + ")".repeat(depth)
}

/** Parses an $expand string, also badly nested ones, into structured specs. */
export function parseExpandString(text: string): ExpandSpec[] {
  const cleaned = text.trim().replace(/^\$expand\s*=\s*/i, "")
  return splitTopLevel(cleaned, ",").flatMap((item) => {
    const name = item.match(/^([A-Za-z_][\w]*)/)?.[1]
    if (!name) return []
    let rest = item.slice(name.length).trim()
    if (rest.startsWith("/")) {
      // _Nav/Field
      return [{ navigation: name, select: rest.slice(1).replace(/[()]/g, "") }]
    }
    if (!rest.startsWith("(")) return [{ navigation: name }]
    rest = rest.slice(1)
    if (rest.endsWith(")")) rest = rest.slice(0, -1)
    const options = splitTopLevel(dropUnbalancedClosers(rest), ";&").flatMap((option) => splitTopLevel(option.replace(/,\s*(?=\$)/g, ";"), ";"))
    const spec: ExpandSpec = { navigation: name }
    for (const option of options) {
      const match = option.match(/^\$?(\w+)\s*=\s*([\s\S]*)$/)
      if (!match) continue
      const key = match[1].toLowerCase()
      const value = match[2].trim()
      if (key === "select") spec.select = value
      else if (key === "filter") spec.filter = value
      else if (key === "orderby") spec.orderby = value
      else if (key === "top") spec.top = value
      else if (key === "skip") spec.skip = value
      else if (key === "expand") spec.expand = parseExpandString(value)
    }
    return [spec]
  })
}

/** Expand input in any form: string, list of names, list of specs, or {"_Nav": {...}}. */
export function parseExpandInput(raw: unknown): ExpandSpec[] {
  if (raw === undefined || raw === null || raw === "") return []
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (/^[[{]/.test(trimmed)) {
      const parsed = parseLooseJson(trimmed)
      if (parsed !== undefined) return parseExpandInput(parsed)
    }
    return parseExpandString(trimmed)
  }
  if (Array.isArray(raw)) return raw.flatMap((item) => parseExpandInput(item))
  if (typeof raw === "object") {
    const object = raw as Record<string, unknown>
    const navigation = object.navigation ?? object.name ?? object.property ?? object.path ?? object.nav ?? object.entity
    if (typeof navigation === "string") {
      return [{
        navigation,
        select: object.select ?? object.fields,
        filter: object.filter,
        conditions: object.conditions ?? object.where,
        match: object.match,
        orderby: object.orderby ?? object.orderBy,
        top: object.top ?? object.limit,
        skip: object.skip,
        expand: object.expand ? parseExpandInput(object.expand) : undefined,
      }]
    }
    // {"_ProductDescription": {"select": [...]}, "_ProductPlant": true}
    return Object.entries(object).flatMap(([name, options]) => {
      const spec = parseObject(options)
      return [{ ...(spec ? (parseExpandInput({ ...spec, navigation: name })[0] ?? {}) : {}), navigation: name }]
    })
  }
  return []
}

/** Validated $expand: navigation names resolved, fields checked, filters repaired; at most two levels. */
export function buildExpand(catalog: ServiceCatalog, type: EntityTypeInfo, specs: ExpandSpec[], notes: string[], depth = 1): string | undefined {
  const merged = new Map<string, ExpandSpec>()
  for (const spec of specs) {
    const nav = resolveNavigation(catalog, type, spec.navigation)
    if (!nav) {
      notes.push(`Left out "${spec.navigation}": ${type.name} has no such related data. It has ${type.navigation.map((item) => item.name).join(", ") || "none"}.`)
      continue
    }
    const existing = merged.get(nav.name)
    if (existing) {
      const names = [...(parseNameList(existing.select) ?? []), ...(parseNameList(spec.select) ?? [])]
      existing.select = names.length ? names : undefined
      continue
    }
    merged.set(nav.name, { ...spec, navigation: nav.name })
  }
  const parts: string[] = []
  for (const [navName, spec] of merged) {
    const nav = type.navigation.find((item) => item.name === navName)!
    const target = catalog.entityTypes.get(nav.targetType)
    if (!target) continue
    const options: string[] = []
    const select = resolveSelect(catalog, target, spec.select, notes)
    // Without a selection, the main fields only (related data can have a hundred fields), without the parent's key repeated.
    const fields = select.names.length ? select.names : defaultSelect(target, 10).filter((name) => !type.keys.includes(name))
    if (fields.length) options.push(`$select=${fields.join(",")}`)
    const filter = andFilters(normalizeFilter(target, spec.filter, notes), buildConditions(target, spec.conditions, spec.match, notes))
    if (filter) options.push(`$filter=${filter}`)
    const orderby = normalizeOrderby(target, spec.orderby, notes)
    if (orderby) options.push(`$orderby=${orderby}`)
    const top = parseCount(spec.top)
    if (top !== undefined && top > 0) options.push(`$top=${top}`)
    const skip = parseCount(spec.skip)
    if (skip) options.push(`$skip=${skip}`)
    if (spec.expand?.length) {
      if (depth >= 2) {
        notes.push(`Left out the expansion below ${nav.name}: at most two levels are allowed. Query that data directly instead.`)
      } else {
        const nested = buildExpand(catalog, target, spec.expand, notes, depth + 1)
        if (nested) options.push(`$expand=${nested}`)
      }
    }
    parts.push(options.length ? `${nav.name}(${options.join(";")})` : nav.name)
  }
  return parts.length ? parts.join(",") : undefined
}

// ---------- key predicates in paths ----------

/** Key values from a predicate's inside: "'A'", "A", "Product='A',Plant='1010'", "Product=A". */
export function parsePredicate(type: EntityTypeInfo, inner: string): Record<string, string> {
  const text = inner.trim()
  const parts = splitTopLevel(text, ",")
  if (parts.length === 1 && !/^[A-Za-z_]\w*\s*=/.test(parts[0])) {
    if (type.keys.length !== 1) throw new QueryInputError(`${type.name} has the keys ${type.keys.join(", ")}; write them as ${type.keys.map((key) => `${key}='…'`).join(",")}.`)
    return { [type.keys[0]]: unquote(parts[0]) }
  }
  const keys: Record<string, string> = {}
  for (const part of parts) {
    const match = part.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/)
    if (!match) throw new QueryInputError(`Cannot read the key "${part}". Write keys as Name='value'.`)
    const key = type.keys.find((name) => name.toLowerCase() === match[1].toLowerCase()) ?? match[1]
    keys[key] = unquote(match[2])
  }
  return keys
}

/** Splits a resource path at "/" outside quotes and parentheses. */
export function splitPath(path: string): string[] {
  return splitTopLevel(path.replace(/^\/+/, ""), "/")
}
