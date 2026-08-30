"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { Badge, CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PresenceEmber } from "@/components/ui/presence-ember";
import { Pulse } from "@/components/ui/skeleton";
import { Reveal, Section, SectionHeader } from "@/features/landing/components/reveal";
import { PREVIEW } from "@/features/landing/copy";
import { useMotionAllowed } from "@/lib/hooks/use-motion-preference";
import { cn } from "@/lib/utils/cn";

/**
 * Product interaction preview.
 *
 * Not a screenshot and not a video — the real components, assembled. Everything
 * inside this frame is the same `Avatar`, `Badge`, `Button` and `PresenceEmber`
 * the product uses, so the preview cannot drift out of date and cannot flatter
 * the product beyond what it actually looks like.
 *
 * This is also the one place on the page where Framer Motion does something CSS
 * genuinely cannot: the lit underline is a single element that *travels* between
 * tabs via `layoutId`, rather than three elements fading in and out. That
 * continuity is the difference between a control that feels physical and one
 * that feels like a re-render.
 */

type TabKey = (typeof PREVIEW.tabs)[number]["key"];

export function ProductPreview() {
  const [tab, setTab] = useState<TabKey>("messages");
  const allowed = useMotionAllowed();

  return (
    <Section id="room">
      <SectionHeader
        index={PREVIEW.index}
        eyebrow={PREVIEW.eyebrow}
        title={PREVIEW.title}
        lead={PREVIEW.lead}
      />

      <Reveal delay={0.1} className="mt-12">
        <div
          role="tablist"
          aria-label="Product preview"
          className="flex gap-1 border-b border-line"
        >
          {PREVIEW.tabs.map((item) => {
            const active = item.key === tab;
            return (
              <button
                key={item.key}
                role="tab"
                type="button"
                id={`preview-tab-${item.key}`}
                aria-selected={active}
                aria-controls={`preview-panel-${item.key}`}
                onClick={() => setTab(item.key)}
                className={cn(
                  "control-focus relative cursor-pointer rounded-t-soft px-4 py-3 text-sm",
                  "transition-colors duration-[var(--t-quick)]",
                  active ? "text-fg-loud" : "text-fg-dim hover:text-fg",
                )}
              >
                {item.label}
                {active ? (
                  <motion.span
                    aria-hidden="true"
                    /* layoutId is what makes the bar travel between tabs rather
                       than cross-fade. Dropped entirely under reduced motion, so
                       the indicator simply appears where it belongs. */
                    {...(allowed ? { layoutId: "preview-underline" } : {})}
                    className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-ember"
                    style={{ boxShadow: "var(--elev-lit)" }}
                    transition={{ duration: 0.32, ease: [0.65, 0, 0.35, 1] }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="panel panel-raised rounded-b-soft border-t-0 p-4 sm:p-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              id={`preview-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`preview-tab-${tab}`}
              {...(allowed
                ? {
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                    transition: { duration: 0.18 },
                  }
                : {})}
            >
              {tab === "messages" ? <MessagesPreview /> : null}
              {tab === "calls" ? <CallsPreview /> : null}
              {tab === "games" ? <GamesPreview /> : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </Reveal>
    </Section>
  );
}

/* ---------------------------------------------------------------- Messages */

const THREAD = [
  { from: "them", text: "are we still on for tonight" },
  { from: "me", text: "yes. 9? I'll set up the room" },
  { from: "them", text: "Theo says he's in but only if we don't play trivia again" },
  { from: "me", text: "we are absolutely playing trivia again" },
];

function MessagesPreview() {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 border-b border-line pb-4">
        <Avatar name="Ada Okonjo" size="sm" seed="u1" presence="lit" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg-loud">Ada Okonjo</span>
          <span className="text-2xs text-moss">Online</span>
        </div>
        <Button variant="ghost" size="sm" iconOnly icon="calls" aria-label="Start a call" />
        <Button variant="ghost" size="sm" iconOnly icon="video" aria-label="Start a video call" />
      </header>

      <ul className="flex flex-col gap-2.5">
        {THREAD.map((message, index) => (
          <li
            key={index}
            className={cn("flex", message.from === "me" ? "justify-end" : "justify-start")}
          >
            <span
              className={cn(
                "max-w-[min(30rem,80%)] px-3.5 py-2.5 text-sm leading-body",
                message.from === "me"
                  ? "bubble-out bg-[var(--wash-accent-strong)] text-fg-loud"
                  : "bubble-in bg-surface text-fg",
              )}
            >
              {message.text}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2 pl-1 text-2xs text-fg-faint">
        <Pulse className="text-ember" />
        Nour is typing
      </div>

      <div className="flex items-center gap-2 rounded-soft border border-line bg-sunken px-3 py-2.5">
        <span className="flex-1 text-sm text-fg-faint">Message Ada</span>
        <Icon name="send" size={16} className="text-ember" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Calls */

function CallsPreview() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Badge tone="moss">Connected · peer to peer</Badge>
        <span className="numeric text-sm text-fg-dim" data-numeric>
          12:04
        </span>
      </div>

      {/* Off-centre by construction: the speaker takes seven columns of twelve,
          never a symmetric grid of equal tiles. */}
      <div className="grid grid-cols-12 gap-3">
        <CallTile name="Rafa Mendes" seed="u2" speaking className="col-span-12 sm:col-span-8" />
        <div className="col-span-12 flex gap-3 sm:col-span-4 sm:flex-col">
          <CallTile name="Ada Okonjo" seed="u1" className="flex-1" compact />
          <CallTile name="Jonas Vik" seed="u4" muted className="flex-1" compact />
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 pt-1">
        <Button variant="quiet" size="md" iconOnly icon="mic" aria-label="Mute" />
        <Button variant="quiet" size="md" iconOnly icon="video" aria-label="Stop video" />
        <Button variant="quiet" size="md" iconOnly icon="screen" aria-label="Share screen" />
        <Button variant="danger" size="md" iconOnly icon="calls" aria-label="Leave call" />
      </div>
    </div>
  );
}

function CallTile({
  name,
  seed,
  speaking = false,
  muted = false,
  compact = false,
  className,
}: {
  name: string;
  seed: string;
  speaking?: boolean;
  muted?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-soft bg-sunken",
        compact ? "aspect-[4/3]" : "aspect-video",
        // Active speaker is light along the tile edge, never a green border.
        speaking
          ? "shadow-[0_0_0_1px_var(--ember),var(--elev-lit)]"
          : "shadow-[0_0_0_1px_var(--line)]",
        className,
      )}
    >
      <Avatar name={name} size={compact ? "md" : "lg"} seed={seed} />

      <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5">
        <span className="truncate rounded-edge bg-[color-mix(in_oklab,var(--ground)_70%,transparent)] px-1.5 py-0.5 text-2xs text-fg">
          {name.split(" ")[0]}
        </span>
        {muted ? <Icon name="micOff" size={13} className="text-fg-faint" /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Games */

const LOBBY = [
  { id: "u1", name: "Ada", ready: true },
  { id: "u2", name: "Rafa", ready: true },
  { id: "u4", name: "Jonas", ready: true },
  { id: "u3", name: "Nour", ready: false },
];

function GamesPreview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="label text-fg-faint">Lobby</span>
          <h3 className="heading text-lg text-fg-loud">Word Rush</h3>
        </div>
        <Badge tone="ice">Round 3 of 5</Badge>
      </div>

      <div className="grid grid-cols-12 items-center gap-4">
        <div className="col-span-12 flex flex-col gap-2 sm:col-span-7">
          {LOBBY.map((player) => (
            <div
              key={player.id}
              className="flex items-center gap-3 rounded-inset border border-line bg-surface px-3 py-2"
            >
              <Avatar name={player.name} size="xs" seed={player.id} />
              <span className="flex-1 truncate text-sm text-fg">{player.name}</span>
              {player.ready ? (
                <Badge tone="moss" caps>
                  Ready
                </Badge>
              ) : (
                <span className="flex items-center gap-1.5 text-2xs text-fg-faint">
                  <PresenceEmber state="cooling" size="sm" />
                  Waiting
                </span>
              )}
            </div>
          ))}
        </div>

        {/* The countdown is the one place the numeric face goes big. */}
        <div className="col-span-12 flex flex-col items-center justify-center gap-2 rounded-soft bg-sunken py-8 sm:col-span-5">
          <span className="label text-fg-faint">Starting in</span>
          <span className="numeric text-d-sm leading-none text-ice">3</span>
          <AvatarStack
            people={LOBBY.map((p) => ({ name: p.name, seed: p.id }))}
            size="2xs"
            className="pt-2"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <span className="flex items-center gap-2 text-2xs text-fg-dim">
          Your score
          <CountBadge count={41} tone="neutral" label="points" />
        </span>
        <Button variant="primary" size="sm">
          Ready up
        </Button>
      </div>
    </div>
  );
}
