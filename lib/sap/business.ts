/**
 * Business language for SAP data: which business area a connected API
 * covers, and readable names for OData entity sets and paths. Shared by the
 * agent prompt (server) and the chat UI (browser); no server-only imports.
 */

export type BusinessArea = {
  id: string
  /** Title of the area, e.g. "Product master". */
  title: string
  /** What the data is called in a sentence, e.g. "product master data". */
  data: string
  /** Questions a business user can send as they are. */
  starters: readonly string[]
  /** Business rules for the agent prompt; orientation, confirmed against $metadata. */
  notes: readonly string[]
  /** Fields this API does not let change, with the reason; the change tool refuses them. */
  readOnlyFields?: readonly { entitySet: string; field: string; reason: string }[]
}

type AreaDefinition = BusinessArea & { match: RegExp }

/**
 * Known APIs from SAP Business Accelerator Hub, recognised by the service
 * path. Order matters: "productionorder" must win over "product".
 */
const AREAS: readonly AreaDefinition[] = [
  {
    id: "production-order",
    match: /productionorder|manufacturingorder|mfgorder/,
    title: "Production orders",
    data: "production orders",
    starters: ["Which production orders are released but not yet confirmed?", "Show the 10 most recently created production orders", "Which production orders are due this week?"],
    notes: [
      "A production order makes a product in a plant from its BOM and routing; its status shows the progress (created, released, partly or finally confirmed, delivered, technically completed).",
      "Quantities, dates and status changes after release or confirmation have consequences for material requirements planning and costing; mention them.",
    ],
  },
  {
    id: "maintenance-order",
    match: /maintenanceorder|maintorder/,
    title: "Maintenance orders",
    data: "maintenance orders",
    starters: ["Show open maintenance orders", "Which maintenance orders are planned for this week?", "Show the 10 most recently created maintenance orders"],
    notes: ["A maintenance order plans and records work on a technical object or equipment; its status shows whether it is released, confirmed or completed."],
  },
  {
    id: "sales-order",
    match: /salesorder/,
    title: "Sales orders",
    data: "sales orders",
    starters: ["Show the 10 most recent sales orders", "Which sales orders were created this week?", "Show the items of the most recent sales order"],
    notes: [
      "A sales order has a header (sold-to party, sales organization, distribution channel, division, requested delivery date) and items with schedule lines; pricing elements make up the net value.",
      "Delivery and billing status show how far the order has progressed. Quantities and prices of items that are already delivered or billed usually cannot be changed; SAP rejects such changes.",
    ],
  },
  {
    id: "purchase-order",
    match: /purchaseorder/,
    title: "Purchase orders",
    data: "purchase orders",
    starters: ["Show the 10 most recent purchase orders", "Which purchase orders were created this month?", "Show the items of the most recent purchase order"],
    notes: [
      "A purchase order has a header (supplier, company code, purchasing organization and group) and items with quantity, price, plant and delivery date.",
      "Items with goods receipts or invoices can usually no longer be changed freely; explain what that means before preparing a change.",
    ],
  },
  {
    id: "business-partner",
    match: /businesspartner/,
    title: "Business partners",
    data: "business partners (customers and suppliers)",
    starters: ["Show the 10 most recently created business partners", "Find business partners whose name contains 'GmbH'", "Which roles does the most recent business partner have?"],
    notes: [
      "A business partner is a person, organization or group; roles make it a customer, a supplier or both. Addresses, bank details and company code or sales area data hang below it.",
      "Changes to bank details and addresses are sensitive (payment fraud risk); point out that many companies require a second person to check them.",
    ],
  },
  {
    id: "bill-of-material",
    match: /billofmaterial|apibom|\/bom/,
    title: "Bills of material",
    data: "bills of material",
    starters: ["Show the 10 most recently changed bills of material", "Which components does the most recent bill of material have?", "Which bills of material are used for production?"],
    notes: [
      "A bill of material (BOM) lists the components of a product with quantities, for a plant and a usage (for example production or costing), valid from a date.",
      "Changes affect material requirements planning and product costing from their valid-from date; engineering change numbers may be required.",
    ],
  },
  {
    id: "routing",
    match: /routing/,
    title: "Routings",
    data: "routings",
    starters: ["Show the 10 most recently changed routings", "Which operations does the most recent routing have?", "Which work centers are used in routings?"],
    notes: ["A routing lists the operations to make a product, each at a work center with standard values (setup, machine and labor time). It drives scheduling, capacity planning and costing."],
  },
  {
    id: "work-center",
    match: /workcenter/,
    title: "Work centers",
    data: "work centers",
    starters: ["List the work centers per plant", "Show work centers with their cost centers", "Which work centers were changed most recently?"],
    notes: ["A work center belongs to a plant and is linked to a cost center for activity costing; its capacities and formulas drive scheduling and capacity planning."],
  },
  {
    id: "cost-center",
    match: /costcenter/,
    title: "Cost centers",
    data: "cost centers",
    starters: ["List cost centers with their persons responsible", "Which cost centers are valid today?", "Which cost centers belong to each company code?"],
    notes: [
      "A cost center belongs to a controlling area and a company code, has a category, a person responsible and a validity period. Many fields are time-dependent: a change applies from a valid-from date.",
      "A cost center with postings cannot simply be deleted; it is locked or its validity ends.",
    ],
  },
  {
    id: "journal-entry",
    match: /journalentry|generalledger|glaccountlineitem|glaccount/,
    title: "Journal entries and postings",
    data: "journal entries and postings",
    starters: ["Show this month's journal entries", "What was posted last month, by G/L account?", "Show the 10 largest postings this month"],
    notes: [
      "Journal entries are identified by company code, fiscal year and accounting document number; posting date and fiscal period decide the month they belong to. Amounts are in transaction and company code currency.",
      "A posted journal entry cannot be changed in amounts or accounts, nor deleted: it is corrected by a reversal posting. Never propose deleting or changing amounts of a posting.",
    ],
  },
  {
    id: "product",
    match: /product(?!ion)/,
    title: "Product master",
    data: "product master data",
    starters: ["Show the 10 most recently changed products", "Find products whose description contains 'pump'", "Which products are flagged for deletion?"],
    notes: [
      "The root entity set is Product (client-level data). Descriptions are in _ProductDescription (per language); data per organizational level is in navigations such as _ProductPlant, _ProductSalesDelivery, _ProductValuation and _ProductUnitOfMeasure, or in the entity sets of the same names.",
      "To list products, query Product. To show their names, expand _ProductDescription with a condition on Language (EN, or the user's language).",
      "Search products by number with conditions on Product (startswith, contains), by name with conditions on ProductDescription in ProductDescription.",
      "Not in this API: long texts (basic data, sales, purchase order, inspection texts), classification and characteristics, retail articles.",
      "The product type cannot be changed through this API; SAP offers the Fiori app Change Material Type for that.",
      "Weights, volumes, dimensions and periods are quantities with a unit field and an ISO unit field (gross and net weight share the unit of weight); prices have a currency. SAP needs each group complete and consistent in one change: name only what the user wants changed, the change tool adds the rest and converts units such as kg, gram or piece to SAP's codes. If the unit changes, the numbers measured in it are not converted: say so.",
      "The net weight cannot be higher than the gross weight.",
      "Status, group and category codes (for example the cross-plant status) must exist in SAP customizing. When the change tool warns that no product uses a value yet, ask the user to confirm it before they approve.",
      "A new product needs its product number (no internal numbering here), product type, base unit, usually the industry sector, and at least one description of at most 40 characters.",
      "Products and most of their organizational data cannot be deleted physically through this API: propose the deletion flag (IsMarkedForDeletion), explain that it is reversible and that physical removal only happens by archiving in SAP. Descriptions can be deleted, but never the last one.",
      "Authorization problems usually concern product master authorizations by product type, plant or sales organization.",
    ],
    readOnlyFields: [
      {
        entitySet: "Product",
        field: "ProductType",
        reason: "The product type cannot be changed through the Product API. Use the Fiori app Change Material Type instead.",
      },
    ],
  },
]

