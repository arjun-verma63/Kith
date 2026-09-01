import type { IconName } from "@/components/ui/icon";
import type { NavHref } from "@/components/layout/nav-item";

/**
 * The destinations.
 *
 * `href` is present only for routes that actually exist. Everything else renders
 * as pending — visible, clearly unavailable, and not a link. Adding an href here
 * is the last step of building a destination, not the first.
 *
 * Ordered by how often somebody opens it, because on the mobile bar that order
 * is spatial: the leftmost item is the one under the thumb.
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
  { key: "messages", label: "Messages", icon: "messages", href: "/messages", primary: true },
  { key: "calls", label: "Calls", icon: "calls", href: "/calls", primary: true },
  { key: "games", label: "Games", icon: "games", href: "/games", primary: true },
  { key: "friends", label: "Friends", icon: "friends", href: "/friends", primary: true },
  {
    key: "settings",
    label: "Settings",
    icon: "settings",
    href: "/settings/profile",
    primary: true,
  },
  /*
   * Couple is the one destination that is conditional on having one, so it is
   * not on the bar: five items is what fits across a 320px screen with a label
   * under each, and a sixth that appears for two people out of six would make
   * the bar reflow for them alone. It stays in the header, where it already
   * appears only when there is something behind it.
   */
  { key: "couple", label: "Couple", icon: "couple", href: "/couple", primary: false },
] as const;
