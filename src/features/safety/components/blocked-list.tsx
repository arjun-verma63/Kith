"use client";

import { useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { unblockUserAction } from "@/features/safety/actions";
import type { BlockedAccount } from "@/features/safety/queries";
import { UNBLOCK_CAVEAT } from "@/features/safety/reasons";

/**
 * Settings → Safety → who you have blocked.
 *
 * The only place this list exists. It has to, because blocking hides the person
 * everywhere else — including from search — so without this page an accidental
 * block would be genuinely hard to undo: you cannot find them to unblock them.
 *
 * The note beside each row is the blocker's own, from `blocks.reason`. Nobody
 * else can read it, and in six months "why did I block this person" turns out to
 * be a hard question.
 */

export function BlockedList({ blocked }: { blocked: BlockedAccount[] }) {
  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Blocked accounts</span>
        {blocked.length > 0 ? (
          <span className="numeric text-2xs text-fg-faint tabular-nums">{blocked.length}</span>
        ) : null}
      </header>

      <div className="p-4">
        {blocked.length === 0 ? (
          <p className="text-sm text-fg-dim">You have not blocked anybody.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {blocked.map((account) => (
                <BlockedRow key={account.id} account={account} />
              ))}
            </ul>
            <p className="max-w-prose text-2xs leading-body text-fg-faint">{UNBLOCK_CAVEAT}</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function BlockedRow({ account }: { account: BlockedAccount }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <li className="flex items-center gap-3 rounded-inset border border-line px-3 py-2.5">
      <Avatar
        name={account.displayName}
        seed={account.id}
        size="sm"
        src={account.avatarUrl}
        className="opacity-60"
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-fg-loud">{account.displayName}</span>
        <span className="truncate text-2xs text-fg-faint">
          {account.reason ? `${account.reason} · ` : ""}
          blocked{" "}
          {new Date(account.blockedAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
        {error ? <span className="text-2xs text-signal">{error}</span> : null}
      </span>

      <Button
        variant="quiet"
        size="sm"
        loading={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await unblockUserAction(account.id);
            if (!result.ok) setError(result.reason);
          });
        }}
      >
        Unblock
      </Button>
    </li>
  );
}
