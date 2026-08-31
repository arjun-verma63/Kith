import "server-only";

import { z } from "zod";

import { classifyIceUrl } from "@/lib/webrtc/config";

import { legacyKeyRole, parseEnv, serverEnvSchema } from "./schema";

/**
 * Private environment.
 *
 * The `server-only` import above is the guard: if any client component ever
 * imports this module — directly or through a chain — the build fails instead
 * of quietly shipping a secret to the browser. Every module that touches a
 * secret (the Supabase admin client, the TURN credential minter) starts with
 * that same line.
 */
export const serverEnv = parseEnv(serverEnvSchema, process.env, "server");

export const isProduction = serverEnv.NODE_ENV === "production";
export const isDevelopment = serverEnv.NODE_ENV === "development";

/**
 * Service role key. Bypasses Row Level Security completely.
 *
 * Defined in this module rather than alongside the public schema because Zod
 * schemas cannot be tree-shaken — anything in the shared schema file ends up in
 * the browser bundle. Behind `server-only`, it cannot.
 */
const secretKey = z
  .string()
  .min(20, "Looks too short to be a Supabase key.")
  .refine((key) => !key.startsWith("sb_publishable_"), {
    message: "This is the publishable key. The service-role/secret key is required here.",
  })
  .refine((key) => legacyKeyRole(key) !== "anon", {
    message: "This is the anon key. The service-role key is required here.",
  });

export const supabaseSecretEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: secretKey,
});

export type SupabaseSecretEnv = z.infer<typeof supabaseSecretEnvSchema>;

let supabaseSecretEnv: SupabaseSecretEnv | undefined;

/**
 * The service-role key, validated on first use.
 *
 * Reached only by `lib/supabase/admin.ts`. If you find yourself calling this
 * from anywhere else, the thing you are about to write almost certainly belongs
 * behind a Row Level Security policy instead.
 */
export function getSupabaseSecretEnv(): SupabaseSecretEnv {
  supabaseSecretEnv ??= parseEnv(
    supabaseSecretEnvSchema,
    {
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    "Supabase secret",
  );

  return supabaseSecretEnv;
}

/* ========================================================================== */
/*  TURN                                                                      */
/* ========================================================================== */

/**
 * Relay configuration.
 *
 * Here rather than in the shared schema for the same reason as the service-role
 * key: a Zod schema is a top-level call that a bundler must assume is
 * side-effectful, so anything defined in `schema.ts` ships to the browser. No
 * value would leak — values only exist in `process.env` on the server — but the
 * shape of a secret does not belong in a bundle either.
 *
 * Entirely optional. With none of it set, calls run on STUN alone exactly as
 * they did before TURN existed, which is what makes a fresh clone work without
 * anybody signing up for a relay.
 */

/** `turn:` and `turns:` URLs, comma-separated. Order does not matter to ICE. */
const turnUrls = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  )
  .refine((urls) => urls.length > 0, { message: "TURN_URLS is set but contains no URLs." })
  .refine((urls) => urls.every((url) => classifyIceUrl(url) !== null), {
    message:
      "Every TURN_URLS entry must be a turn: or turns: URL, e.g. turn:relay.example.com:3478?transport=udp",
  })
  .refine((urls) => urls.every((url) => classifyIceUrl(url) !== "stun"), {
    message: "TURN_URLS is for relays. Public STUN is built in and does not need configuring.",
  });

const turnEnvSchema = z
  .object({
    TURN_URLS: turnUrls,
    TURN_SHARED_SECRET: z
      .string()
      .min(16, "A TURN shared secret this short is not a secret.")
      .optional(),
    TURN_USERNAME: z.string().min(1).optional(),
    TURN_PASSWORD: z.string().min(1).optional(),
    /**
     * Ten minutes by default. Long enough that no realistic call setup outruns
     * it, short enough that a leaked credential is worthless by the time anybody
     * notices it leaked.
     */
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  })
  .refine((env) => env.TURN_SHARED_SECRET ?? (env.TURN_USERNAME && env.TURN_PASSWORD), {
    message:
      "TURN_URLS is set, so credentials are required: either TURN_SHARED_SECRET (preferred, ephemeral) or both TURN_USERNAME and TURN_PASSWORD (static).",
  });

export type TurnEnv =
  | {
      mode: "hmac";
      urls: string[];
      sharedSecret: string;
      ttlSeconds: number;
    }
  | {
      mode: "static";
      urls: string[];
      username: string;
      password: string;
    };

let turnEnv: TurnEnv | null | undefined;

/**
 * The relay configuration, validated on first use, or null when there is none.
 *
 * Deliberately does NOT throw when TURN is absent — absence is a supported
 * configuration and the default one. It throws only when TURN is half
 * configured, because a relay that is set up but unusable is worse than no relay
 * at all: it looks configured, so nobody investigates why calls fail.
 */
export function getTurnEnv(): TurnEnv | null {
  if (turnEnv !== undefined) return turnEnv;

  if (!process.env.TURN_URLS) {
    turnEnv = null;
    return turnEnv;
  }

  const parsed = parseEnv(
    turnEnvSchema,
    {
      TURN_URLS: process.env.TURN_URLS,
      TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_PASSWORD: process.env.TURN_PASSWORD,
      TURN_CREDENTIAL_TTL_SECONDS: process.env.TURN_CREDENTIAL_TTL_SECONDS,
    },
    "TURN",
  );

  // HMAC wins when both are present. It is strictly better, and somebody who
  // has configured both has almost certainly just not removed the old one.
  turnEnv = parsed.TURN_SHARED_SECRET
    ? {
        mode: "hmac",
        urls: parsed.TURN_URLS,
        sharedSecret: parsed.TURN_SHARED_SECRET,
        ttlSeconds: parsed.TURN_CREDENTIAL_TTL_SECONDS,
      }
    : {
        mode: "static",
        urls: parsed.TURN_URLS,
        username: parsed.TURN_USERNAME as string,
        password: parsed.TURN_PASSWORD as string,
      };

  warnAboutCoverage(turnEnv);
  return turnEnv;
}

/**
 * Says something once, at boot, about a half-finished relay.
 *
 * TURN over UDP only is the usual first configuration and it covers most of
 * what STUN misses. What it does not cover is the corporate firewall that drops
 * UDP entirely — and the symptom is "calls work for everybody except the person
 * in the office", which is a miserable thing to debug months later.
 */
function warnAboutCoverage(env: TurnEnv): void {
  const transports = new Set(env.urls.map((url) => classifyIceUrl(url)));

  if (!transports.has("turn-tls")) {
    console.warn(
      "[turn] No turns: (TLS) URL configured. Calls will still fail behind firewalls that " +
        "allow only TCP 443. Add turns:<host>:5349?transport=tcp — or :443 if the relay offers it.",
    );
  }

  if (!transports.has("turn-udp")) {
    console.warn(
      "[turn] No UDP relay URL configured. Relayed calls will fall back to TCP, which adds " +
        "latency to every packet. Add turn:<host>:3478?transport=udp unless that is deliberate.",
    );
  }

  if (env.mode === "static") {
    console.warn(
      "[turn] Using STATIC credentials. They are delivered only to signed-in users, but they " +
        "do not expire and rotating them means changing an environment variable. Prefer " +
        "TURN_SHARED_SECRET (ephemeral) where the provider supports it.",
    );
  }
}
