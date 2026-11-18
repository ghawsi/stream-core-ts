import type { SapClient } from "@/lib/sap/client"

/**
 * The OData V4 $metadata (CSDL XML) of a service, reduced to what the agent
 * needs: entity sets, keys, properties with types, lengths and labels,
 * navigation properties, and insert/update/delete restrictions.
 *
 * The live $metadata is the first source of truth for the product agent;
 * nothing names an entity or property that is not in it.
 */

export type PropertyInfo = {
  name: string
  type: string
  maxLength?: number
  precision?: number
  scale?: number
  /** Scale="variable": the decimals depend on the currency or unit of the value. */
  variableScale?: boolean
  nullable: boolean
  label?: string
  computed?: boolean
  immutable?: boolean
  /** Quantity: the property holding its SAP unit (Measures.Unit), e.g. GrossWeight → WeightUnit. */
  unitProperty?: string
  /** Quantity: the property holding its ISO unit (Measures.UNECEUnit), e.g. GrossWeight → WeightISOUnit. */
  isoUnitProperty?: string
  /** Amount: the property holding its currency (Measures.ISOCurrency), e.g. StandardPrice → Currency. */
  currencyProperty?: string
  /** Common.IsUnit: the property is a unit of measure. */
  isUnit?: boolean
  /** Common.IsCurrency: the property is a currency code. */
  isCurrency?: boolean
  /** Common.IsUpperCase: SAP stores the value in upper case only. */
  upperCase?: boolean
  /** Common.IsDigitSequence: the value consists of digits only. */
  digitsOnly?: boolean
}

/** Where SAP's code lists for units of measure and currencies are (CodeList vocabulary on the container). */
export type CodeListReference = { url: string; collectionPath: string }

export type NavigationInfo = {
  name: string
  /** Qualified target type. */
  targetType: string
  collection: boolean
}

export type EntityTypeInfo = {
  qualifiedName: string
  name: string
  keys: string[]
  properties: PropertyInfo[]
  navigation: NavigationInfo[]
  label?: string
}

export type EntitySetInfo = {
  name: string
  entityType: string
  label?: string
  insertable: boolean
  updatable: boolean
  deletable: boolean
}

export type ServiceCatalog = {
  entitySets: EntitySetInfo[]
  entityTypes: Map<string, EntityTypeInfo>
  /** Code lists the service refers to, with URLs relative to its $metadata. */
  codeLists?: { units?: CodeListReference; currencies?: CodeListReference }
  fetchedAt: number
}

const CACHE_TTL_MS = 30 * 60 * 1000
const cache = new Map<string, ServiceCatalog>()

// ---------- tiny CSDL reader (no XML dependency) ----------

function decodeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:.]+)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2])
  return result
}

/** Elements `<Name ...>…</Name>` or `<Name .../>`, with their attributes and inner XML. */
function elements(xml: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const result: { attrs: Record<string, string>; inner: string }[] = []
  const pattern = new RegExp(`<${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${name}>)`, "g")
  for (const match of xml.matchAll(pattern)) result.push({ attrs: attributes(match[1] ?? ""), inner: match[3] ?? "" })
  return result
}

/** Value of an annotation whose term ends with `.term` (aliases such as SAP__common differ by system). */
function annotationString(xml: string, term: string): string | undefined {
  for (const annotation of elements(xml, "Annotation")) {
    if (annotation.attrs.Term?.endsWith(`.${term}`)) return annotation.attrs.String ?? annotation.inner.replace(/<[^>]+>/g, "").trim()
  }
  return undefined
}

function annotationFlag(xml: string, term: string): boolean | undefined {
  for (const annotation of elements(xml, "Annotation")) {
    if (annotation.attrs.Term?.endsWith(`.${term}`)) return annotation.attrs.Bool === undefined ? true : annotation.attrs.Bool === "true"
  }
  return undefined
}

/** The Path of an annotation such as <Annotation Term="SAP__measures.Unit" Path="WeightUnit"/>. */
function annotationPath(xml: string, term: string): string | undefined {
  for (const annotation of elements(xml, "Annotation")) {
    if (annotation.attrs.Term?.endsWith(`.${term}`) && annotation.attrs.Path) return annotation.attrs.Path
  }
  return undefined
}

