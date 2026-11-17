# Role & Objective
You are an expert Full-Stack Engineer specializing in Next.js (App Router), TypeScript, Prisma, SQLite, and Tailwind CSS. Your task is to build a clean, responsive **AI Chat Page** (`/chat` and `/chat/[id]`) modeled after the **Claude chat interface**, featuring a collapsible left-hand chat history sidebar and a centered, multi-line prompt input box for an SAP S/4HANA AI Chat application.

# Tech Stack & Design System Constraints
- **Framework:** Next.js (App Router, Server Actions, and Streaming Route Handlers)
- **Database & ORM:** SQLite with Prisma
- **Validation:** Zod
- **Styling & UI Components (CRITICAL):**
  - Before writing any UI code, **inspect the `/Design System` folder** in the repository to understand the existing Tailwind CSS configuration, color tokens, typography, spacing rules, and reusable UI primitives (buttons, inputs/textareas, avatars, badges, cards, tooltips, dropdowns, modals, and alerts/toasts).
  - **Strictly adhere to the `/Design System` conventions.** Reuse existing components and semantic utility classes from `/Design System` instead of inventing ad-hoc Tailwind styles or raw HTML form controls.
  - Only introduce custom Tailwind utility classes for layout alignment (e.g., `grid`, `flex`, `h-screen`, `overflow-y-auto`, `gap`) when composing components from `/Design System`.

# 1. Database Schema (Prisma)
Update `prisma/schema.prisma` to store chat sessions and messages alongside the existing `AiProviderConfig` model:
- **`ChatSession` model:**
  - `id`: String (cuid/uuid, primary key)
  - `title`: String (Auto-generated from the first user message, e.g., first 50 characters, or updated via LLM; default `"New Chat"`)
  - `createdAt`: DateTime (Default `now()`)
  - `updatedAt`: DateTime (`@updatedAt` — used to sort recent chats in the sidebar)
  - `messages`: Relation to `ChatMessage[]` (Cascade delete)
- **`ChatMessage` model:**
  - `id`: String (cuid/uuid, primary key)
  - `sessionId`: String (Foreign key to `ChatSession`)
  - `role`: String (`"user"` | `"assistant"` | `"system"`)
  - `content`: String (Full message text / Markdown)
  - `modelUsed`: String? (Optional: tracks which active model answered)
  - `createdAt`: DateTime (Default `now()`)

# 2. UI Layout & Claude-Style Interface Requirements
Build the Chat Page UI strictly using the components and tokens found in `/Design System`:

## A. Left Sidebar (Chat History)
1. **Header & Controls:**
   - **"+ New Chat" Button** at the top to reset the conversation view and start a fresh session.
   - **Sidebar Toggle Button** to collapse/expand the sidebar smoothly on desktop and open as a drawer on mobile.
2. **Chronological History List:**
   - Group past `ChatSession` items by date (e.g., *Today*, *Yesterday*, *Previous 7 Days*, *Older*).
   - Highlight the currently active chat session.
   - Include a subtle hover menu (using `/Design System` dropdown/icon buttons) to **Rename** or **Delete** a chat session.
3. **Footer:**
   - Display a compact indicator showing the currently active AI model (from `AiProviderConfig` where `isActive = true`) with a quick link to `/settings/ai`.

## B. Main Chat Canvas
1. **Empty / Welcome State (New Chat):**
   - Center the welcome greeting and the chat input box vertically in the viewport (Claude style).
   - Optionally display 3–4 clickable SAP S/4HANA starter prompt chips (e.g., *"Explain OData V4 $expand syntax"*, *"Draft an ABAP CDS view query"*).
2. **Active Conversation Thread:**
   - Smoothly transition the input box to the bottom of the screen once the first message is sent.
   - Render messages in a centered, readable max-width column (`max-w-3xl mx-auto`).
   - **User Messages:** Clean, right-aligned or distinct surface container matching `/Design System` card/bubble tokens.
   - **Assistant Messages:** Left-aligned with clean Markdown rendering (headings, bullet lists, inline code, and syntax-highlighted code blocks with a "Copy" button) and a subtle streaming cursor indicator while generating.
   - Auto-scroll to the newest message during streaming while allowing the user to scroll up freely.

## C. Claude-Style Chat Input Box
1. **Elevated Rounded Container:**
   - Styled with `/Design System` surface, border, and shadow tokens (`rounded-2xl` or matching design token) anchored at the bottom (or centered on empty state).
2. **Auto-Expanding Textarea:**
   - Grows vertically as the user types up to ~6–8 lines, then scrolls internally.
   - **Keyboard Shortcuts:** `Enter` sends the message; `Shift + Enter` inserts a new line.
3. **Input Footer Toolbar (Inside the Input Box):**
   - Left side: Subtle active model badge (e.g., `Claude 3.7 Sonnet` or `GPT-4o`) or warning badge if no active model is configured in `/settings/ai`.
   - Right side: **Send Button** (disabled when empty) that transforms into a **Stop Generating** button while the assistant is streaming a response.

# 3. Backend API & Streaming Integration
1. **Streaming Chat Endpoint (`POST /api/chat`):**
   - Validate the incoming payload (`sessionId`, `message`) with Zod.
   - Fetch the active `AiProviderConfig` (`where: { isActive: true }`) and decrypt `apiKeyEncrypted` on the server using `lib/crypto.ts`. If no active provider exists, return a clear `400` error prompting the user to configure `/settings/ai`.
   - Create a new `ChatSession` if `sessionId` is not provided, persist the user's `ChatMessage`, and stream the response back to the client (via Server-Sent Events / `ReadableStream`) across the configured provider (OpenAI, Anthropic, Azure OpenAI, or OpenAI-compatible).
   - Persist the complete assistant `ChatMessage` to SQLite once streaming finishes and update `ChatSession.updatedAt`.
2. **History Management Actions (`app/actions/chat.ts`):**
   - `getChatSessions()`: Fetch all sessions ordered by `updatedAt DESC`.
   - `getChatMessages(sessionId)`: Fetch message history for a specific session.
   - `renameChatSession(sessionId, title)` & `deleteChatSession(sessionId)`: Server Actions with `revalidatePath` to keep the left sidebar immediately in sync.

# 4. Execution Steps
1. **Inspect `/Design System`:** Read the files inside `/Design System` first and briefly list which components, surface colors, and typography tokens you will reuse.
2. **Database & Validation:** Update `prisma/schema.prisma` with `ChatSession` and `ChatMessage` (provide the `npx prisma migrate dev` command) and create `lib/validations/chat.ts`.
3. **Backend & Streaming:** Implement the Server Actions for chat history management and the `POST /api/chat` streaming route handler.
4. **UI Implementation:** Build `/app/chat/page.tsx`, `/app/chat/[id]/page.tsx`, and modular client components (`ChatSidebar`, `ChatThread`, `ClaudePromptInput`) strictly using `/Design System` primitives.
