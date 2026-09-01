import type { MetadataRoute } from "next";

import { APP } from "@/lib/constants";

/**
 * The web app manifest, served at `/manifest.webmanifest`.
 *
 * ── What is deliberately not in here ─────────────────────────────────────────
 *
 * NOTHING ABOUT PUSH NOTIFICATIONS. No `gcm_sender_id`, no permission prompt on
 * launch, and no service-worker `push` handler to go with one. KITH's
 * notifications are rows in a table read by the bell in the header; they do not
 * reach a locked phone and this file does not imply that they do. Implementing
 * Web Push properly means VAPID keys, a subscription table, and something
 * server-side to send from — a feature, not a manifest key. See docs/PWA.md.
 *
 * NO `screenshots`. Chrome uses them for a richer install dialogue, and there
 * are none to supply that would not be invented.
 *
 * NO `orientation` lock. The thread and the game boards were made to work in
 * landscape during the mobile pass; pinning to portrait would undo that for the
 * one person who reads in bed sideways.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    /*
     * `id` is what a browser uses to decide whether an install is THIS app or a
     * different one. Without it the identity is `start_url`, so changing where
     * the app opens would orphan every existing installation. Pinned to "/" and
     * never to be changed.
     */
    id: "/",

    name: `${APP.name} — ${APP.tagline}`,
    short_name: APP.name,
    description: APP.description,

    /*
     * Not "/". The root is the marketing page, which is the wrong thing to open
     * for somebody who has installed the app — they are signed in and want the
     * room. Signed out, middleware sends this to /login carrying the
     * destination, so the first launch after installing still lands here.
     */
    start_url: "/messages",
    scope: "/",

    display: "standalone",

    /*
     * The splash screen and the surround. Dusk, because that is what the app
     * renders by default and a white flash before a dark app is the most
     * obvious tell that something was bolted on.
     *
     * `theme_color` here is a static fallback; the real one is a meta tag the
     * appearance bootstrap keeps in step with the theme the person actually
     * chose, which a manifest cannot express.
     */
    background_color: "#0e0b0a",
    theme_color: "#0e0b0a",

    categories: ["social"],
    lang: "en-GB",
    dir: "ltr",

    icons: [
      // `any` is drawn as supplied — tabs, task switchers, desktop shortcuts.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // `maskable` is full-bleed, because Android crops to whatever shape the
      // launcher uses and only the central 80% is guaranteed to survive.
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],

    /*
     * Long-press the installed icon. Two, not five: a shortcut menu that mirrors
     * the navigation is a second navigation to maintain, and these are the two
     * things somebody opens the app *to do* rather than to browse.
     */
    shortcuts: [
      {
        name: "Messages",
        short_name: "Messages",
        description: "Open your conversations",
        url: "/messages",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Games",
        short_name: "Games",
        description: "Start something with the people in the room",
        url: "/games",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],

    prefer_related_applications: false,
  };
}
