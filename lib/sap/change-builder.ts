import type { CodeEntry } from "./code-match"
import type { EntityTypeInfo, PropertyInfo } from "./metadata"

/**
 * Complete and consistent changes for SAP APIs whose fields depend on each
 * other, as the $metadata declares it:
 *
 * - a quantity and its unit (Measures.Unit) and ISO unit (Measures.UNECEUnit),
 *   e.g. GrossWeight + NetWeight + WeightUnit + WeightISOUnit;
 * - an amount and its currency (Measures.ISOCurrency), e.g. StandardPrice + Currency.
 *
 * SAP needs the whole group in one request and the values must fit together
 * (a unit and its ISO code, decimals per unit or currency). The model only
 * names what the user wants changed; this module normalises the values
 * (units and currencies through SAP's code lists, upper case, digits),
 * adds the dependent fields with their current values and reports what does
 * not fit before anything is sent. Pure functions.
 */

export class ChangeInputError extends Error {}

export type CodeResolver = {
  /** Finds a unit by any form; null when the system offers no unit code list. */
  unit: ((input: string) => CodeEntry | { suggestions: string[] }) | null
  currency: ((input: string) => CodeEntry | { suggestions: string[] }) | null
}

export type DependencyGroup = {
  kind: "unit" | "currency"
  /** The unit or currency field. */
  code: string
  /** The ISO unit field, for unit groups. */
  iso?: string
  /** Quantities or amounts measured in it. */
  members: string[]
}

export type ChangeRow = { field: string; label?: string; current: string; next: string; sentAlong?: boolean; note?: string }

const find = (type: EntityTypeInfo, name: string | undefined) => (name ? type.properties.find((property) => property.name === name) : undefined)
const labelOf = (property: PropertyInfo | undefined, fallback = "") => property?.label ?? property?.name ?? fallback

/** Fields SAP needs together, from the unit, ISO unit and currency annotations; BaseUnit ↔ BaseISOUnit by name. */
export function dependencyGroups(type: EntityTypeInfo): DependencyGroup[] {
  const groups = new Map<string, DependencyGroup>()
  const group = (kind: DependencyGroup["kind"], code: string) => {
    const key = `${kind}:${code}`
    let entry = groups.get(key)
    if (!entry) {
      entry = { kind, code, members: [] }
      groups.set(key, entry)
    }
    return entry
  }
  for (const property of type.properties) {
    if (property.unitProperty && find(type, property.unitProperty)) {
      const entry = group("unit", property.unitProperty)
      entry.members.push(property.name)
      if (property.isoUnitProperty && find(type, property.isoUnitProperty)) entry.iso ??= property.isoUnitProperty
    }
    if (property.currencyProperty && find(type, property.currencyProperty)) group("currency", property.currencyProperty).members.push(property.name)
  }
  for (const property of type.properties) if (property.isUnit) group("unit", property.name)
  for (const entry of groups.values()) {
    if (entry.kind !== "unit" || entry.iso) continue
    const iso = entry.code.replace(/Unit$/, "ISOUnit")
    if (iso !== entry.code && find(type, iso)) entry.iso = iso
  }
  return [...groups.values()]
}

/** Keys, calculated and immutable fields are never sent. */
const sendable = (type: EntityTypeInfo, property: PropertyInfo | undefined) => Boolean(property && !property.computed && !property.immutable && !type.keys.includes(property.name))

export type PreparedChange = {
  /** Requested values, normalised (SAP unit and currency codes, upper case), plus derived unit or ISO fields. */
  values: Record<string, unknown>
  /** Fields to read and send along because a requested field depends on them. */
  dependents: string[]
  /** What was converted, for the model and the user. */
  notes: string[]
  /** Code list entries of units and currencies set in this change, by field. */
  entries: Record<string, CodeEntry>
}

function resolveCode(kind: "unit" | "currency", resolver: CodeResolver, property: PropertyInfo, raw: unknown, notes: string[]): { value: string; entry?: CodeEntry } {
  const text = String(raw ?? "").trim()
  if (!text) return { value: "" }
  const lookup = kind === "unit" ? resolver.unit : resolver.currency
  if (!lookup) {
    const upper = text.toUpperCase()
    if (upper !== text) notes.push(`${labelOf(property)} "${text}" sent as "${upper}" (SAP offers no ${kind} code list to check it).`)
    return { value: upper }
  }
  const found = lookup(text)
  if (!("code" in found)) {
    throw new ChangeInputError(
      `"${text}" is not a ${kind === "unit" ? "unit of measure" : "currency"} in this SAP system (${labelOf(property)}).${found.suggestions.length ? ` Did you mean ${found.suggestions.join(", ")}?` : ""} Ask the user which one is meant.`
    )
  }
  if (found.code !== text) notes.push(`${labelOf(property)} "${text}" is SAP ${kind} ${found.code}${found.iso && found.iso !== found.code ? ` (ISO ${found.iso})` : ""}.`)
  return { value: found.code, entry: found }
}

/**
 * Normalises the requested values and works out the dependent fields.
 * `requested` maps exact field names to the values the model gave.
 */
