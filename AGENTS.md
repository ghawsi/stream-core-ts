<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## User interface

Build every interface with the design system `@boilerplate/ui`. Do not write new
base components and do not install another component library.

- Before writing interface code, read `node_modules/@boilerplate/ui/AGENTS.md`
  and `node_modules/@boilerplate/ui/llms.txt`.
- For each component you use, read
  `node_modules/@boilerplate/ui/docs/components/<name>.md`.
- Import from `@boilerplate/ui`. Style with semantic token classes only
  (`bg-primary`, `text-muted-foreground`, `rounded-md`); no colour literals.
- Every icon-only button needs an `aria-label`.
- The providers are mounted in `app/layout.tsx`; do not mount them again.

<!-- END:nextjs-agent-rules -->
