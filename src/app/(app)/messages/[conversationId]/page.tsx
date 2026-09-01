import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { LivePresenceLabel } from "@/components/presence/live-presence";
import { Avatar } from "@/components/ui/avatar";
import { CallButton } from "@/features/calls/components/call-button";
import { Icon } from "@/components/ui/icon";
import { MessageThread } from "@/features/messages/components/message-thread";
import { getPreferences } from "@/features/settings/queries";
import { listConversationMembers } from "@/features/messages/members";
import { getConversation, listMessages } from "@/features/messages/queries";
import type { DeclaredStatus } from "@/lib/presence";
import { getCurrentUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function conversationName(conversation: {
  kind: string;
  title: string | null;
  other: { displayName: string } | null;
}): string {
  if (conversation.kind === "dm") return conversation.other?.displayName ?? "Someone who left";
  return conversation.title ?? "Group";
}

export async function generateMetadata({
  params,
}: PageProps<"/messages/[conversationId]">): Promise<Metadata> {
  const { conversationId } = await params;
  const conversation = await getConversation(conversationId);
  return { title: conversation ? conversationName(conversation) : "Messages" };
}

export default async function ConversationPage({
  params,
}: PageProps<"/messages/[conversationId]">) {
  const { conversationId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  /*
   * `getConversation` reads from the RLS-filtered list, so a conversation you
   * are not a member of simply is not in it. Null therefore covers both "no such
   * conversation" and "not yours", identically — which is what stops this page
   * being an oracle for whether a given uuid exists.
   */
  const conversation = await getConversation(conversationId);
  if (!conversation) notFound();

  const [page, members, preferences] = await Promise.all([
    listMessages(conversationId),
    listConversationMembers(conversationId),
    // Whether this person broadcasts that they are typing. Folded into the batch
    // rather than costing the thread another round trip.
    getPreferences(),
  ]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        {/* Back to the list. Phone only — on a wide screen the list is already
            beside this, and a back button would point at nothing. */}
        <Link
          href="/messages"
          aria-label="Back to conversations"
          className="control-focus -ml-1 rounded-inset p-1 text-fg-dim lg:hidden"
        >
          <Icon name="chevronRight" size={18} className="rotate-180" />
        </Link>

        {conversation.other ? (
          <Avatar
            name={conversation.other.displayName}
            seed={conversation.other.id}
            size="sm"
            src={conversation.other.avatarUrl}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg-loud">{conversationName(conversation)}</span>
          {conversation.other ? (
            <LivePresenceLabel
              subject={{
                userId: conversation.other.id,
                status: conversation.other.status as DeclaredStatus,
                lastSeenAt: conversation.other.lastSeenAt,
              }}
              name={conversation.other.displayName}
            />
          ) : (
            <span className="text-2xs text-fg-faint">{conversation.memberCount} people</span>
          )}
        </div>

        {/* Voice only. The button is disabled while any call is live, because
            there is only ever one. */}
        <CallButton
          conversationId={conversationId}
          {...(conversation.other ? { peerName: conversation.other.displayName } : {})}
        />
      </header>

      <MessageThread
        conversationId={conversationId}
        currentUserId={user.id}
        initial={page}
        memberNames={members}
        broadcastTyping={preferences.typingIndicators}
      />
    </section>
  );
}
