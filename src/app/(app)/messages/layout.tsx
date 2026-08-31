import { ConversationList } from "@/features/messages/components/conversation-list";
import { listConversations } from "@/features/messages/queries";

/**
 * Two panes on a wide screen, one on a phone.
 *
 * The list is rendered here rather than inside each page so it survives
 * navigation between threads — no refetch, no flash, and the scroll position
 * holds. Which pane is visible at a narrow width is decided inside
 * `ConversationList`, because that needs the current route.
 */
export const dynamic = "force-dynamic";

export default async function MessagesLayout({ children }: LayoutProps<"/messages">) {
  const conversations = await listConversations();

  return (
    <div className="flex h-[calc(100dvh-4rem)] w-full">
      <ConversationList conversations={conversations} />
      {children}
    </div>
  );
}