/** A record annotation's string properties, e.g. CodeList.UnitsOfMeasure {Url, CollectionPath}. */
function annotationRecord(xml: string, term: string): Record<string, string> | undefined {
  for (const annotation of elements(xml, "Annotation")) {
    if (!annotation.attrs.Term?.endsWith(`.${term}`)) continue
    const record: Record<string, string> = {}
    for (const value of elements(annotation.inner, "PropertyValue")) {
      if (value.attrs.Property && value.attrs.String !== undefined) record[value.attrs.Property] = value.attrs.String
    }
    return record
  }
  return undefined
}

/** Reads the semantic annotations of a property (inline or external) into it. */
function applyPropertyAnnotations(property: PropertyInfo, xml: string) {
  property.label ??= annotationString(xml, "Label")
  property.computed ??= annotationFlag(xml, "Computed")
  property.immutable ??= annotationFlag(xml, "Immutable")
  property.unitProperty ??= annotationPath(xml, "Unit")
  property.isoUnitProperty ??= annotationPath(xml, "UNECEUnit")
  property.currencyProperty ??= annotationPath(xml, "ISOCurrency")
  property.isUnit ??= annotationFlag(xml, "IsUnit")
  property.isCurrency ??= annotationFlag(xml, "IsCurrency")
  property.upperCase ??= annotationFlag(xml, "IsUpperCase")
  property.digitsOnly ??= annotationFlag(xml, "IsDigitSequence")
}

/** e.g. InsertRestrictions/Insertable = false inside a Record. */
function restriction(xml: string, term: string, property: string): boolean | undefined {
  for (const annotation of elements(xml, "Annotation")) {
    if (!annotation.attrs.Term?.endsWith(`.${term}`)) continue
    for (const value of elements(annotation.inner, "PropertyValue")) {
      if (value.attrs.Property === property && value.attrs.Bool !== undefined) return value.attrs.Bool === "true"
    }
  }
  return undefined
}

