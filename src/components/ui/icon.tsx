import type { ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * The KITH icon set.
 *
 * Drawn rather than installed. A general-purpose icon library would bring one
 * thousand glyphs in somebody else's hand — the wrong stroke weight, the wrong
 * corner radius, the wrong personality — and an icon set is one of the loudest
 * signals of whether an interface was designed or assembled.
 *
 * The rules, kept consistent so the set reads as one hand:
 *   - 24x24 box, 2px optical padding
 *   - 1.5px stroke, round caps and joins, `currentColor`
 *   - geometric construction, softened corners, no filled shapes except pips
 *
 * Choices worth noting: Home is a room with a door, not a generic house.
 * Games is a die rather than a gamepad — playful, and not Discord's controller.
 * Couple is two intersecting rings, which reads as union without a heart in
 * sight. Settings is sliders rather than a gear, because you are adjusting
 * levels, not repairing machinery.
 */

const PATHS = {
  // --- Navigation ---
  home: "M3.5 20.5V9.8L12 4l8.5 5.8v10.7M3 20.5h18M9.5 20.5v-5.2a2.5 2.5 0 0 1 5 0v5.2",
  friends:
    "M9 11.2a3.35 3.35 0 1 0 0-6.7 3.35 3.35 0 0 0 0 6.7ZM3 19.8a6 6 0 0 1 12 0M15.5 5.2a3.35 3.35 0 0 1 0 6.6M17 14.4a6 6 0 0 1 4 5.4",
  messages:
    "M5.5 4h13A2.5 2.5 0 0 1 21 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.4V16h-1A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4Z",
  calls:
    "M6.6 3.6 9.1 6.1 7.4 8.4a13.2 13.2 0 0 0 6.2 6.2l2.3-1.7 2.5 2.5a1.8 1.8 0 0 1-.2 2.6c-1.4 1.2-3.5 1.2-5.6.2A19.2 19.2 0 0 1 3.5 9.1c-1-2.1-1-4.2.2-5.6a1.8 1.8 0 0 1 2.6-.2Z",
  games:
    "M6.2 3.5h11.6A2.7 2.7 0 0 1 20.5 6.2v11.6a2.7 2.7 0 0 1-2.7 2.7H6.2a2.7 2.7 0 0 1-2.7-2.7V6.2A2.7 2.7 0 0 1 6.2 3.5Z",
  couple: "M9.6 17.4a5.4 5.4 0 1 1 0-10.8 5.4 5.4 0 0 1 0 10.8ZM14.4 6.6a5.4 5.4 0 1 1 0 10.8",
  settings:
    "M3.5 7h8M16.5 7h4M3.5 12h4M12.5 12h8M3.5 17h8M16.5 17h4M14 4.9A2.1 2.1 0 1 1 14 9.1a2.1 2.1 0 0 1 0-4.2ZM10 9.9a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2ZM14 14.9a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2Z",

  // --- Interface ---
  close: "M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8",
  check: "m5 12.6 4.6 4.6L19 7.8",
  chevronDown: "m6.5 9.5 5.5 5.5 5.5-5.5",
  chevronRight: "m9.5 6.5 5.5 5.5-5.5 5.5",
  arrowRight: "M4 12h15.5m0 0-5.5-5.5M19.5 12 14 17.5",
  search: "M11 17.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13ZM16 16l4.5 4.5",
  plus: "M12 5v14M5 12h14",
  more: "",
  bell: "M18 9.5a6 6 0 1 0-12 0c0 4.6-2 6-2 6h16s-2-1.4-2-6ZM10.2 19.5a2.1 2.1 0 0 0 3.6 0",

  // --- Call controls ---
  mic: "M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5.4a2.6 2.6 0 0 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5ZM5.8 11.3a6.2 6.2 0 0 0 12.4 0M12 17.5v3",
  micOff: "M5.8 11.3a6.2 6.2 0 0 0 9.4 5.3M9.4 6.1a2.6 2.6 0 0 1 5.2 0v5.2M4 4l16 16M12 17.5v3",
  video:
    "M3.5 7.7a2.2 2.2 0 0 1 2.2-2.2h7a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2h-7a2.2 2.2 0 0 1-2.2-2.2ZM14.9 10.6l5.6-3.1v9l-5.6-3.1",
  screen:
    "M3.5 6.2A1.7 1.7 0 0 1 5.2 4.5h13.6a1.7 1.7 0 0 1 1.7 1.7v9.1a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7ZM8.5 20.5h7M12 17v3.5",

  // --- Status and moderation ---
  alert: "M12 4.5 21 19.5H3ZM12 10v4M12 16.8v.2",
  info: "M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17ZM12 11v5.5M12 7.6v.2",
  shield: "M12 3.8 19.5 6v6c0 4.2-3.2 7.2-7.5 8.4C7.7 19.2 4.5 16.2 4.5 12V6Z",
  block: "M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17ZM6 6l12 12",
  send: "M20.5 3.5 3.5 10.2l7 2.8 2.8 7Z",
  eye: "M12 5.5c4.2 0 7.6 2.8 9 6.5-1.4 3.7-4.8 6.5-9 6.5S4.4 15.7 3 12c1.4-3.7 4.8-6.5 9-6.5ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff:
    "M9.9 5.8A9.7 9.7 0 0 1 12 5.5c4.2 0 7.6 2.8 9 6.5a12 12 0 0 1-2.6 3.7M6.2 7.7A11.6 11.6 0 0 0 3 12c1.4 3.7 4.8 6.5 9 6.5a9.6 9.6 0 0 0 3.4-.6M10.1 10.1a2.7 2.7 0 0 0 3.8 3.8M4 4l16 16",
  mail: "M4.5 5.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM2.9 7l8.2 5.6a1.6 1.6 0 0 0 1.8 0L21.1 7",
  key: "M15 3.5a5.5 5.5 0 1 1-5.2 7.3L3.5 17.1V20.5H7v-2h2v-2h2l1.7-1.7A5.5 5.5 0 0 1 15 3.5ZM16.6 8.4v.2",
} as const;

export type IconName = keyof typeof PATHS;

/** Icons that need geometry a single stroked path cannot express. */
const EXTRAS: Partial<Record<IconName, ReactNode>> = {
  // The three pips that make the square read as a die rather than a window.
  games: (
    <>
      <circle cx="8.6" cy="8.6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="15.4" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5.6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.4" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Any CSS length. Defaults to 1em so icons scale with their text. */
  size?: number | string;
  /**
   * Give this only when the icon is the sole content of a control and there is
   * no other accessible name. Decorative icons stay hidden, which is the default.
   */
  title?: string;
}

export function Icon({ name, size = "1em", title, className, ...props }: IconProps) {
  const path = PATHS[name];
  const extra = EXTRAS[name];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {path ? <path d={path} /> : null}
      {extra}
    </svg>
  );
}

/** The KITH mark. Not part of the icon set — it has its own construction. */
export function KithMark({ size = 24, className, ...props }: Omit<IconProps, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M7.5 4v16M7.5 12.15 15 4M7.5 11.85 15 20" />
    </svg>
  );
}
