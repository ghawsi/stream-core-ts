import { isAllowedServiceRoot, SapSessionExpiredError, type SapClient } from "@/lib/sap/client"
import { parseCsdl, typeOfSet, type CodeListReference, type ServiceCatalog } from "@/lib/sap/metadata"
import { normaliseServicePath } from "@/lib/sap/odata"
import type { CodeList } from "@/lib/sap/code-match"

export { describeCode, findCode, type CodeEntry, type CodeList } from "@/lib/sap/code-match"

/**
 * SAP's code lists for units of measure and currencies (the common service
 * that the API's $metadata points to with CodeList.UnitsOfMeasure and
 * CodeList.CurrencyCodes). The API exchanges SAP's internal codes ("KG",
 * "ST", "CCM"); people and models say "kg", "piece", "KGM" or "cm3". The
 * list maps all of these to the internal code and gives its ISO code and the
 * decimals the unit or currency allows.
 */

const TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { list: CodeList | null; fetchedAt: number; ttl: number }>()

/** The code list's service root, resolved like a browser would against the API's $metadata URL. */
export function codeListServiceRoot(servicePath: string, reference: CodeListReference): string | null {
  try {
    const resolved = new URL(reference.url, `https://sap.invalid${normaliseServicePath(servicePath)}/$metadata`)
    const root = resolved.pathname.replace(/\/\$metadata$/, "").replace(/\/+$/, "")
    return isAllowedServiceRoot(root) ? root : null
  } catch {
    return null
  }
}

/** Property names of a code list entity from its own $metadata annotations; standard SAP names otherwise. */
function codeListFields(xml: string, collectionPath: string) {
  const catalog = parseCsdl(xml)
  const set = catalog.entitySets.find((item) => item.name === collectionPath)
  const type = set ? typeOfSet(catalog, set) : undefined
  const key = type?.keys[0]
  const names = new Set(type?.properties.map((property) => property.name) ?? [])
  // Annotations on the key property: Common.Text, CodeList.StandardCode, CodeList.ExternalCode, Common.UnitSpecificScale.
  const annotations = key && type ? (xml.match(new RegExp(`<Annotations Target="[^"]*\\b${type.name}/${key}">([\\s\\S]*?)</Annotations>`))?.[1] ?? "") : ""
  const path = (term: string) => annotations.match(new RegExp(`Term="[^"]*\\.${term}"[^>]*Path="([^"]+)"`))?.[1]
  const pick = (annotated: string | undefined, ...fallbacks: string[]) => annotated ?? fallbacks.find((name) => names.has(name))
  return {
    code: key ?? (collectionPath === "Currencies" ? "CurrencyCode" : "UnitCode"),
    iso: pick(path("StandardCode"), "ISOCode"),
    external: pick(path("ExternalCode"), "ExternalCode"),
    text: pick(path("Text"), "Text", "Description"),
    decimals: pick(path("UnitSpecificScale"), "DecimalPlaces"),
  }
}

/** The unit or currency code list for this service, from cache or SAP; null when SAP offers none. */
export async function loadCodeList(client: SapClient, catalog: ServiceCatalog, kind: CodeList["kind"]): Promise<CodeList | null> {
  const reference = catalog.codeLists?.[kind]
  if (!reference) return null
  const root = codeListServiceRoot(client.system.servicePath, reference)
  if (!root) return null
  const key = `${client.system.id}|${client.system.baseUrl}|${client.system.sapClient}|${root}|${reference.collectionPath}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached.list

  let list: CodeList | null = null
  try {
    const metadata = await client.request({ method: "GET", path: "$metadata", accept: "application/xml", serviceRoot: root, toolName: "code_list" })
    const fields = metadata.ok ? codeListFields(metadata.text, reference.collectionPath) : codeListFields("", reference.collectionPath)
    const response = await client.request({ method: "GET", path: reference.collectionPath, query: { $top: "10000" }, serviceRoot: root, toolName: "code_list" })
    const rows = (response.data as { value?: Record<string, unknown>[] } | null)?.value
    if (response.ok && Array.isArray(rows)) {
      const text = (row: Record<string, unknown>, name?: string) => (name && row[name] !== undefined && row[name] !== null && row[name] !== "" ? String(row[name]) : undefined)
      list = {
        kind,
        entries: rows
          .map((row) => ({
            code: String(row[fields.code] ?? ""),
            iso: text(row, fields.iso),
            external: text(row, fields.external),
            text: text(row, fields.text),
            decimals: fields.decimals !== undefined && row[fields.decimals] !== undefined && row[fields.decimals] !== null ? Number(row[fields.decimals]) : undefined,
          }))
          .filter((entry) => entry.code),
      }
    }
  } catch (error) {
    if (error instanceof SapSessionExpiredError) throw error
    list = null
  }
  cache.set(key, { list, fetchedAt: Date.now(), ttl: list ? TTL_MS : FAILURE_TTL_MS })
  return list
}