export function parseCsdl(xml: string): ServiceCatalog {
  const entityTypes = new Map<string, EntityTypeInfo>()
  const entitySets: EntitySetInfo[] = []
  const targetAnnotations = new Map<string, string>() // target -> inner XML of <Annotations>

  for (const schema of elements(xml, "Schema")) {
    const namespace = schema.attrs.Namespace
    const alias = schema.attrs.Alias

    for (const block of elements(schema.inner, "Annotations")) {
      const target = block.attrs.Target ?? ""
      const normalised = alias && target.startsWith(`${alias}.`) ? `${namespace}.${target.slice(alias.length + 1)}` : target
      targetAnnotations.set(normalised, (targetAnnotations.get(normalised) ?? "") + block.inner)
    }

    for (const type of elements(schema.inner, "EntityType")) {
      const name = type.attrs.Name
      const keyBlock = elements(type.inner, "Key")[0]?.inner ?? ""
      const keys = elements(keyBlock, "PropertyRef").map((ref) => ref.attrs.Name)
      const properties: PropertyInfo[] = elements(type.inner, "Property").map((property) => {
        const info: PropertyInfo = {
          name: property.attrs.Name,
          type: property.attrs.Type,
          maxLength: property.attrs.MaxLength && property.attrs.MaxLength !== "max" ? Number(property.attrs.MaxLength) : undefined,
          precision: property.attrs.Precision ? Number(property.attrs.Precision) : undefined,
          // Edm.Decimal without Scale has scale 0; "variable" depends on the currency or unit.
          scale:
            property.attrs.Scale && /^\d+$/.test(property.attrs.Scale)
              ? Number(property.attrs.Scale)
              : property.attrs.Type === "Edm.Decimal" && property.attrs.Scale === undefined
                ? 0
                : undefined,
          variableScale: property.attrs.Scale === "variable" || undefined,
          nullable: property.attrs.Nullable !== "false",
        }
        applyPropertyAnnotations(info, property.inner)
        return info
      })
      const navigation: NavigationInfo[] = elements(type.inner, "NavigationProperty").map((nav) => {
        const rawType = nav.attrs.Type ?? ""
        const collection = rawType.startsWith("Collection(")
        const target = collection ? rawType.slice("Collection(".length, -1) : rawType
        const qualified = alias && target.startsWith(`${alias}.`) ? `${namespace}.${target.slice(alias.length + 1)}` : target
        return { name: nav.attrs.Name, targetType: qualified, collection }
      })
      entityTypes.set(`${namespace}.${name}`, { qualifiedName: `${namespace}.${name}`, name, keys, properties, navigation })
    }

    for (const container of elements(schema.inner, "EntityContainer")) {
      const containerName = `${namespace}.${container.attrs.Name}`
      for (const set of elements(container.inner, "EntitySet")) {
        const rawType = set.attrs.EntityType ?? ""
        const qualified = alias && rawType.startsWith(`${alias}.`) ? `${namespace}.${rawType.slice(alias.length + 1)}` : rawType
        const annotationsXml = set.inner + (targetAnnotations.get(`${containerName}/${set.attrs.Name}`) ?? "")
        entitySets.push({
          name: set.attrs.Name,
          entityType: qualified,
          label: annotationString(annotationsXml, "Label"),
          insertable: restriction(annotationsXml, "InsertRestrictions", "Insertable") ?? true,
          updatable: restriction(annotationsXml, "UpdateRestrictions", "Updatable") ?? true,
          deletable: restriction(annotationsXml, "DeleteRestrictions", "Deletable") ?? true,
        })
      }
    }
  }

  // External annotations (Target="ns.Type/Property") add labels, flags and unit/currency references.
  for (const type of entityTypes.values()) {
    type.label ??= annotationString(targetAnnotations.get(type.qualifiedName) ?? "", "Label")
    for (const property of type.properties) {
      const external = targetAnnotations.get(`${type.qualifiedName}/${property.name}`)
      if (external) applyPropertyAnnotations(property, external)
    }
  }

  // Code lists for units and currencies, annotated on the entity container.
  const codeLists: NonNullable<ServiceCatalog["codeLists"]> = {}
  for (const [target, xml] of targetAnnotations) {
    if (target.includes("/")) continue
    const units = annotationRecord(xml, "UnitsOfMeasure")
    const currencies = annotationRecord(xml, "CurrencyCodes")
    if (units?.Url && units.CollectionPath) codeLists.units ??= { url: units.Url, collectionPath: units.CollectionPath }
    if (currencies?.Url && currencies.CollectionPath) codeLists.currencies ??= { url: currencies.Url, collectionPath: currencies.CollectionPath }
  }

  return { entitySets, entityTypes, ...(codeLists.units || codeLists.currencies ? { codeLists } : {}), fetchedAt: Date.now() }
}

// ---------- loading ----------

export class MetadataUnavailableError extends Error {}

