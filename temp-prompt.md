# Role & Objective
You are an expert Full-Stack Engineer specializing in Next.js (App Router), TypeScript, Prisma, SQLite, and Tailwind CSS. Your task is to build a secure, user-friendly "AI Model Settings" page (`/settings/ai`) that allows users to configure, test, and manage remote LLM providers (OpenAI, Anthropic Claude, Azure OpenAI, and OpenAI-compatible endpoints) for an SAP S/4HANA AI Chat application.

# Tech Stack & Design System Constraints
- **Framework:** Next.js (App Router, Server Actions or Route Handlers)
- **Database & ORM:** SQLite with Prisma
- **Validation:** Zod
- **Styling & UI Components (CRITICAL):**
  - Before writing any UI code, **inspect the `/Design System` folder** in the repository to understand the existing Tailwind CSS configuration, color tokens, typography, spacing rules, and reusable UI primitives (buttons, inputs, selects, cards, badges, toggles, modals, alerts/toasts, and accordions).
  - **Strictly adhere to the `/Design System` conventions.** Reuse existing components and semantic utility classes from `/Design System` instead of inventing ad-hoc Tailwind styles or raw HTML form controls.
  - Only introduce custom Tailwind utility classes for layout alignment (e.g., `grid`, `flex`, `gap`) when composing components from `/Design System`.

# 1. Database Schema (Prisma)
Update `prisma/schema.prisma` to include an `AiProviderConfig` model. Ensure API keys are never exposed in plaintext to the client after saving.
- `id`: String (cuid/uuid, primary key)
- `name`: String (User-friendly label, e.g., "Production Claude 3.7" or "Azure GPT-4o")
- `provider`: String (`"OPENAI"` | `"ANTHROPIC"` | `"AZURE_OPENAI"` | `"CUSTOM_OPENAI_COMPATIBLE"`)
- `baseUrl`: String? (Optional for standard OpenAI/Anthropic; required for Azure and Custom endpoints, e.g., `https://openai.com`)
- `apiKeyEncrypted`: String (Store encrypted using Node's `crypto` module with a server-side `ENCRYPTION_KEY` env variable)
- `modelName`: String (e.g., `gpt-4o`, `claude-3-7-sonnet-latest`, or Azure deployment name)
- `apiVersion`: String? (Required specifically when provider is `"AZURE_OPENAI"`, e.g., `2024-10-21`)
- `temperature`: Float (Default `0.1` — keep low for deterministic SAP data analysis)
- `maxTokens`: Int (Default `4096`)
- `topP`: Float? (Default `1.0`)
- `timeoutSeconds`: Int (Default `60` — SAP OData payloads + reasoning can take time)
- `isActive`: Boolean (Default `false` — only one configuration should be active at a time)
- `createdAt` & `updatedAt`: DateTime

# 2. UI Fields & Dynamic Form Behavior
Build the Settings Page UI using the components and patterns found in `/Design System`. Organize the form into logical sections and dynamically show/hide fields based on the selected **Provider**:

## Section A: Provider & Connection
1. **Configuration Name** (Text input): e.g., "SAP Finance Assistant LLM".
2. **AI Provider** (Select / Radio card group from `/Design System`):
   - OpenAI (`OPENAI`)
   - Anthropic Claude (`ANTHROPIC`)
   - Azure OpenAI (`AZURE_OPENAI`)
   - Custom / OpenAI-Compatible (`CUSTOM_OPENAI_COMPATIBLE` — e.g., Ollama, vLLM, SAP AI Core proxy)
3. **API Endpoint / Base URL** (URL input):
   - Auto-fill sensible defaults when switching providers (`https://openai.com` for OpenAI, `https://anthropic.com` for Anthropic).
   - Make editable and required for `AZURE_OPENAI` and `CUSTOM_OPENAI_COMPATIBLE`.
4. **API Version** (Text input):
   - **Conditional:** Show *only* when `AZURE_OPENAI` is selected (e.g., `2024-10-21`).
5. **API Key** (Password input with show/hide toggle):
   - On edit, display a masked placeholder (e.g., `sk-••••••••••••1234`) and only overwrite in the database if the user enters a new value.

## Section B: Model Selection
6. **Model / Deployment Name** (Combobox or Select + Custom Input):
   - Provide quick-select presets based on the chosen provider (e.g., `gpt-4o`, `o3-mini`, `claude-3-7-sonnet-latest`, `claude-3-5-haiku-latest`), while still allowing the user to type any custom model string or Azure Deployment ID.

## Section C: Inference Parameters (Collapsible "Advanced Settings" Accordion)
7. **Temperature** (Slider + Number input, `0.0` to `1.0`, step `0.1`, default `0.1`):
   - Helper text: *"Lower values (0.0–0.2) are recommended for strict SAP S/4HANA rule adherence and OData JSON analysis."*
8. **Max Output Tokens** (Number input, default `4096`):
   - Helper text: *"Maximum length of the AI response."*
9. **Request Timeout (Seconds)** (Number input, default `60`):
   - Helper text: *"Increase if analyzing large SAP OData V4 payloads."*
10. **Set as Active Model** (Toggle switch):
    - Marks this configuration as the active model used by the chat integration layer.

# 3. Interactive Features & API Routes / Server Actions
Implement the following backend logic cleanly:
1. **Encryption Utility (`lib/crypto.ts`):** Use AES-256-GCM to encrypt the API key before saving to SQLite and decrypt it only on the server when testing or making LLM calls. Return a clear error message if `process.env.ENCRYPTION_KEY` is missing.
2. **"Test Connection" Button:**
   - Allow the user to click **"Test Connection"** before or after saving.
   - Create a server action or endpoint (`POST /api/settings/ai/test`) that sends a minimal, low-token ping (`"Reply with OK"`, `max_tokens: 5`) to the configured provider using the exact URL, headers (`Authorization: Bearer` for OpenAI/Custom, `x-api-key` + `anthropic-version` for Anthropic, `api-key` + `api-version` query param for Azure), and model name.
   - Display a clear status notification using the `/Design System` alert/toast component showing response latency (e.g., *"Connected successfully in 420ms"*) or the exact API error (e.g., *"401 Unauthorized: Invalid API Key"* or *"404: Model/Deployment not found"*).
3. **Saved Configurations List:**
   - Display saved configurations using the `/Design System` card or table components, showing Name, Provider badge, Model, Masked Key, Active status badge, and actions (Activate, Edit, Delete).

# 4. Execution Steps
1. **Inspect `/Design System`:** Read the files inside `/Design System` first and briefly list which components and styling tokens you will reuse.
2. **Database & Validation:** Update `prisma/schema.prisma` (provide the `npx prisma migrate dev` command), create `lib/crypto.ts`, and create `lib/validations/ai-config.ts` with Zod schemas.
3. **Backend Handlers:** Implement the Next.js Server Actions / API routes for CRUD operations and the live "Test Connection" endpoint.
4. **UI Implementation:** Build `/app/settings/ai/page.tsx` and modular client components strictly using the `/Design System` primitives.
