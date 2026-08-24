/** Brand and site constants. Copy that appears in more than one place lives here. */
export const APP = {
  name: "KITH",
  tagline: "Your people. Your space.",
  description:
    "A private space for a small group of friends — messages, calls and games, and nobody else.",
} as const;

/** localStorage key for the Dusk/Daylight preference. */
export const THEME_STORAGE_KEY = "kith-theme";

export const THEMES = ["dusk", "daylight"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "dusk";
