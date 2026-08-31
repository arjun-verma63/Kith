"use client";

import { PresenceEmber } from "@/components/ui/presence-ember";
import {
  usePresence,
  usePresenceLabel,
  type PresenceSubject,
} from "@/components/presence/use-presence";
import { cn } from "@/lib/utils/cn";

/**
 * An ember and a label that follow the live channel.
 *
 * Small client components dropped into otherwise server-rendered pages. The
 * profile page stays a server component and only this line hydrates, rather than
 * the whole page becoming client-side to keep one dot up to date.
 *
 * Server rendering has no socket, so the first paint uses the `last_seen_at`
 * fallback and the light corrects itself once the channel connects. That change
 * is the honest behaviour: at first paint the server genuinely did not know.
 */

export function LiveEmber({
  subject,
  name,
  size = "md",
  className,
}: {
  subject: PresenceSubject;
  name?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const state = usePresence(subject);

  return (
    <PresenceEmber
      state={state}
      size={size}
      {...(name ? { name } : {})}
      {...(className ? { className } : {})}
    />
  );
}

export function LivePresenceLabel({
  subject,
  name,
  className,
}: {
  subject: PresenceSubject;
  name?: string;
  className?: string;
}) {
  const state = usePresence(subject);
  const label = usePresenceLabel(subject);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-xs",
        state === "lit" ? "text-moss" : "text-fg-dim",
        className,
      )}
    >
      <PresenceEmber state={state} size="sm" {...(name ? { name } : {})} />
      {label}
    </span>
  );
}
