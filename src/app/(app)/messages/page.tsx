import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Messages" };

/**
 * The desktop resting state.
 *
 * Hidden on a phone: at that width `/messages` IS the list, and a "pick a
 * conversation" panel underneath it would be an instruction nobody needs.
 */
export default function MessagesIndexPage() {
  return (
    <div className="hidden flex-1 items-center justify-center lg:flex">
      <EmptyState
        title="Pick a conversation"
        description="Or start a new one from a friend's profile."
      />
    </div>
  );
}
