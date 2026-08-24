# lib/server

Modules that must never reach the browser. Every file in here starts with:

```ts
import "server-only";
```

That import is a build-time guard: if a client component ever pulls one of these in,
directly or through a chain of imports, the build fails instead of quietly shipping a
secret to the browser.

What lands here: the Supabase service-role client (Phase 2), the TURN credential
minter (Phase 7), the authoritative game-move resolver (Phase 9), and the rate limiter.

`src/lib/env/server.ts` follows the same rule and is the working example.
