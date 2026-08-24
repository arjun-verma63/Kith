# types

Cross-cutting types that are not owned by a single feature slice.

`database.ts` lands here in Phase 2. It is **generated**, never hand-edited:

```bash
npx supabase gen types typescript --project-id <ref> > src/types/database.ts
```

Anything derivable from a Zod schema should be inferred from that schema
(`z.infer<typeof schema>`) rather than declared twice.
