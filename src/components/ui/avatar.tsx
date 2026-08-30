import type { CSSProperties } from "react";

import { PresenceEmber, type PresenceState } from "@/components/ui/presence-ember";
import { cn } from "@/lib/utils/cn";

/**
 * A person.
 *
 * The signature detail: when presence is shown, the light does not sit *on* the
 * portrait — a notch is cut out of it and the ember sits *in* the gap. A green
 * dot pasted over the bottom-right corner is the single most copied pattern in
 * this category, and avoiding it costs one CSS mask.
 *
 * Fallbacks are initials on a tint derived deterministically from the person's
 * id, so the same person is always the same colour, and the tints come from the
 * palette so a fallback can never introduce an off-system hue.
 */

const SIZE = {
  "2xs": { box: "size-[var(--avatar-2xs)]", text: "text-[0.5rem]", ember: "sm" },
  xs: { box: "size-[var(--avatar-xs)]", text: "text-[0.625rem]", ember: "sm" },
  sm: { box: "size-[var(--avatar-sm)]", text: "text-2xs", ember: "sm" },
  md: { box: "size-[var(--avatar-md)]", text: "text-sm", ember: "md" },
  lg: { box: "size-[var(--avatar-lg)]", text: "text-md", ember: "lg" },
  xl: { box: "size-[var(--avatar-xl)]", text: "text-d-xs", ember: "lg" },
} as const;

const SIZE_VAR = {
  "2xs": "var(--avatar-2xs)",
  xs: "var(--avatar-xs)",
  sm: "var(--avatar-sm)",
  md: "var(--avatar-md)",
  lg: "var(--avatar-lg)",
  xl: "var(--avatar-xl)",
} as const;

export type AvatarSize = keyof typeof SIZE;

/** Stable, well-distributed, and deterministic across server and client. */
function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `var(--tint-${(Math.abs(hash) % 6) + 1})`;
}

function initialsFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export interface AvatarProps {
  /** Display name. Used for initials and as the image's alternative text. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
  /** Stable identifier for the tint. Falls back to the name. */
  seed?: string;
  /** Omit entirely when presence is irrelevant — no notch, no ember. */
  presence?: PresenceState;
  /** Ring of light around someone who is here. */
  ring?: boolean;
  className?: string;
}

export function Avatar({
  name,
  src,
  size = "md",
  seed,
  presence,
  ring = false,
  className,
}: AvatarProps) {
  const spec = SIZE[size];
  const showPresence = presence !== undefined;
  const tiny = size === "2xs" || size === "xs";
  // Below ~28px the notch eats too much of the portrait to still read as a face.
  const notched = showPresence && !tiny;

  return (
    <span
      className={cn("relative inline-flex", spec.box, className)}
      style={{ "--avatar-size": SIZE_VAR[size] } as CSSProperties}
    >
      <span
        data-lit={presence === "lit"}
        className={cn("avatar h-full w-full", notched && "avatar-notched", ring && "avatar-ring")}
        style={{ "--tint": tintFor(seed ?? name) } as CSSProperties}
      >
        {src ? (
          /* Avatars are fixed-size (20-112px) and are resized once at upload
             time in Phase 3. Routing a 36px circle through the image optimiser
             costs a serverless invocation per render for no measurable gain,
             which is the wrong trade on a free tier serving six people. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span aria-hidden="true" className={cn("font-ui font-semibold", spec.text)}>
            {initialsFrom(name)}
          </span>
        )}
      </span>

      {showPresence ? (
        <PresenceEmber
          state={presence}
          size={spec.ember}
          name={name}
          className={cn(
            "absolute",
            notched ? "right-0 bottom-0 translate-x-[8%] translate-y-[8%]" : "-right-px -bottom-px",
          )}
        />
      ) : (
        <span className="sr-only">{name}</span>
      )}
    </span>
  );
}

export interface AvatarStackProps {
  people: Array<{ name: string; src?: string | null; seed?: string }>;
  size?: AvatarSize;
  /** Beyond this, the rest collapse into a count. */
  max?: number;
  className?: string;
}

/**
 * Overlapping portraits for a group. Each carries a ring in the ground colour so
 * the silhouettes stay separable where they overlap.
 */
export function AvatarStack({ people, size = "sm", max = 4, className }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;

  return (
    <span className={cn("inline-flex items-center", className)}>
      {shown.map((person, index) => (
        <span
          key={person.seed ?? person.name}
          className="rounded-full ring-2 ring-ground"
          style={{ marginLeft: index === 0 ? 0 : "-0.5em" }}
        >
          <Avatar
            name={person.name}
            size={size}
            {...(person.src ? { src: person.src } : {})}
            {...(person.seed ? { seed: person.seed } : {})}
          />
        </span>
      ))}

      {overflow > 0 ? (
        <span
          className={cn(
            "numeric inline-grid place-items-center rounded-full",
            "bg-raised text-fg-dim ring-2 ring-ground",
            SIZE[size].box,
            SIZE[size].text,
          )}
          style={{ marginLeft: "-0.5em" }}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
