# Features

Business logic lives here, in vertical slices — one directory per domain, not one
directory per file type. A slice owns its data access, its validation, its state and
its components, so a feature can be read (or deleted) in one place.

## The slice contract

A feature slice uses as many of these as it needs, and no more:

| File          | Contains                                                                | Runs on |
| ------------- | ----------------------------------------------------------------------- | ------- |
| `schema.ts`   | Zod schemas for every input this feature accepts                        | both    |
| `queries.ts`  | Read paths. RLS-scoped Supabase reads, called from Server Components    | server  |
| `actions.ts`  | Write paths. `"use server"`, validate → authorize → mutate → revalidate | server  |
| `realtime.ts` | Channel subscriptions and payload parsing for this domain               | client  |
| `store.ts`    | Ephemeral client state (Zustand) that does not belong on the server     | client  |
| `hooks/`      | React hooks wrapping queries/actions for components                     | client  |
| `components/` | UI specific to this feature                                             | both    |
| `types.ts`    | Types not derivable from the schema or the generated database types     | both    |

## Rules

1. **Dependencies point inward.** `app/` → `features/` → `lib/` + `components/ui/`.
   A feature may not import another feature; if two need the same thing, it belongs
   in `lib/` or `components/`. ESLint enforces the outer edges of this.
2. **Components in a slice do not call Supabase.** They call something from
   `queries.ts`, `actions.ts` or `hooks/`.
3. **Never trust a client-supplied user id.** Identity comes from the session on the
   server, and the database enforces it again through RLS.
4. **Actions return `Result`** (`@/lib/result`) rather than throwing, so the UI can
   render "username taken" instead of a generic crash screen.

Planned slices, in build order: `auth`, `profile`, `friends`, `presence`, `messaging`,
`calls`, `games`, `couple`, `moderation`.