export function prepareChange(type: EntityTypeInfo, requested: Record<string, unknown>, resolver: CodeResolver): PreparedChange {
  const groups = dependencyGroups(type)
  const values: Record<string, unknown> = {}
  const notes: string[] = []
  const entries: Record<string, CodeEntry> = {}
  const isoFields = new Map(groups.filter((group) => group.iso).map((group) => [group.iso!, group]))
  const unitFields = new Map(groups.filter((group) => group.kind === "unit").map((group) => [group.code, group]))
  const currencyFields = new Map(groups.filter((group) => group.kind === "currency").map((group) => [group.code, group]))

  for (const [name, raw] of Object.entries(requested)) {
    const property = find(type, name)
    if (!property) throw new ChangeInputError(`${type.name} has no field ${name}.`)
    if (unitFields.has(name) || property.isUnit) {
      const { value, entry } = resolveCode("unit", resolver, property, raw, notes)
      values[name] = value
      if (entry) entries[name] = entry
    } else if (isoFields.has(name)) {
      // An ISO unit given directly: find the SAP unit with that ISO code.
      const { value, entry } = resolveCode("unit", resolver, property, raw, notes)
      values[name] = entry?.iso ?? value
      if (entry) entries[name] = entry
    } else if (currencyFields.has(name) || property.isCurrency) {
      const { value, entry } = resolveCode("currency", resolver, property, raw, notes)
      values[name] = value
      if (entry) entries[name] = entry
    } else if (property.upperCase && typeof raw === "string" && raw !== raw.toUpperCase()) {
      values[name] = raw.toUpperCase()
      notes.push(`${labelOf(property)} "${raw}" sent as "${raw.toUpperCase()}" (SAP stores it in upper case).`)
    } else if (property.digitsOnly && raw !== null && raw !== undefined && String(raw).trim() !== "" && !/^\d+$/.test(String(raw).trim())) {
      throw new ChangeInputError(`${labelOf(property)} takes digits only; got "${String(raw)}".`)
    } else {
      values[name] = raw
    }
  }

  // Unit and ISO unit must name the same unit.
  for (const group of groups) {
    if (group.kind !== "unit" || !group.iso) continue
    const unitEntry = entries[group.code]
    const isoEntry = entries[group.iso]
    const unitProperty = find(type, group.code)
    const isoProperty = find(type, group.iso)
    if (unitEntry && isoEntry && unitEntry.iso && isoEntry.iso && unitEntry.iso !== isoEntry.iso) {
      throw new ChangeInputError(
        `${labelOf(unitProperty)} ${unitEntry.code} (ISO ${unitEntry.iso}) and ${labelOf(isoProperty)} ${isoEntry.iso} name different units. Give one unit only; the tool sets both fields.`
      )
    }
    if (isoEntry && !(group.code in values) && sendable(type, unitProperty)) {
      values[group.code] = isoEntry.code
      entries[group.code] = isoEntry
      notes.push(`${labelOf(unitProperty)} set to ${isoEntry.code} to match ISO ${isoEntry.iso}.`)
    }
    if (unitEntry && !(group.iso in values) && sendable(type, isoProperty)) {
      if (unitEntry.iso) {
        values[group.iso] = unitEntry.iso
        entries[group.iso] = unitEntry
      }
    }
  }

  // Everything else in a touched group travels along with its current value.
  const dependents = new Set<string>()
  for (const group of groups) {
    const fields = [group.code, ...(group.iso ? [group.iso] : []), ...group.members]
    if (!fields.some((field) => field in values)) continue
    for (const field of fields) if (!(field in values) && sendable(type, find(type, field))) dependents.add(field)
  }
  return { values, dependents: [...dependents], notes, entries }
}

const display = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value))
const numeric = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null)
const decimalsIn = (value: unknown) => String(value ?? "").split(".")[1]?.replace(/0+$/, "").length ?? 0

/** Equal for the purpose of a change: "12.500" equals "12.5" for decimals; empty equals null. */
export function sameValue(before: unknown, next: unknown) {
  if (display(before) === display(next)) return true
  const a = numeric(before)
  const b = numeric(next)
  return a !== null && b !== null && a === b
}

export type CompletedChange = {
  /** The request body: changed fields and their dependent fields. */
  payload: Record<string, unknown>
  /** Changed fields first, then fields sent along unchanged. */
  rows: ChangeRow[]
  warnings: string[]
}

/**
 * Builds the request from the converted values and the record's current
 * values (null for a create): only real changes, plus every field of a
 * touched group; checks units, decimals and weights. Throws ChangeInputError
 * for what SAP would refuse anyway.
 */
