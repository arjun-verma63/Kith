"use client";

import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Reveal, Section, SectionHeader } from "@/features/landing/components/reveal";
import { GAMES } from "@/features/landing/copy";
import { cn } from "@/lib/utils/cn";

/**
 * Games.
 *
 * The one section where the system is allowed to be playful: `--ice` enters the
 * palette, the mono face goes large, and the tiles sit in an asymmetric mosaic
 * rather than an even grid — the first tile takes seven columns and the rest
 * step down, so the eye moves through them instead of scanning a table.
 *
 * The hover is a tilt of well under a degree plus the edge lighting up. Enough
 * to feel like an object responding; not enough to be a novelty.
 */
export function GamesSection() {
  return (
    <Section id="games">
      <SectionHeader
        index={GAMES.index}
        eyebrow={GAMES.eyebrow}
        title={GAMES.title}
        lead={GAMES.lead}
      />

      <div className="mt-12 grid grid-cols-12 gap-3">
        {GAMES.items.map((game, index) => (
          <Reveal
            key={game.name}
            delay={index * 0.06}
            className={cn(
              "col-span-12",
              index === 0 ? "sm:col-span-7" : "sm:col-span-5",
              index === 1 && "sm:col-span-5",
              index === 2 && "sm:col-span-5",
              index === 3 && "sm:col-span-7",
            )}
          >
            <article
              className={cn(
                "group h-full rounded-soft border border-line bg-surface p-5",
                "transition-[border-color,transform,background-color] duration-[var(--t-base)] ease-move",
                "hover:-rotate-[0.25deg] hover:border-ice hover:bg-raised",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <h3 className="heading text-lg text-fg-loud">{game.name}</h3>
                  <p className="text-sm text-fg-dim">{game.note}</p>
                </div>
                <Icon
                  name="games"
                  size={20}
                  className="text-fg-faint transition-colors duration-[var(--t-base)] group-hover:text-ice"
                />
              </div>

              <div className="mt-6 flex items-center gap-2">
                <Badge tone="ice" caps>
                  {game.kind}
                </Badge>
                <span className="numeric text-2xs text-fg-faint">{game.players} players</span>
              </div>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.2}>
        <p className="mt-8 max-w-[62ch] border-l-2 border-line pl-4 text-sm leading-body text-fg-faint">
          {GAMES.footnote}
        </p>
      </Reveal>
    </Section>
  );
}
