"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { Reveal, Section, SectionHeader } from "@/features/landing/components/reveal";
import { COUPLE } from "@/features/landing/copy";
import { useMotionAllowed } from "@/lib/hooks/use-motion-preference";

/**
 * Couple mode.
 *
 * Differentiated by **material, not motif**: the accent moves to plum, the
 * ground warms half a step, the leading opens up. No hearts, no pink gradient,
 * no script typeface. The brief said warmer without becoming cheesy, and the way
 * to do that is to change the light in the room rather than decorate it.
 *
 * The demonstration is the mechanic itself: one answer is in, the other is
 * covered, and neither of you can read the other's until you have both written
 * yours. Clicking reveals it — which is the only honest way to show a rule that
 * is enforced in the database.
 */
export function CoupleSection() {
  const [revealed, setRevealed] = useState(false);
  const allowed = useMotionAllowed();

  return (
    <Section className="bg-[color-mix(in_oklab,var(--plum)_5%,transparent)]" id="couple">
      <SectionHeader
        index={COUPLE.index}
        eyebrow={COUPLE.eyebrow}
        title={COUPLE.title}
        lead={COUPLE.lead}
      />

      <div className="mt-12 grid grid-cols-12 gap-x-8 gap-y-10">
        <Reveal className="col-span-12 lg:col-span-6">
          <div className="panel panel-raised rounded-soft p-5">
            <div className="flex items-center gap-2 pb-4">
              <span className="size-1.5 rounded-full bg-plum" aria-hidden="true" />
              <span className="label text-fg-faint">Today&rsquo;s question</span>
            </div>

            <p className="heading leading-snug text-md text-fg-loud">{COUPLE.question}</p>

            <div className="mt-6 flex flex-col gap-3">
              <Answer name={COUPLE.answered.name} seed="couple-a">
                <p className="text-sm leading-body text-fg">{COUPLE.answered.text}</p>
              </Answer>

              <Answer name={COUPLE.waiting.name} seed="couple-b">
                <AnimatePresence mode="wait" initial={false}>
                  {revealed ? (
                    <motion.p
                      key="revealed"
                      {...(allowed
                        ? {
                            initial: { opacity: 0 },
                            animate: { opacity: 1 },
                            transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
                          }
                        : {})}
                      className="text-sm leading-body text-fg"
                    >
                      That I could not stand camping. I still cannot, but I like being there.
                    </motion.p>
                  ) : (
                    <motion.button
                      key="hidden"
                      type="button"
                      onClick={() => setRevealed(true)}
                      {...(allowed ? { exit: { opacity: 0 }, transition: { duration: 0.2 } } : {})}
                      className="control-focus flex w-full cursor-pointer items-center gap-2 rounded-inset text-left text-sm text-fg-faint"
                    >
                      <Icon name="shield" size={14} />
                      {COUPLE.waiting.hint}
                    </motion.button>
                  )}
                </AnimatePresence>
              </Answer>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.1} className="col-span-12 lg:col-span-5 lg:col-start-8 lg:self-center">
          <ul className="flex flex-col gap-5">
            {COUPLE.points.map((point) => (
              <li key={point} className="flex gap-3">
                <span aria-hidden="true" className="mt-[0.65em] h-px w-5 shrink-0 bg-plum" />
                <p className="leading-relaxed text-base text-fg-dim">{point}</p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}

function Answer({ name, seed, children }: { name: string; seed: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-inset border border-line bg-surface px-3 py-3">
      <Avatar name={name} size="xs" seed={seed} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-2xs text-fg-faint">{name}</span>
        {children}
      </div>
    </div>
  );
}
