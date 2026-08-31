import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { KithMark } from "@/components/ui/icon";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { signOutAction } from "@/features/auth/actions";
import { PresenceProvider } from "@/components/presence/provider";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { countUnreadNotifications, listNotifications } from "@/features/notifications/queries";
import { RoomCount } from "@/components/presence/room-count";
import { PresenceHeartbeat } from "@/features/profile/components/presence-heartbeat";
import { listFriends } from "@/features/friends/queries";
import { getOwnProfile } from "@/features/profile/queries";
import type { DeclaredStatus } from "@/lib/presence";

/**
 * Minimal shell for the signed-in surfaces that exist so far.
 *
 * Deliberately not the nav rail. The rail is built around destinations that do
 * not exist yet and around your people, who arrive with friends — shipping it
 * now would mean seven items where six go nowhere. This is the smallest chrome
 * that makes the profile pages navigable, and it is replaced wholesale when the
 * app shell lands.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const profile = await getOwnProfile();

  // Middleware already redirects an unauthenticated request, but a layout that
  // dereferences a profile should not depend on a layer above it having run.
  if (!profile) redirect("/login");

  // Who to count in the room indicator. Friends only — presence is not a
  // directory of everyone who happens to hold an account.
  // Fetched in parallel: three reads with nothing to say to each other should
  // not cost three sequential round trips on every page in the app.
  const [friends, notifications, unread] = await Promise.all([
    listFriends(),
    listNotifications(),
    countUnreadNotifications(),
  ]);

  return (
    <PresenceProvider userId={profile.id} status={profile.status as DeclaredStatus}>
      <div className="flex min-h-dvh flex-col">
        {/* Two mechanisms, two jobs. The channel above answers "who is connected
            right now" with no writes at all; this heartbeat keeps last_seen_at
            fresh so "last seen 20 minutes ago" still works after they leave and
            whenever the socket is down. */}
        <PresenceHeartbeat />

        <header className="border-b border-line">
          <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-6 sm:px-10">
            <Link href="/" className="control-focus flex items-center gap-2.5 rounded-edge">
              <KithMark size={17} className="text-ember" />
              <span className="display-wonk text-md text-fg-loud">KITH</span>
            </Link>

            <div className="flex items-center gap-3">
              <Link
                href="/messages"
                className="control-focus link-grow rounded-edge text-sm text-fg-dim"
              >
                Messages
              </Link>

              <RoomCount friendIds={friends.map((friend) => friend.id)} />

              <NotificationBell
                userId={profile.id}
                initialNotifications={notifications}
                initialUnread={unread}
              />

              <ThemeToggle className="hidden sm:inline-flex" />

              <Link
                href={`/u/${profile.username}`}
                className="control-focus flex items-center gap-2 rounded-full"
              >
                <span className="hidden text-sm text-fg-dim sm:inline">{profile.display_name}</span>
                <Avatar
                  name={profile.display_name}
                  seed={profile.id}
                  size="xs"
                  src={profile.avatarUrl}
                />
              </Link>

              <form action={signOutAction}>
                <Button type="submit" variant="ghost" size="sm">
                  Sign out
                </Button>
              </form>
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>
      </div>
    </PresenceProvider>
  );
}
