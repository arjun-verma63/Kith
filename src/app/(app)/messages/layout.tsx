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

  /*
   * `dvh`, not `vh`.
   *
   * On a phone the browser chrome grows and shrinks as you scroll and the
   * software keyboard takes a bite out of the viewport; `vh` freezes at the
   * largest of those, which puts the composer under the keyboard. `dvh` tracks
   * it, so the thread is exactly as tall as the space that is actually visible.
   *
   * The subtractions come from tokens rather than from a literal `4rem`, because
   * the header is 3.5rem on a phone and 4rem from `lg`, and the bottom bar exists
   * at one of those widths and not the other. A hard-coded number here was a
   * number that had already stopped being true.
   */
  return (
    <div className="flex h-[calc(100dvh-var(--app-header-h)-var(--nav-bar-h)-var(--safe-t))] w-full">
      <ConversationList conversations={conversations} />
      {children}
    </div>
  );
}
