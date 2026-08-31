import Link from "next/link";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { LivePresenceLabel } from "@/components/presence/live-presence";
import { formatBirthday, formatJoined } from "@/features/profile/presence";
import { derivePresence, type DeclaredStatus } from "@/lib/presence";
import type { ProfileView as Profile } from "@/features/profile/queries";

/**
 * Somebody's profile.
 *
 * A server component: everything on it is derived from data the server already
 * has, and there is nothing to interact with. Making it a client component would
 * ship the whole thing to the browser to render text that never changes.
 *
 * The composition is the one the design system asks for — off-axis, the portrait
 * large and to the left, the name in Fraunces at display scale. Not a centred
 * card with a 96px circle on top of it, which is the layout every profile page
 * defaults to.
 */
export function ProfileView({ profile }: { profile: Profile }) {
  const status = profile.status as DeclaredStatus;
  // The avatar ring uses the server-rendered fallback so the page has a sensible
  // first paint; the label below it is a client component that follows the live
  // channel and corrects both once the socket is up.
  const presence = derivePresence({ status, lastSeenAt: profile.last_seen_at });
  const subject = {
    userId: profile.id,
    status,
    lastSeenAt: profile.last_seen_at,
  };
  const birthday = formatBirthday(profile.birthday);

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-14 sm:px-10">
      <header className="flex flex-col gap-7 sm:flex-row sm:items-end sm:gap-9">
        <Avatar
          name={profile.display_name}
          seed={profile.id}
          size="xl"
          src={profile.avatarUrl}
          presence={presence}
          ring={presence === "lit"}
        />

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="display text-d-xs text-fg-loud sm:text-d-sm">{profile.display_name}</h1>
            {profile.pronouns ? (
              <span className="text-sm text-fg-faint">{profile.pronouns}</span>
            ) : null}
          </div>

          <p className="numeric text-sm text-fg-dim">@{profile.username}</p>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <LivePresenceLabel subject={subject} name={profile.display_name} />

            {profile.status_text ? <Badge tone="neutral">{profile.status_text}</Badge> : null}
          </div>
        </div>
      </header>

      {profile.bio ? (
        <p className="mt-10 max-w-[52ch] text-md leading-body text-fg">{profile.bio}</p>
      ) : profile.isOwn ? (
        <p className="mt-10 max-w-[52ch] text-sm text-fg-faint">
          You have not written a bio.{" "}
          <Link href="/settings/profile" className="text-ember underline-offset-4 hover:underline">
            Say something
          </Link>
          .
        </p>
      ) : null}

      {/* Facts as a definition list with hairlines, not as a row of cards. */}
      <dl className="mt-12 flex flex-col border-t border-line">
        <Fact label="In the room since" value={formatJoined(profile.created_at)} icon="home" />
        {birthday ? <Fact label="Birthday" value={birthday} icon="couple" /> : null}
      </dl>

      {profile.isOwn ? (
        <div className="mt-10">
          <ButtonLink href="/settings/profile" variant="quiet" size="md" icon="settings">
            Edit your profile
          </ButtonLink>
        </div>
      ) : null}
    </article>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon: "home" | "couple" }) {
  return (
    <div className="flex items-baseline gap-4 border-b border-line py-4">
      <dt className="label flex w-40 shrink-0 items-center gap-2 text-fg-faint">
        <Icon name={icon} size={13} />
        {label}
      </dt>
      <dd className="text-sm text-fg">{value}</dd>
    </div>
  );
}
