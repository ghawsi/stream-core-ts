# Role & Objective
You are a Senior Full-Stack & SAP Integration Architect. Your task is to design and implement an enterprise-grade **AI Function Calling (Tool Use) & SAP S/4HANA OData V4 Integration** within an existing Next.js AI chat application. 

The existing AI chat flow (user prompt -> remote AI model -> streamed/returned text response) works properly and must remain intact for standard conversational queries. You are extending it so that when a user asks for SAP business data or actions, the AI model can invoke OData V4 tools, execute authenticated HTTP requests against an on-premise SAP S/4HANA ICF node, and synthesize the returned JSON payload into a natural language response.

---

# Existing Technical Stack
- **Frontend & Backend Framework:** Next.js (App Router, TypeScript)
- **Database & ORM:** SQLite with Prisma ORM
- **Authentication:** Better-auth
- **Target External System:** SAP S/4HANA On-Premise exposing OData V4 services via Internet Communication Framework (ICF) nodes (`/sap/opu/odata4/...`)

---

# Architectural & Functional Requirements

## 1. Security, Network & SAP Authentication (`src/lib/sap/client.ts`)
- **Environment Configuration:** Define strict server-side environment variables in `.env` (validated via Zod or startup check):
  - `SAP_ODATA_BASE_URL` (e.g., `https://<sap-host>:<port>/sap/opu/odata4/sap/<service>/srvd/sap/<definition>/0001`)
  - `SAP_CLIENT` (e.g., `100` — passed via `sap-client` header or query parameter)
  - `SAP_AUTH_TYPE` (`BASIC` | `OAUTH2` | `PRINCIPAL_PROPAGATION`)
  - `SAP_USERNAME` & `SAP_PASSWORD` (if using technical user Basic Auth)
  - `SAP_ALLOW_SELF_SIGNED_CERT` (boolean toggle for on-premise internal CA certificates)
- **Session Verification:** Every API route invoking SAP tools must first validate the active user session using **Better-auth** (`auth.api.getSession`). Unauthenticated requests must be rejected with `401 Unauthorized`.
- **CSRF Token & Session Cookie Handling (Mandatory for Write Operations):**
  - If `POST`, `PATCH`, `PUT`, or `DELETE` operations are enabled, implement a pre-flight `GET` or `HEAD` request to the service root with header `x-csrf-token: fetch`.
  - Capture the returned `x-csrf-token` header and all `Set-Cookie` session headers (`sap-usercontext`, `SAP_SESSIONID_*`, `MYSAPSSO2`), and attach them to the subsequent mutating OData V4 request.
- **SAP-Specific Headers:** Ensure every OData V4 request includes:
  - `Accept: application/json`
  - `Content-Type: application/json` (for mutations)
  - `sap-client: <SAP_CLIENT>`

## 2. OData V4 Schema & Metadata Awareness (`src/lib/sap/metadata.ts`)
- **Service Metadata Caching:** Implement a mechanism to fetch and cache the OData V4 `$metadata` document (or a curated JSON schema subset of exposed EntitySets, Properties, Types, and NavigationProperties) so the AI knows exact SAP technical field names (e.g., `SalesOrder`, `SoldToParty`, `TotalNetAmount`, `TransactionCurrency`).
- **OData V4 Query Builder & Guardrails:**
  - Support standard OData V4 system query options: `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$expand`, and `$count`.
  - **Payload Protection:** Enforce a hard server-side cap on `$top` (e.g., default `20`, max `50`) and require `$select` where possible to prevent SAP memory dumps (`TSV_TNEW_PAGE_ALLOC_FAILED`) and LLM context-window overflows.
  - **OData V4 Syntax Enforcement:** Ensure the AI/query builder uses strict OData V4 syntax (e.g., `contains(Field,'val')` instead of OData V2 `substringof`, single quotes around string literals, ISO 8601 dates without `datetime'...'` prefixes).

## 3. AI Tool Definitions & Execution Loop (`src/lib/ai/tools/sap-odata.ts`)
- **Tool Schema Design:** Define modular, well-documented tools compatible with the existing AI SDK/provider:
  1. `sap_list_entities`: Lists available OData V4 EntitySets and their key properties/descriptions.
  2. `sap_query_odata`: Executes a read-only `GET` query against a specified EntitySet using structured arguments (`entitySet`, `select`, `filter`, `orderby`, `top`, `expand`).
  3. `sap_get_entity_by_key`: Fetches a single record by its primary key(s) (e.g., `SalesOrder='50000123'`).
  4. *(Optional/Gated)* `sap_mutate_odata`: Handles `POST`/`PATCH` requests, strictly gated behind a human-in-the-loop UI confirmation step before execution.
- **Multi-Step Agentic Loop:**
  - Update the chat completion handler to handle `tool_calls` in a loop (max 5 iterations to prevent infinite loops).
  - If an SAP OData call returns a `400 Bad Request` (e.g., invalid `$filter` syntax or wrong property name), parse the SAP OData error JSON (`error.message` / `error.details`) and feed that exact error back to the AI as the tool output so the AI can self-correct the query and retry.

## 4. Database Persistence & Audit Logging (`prisma/schema.prisma`)
- Extend the SQLite Prisma schema to persist tool executions and audit logs linked to the Better-auth `User` and chat session:
  - Create a `SapAuditLog` model tracking: `id`, `userId`, `chatId`, `toolName`, `httpMethod`, `requestUrl`, `requestPayload` (JSON string), `responseStatus` (Int), `errorMessage` (nullable), `durationMs` (Int), and `createdAt`.
  - Ensure all SAP queries executed via the chat app are logged for compliance and debugging.

## 5. Frontend UX & Transparency (Next.js Components)
- **Tool Execution Indicators:** Update the chat UI to display subtle, collapsible status badges during tool execution (e.g., *"Querying SAP S/4HANA: SalesOrders..."*) and allow users to inspect the executed OData query parameters for transparency.
- **Human-in-the-Loop Confirmation (If Write Operations Enabled):** Render an interactive confirmation card in the chat stream displaying the exact target EntitySet and payload before allowing any `POST`, `PATCH`, or `DELETE` request to fire against S/4HANA.

---

# Implementation Deliverables Expected From You
1. **Prisma Schema Update:** Provide the exact additions to `prisma/schema.prisma` for `SapAuditLog` and run/generate instructions.
2. **SAP OData V4 Client (`src/lib/sap/client.ts`):** Complete TypeScript implementation handling Basic/OAuth headers, `sap-client`, self-signed TLS options, CSRF token/cookie lifecycle, timeout handling, and SAP error parsing.
3. **AI Tool Definitions & Execution Engine (`src/lib/ai/tools/sap-odata.ts`):** Type-safe tool schemas with clear descriptions instructing the LLM on SAP OData V4 syntax rules, integrated into the existing chat API route.
4. **System Prompt Augmentation:** Provide the exact system prompt instructions to append to the AI model so it reliably translates user intent into accurate OData V4 filters, formats currency/dates cleanly, and never hallucinates SAP records when a query returns `[]`.
5. **Audit & Error Handling:** Full integration with Prisma logging and graceful fallback messages when the on-premise SAP system is unreachable or returns authorization errors (`403 Forbidden`).

---

# Constraints & Coding Standards
- Write strict, production-ready TypeScript with zero `any` types.
- Never expose SAP credentials, internal hostnames, or raw stack traces to the client browser; all SAP HTTP calls must execute strictly inside Next.js server routes/actions.
- Preserve all existing Better-auth session checks and existing chat functionality.
