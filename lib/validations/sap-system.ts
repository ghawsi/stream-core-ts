import { z } from "zod"

export const DEFAULT_SERVICE_PATH = "/sap/opu/odata4/"

/** Development, quality assurance, production. PRD change plans carry a warning. */
export const SAP_ENVIRONMENTS = ["DEV", "QAS", "PRD"] as const

/** https://host[:port][/prefix] without credentials, query or fragment; no trailing slash. */
const baseUrl = z
  .string()
  .trim()
  .min(1, "Enter the base URL of the SAP system.")
  .max(300, "The URL is too long.")
  .superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter a full URL, for example https://s4dev.company.local:44300." })
      return
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: "Use an https:// (or http://) URL." })
    } else if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "Do not put a user name or password in the URL." })
    } else if (url.search || url.hash) {
      ctx.addIssue({ code: "custom", message: "Leave out ?query and #fragment; the SAP client has its own field." })
    }
  })
  .transform((value) => value.replace(/\/+$/, ""))

const servicePath = z
  .string()
  .trim()
  .min(1, "Enter the OData V4 service path.")
  .max(300, "The path is too long.")
  .regex(/^\/[A-Za-z0-9_\-./~]*$/, "Start with / and use letters, digits and - _ . / ~ only.")
  .refine((value) => !value.split("/").includes(".."), "The path cannot contain ..")
  .transform((value) => value.replace(/\/+$/, "") || "/")

export const sapSystemSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100, "Use at most 100 characters."),
  description: z
    .string()
    .trim()
    .max(500, "Use at most 500 characters.")
    .default("")
    .transform((value) => value || null),
  baseUrl,
  sapClient: z.string().trim().regex(/^\d{3}$/, "The SAP client has three digits, for example 100."),
  servicePath,
  environment: z.enum(SAP_ENVIRONMENTS, { error: "Choose DEV, QAS or PRD." }).default("DEV"),
  isActive: z.boolean().default(true),
})

export type SapSystemInput = z.input<typeof sapSystemSchema>
export type SapSystemValues = z.output<typeof sapSystemSchema>