/** The catalog of the system's service, from cache or from a live GET $metadata. */
export async function loadCatalog(client: SapClient, options: { refresh?: boolean } = {}): Promise<ServiceCatalog> {
  const { system } = client
  const key = `${system.id}|${system.baseUrl}|${system.servicePath}|${system.sapClient}`
  const cached = cache.get(key)
  if (cached && !options.refresh && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const response = await client.request({ method: "GET", path: "$metadata", accept: "application/xml", toolName: "metadata" })
  if (response.status === 404) {
    throw new MetadataUnavailableError(
      `$metadata returned 404. The service is not published or the path is wrong: publish the service group in /IWFND/V4_ADMIN and check node /sap/opu/odata4 in SICF.`
    )
  }
  if (!response.ok) {
    throw new MetadataUnavailableError(`$metadata returned ${response.status}: ${response.error?.message ?? "no details"}`)
  }
  const catalog = parseCsdl(response.text)
  if (catalog.entitySets.length === 0) throw new MetadataUnavailableError("$metadata contains no entity sets.")
  cache.set(key, catalog)
  if (cache.size > 50) cache.delete(cache.keys().next().value as string)
  return catalog
}

// ---------- lookups ----------

export function findEntitySet(catalog: ServiceCatalog, name: string): EntitySetInfo | undefined {
  return catalog.entitySets.find((set) => set.name === name) ?? catalog.entitySets.find((set) => set.name.toLowerCase() === name.toLowerCase())
}

export function typeOfSet(catalog: ServiceCatalog, set: EntitySetInfo): EntityTypeInfo | undefined {
  return catalog.entityTypes.get(set.entityType)
}

export const isStringType = (type: string) => type === "Edm.String"

/** Number-like types that IEEE754Compatible=true sends as JSON strings. */
export const isStringEncodedNumber = (type: string) => type === "Edm.Decimal" || type === "Edm.Int64"

/**
 * Key predicate for an entity: `('EF-MAT')` or `(Product='EF-MAT',Plant='1010')`.
 * Strings: single quotes doubled, then reserved characters percent-encoded.
 * Other types (numbers, booleans, GUIDs, dates) unquoted.
 */
export function buildKeyPredicate(type: EntityTypeInfo, keys: Record<string, string | number | boolean>): string {
  const provided = Object.keys(keys)
  const missing = type.keys.filter((key) => !(key in keys))
  if (missing.length > 0) throw new Error(`Missing key ${missing.join(", ")} for ${type.name}. Its keys are ${type.keys.join(", ")}.`)
  const unknown = provided.filter((key) => !type.keys.includes(key))
  if (unknown.length > 0) throw new Error(`${unknown.join(", ")} is not a key of ${type.name}. Its keys are ${type.keys.join(", ")}.`)

  const literal = (name: string) => {
    const property = type.properties.find((item) => item.name === name)
    const value = String(keys[name])
    if (!property || isStringType(property.type)) {
      if (property?.maxLength && value.length > property.maxLength) {
        throw new Error(`${name} has at most ${property.maxLength} characters; "${value}" has ${value.length}.`)
      }
      const quoted = value.replace(/'/g, "''")
      const encoded = quoted
        .replace(/%/g, "%25")
        .replace(/ /g, "%20")
        .replace(/\//g, "%2F")
        .replace(/#/g, "%23")
        .replace(/\?/g, "%3F")
        .replace(/&/g, "%26")
        .replace(/\+/g, "%2B")
      return `'${encoded}'`
    }
    return encodeURIComponent(value)
  }

  if (type.keys.length === 1) return `(${literal(type.keys[0])})`
  return `(${type.keys.map((key) => `${key}=${literal(key)}`).join(",")})`
}

/**
 * Resolves an entity-set or navigation path such as
 * "Product('EF-MAT')/_ProductPlant" to the entity type it returns.
 */
export function resolvePathType(catalog: ServiceCatalog, path: string): { type: EntityTypeInfo; collection: boolean } | { error: string } {
  const segments = path.split("/").filter(Boolean)
  const first = segments[0]?.match(/^([A-Za-z_][\w]*)(\(.*\))?$/)
  if (!first) return { error: `"${path}" does not start with an entity set name.` }
  const set = findEntitySet(catalog, first[1])
  if (!set) return { error: `There is no entity set "${first[1]}". Call sap_list_entities to see the available ones.` }
  let type = typeOfSet(catalog, set)
  if (!type) return { error: `The type of ${set.name} is missing from $metadata.` }
  let collection = !first[2]

  for (const segment of segments.slice(1)) {
    const match = segment.match(/^([A-Za-z_][\w]*)(\(.*\))?$/)
    if (!match) return { error: `"${segment}" is not a navigation property.` }
    const nav = type.navigation.find((item) => item.name === match[1])
    if (!nav) {
      return { error: `${type.name} has no navigation property "${match[1]}". It has: ${type.navigation.map((item) => item.name).join(", ") || "none"}.` }
    }
    const next = catalog.entityTypes.get(nav.targetType)
    if (!next) return { error: `The target type of ${nav.name} is missing from $metadata.` }
    type = next
    collection = nav.collection && !match[2]
  }
  return { type, collection }
}
