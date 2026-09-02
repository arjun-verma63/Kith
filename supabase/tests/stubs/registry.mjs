/**
 * The scripted world a server action runs in.
 *
 * A Next.js server action is ordinary code wearing a `"use server"` hat, but it
 * imports three things that only exist inside a request: `next/navigation`, the
 * cookie-bound Supabase client, and the service-role client. That is the entire
 * reason `src/features/auth/actions.ts` had no tests — not that it was hard to
 * test, but that importing it threw.
 *
 * So the three imports are replaced (see `action-loader.mjs`) with modules that
 * read from this registry, and the test scripts the registry before calling the
 * action. Everything else — the schemas, the invite hashing, the ordering, the
 * error branches, the wording of every message — is the real shipped file.
 *
 * The alternative is asserting on the source text with a grep, which proves a
 * string is present and nothing about whether it runs.
 */

/** Every call the action made, in order, so a test can assert on sequence. */
export const calls = [];

/** What the doubles should return. Replaced wholesale by `script()`. */
export let plan = {};

export function script(next) {
  calls.length = 0;
  plan = next;
}

function record(entry) {
  calls.push(entry);
  return entry;
}

/** Calls of one name, in order. */
export function callsTo(name) {
  return calls.filter((entry) => entry.name === name);
}

export function called(name) {
  return calls.some((entry) => entry.name === name);
}

/**
 * `redirect()` works by throwing, and code after it is unreachable — which is
 * load-bearing in `signUpAction`, where the redirect is the only success path.
 * A double that returned instead would let execution fall off the end and
 * report `undefined` as the result, hiding exactly the bug worth catching.
 */
export class RedirectError extends Error {
  constructor(to) {
    super(`NEXT_REDIRECT:${to}`);
    this.name = "RedirectError";
    this.to = to;
  }
}

export function redirect(to) {
  record({ name: "redirect", to });
  throw new RedirectError(to);
}

/**
 * Runs an action and reports what it did, so a test never has to decide whether
 * a throw was a redirect or a real failure.
 */
export async function run(action, formData) {
  try {
    const result = await action(undefined, formData);
    return { kind: "returned", result };
  } catch (error) {
    if (error instanceof RedirectError) return { kind: "redirected", to: error.to };
    return { kind: "threw", error };
  }
}

export function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/*  The doubles                                                               */
/* -------------------------------------------------------------------------- */

const nothing = { data: null, error: null };

/**
 * The cookie-bound client.
 *
 * Only the `auth` surface the auth actions touch. Anything not scripted returns
 * a null-and-null, which is what the real client does for a call that found
 * nothing — so an unscripted call takes the "no session" branch rather than
 * crashing with a shape error and looking like a different bug.
 */
export function createSupabaseServerClient() {
  return Promise.resolve({
    auth: {
      signUp: async (args) => record({ name: "signUp", args }) && (plan.signUp ?? nothing),
      signInWithPassword: async (args) =>
        record({ name: "signInWithPassword", args }) && (plan.signInWithPassword ?? nothing),
      signOut: async (args) =>
        record({ name: "signOut", args }) && (plan.signOut ?? { error: null }),
      getUser: async () =>
        record({ name: "getUser" }) && (plan.getUser ?? { data: { user: null } }),
      updateUser: async (args) =>
        record({ name: "updateUser", args }) && (plan.updateUser ?? { data: null, error: null }),
      resetPasswordForEmail: async (email, options) =>
        record({ name: "resetPasswordForEmail", args: { email, options } }) &&
        (plan.resetPasswordForEmail ?? { error: null }),
      resend: async (args) => record({ name: "resend", args }) && (plan.resend ?? { error: null }),
    },
  });
}

/** The service-role client. `rpc` is scripted per function name. */
export function getSupabaseAdminClient() {
  return {
    rpc: async (fn, args) => {
      record({ name: `rpc:${fn}`, args });
      const scripted = plan.rpc?.[fn];
      if (typeof scripted === "function") return scripted(args);
      return scripted ?? nothing;
    },
    from: (table) => ({
      insert: async (row) => record({ name: `insert:${table}`, args: row }) && { error: null },
    }),
  };
}
