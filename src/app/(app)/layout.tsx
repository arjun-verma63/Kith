import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Button, ButtonLink } from "@/components/ui/button";
import { KithMark } from "@/components/ui/icon";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { signOutAction } from "@/features/auth/actions";
import { CallProvider } from "@/features/calls/call-provider";
import { getActiveCall } from "@/features/calls/queries";
import { getMyCouple, listInvitations } from "@/features/couple/queries";
import { PresenceProvider } from "@/components/presence/provider";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { countUnreadNotifications, listNotifications } from "@/features/notifications/queries";
import { RoomCount } from "@/components/presence/room-count";
import { PresenceHeartbeat } from "@/features/profile/components/presence-heartbeat";
import { listFriends } from "@/features/friends/queries";
import { NavBar } from "@/components/layout/nav-rail";
import { AppearanceBoot } from "@/features/settings/components/appearance-boot";
import { getAppearance } from "@/features/settings/queries";
import { getOwnProfile } from "@/features/profile/queries";
import type { DeclaredStatus } from "@/lib/presence";
import { cn } from "@/lib/utils/cn";

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
  const [friends, notifications, unread, activeCall, couple, coupleInvitations, appearance] =
    await Promise.all([
      listFriends(),
      listNotifications(),
      countUnreadNotifications(),
      // Server-rendered so a refresh mid-call comes back to the call rather than
      // quietly abandoning the other person.
      getActiveCall(),
      getMyCouple(),
      listInvitations(),
      // Two columns, folded into the batch that was already running rather than
      // costing the shell another round trip.
      getAppearance(),
    ]);

  /*
   * Couple mode is optional and stays out of the way.
   *
   * The link appears only when there is something behind it — a partner, or a
   * question waiting. For everybody else KITH looks exactly as it did before
   * the feature existed, which is the difference between an optional feature and
   * a product that has quietly become a dating app.
   */
  const showCouple = couple !== null || coupleInvitations.length > 0;

  return (
    <PresenceProvider userId={profile.id} status={profile.status as DeclaredStatus}>
      <AppearanceBoot theme={appearance.theme} motion={appearance.motion} />
      <CallProvider userId={profile.id} initialCall={activeCall}>
        <div className="flex min-h-dvh flex-col">
          {/* Two mechanisms, two jobs. The channel above answers "who is connected
            right now" with no writes at all; this heartbeat keeps last_seen_at
            fresh so "last seen 20 minutes ago" still works after they leave and
            whenever the socket is down. */}
          <PresenceHeartbeat />

          {/* The header keeps identity and status; the destinations move to the
              bottom bar below `lg`. See NavBar for why that is a different
              component rather than a smaller row.

              Sticky, because on a phone the page below it is long and the bell
              is the one control people reach back up for. */}
          <header
            className={cn(
              "sticky top-0 z-[var(--z-sticky)] border-b border-line",
              "bg-[var(--surface)]/90 backdrop-blur-sm",
              "pt-[var(--safe-t)]",
            )}
          >
            <div
              className={cn(
                "mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-10",
                "h-[var(--app-header-h)]",
              )}
            >
              <Link href="/" className="control-focus flex items-center gap-2.5 rounded-edge">
                <KithMark size={17} className="text-ember" />
                <span className="display-wonk text-md text-fg-loud">KITH</span>
              </Link>

              <div className="flex items-center gap-2 sm:gap-3">
                <div className="hidden items-center gap-3 lg:flex">
                  <Link
                    href="/messages"
                    className="control-focus link-grow rounded-edge text-sm text-fg-dim"
                  >
                    Messages
                  </Link>

                  <Link
                    href="/calls"
                    className="control-focus link-grow rounded-edge text-sm text-fg-dim"
                  >
                    Calls
                  </Link>

                  <Link
                    href="/games"
                    className="control-focus link-grow rounded-edge text-sm text-fg-dim"
                  >
                    Games
                  </Link>

                  <Link
                    href="/friends"
                    className="control-focus link-grow rounded-edge text-sm text-fg-dim"
                  >
                    Friends
                  </Link>
                </div>

                {/* Couple is not on the bottom bar — five items is what fits
                    across 320px — so it stays here at every width, and only
                    when there is something behind it. */}
                {showCouple ? (
                  <Link
                    href="/couple"
                    className="control-focus link-grow rounded-edge text-sm text-fg-dim"
                  >
                    Couple
                  </Link>
                ) : null}

                <RoomCount
                  friendIds={friends.map((friend) => friend.id)}
                  className="hidden sm:flex"
                />

                <NotificationBell
                  userId={profile.id}
                  initialNotifications={notifications}
                  initialUnread={unread}
                />

                <ThemeToggle className="hidden sm:inline-flex" />

                {/* Settings is on the bottom bar and signing out is inside
                    Settings → Account, so the header stops carrying either of
                    them below `lg`. */}
                <ButtonLink
                  href="/settings/profile"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="settings"
                  aria-label="Settings"
                  className="hidden lg:inline-flex"
                />

                <Link
                  href={`/u/${profile.username}`}
                  aria-label="Your profile"
                  className="control-focus flex items-center gap-2 rounded-full"
                >
                  <span className="hidden text-sm text-fg-dim lg:inline">
                    {profile.display_name}
                  </span>
                  <Avatar
                    name={profile.display_name}
                    seed={profile.id}
                    size="xs"
                    src={profile.avatarUrl}
                  />
                </Link>

                <form action={signOutAction} className="hidden lg:block">
                  <Button type="submit" variant="ghost" size="sm">
                    Sign out
                  </Button>
                </form>
              </div>
            </div>
          </header>

          {/* The bar is fixed, so the page has to end above it rather than
              behind it. `--nav-bar-h` is zero from `lg`, where there is no bar. */}
          <main className="flex-1 pb-[var(--nav-bar-h)]">{children}</main>

          <NavBar counts={{ messages: unread }} />
        </div>
      </CallProvider>
    </PresenceProvider>
  );
}
