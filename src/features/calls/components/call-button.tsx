"use client";

import { Icon } from "@/components/ui/icon";
import { useCall } from "@/features/calls/call-provider";
import { cn } from "@/lib/utils/cn";

/**
 * "Call".
 *
 * Disabled while any call is live, because there is only ever one — pressing it
 * mid-call would ring somebody from a conversation you are not listening to.
 * The database refuses that too (`already_in_call`), but a button that cannot be
 * pressed is a better answer than an error you have to read.
 */
export function CallButton({
  conversationId,
  peerName,
  className,
}: {
  conversationId: string;
  peerName?: string;
  className?: string;
}) {
  const { startCall, phase, busy } = useCall();
  const unavailable = phase !== "idle" || busy;

  return (
    <button
      type="button"
      onClick={() => void startCall(conversationId)}
      disabled={unavailable}
      aria-label={peerName ? `Call ${peerName}` : "Start a voice call"}
      title={
        phase !== "idle"
          ? "You are already on a call"
          : peerName
            ? `Call ${peerName}`
            : "Start a voice call"
      }
      className={cn(
        "control-focus grid size-9 place-items-center rounded-full border border-line",
        "bg-raised text-fg-dim transition-colors duration-[var(--t-quick)]",
        "hover:border-line-lit hover:text-moss",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg-dim",
        className,
      )}
    >
      <Icon name="calls" size={16} />
    </button>
  );
}
