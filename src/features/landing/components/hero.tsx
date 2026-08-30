"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { Avatar } from "@/components/ui/avatar";
import { AuthCta } from "@/features/landing/components/auth-cta";
import { HERO } from "@/features/landing/copy";
import { useMotionAllowed } from "@/lib/hooks/use-motion-preference";
import { cn } from "@/lib/utils/cn";

/**
 * Hero.
 *
 * Two moves, both earning their keep.
 *
 * The headline rises out of its own line box behind a clip mask. That is
 * origin-anchored motion — the words come from behind their baseline, somewhere
 * they could plausibly have been — rather than the fade-up-from-nowhere that
 * marks a page as generated. It is also two transforms on two elements, which
 * costs nothing.
 *
 * The room strip on the right is the product thesis, demonstrated instead of
 * described: six people, their lights showing who is around, and — a few seconds
 * in — one of them arriving. That single state change says more about what KITH
 * is than a paragraph could.
 */

const ROOM = [
  { id: "u1", name: "Ada", presence: "lit" as const },
  { id: "u2", name: "Rafa", presence: "lit" as const },
  { id: "u3", name: "Nour", presence: "cooling" as const },
  { id: "u4", name: "Jonas", presence: "lit" as const },
  { id: "u5", name: "Priya", presence: "dark" as const },
  { id: "u6", name: "Theo", presence: "dark" as const },
];

/** The one who arrives while you are reading. */
const ARRIVES = 4;

export function Hero() {
  const allowed = useMotionAllowed();
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    const timer = window.setTimeout(() => setArrived(true), 3800);
    return () => window.clearTimeout(timer);
  }, [allowed]);

  return (
    <section id="top" className="relative px-6 pt-32 pb-20 sm:px-10 sm:pt-40 sm:pb-28 lg:px-16">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-12 gap-y-16">
        {/* Type column. Starts at column 1 but stops well short of the right
            edge, so the composition has an axis rather than filling a box. */}
        <div className="col-span-12 flex flex-col items-start gap-8 lg:col-span-7">
          <MaskedLine allowed={allowed} delay={0}>
            <span className="label text-fg-faint">{HERO.eyebrow}</span>
          </MaskedLine>

          <h1 className="flex flex-col">
            <span className="sr-only">
              {HERO.headline[0]} {HERO.headline[1]}
            </span>
            {HERO.headline.map((line, index) => (
              <MaskedLine key={line} allowed={allowed} delay={0.08 + index * 0.09}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "display-wonk block text-[clamp(3.25rem,10.5vw,7.25rem)]",
                    index === 0 ? "text-fg-loud" : "text-ember",
                  )}
                >
                  {line}
                </span>
              </MaskedLine>
            ))}
          </h1>

          <MaskedLine allowed={allowed} delay={0.3}>
            <p className="max-w-[48ch] text-md leading-body text-fg-dim">{HERO.lead}</p>
          </MaskedLine>

          <MaskedLine allowed={allowed} delay={0.38}>
            <div className="flex flex-wrap items-center gap-3">
              <AuthCta
                intent="request-invite"
                variant="primary"
                size="lg"
                trailingIcon="arrowRight"
              >
                {HERO.primaryCta}
              </AuthCta>
              <AuthCta intent="sign-in" variant="ghost" size="lg">
                {HERO.secondaryCta}
              </AuthCta>
            </div>
          </MaskedLine>
        </div>

        {/* The room. On narrow screens it becomes a horizontal strip under the
            type rather than a squeezed column — re-authored, not scaled. */}
        <div className="col-span-12 lg:col-span-4 lg:col-start-9 lg:self-center">
          <RoomStrip allowed={allowed} arrived={arrived} />
        </div>
      </div>
    </section>
  );
}

/** A line that rises out of its own box. The mask is the parent's overflow. */
function MaskedLine({
  children,
  allowed,
  delay,
}: {
  children: ReactNode;
  allowed: boolean;
  delay: number;
}) {
  if (!allowed) return <span className="block overflow-hidden">{children}</span>;

  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <motion.span
        className="block"
        initial={{ y: "115%" }}
        animate={{ y: "0%" }}
        transition={{ duration: 0.85, delay, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.span>
    </span>
  );
}

function RoomStrip({ allowed, arrived }: { allowed: boolean; arrived: boolean }) {
  const people = ROOM.map((person, index) =>
    index === ARRIVES && arrived ? { ...person, presence: "lit" as const } : person,
  );
  const newcomer = ROOM[ARRIVES];

  return (
    <div className="panel panel-raised rounded-soft p-4">
      <div className="flex items-baseline justify-between gap-3 pb-3">
        <span className="label text-fg-faint">{HERO.roomLabel}</span>
        <span className="numeric text-2xs text-fg-faint">
          {people.filter((p) => p.presence !== "dark").length}/{people.length}
        </span>
      </div>

      <ul className="flex flex-row flex-wrap gap-x-6 gap-y-3 sm:gap-x-8 lg:flex-col lg:gap-2">
        {people.map((person, index) => (
          <motion.li
            key={person.id}
            className="flex items-center gap-2.5"
            {...(allowed
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  transition: { duration: 0.5, delay: 0.5 + index * 0.09 },
                }
              : {})}
          >
            <Avatar name={person.name} size="sm" seed={person.id} presence={person.presence} />
            <span
              className={cn(
                "text-sm transition-colors duration-[var(--t-base)]",
                person.presence === "dark" ? "text-fg-faint" : "text-fg",
              )}
            >
              {person.name}
            </span>
          </motion.li>
        ))}
      </ul>

      {/* The arrival. A live region so the change is announced rather than only
          seen — the whole point is that presence is information. */}
      <div aria-live="polite" className="min-h-[1.5rem] pt-3">
        <AnimatePresence>
          {arrived && newcomer ? (
            <motion.p
              initial={allowed ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="text-2xs text-fg-dim"
            >
              <span className="text-ember">{newcomer.name}</span> {HERO.arrivalNote}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
