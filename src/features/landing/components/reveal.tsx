"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { useMotionAllowed } from "@/lib/hooks/use-motion-preference";
import { cn } from "@/lib/utils/cn";

/**
 * Scroll reveal.
 *
 * Deliberately **not** the fade-up-20px that every generated landing page uses.
 * That effect reads as "content flying in from nowhere" and it is the single
 * most recognisable tell in the category.
 *
 * This is light instead: opacity leads, and a 0.6% scale gives it just enough
 * weight to settle rather than blink on. Nothing travels, because nothing here
 * has anywhere to travel from. Elements that *do* have an origin — a menu from
 * its trigger, a headline from its own baseline — get real directional motion.
 *
 * Renders the resting state directly when motion is not allowed, so nothing is
 * ever hidden behind an animation that will not play.
 */

export interface RevealProps {
  children: ReactNode;
  /** Seconds. Use to stagger siblings, sparingly — 0.06 per item is plenty. */
  delay?: number;
  className?: string;
}

export function Reveal({ children, delay = 0, className }: RevealProps) {
  const allowed = useMotionAllowed();

  if (!allowed) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, scale: 0.994 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Section chrome: a mono index, an all-caps eyebrow, a Fraunces title and one
 * line of lead. Left-aligned and off-axis — a centred heading over a three-card
 * grid is the layout this whole system exists to avoid.
 */
export interface SectionHeaderProps {
  index: string;
  eyebrow: string;
  title: string;
  lead?: string;
  className?: string;
}

export function SectionHeader({ index, eyebrow, title, lead, className }: SectionHeaderProps) {
  return (
    <Reveal className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-baseline gap-3">
        <span className="numeric text-2xs text-ember">{index}</span>
        <span className="label text-fg-faint">{eyebrow}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </div>

      <h2 className="display max-w-[16ch] text-d-xs text-fg-loud sm:text-d-sm">{title}</h2>

      {lead ? <p className="max-w-[52ch] text-md leading-body text-fg-dim">{lead}</p> : null}
    </Reveal>
  );
}

/** Consistent vertical rhythm and the hairline that separates every section. */
export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      {...(id ? { id } : {})}
      className={cn(
        "scroll-mt-20 border-t border-line px-6 py-20 sm:px-10 sm:py-28 lg:px-16",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}
