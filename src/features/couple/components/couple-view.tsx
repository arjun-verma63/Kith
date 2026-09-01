"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";
import {
  answerPromptAction,
  endCoupleAction,
  respondToCoupleAction,
  setCoupleDetailsAction,
  setWhoCanProposeAction,
} from "@/features/couple/actions";
import { CoupleGames } from "@/features/couple/components/couple-games";
import type {
  Couple,
  CoupleGame,
  CoupleGameSession,
  CoupleInvitation,
  CouplePrompt,
} from "@/features/couple/queries";
import { cn } from "@/lib/utils/cn";

/**
 * The couple page.
 *
 * The whole feature, on one screen, reachable from one link that only appears
 * when there is something here. KITH is not a dating app and this is the part
 * where that is either true or not: no discovery, no suggestions, no counters,
 * nothing on any other page unless both people asked for it.
 *
 * Three states, and most people will only ever see the first:
 *
 *   nothing     an explanation and a privacy control. No call to action, no
 *               "find someone" — this is a thing you do with a friend, from
 *               their profile, when you both already know you want to.
 *   waiting     a question asked, or one to answer.
 *   together    the partnership, the daily question, and the way out.
 */

export function CoupleView({
  couple,
  invitations,
  prompts,
  whoCanPropose,
  games,
  gameHistory,
}: {
  couple: Couple | null;
  invitations: CoupleInvitation[];
  prompts: CouplePrompt[];
  whoCanPropose: "everyone" | "friends" | "nobody";
  games: CoupleGame[];
  gameHistory: CoupleGameSession[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10 sm:px-10">
      <header className="flex flex-col gap-1">
        <h1 className="heading text-d-xs text-fg-loud">Couple</h1>
        <p className="text-sm text-fg-dim">
          {couple
            ? "A private space, just the two of you."
            : "An optional, private corner of KITH for two people who are already here."}
        </p>
      </header>

      {invitations.map((invitation) => (
        <Invitation key={invitation.id} invitation={invitation} />
      ))}

      {couple ? (
        <>
          <Together couple={couple} />
          <DailyQuestion couple={couple} prompts={prompts} />
          <CoupleGames coupleId={couple.id} games={games} history={gameHistory} />
          <Settings couple={couple} />
        </>
      ) : (
        <Empty whoCanPropose={whoCanPropose} hasInvitations={invitations.length > 0} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * What almost everybody sees.
 *
 * Deliberately not a pitch. There is no button here, because there is nothing to
 * press — the only way in is from the profile of a friend, which is the design
 * rather than an omission, and saying so plainly is better than a dead end.
 */
function Empty({
  whoCanPropose,
  hasInvitations,
}: {
  whoCanPropose: "everyone" | "friends" | "nobody";
  hasInvitations: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [scope, setScope] = useState(whoCanPropose === "nobody" ? "nobody" : "friends");

  return (
    <div className="flex flex-col gap-5">
      {!hasInvitations ? (
        <Panel
          tone="flat"
          padding="lg"
          className="flex flex-col items-center gap-3 rounded-soft text-center"
        >
          <Icon name="couple" size={24} className="text-fg-faint" />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-fg">You&rsquo;re not in a couple here.</p>
            <p className="max-w-sm text-2xs text-fg-faint">
              If you want one, ask from your friend&rsquo;s profile. It stays private unless you
              both decide otherwise, and it changes nothing else about KITH.
            </p>
          </div>
          <ButtonLink href="/friends" variant="quiet" size="sm">
            Your friends
          </ButtonLink>
        </Panel>
      ) : null}

      <Panel tone="flat" padding="md" className="flex flex-col gap-3 rounded-soft">
        <div className="flex flex-col gap-0.5">
          <span className="label text-fg-faint">Being asked</span>
          <p className="text-2xs text-fg-faint">
            Only friends can ever ask, whatever this is set to. You can also turn it off.
          </p>
        </div>

        <div className="flex gap-2">
          {(["friends", "nobody"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={pending}
              onClick={() => {
                setScope(option);
                startTransition(async () => {
                  await setWhoCanProposeAction(option);
                });
              }}
              className={cn(
                "control-focus flex-1 rounded-inset border px-3 py-2 text-sm transition-colors",
                scope === option
                  ? "border-ember bg-[var(--wash-accent)] text-fg-loud"
                  : "border-line text-fg-dim hover:border-line-lit",
              )}
            >
              {option === "friends" ? "Friends can ask" : "Nobody can ask"}
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Invitation({ invitation }: { invitation: CoupleInvitation }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const respond = (accept: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await respondToCoupleAction(invitation.id, accept);
      if (!result.ok) setError(result.reason);
    });
  };

  if (invitation.direction === "outgoing") {
    return (
      <Panel tone="flat" padding="md" className="flex items-center gap-3 rounded-soft">
        <Avatar
          name={invitation.other.displayName}
          seed={invitation.other.id}
          size="sm"
          src={invitation.other.avatarUrl}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg">
            You asked <span className="text-fg-loud">{invitation.other.displayName}</span>
          </span>
          <span className="text-2xs text-fg-faint">Waiting for them.</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          loading={pending}
          // Withdrawing is the same operation as declining: the proposal ends.
          onClick={() => respond(false)}
        >
          Withdraw
        </Button>
      </Panel>
    );
  }

  return (
    <Panel
      tone="raised"
      padding="lg"
      className="lit-edge flex flex-col items-center gap-4 rounded-soft text-center"
    >
      <Avatar
        name={invitation.other.displayName}
        seed={invitation.other.id}
        size="lg"
        src={invitation.other.avatarUrl}
      />

      <div className="flex flex-col gap-1">
        <p className="heading text-md text-fg-loud">
          {invitation.other.displayName} asked to pair with you
        </p>
        <p className="text-2xs text-fg-faint">
          It&rsquo;s private by default, and either of you can end it whenever.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" loading={pending} onClick={() => respond(false)}>
          Not now
        </Button>
        <Button variant="primary" size="sm" loading={pending} onClick={() => respond(true)}>
          Yes
        </Button>
      </div>

      {error ? (
        <p role="status" className="text-sm text-signal">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function Together({ couple }: { couple: Couple }) {
  const days = daysSince(couple.anniversary ?? couple.startedAt);

  return (
    <Panel
      tone="raised"
      padding="lg"
      className="lit-edge flex flex-col items-center gap-4 rounded-soft"
    >
      {/* Two faces, overlapping. The only place in KITH that draws a pair. */}
      <div className="flex items-center -space-x-3">
        <Avatar
          name={couple.partner.displayName}
          seed={couple.partner.id}
          size="lg"
          src={couple.partner.avatarUrl}
          className="ring-2 ring-[var(--bg-raised)]"
        />
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-full bg-plum text-on-accent ring-2 ring-[var(--bg-raised)]"
        >
          <Icon name="couple" size={15} />
        </span>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <Link
          href={`/u/${couple.partner.username}`}
          className="control-focus link-grow heading rounded-edge text-md text-fg-loud"
        >
          {couple.partner.displayName}
        </Link>
        <p className="numeric text-2xs text-fg-faint">
          {days !== null ? `${days.toLocaleString()} days` : "Since you paired"}
          {couple.promptCount > 0 ? ` · ${couple.promptCount} questions` : ""}
        </p>
      </div>

      {couple.visibility === "private" ? (
        <Badge tone="neutral">Private</Badge>
      ) : (
        <Badge tone="plum">Visible to friends</Badge>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The daily question.
 *
 * The one mechanic here, and the reason the schema is interesting: you cannot
 * read your partner's answer until you have written your own. That is not a
 * blur or a `hidden` attribute — the row is not in the response. So the "write
 * yours first" state below is describing something real, not performing it.
 */
function DailyQuestion({ couple, prompts }: { couple: Couple; prompts: CouplePrompt[] }) {
  const [today, ...history] = prompts;

  return (
    <div className="flex flex-col gap-4">
      {today ? (
        <PromptCard prompt={today} partnerName={couple.partner.displayName} today />
      ) : (
        <Panel tone="flat" padding="lg" className="rounded-soft text-center">
          <p className="text-sm text-fg-faint">Today&rsquo;s question is on its way.</p>
        </Panel>
      )}

      {history.length > 0 ? (
        <details className="group/history">
          <summary className="control-focus label cursor-pointer rounded-edge py-1 text-fg-faint">
            Earlier questions · {history.length}
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {history.map((prompt) => (
              <li key={prompt.id}>
                <PromptCard prompt={prompt} partnerName={couple.partner.displayName} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PromptCard({
  prompt,
  partnerName,
  today = false,
}: {
  prompt: CouplePrompt;
  partnerName: string;
  today?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const answered = prompt.myAnswer !== null;

  return (
    <Panel
      tone={today ? "raised" : "flat"}
      padding="lg"
      className="flex flex-col gap-4 rounded-soft"
    >
      <div className="flex flex-col gap-1">
        {today ? <span className="label text-ember">Today</span> : null}
        <p className="heading text-md text-fg-loud">{prompt.question}</p>
      </div>

      {answered ? (
        <div className="flex flex-col gap-3">
          <Answer label="You" body={prompt.myAnswer!} />

          {prompt.partnerAnswer !== null ? (
            <Answer label={partnerName} body={prompt.partnerAnswer} tone="plum" />
          ) : (
            <p className="text-2xs text-fg-faint">
              {prompt.partnerHasAnswered
                ? `${partnerName} has answered. Refresh to see it.`
                : `Waiting for ${partnerName}.`}
            </p>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.trim();
            if (!body) return;

            setError(null);
            startTransition(async () => {
              const result = await answerPromptAction(prompt.id, body);
              if (!result.ok) setError(result.reason);
              else setDraft("");
            });
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Your answer…"
            aria-label="Your answer"
            className="input resize-none text-sm"
          />

          <div className="flex items-center justify-between gap-3">
            {/* Said before they write, not after, because it changes what people
                write — knowing the other answer is locked away makes an honest
                answer easier. */}
            <p className="text-2xs text-fg-faint">
              {prompt.partnerHasAnswered
                ? `${partnerName} has answered. You'll see it once you have.`
                : `Neither of you can see the other's until you've both written.`}
            </p>
            <Button
              type="submit"
              variant="lit"
              size="sm"
              loading={pending}
              disabled={draft.trim().length === 0}
            >
              Answer
            </Button>
          </div>

          {error ? (
            <p role="status" className="text-sm text-signal">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Panel>
  );
}

function Answer({ label, body, tone }: { label: string; body: string; tone?: "plum" }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={cn("label", tone === "plum" ? "text-plum" : "text-fg-faint")}>{label}</span>
      <p className="prose text-sm whitespace-pre-wrap text-fg">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Settings({ couple }: { couple: Couple }) {
  const [pending, startTransition] = useTransition();
  const [ending, setEnding] = useState(false);
  const [anniversary, setAnniversary] = useState(couple.anniversary ?? "");
  const [visibility, setVisibility] = useState(couple.visibility);
  const [error, setError] = useState<string | null>(null);

  const save = (next: Partial<{ anniversary: string; visibility: "private" | "friends" }>) => {
    setError(null);
    startTransition(async () => {
      const result = await setCoupleDetailsAction(couple.id, next);
      if (!result.ok) setError(result.reason);
    });
  };

  return (
    <Panel tone="flat" padding="md" className="flex flex-col gap-4 rounded-soft">
      <span className="label text-fg-faint">Just between you</span>

      <label className="flex items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm text-fg">Anniversary</span>
          <span className="text-2xs text-fg-faint">Only the two of you see the date.</span>
        </span>
        <input
          type="date"
          value={anniversary}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(event) => {
            setAnniversary(event.target.value);
            save({ anniversary: event.target.value });
          }}
          className="input w-40 text-sm"
        />
      </label>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-fg">Who can see it</span>
          <span className="text-2xs text-fg-faint">
            Private means nobody but you two. Either of you can change this.
          </span>
        </div>

        <div className="flex gap-2">
          {(["private", "friends"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={pending}
              onClick={() => {
                setVisibility(option);
                save({ visibility: option });
              }}
              className={cn(
                "control-focus flex-1 rounded-inset border px-3 py-2 text-sm transition-colors",
                visibility === option
                  ? "border-plum bg-[color-mix(in_oklab,var(--plum)_12%,transparent)] text-fg-loud"
                  : "border-line text-fg-dim hover:border-line-lit",
              )}
            >
              {option === "private" ? "Private" : "Our friends"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
        <span className="flex flex-col">
          <span className="text-sm text-fg">End it</span>
          <span className="text-2xs text-fg-faint">
            Nothing you wrote is deleted. They are not asked first.
          </span>
        </span>
        <Button variant="danger" size="sm" onClick={() => setEnding(true)}>
          End
        </Button>
      </div>

      {error ? (
        <p role="status" className="text-sm text-signal">
          {error}
        </p>
      ) : null}

      <Dialog
        open={ending}
        onClose={() => setEnding(false)}
        title="End this?"
        description={`You and ${couple.partner.displayName} will stop being paired. Your answers stay where they are, and neither of you will be told by KITH.`}
        dismissible={false}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEnding(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  await endCoupleAction(couple.id);
                  setEnding(false);
                })
              }
            >
              End it
            </Button>
          </>
        }
      />
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function daysSince(iso: string): number | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}
