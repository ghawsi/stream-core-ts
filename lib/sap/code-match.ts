/**
 * Matching what people and models write ("kg", "piece", "KGM", "Euro") to
 * entries of SAP's unit and currency code lists. Pure functions, no imports
 * at runtime (loading the lists is lib/sap/code-lists.ts).
 */

export type CodeEntry = { code: string; iso?: string; external?: string; text?: string; decimals?: number }
export type CodeList = { kind: "units" | "currencies"; entries: CodeEntry[] }

/** Words people use for units, as ISO codes (resolved through the system's own code list). */
const UNIT_WORDS: Record<string, string[]> = {
  piece: ["H87", "PCE", "C62"], pieces: ["H87", "PCE", "C62"], pc: ["H87", "PCE", "C62"], pcs: ["H87", "PCE", "C62"], each: ["EA", "H87", "PCE"], ea: ["EA", "H87", "PCE"], stück: ["H87", "PCE", "C62"], stk: ["H87", "PCE", "C62"],
  kilogram: ["KGM"], kilograms: ["KGM"], kilo: ["KGM"], kilos: ["KGM"], kgs: ["KGM"],
  gram: ["GRM"], grams: ["GRM"], gramm: ["GRM"],
  ton: ["TNE"], tons: ["TNE"], tonne: ["TNE"], tonnes: ["TNE"],
  liter: ["LTR"], liters: ["LTR"], litre: ["LTR"], litres: ["LTR"],
  milliliter: ["MLT"], millilitre: ["MLT"], ml: ["MLT"],
  meter: ["MTR"], meters: ["MTR"], metre: ["MTR"], metres: ["MTR"],
  centimeter: ["CMT"], centimeters: ["CMT"], centimetre: ["CMT"], centimetres: ["CMT"],
  millimeter: ["MMT"], millimeters: ["MMT"], millimetre: ["MMT"], millimetres: ["MMT"],
  cm3: ["CMQ"], ccm: ["CMQ"], "cm³": ["CMQ"], cubiccentimeter: ["CMQ"], cubiccentimeters: ["CMQ"],
  dm3: ["DMQ"], "dm³": ["DMQ"], m3: ["MTQ"], "m³": ["MTQ"], cubicmeter: ["MTQ"], cubicmeters: ["MTQ"],
  m2: ["MTK"], "m²": ["MTK"], squaremeter: ["MTK"], squaremeters: ["MTK"],
  hour: ["HUR"], hours: ["HUR"], day: ["DAY"], days: ["DAY"], week: ["WEE"], weeks: ["WEE"], month: ["MON"], months: ["MON"], year: ["ANN"], years: ["ANN"],
  celsius: ["CEL"], "°c": ["CEL"], fahrenheit: ["FAH"], "°f": ["FAH"],
}

const squash = (text: string) => text.toLowerCase().replace(/[\s._-]+/g, "")

export function describeCode(entry: CodeEntry) {
  const details = [entry.text, entry.iso ? `ISO ${entry.iso}` : undefined].filter(Boolean).join(", ")
  return details ? `${entry.code} (${details})` : entry.code
}

/**
 * The entry a person or model means: the internal code, the external
 * (commercial) code, the ISO code, the text ("Kilogram", "Euro") or a common
 * word ("piece", "kg"). Ambiguous or unknown input returns suggestions.
 */
export function findCode(list: CodeList, input: string): CodeEntry | { suggestions: string[] } {
  const raw = input.trim()
  const wanted = raw.toUpperCase()
  const entries = list.entries
  const exact = entries.find((entry) => entry.code === raw)
  if (exact) return exact
  for (const matches of [
    entries.filter((entry) => entry.code.toUpperCase() === wanted),
    entries.filter((entry) => entry.external?.toUpperCase() === wanted),
    entries.filter((entry) => entry.iso?.toUpperCase() === wanted),
    entries.filter((entry) => entry.text && squash(entry.text) === squash(raw)),
  ]) {
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      // Several units share a code: prefer the one whose external code equals its internal code.
      const primary = matches.find((entry) => entry.external === entry.code) ?? matches.find((entry) => entry.iso === entry.code)
      if (primary) return primary
      return { suggestions: matches.slice(0, 6).map(describeCode) }
    }
  }
  if (list.kind === "units") {
    const words = UNIT_WORDS[squash(raw)] ?? UNIT_WORDS[squash(raw).replace(/s$/, "")] ?? []
    for (const iso of words) {
      const byIso = entries.filter((entry) => entry.iso === iso)
      if (byIso.length) return byIso.find((entry) => entry.external === entry.code) ?? byIso[0]
    }
  }
  const needle = squash(raw)
  const suggestions = needle
    ? entries
        .filter((entry) =>
          [entry.code, entry.external, entry.iso, entry.text].some((value) => value && (squash(value).startsWith(needle) || (needle.length >= 3 && squash(value).includes(needle))))
        )
        .slice(0, 6)
        .map(describeCode)
    : []
  return { suggestions }
}