const GENERIC_AREA: BusinessArea = {
  id: "generic",
  title: "Business data",
  data: "business data",
  starters: ["What business data can I look up in this system?", "Show the 10 most recently changed records", "What can I change in this system?"],
  notes: [],
}

/** The business area an API covers, from its service path; a general area for unknown APIs. */
export function businessAreaFor(servicePath: string | null | undefined): BusinessArea {
  const key = (servicePath ?? "").toLowerCase().replace(/[^a-z0-9/]/g, "")
  return AREAS.find((area) => area.match.test(key)) ?? GENERIC_AREA
}

/** "ProductPlant" → "Product Plant", "_SalesOrderItem" → "Sales Order Item", "A_GLAccount" → "GL Account". */
export function humanizeName(name: string): string {
  return name
    .replace(/^_+/, "")
    .replace(/^A_/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
}

/** Splits an OData path at "/" outside parentheses and quotes. */
function splitPath(path: string): string[] {
  const segments: string[] = []
  let current = ""
  let depth = 0
  let quoted = false
  for (const char of path) {
    if (char === "'") quoted = !quoted
    else if (!quoted && char === "(") depth += 1
    else if (!quoted && char === ")") depth -= 1
    if (char === "/" && depth === 0 && !quoted) {
      if (current) segments.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current) segments.push(current)
  return segments
}

/** "Product('EF-MAT')/_ProductPlant" → "Product EF-MAT › Product Plant". */
export function describeODataPath(path: string): string {
  return splitPath(path)
    .map((segment) => {
      const match = segment.match(/^([^(]+)(?:\((.*)\))?$/)
      if (!match) return segment
      const [, name, keys] = match
      const values = keys
        ? [...keys.matchAll(/(?:\w+=)?('(?:[^']|'')*'|[^,]+)/g)].map(([, value]) =>
            value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value.trim()
          )
        : []
      // Empty key parts (e.g. ValuationType='') add nothing readable.
      return [humanizeName(name), values.filter(Boolean).join(", ")].filter(Boolean).join(" ")
    })
    .join(" › ")
}
