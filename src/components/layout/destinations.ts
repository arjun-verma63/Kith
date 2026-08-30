import type { IconName } from "@/components/ui/icon";
import type { NavHref } from "@/components/layout/nav-item";

/**
 * The seven destinations.
 *
 * `href` is present only for routes that actually exist. Everything else renders
 * as pending — visible, clearly unavailable, and not a link. Adding an href here
 * is the last step of building a destination, not the first.
 *
 * Lives here rather than in `lib/` because it carries icon identities, and `lib/`
 * is UI-agnostic by rule.
 */
export interface Destination {
  key: string;
  label: string;
  icon: IconName;
  href?: NavHref;
  /** Shown on the compact mobile bar. Seven does not fit; five does. */
  primary: boolean;
}

export const DESTINATIONS: readonly Destination[] = [
  { key: "home", label: "Home", icon: "home", href: "/", primary: true },
  { key: "friends", label: "Friends", icon: "friends", primary: true },
  { key: "messages", label: "Messages", icon: "messages", primary: true },
  { key: "calls", label: "Calls", icon: "calls", primary: true },
  { key: "games", label: "Games", icon: "games", primary: true },
  { key: "couple", label: "Couple", icon: "couple", primary: false },
  { key: "settings", label: "Settings", icon: "settings", primary: false },
] as const;