export function completeChange(
  type: EntityTypeInfo,
  prepared: PreparedChange,
  converted: Record<string, unknown>,
  current: Record<string, unknown> | null,
  resolver: CodeResolver
): CompletedChange {
  const groups = dependencyGroups(type)
  const payload: Record<string, unknown> = {}
  const rows: ChangeRow[] = []
  const warnings: string[] = []
  const creating = current === null

  for (const [name, value] of Object.entries(converted)) {
    const before = current?.[name]
    if (!creating && sameValue(before, value)) continue
    payload[name] = value
    rows.push({ field: name, label: find(type, name)?.label, current: creating ? "—" : display(before), next: display(value) })
  }
  if (rows.length === 0) return { payload, rows, warnings }
  const changed = new Set(Object.keys(payload))

  for (const group of groups) {
    const fields = [group.code, ...(group.iso ? [group.iso] : []), ...group.members]
    const touched = fields.filter((field) => changed.has(field))
    if (touched.length === 0) continue
    const codeProperty = find(type, group.code)
    const unitChanged = changed.has(group.code)
    const value = (field: string) => (field in payload ? payload[field] : current?.[field])

    // The rest of the group travels along: values the model repeated unchanged,
    // and dependent fields with their current value (a stale ISO code never does).
    if (!creating) {
      for (const field of fields) {
        if (field in payload || !sendable(type, find(type, field))) continue
        let next: unknown
        if (field in converted) {
          next = converted[field]
        } else if (prepared.dependents.includes(field)) {
          if (field === group.iso && unitChanged) {
            warnings.push(`${labelOf(find(type, field))} is left to SAP: the ISO code of the new unit could not be determined.`)
            continue
          }
          next = current?.[field] ?? ""
        } else {
          continue
        }
        payload[field] = next
        rows.push({
          field,
          label: find(type, field)?.label,
          current: display(current?.[field]),
          next: display(next),
          sentAlong: true,
          note: `required together with ${touched.map((name) => labelOf(find(type, name))).join(", ")}`,
        })
      }
    }

    // A quantity or amount needs its unit or currency.
    const code = String(value(group.code) ?? "").trim()
    const filledMembers = group.members.filter((member) => changed.has(member) && (numeric(payload[member]) ?? 0) !== 0)
    if (!code && filledMembers.length && sendable(type, codeProperty)) {
      throw new ChangeInputError(
        `${filledMembers.map((member) => labelOf(find(type, member))).join(", ")} needs ${group.kind === "unit" ? "a unit" : "a currency"} (${labelOf(codeProperty)}), and none is set. Ask the user which ${group.kind === "unit" ? "unit" : "currency"} is meant.`
      )
    }

    // Decimals allowed by the unit or currency.
    const entry = prepared.entries[group.code] ?? (code ? (group.kind === "unit" ? resolver.unit : resolver.currency)?.(code) : undefined)
    const allowed = entry && "code" in entry ? entry.decimals : undefined
    for (const member of group.members) {
      if (!(member in payload) || allowed === undefined) continue
      const property = find(type, member)
      if (decimalsIn(payload[member]) > allowed) {
        const message = `${labelOf(property)} ${display(payload[member])} has more decimals than ${code} allows (${allowed}).`
        if (group.kind === "currency" || property?.variableScale) throw new ChangeInputError(`${message} Round the amount.`)
        warnings.push(`${message} SAP may round or refuse it.`)
      }
    }

    // A new unit does not convert the numbers measured in it.
    if (unitChanged && !creating) {
      const kept = group.members.filter((member) => !changed.has(member) && (numeric(current?.[member]) ?? 0) !== 0)
      if (kept.length) {
        warnings.push(
          `${kept.map((member) => `${labelOf(find(type, member))} (${display(current?.[member])})`).join(", ")} keep${kept.length === 1 ? "s" : ""} the number but now mean${kept.length === 1 ? "s" : ""} ${code} instead of ${display(current?.[group.code])}. Change ${kept.length === 1 ? "it" : "them"} too if the value should stay the same.`
        )
      }
    }
  }

  // Net weight above gross weight is refused by SAP's product master checks.
  const gross = numeric(payload.GrossWeight ?? current?.GrossWeight)
  const net = numeric(payload.NetWeight ?? current?.NetWeight)
  if (("GrossWeight" in payload || "NetWeight" in payload) && gross !== null && net !== null && net > gross) {
    throw new ChangeInputError(`The net weight (${net}) would be higher than the gross weight (${gross}). SAP does not accept that; ask the user for both values.`)
  }

  // The base unit carries stock, documents and conversions.
  if (changed.has("BaseUnit") && !creating) {
    warnings.push("Changing the base unit of measure affects stock, open documents and unit conversions. SAP refuses it while stock or documents exist.")
  }
  return { payload, rows, warnings }
}

/** Short code fields whose values must exist in SAP customizing (status, group, category codes). */
export function isCustomizingCode(type: EntityTypeInfo, property: PropertyInfo) {
  const groups = dependencyGroups(type)
  const special = new Set(groups.flatMap((group) => [group.code, ...(group.iso ? [group.iso] : [])]))
  return (
    property.type === "Edm.String" &&
    Boolean(property.upperCase) &&
    (property.maxLength ?? 99) <= 4 &&
    !type.keys.includes(property.name) &&
    !special.has(property.name) &&
    !property.isUnit &&
    !property.isCurrency
  )
}
