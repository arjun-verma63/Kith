"use client";

import { DESTINATIONS } from "@/components/layout/destinations";
import { NavItem } from "@/components/layout/nav-item";
import { Avatar } from "@/components/ui/avatar";
import { KithMark } from "@/components/ui/icon";
import type { PresenceState } from "@/lib/presence";
import { cn } from "@/lib/utils/cn";

/**
 * The rail.
 *
 * Three bands: the mark, the destinations, and — pinned to the bottom, always —
 * **your people**. Not a collapsible sidebar, not a member list you open: they
 * are simply in the room with you, permanently, for as long as the app is open.
 *
 * That single decision does more for "private clubhouse" than any amount of
 * styling, and it is only affordable because KITH is built for six people. It
 * would be absurd at a thousand. Being small is a design advantage here, so the
 * layout spends it.
 *
 * Near-square corners and a hairline right edge: this is architecture, not a
 * floating card.
 */

export interface RailPerson {
  id: string;
  name: string;
  avatarUrl?: string | null;
  presence: PresenceState;
}

export interface NavRailProps {
  people?: readonly RailPerson[];
  /** Counts per destination key, e.g. `{ messages: 3 }`. */
  counts?: Readonly<Record<string, number>>;
  /** The signed-in user, shown at the very bottom. */
  me?: { name: string; avatarUrl?: string | null } | undefined;
  /**
   * Forces the active destination by key. Pathname matching is right for most
   * routes; this is the escape hatch for the ones where the URL and the
   * destination do not line up (a call opened from Messages, for instance).
   */
  activeKey?: string;
  className?: string;
}

export function NavRail({ people = [], counts = {}, me, activeKey, className }: NavRailProps) {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "flex h-full w-[15rem] flex-col border-r border-line bg-surface",
        "z-[var(--z-rail)]",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-4 py-5">
        <KithMark size={18} className="text-ember" />
        <span className="display-wonk text-lg text-fg-loud">KITH</span>
      </div>

      <ul className="flex flex-col gap-0.5 px-2">
        {DESTINATIONS.map((destination) => (
          <li key={destination.key}>
            <NavItem
              icon={destination.icon}
              label={destination.label}
              {...(destination.href ? { href: destination.href } : {})}
              {...(counts[destination.key] ? { count: counts[destination.key] } : {})}
              {...(activeKey ? { active: destination.key === activeKey } : {})}
            />
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-1 px-2 pt-6 pb-2">
        {people.length > 0 ? (
          <>
            <p className="label px-2 pb-1 text-fg-faint">In the room</p>
            <ul className="flex flex-col gap-0.5">
              {people.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    className={cn(
                      "control-focus flex w-full items-center gap-2.5 rounded-soft px-2 py-1.5",
                      "text-left transition-colors duration-[var(--t-quick)]",
                      "hover:bg-[var(--wash-hover)]",
                    )}
                  >
                    <Avatar
                      name={person.name}
                      size="xs"
                      seed={person.id}
                      presence={person.presence}
                      {...(person.avatarUrl ? { src: person.avatarUrl } : {})}
                    />
                    <span
                      className={cn(
                        "flex-1 truncate text-xs",
                        person.presence === "dark" ? "text-fg-faint" : "text-fg",
                      )}
                    >
                      {person.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {me ? (
          <div className="mt-2 flex items-center gap-2.5 border-t border-line px-2 pt-3">
            <Avatar
              name={me.name}
              size="xs"
              presence="lit"
              {...(me.avatarUrl ? { src: me.avatarUrl } : {})}
            />
            <span className="flex-1 truncate text-xs text-fg-dim">{me.name}</span>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

/**
 * The mobile counterpart.
 *
 * Re-authored rather than scaled: five primary destinations, the lit edge moves
 * to the bottom of each item, labels shrink to 11px, and the people strip moves
 * out of the navigation entirely (it belongs on Home at this width).
 */
export function NavBar({ counts = {}, className }: Pick<NavRailProps, "counts" | "className">) {
  const primary = DESTINATIONS.filter((destination) => destination.primary);

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "flex items-stretch gap-1 border-t border-line bg-surface px-2 pb-[env(safe-area-inset-bottom)]",
        "z-[var(--z-rail)]",
        className,
      )}
    >
      {primary.map((destination) => (
        <NavItem
          key={destination.key}
          orientation="bar"
          icon={destination.icon}
          label={destination.label}
          {...(destination.href ? { href: destination.href } : {})}
          {...(counts[destination.key] ? { count: counts[destination.key] } : {})}
        />
      ))}
    </nav>
  );
}
