"use client";

import { useState, type ReactNode } from "react";

import { NavBar, NavRail } from "@/components/layout/nav-rail";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { Badge, BadgeDot, CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Icon, KithMark, type IconName } from "@/components/ui/icon";
import { Input, Textarea } from "@/components/ui/input";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { Card, Panel, PanelFooter, PanelHeader } from "@/components/ui/panel";
import { PresenceEmber } from "@/components/ui/presence-ember";
import { Pulse, Skeleton, SkeletonAvatar, SkeletonText } from "@/components/ui/skeleton";
import { ToastProvider, useToast } from "@/components/ui/toast";

/* Fictional names, used only to exercise the components. */
const PEOPLE = [
  { id: "u1", name: "Ada Okonjo", presence: "lit" as const },
  { id: "u2", name: "Rafa Mendes", presence: "lit" as const },
  { id: "u3", name: "Nour Haddad", presence: "cooling" as const },
  { id: "u4", name: "Jonas Vik", presence: "lit" as const },
  { id: "u5", name: "Priya Raman", presence: "dark" as const },
  { id: "u6", name: "Theo Blackwood", presence: "dark" as const },
];

const COLOR_GROUPS: Array<{ group: string; tokens: Array<[string, string]> }> = [
  {
    group: "Ground and surfaces",
    tokens: [
      ["--ground", "The floor of the room"],
      ["--surface", "Panels, the rail, the stage"],
      ["--surface-raised", "Menus, dialogs, toasts"],
      ["--surface-sunken", "Inputs, wells"],
      ["--line", "Hairlines"],
      ["--line-lit", "Hairlines catching light"],
    ],
  },
  {
    group: "Foreground",
    tokens: [
      ["--fg-loud", "Headlines, the active thing"],
      ["--fg", "Body copy"],
      ["--fg-dim", "Secondary — meets 4.5:1"],
      ["--fg-faint", "Hairline text, disabled — 3:1 only"],
    ],
  },
  {
    group: "Spot inks",
    tokens: [
      ["--ember", "Presence, primary action, focus"],
      ["--lantern", "Away, warnings, highlights"],
      ["--moss", "Success, connected"],
      ["--signal", "Errors, destructive, missed"],
      ["--plum", "Couple"],
      ["--ice", "Games"],
    ],
  },
];

export function StyleguideClient() {
  return (
    <ToastProvider>
      <StyleguideBody />
    </ToastProvider>
  );
}

function StyleguideBody() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  return (
    <div className="min-h-dvh">
      <header className="flex items-baseline justify-between border-b border-line px-6 py-5 sm:px-10">
        <div className="flex items-center gap-3">
          <KithMark size={18} className="text-ember" />
          <span className="display-wonk text-lg text-fg-loud">KITH</span>
          <span className="label text-fg-faint">Design system</span>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto max-w-6xl px-6 pb-32 sm:px-10">
        <Section
          id="type"
          title="Typography"
          note="Three faces, three jobs. Two scales, deliberately far apart."
        >
          <div className="flex flex-col gap-6">
            <Row label="display-wonk">
              <p className="display-wonk text-d-md text-fg-loud">Your people.</p>
            </Row>
            <Row label="display">
              <p className="display text-d-sm text-fg">Your space.</p>
            </Row>
            <Row label="heading">
              <p className="heading text-lg text-fg-loud">Section titles and dialogs</p>
            </Row>
            <Row label="body / --fs-base">
              <p className="max-w-[46ch] text-base leading-body text-fg">
                Interface copy sits at 15px in Manrope. It is the voice of the product for
                everything that is not a headline or a number.
              </p>
            </Row>
            <Row label="label">
              <p className="label text-fg-dim">In the room · 11px · +0.12em</p>
            </Row>
            <Row label="numeric">
              <p className="numeric text-md text-fg">04:17 · 128 · 99+</p>
            </Row>
          </div>

          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["2xs", "text-2xs"],
                ["xs", "text-xs"],
                ["sm", "text-sm"],
                ["base", "text-base"],
                ["md", "text-md"],
                ["lg", "text-lg"],
              ] as const
            ).map(([name, cls]) => (
              <Panel key={name} padding="sm" className="flex flex-col gap-1">
                <span className="label text-fg-faint">{name}</span>
                <span className={cls}>Aa</span>
              </Panel>
            ))}
          </div>
        </Section>

        <Section
          id="colour"
          title="Colour"
          note="Every value is a token. Nothing in a component is a literal."
        >
          <div className="flex flex-col gap-8">
            {COLOR_GROUPS.map(({ group, tokens }) => (
              <div key={group} className="flex flex-col gap-3">
                <h3 className="label text-fg-faint">{group}</h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {tokens.map(([token, note]) => (
                    <Panel key={token} padding="sm" className="flex items-center gap-3">
                      <span
                        className="size-9 shrink-0 rounded-edge border border-line"
                        style={{ background: `var(${token})` }}
                      />
                      <span className="flex min-w-0 flex-col">
                        <code className="numeric truncate text-2xs text-fg">{token}</code>
                        <span className="truncate text-2xs text-fg-faint">{note}</span>
                      </span>
                    </Panel>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="shape"
          title="Shape, elevation and motion"
          note="Radius carries meaning: near-square is architecture, rounded is something you touch."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["--r-edge", "2px", "Panels, the rail"],
                ["--r-inset", "6px", "Nested rows"],
                ["--r-soft", "10px", "Buttons, inputs"],
                ["--r-full", "999px", "Avatars, pills"],
              ] as const
            ).map(([token, value, use]) => (
              <Panel key={token} padding="sm" className="flex flex-col gap-2">
                <span
                  className="h-12 w-full border border-line-lit bg-raised"
                  style={{ borderRadius: `var(${token})` }}
                />
                <code className="numeric text-2xs text-fg">{token}</code>
                <span className="text-2xs text-fg-faint">
                  {value} · {use}
                </span>
              </Panel>
            ))}
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {(
              [
                ["flat", "Flush in the room"],
                ["raised", "One step forward"],
                ["overlay", "Came to you"],
              ] as const
            ).map(([tone, note]) => (
              <Panel key={tone} tone={tone} padding="md" className="rounded-soft">
                <p className="text-sm text-fg-loud">panel-{tone}</p>
                <p className="mt-1 text-2xs text-fg-faint">{note}</p>
              </Panel>
            ))}
          </div>

          <div className="mt-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["--t-tap", "80ms", "Heard you"],
                ["--t-quick", "140ms", "Hover, focus"],
                ["--t-base", "240ms", "Something changed"],
                ["--t-considered", "380ms", "A surface arrived"],
                ["--t-journey", "620ms", "You moved"],
                ["--t-story", "1100ms", "Scroll beats"],
              ] as const
            ).map(([token, value, meaning]) => (
              <Panel key={token} padding="sm" className="flex flex-col gap-0.5">
                <code className="numeric text-2xs text-ember">{value}</code>
                <code className="numeric truncate text-2xs text-fg-faint">{token}</code>
                <span className="text-2xs text-fg-dim">{meaning}</span>
              </Panel>
            ))}
          </div>
        </Section>

        <Section
          id="icons"
          title="Icons"
          note="Drawn, not installed. 24px box, 1.5px stroke, one hand."
        >
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-10">
            {(
              [
                "home",
                "friends",
                "messages",
                "calls",
                "games",
                "couple",
                "settings",
                "search",
                "plus",
                "check",
                "close",
                "chevronDown",
                "chevronRight",
                "arrowRight",
                "more",
                "bell",
                "mic",
                "micOff",
                "video",
                "screen",
                "alert",
                "info",
                "shield",
                "block",
                "send",
              ] satisfies IconName[]
            ).map((name) => (
              <Panel key={name} padding="sm" className="flex flex-col items-center gap-2 py-3">
                <Icon name={name} size={22} className="text-fg" />
                <span className="w-full truncate text-center text-[0.625rem] text-fg-faint">
                  {name}
                </span>
              </Panel>
            ))}
          </div>
        </Section>

        <Section
          id="buttons"
          title="Buttons"
          note="One primary per surface. Press is a CSS scale at 80ms."
        >
          <div className="flex flex-col gap-5">
            <Row label="variants">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Start a call</Button>
                <Button variant="quiet">Cancel</Button>
                <Button variant="lit">Invite someone</Button>
                <Button variant="ghost">Dismiss</Button>
                <Button variant="danger">Block</Button>
              </div>
            </Row>
            <Row label="sizes">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
              </div>
            </Row>
            <Row label="with icons">
              <div className="flex flex-wrap items-center gap-2">
                <Button icon="plus" variant="primary">
                  New conversation
                </Button>
                <Button trailingIcon="arrowRight">Continue</Button>
                <Button iconOnly icon="more" aria-label="More actions" />
                <Button iconOnly icon="mic" variant="primary" aria-label="Mute" />
              </div>
            </Row>
            <Row label="states">
              <div className="flex flex-wrap items-center gap-2">
                <Button loading variant="primary">
                  Saving
                </Button>
                <Button disabled>Disabled</Button>
                <Button
                  variant="quiet"
                  loading={loading}
                  onClick={() => {
                    setLoading(true);
                    window.setTimeout(() => setLoading(false), 1600);
                  }}
                >
                  Click to load
                </Button>
              </div>
            </Row>
          </div>
        </Section>

        <Section
          id="inputs"
          title="Inputs"
          note="A recessed surface. Focus is an ember hairline and halo, never blue."
        >
          <div className="grid max-w-2xl gap-5">
            <Field
              label="Username"
              hint="Letters, numbers and underscores. This is how people find you."
            >
              {(props) => <Input {...props} placeholder="ada" icon="search" />}
            </Field>

            <Field label="Email" error="That address is already in use." required>
              {(props) => <Input {...props} type="email" defaultValue="ada@example.com" />}
            </Field>

            <Field label="About you" hint="Optional. Shown on your profile.">
              {(props) => <Textarea {...props} placeholder="Two lines, tops." />}
            </Field>

            <Field label="Disabled">
              {(props) => <Input {...props} disabled defaultValue="Locked" />}
            </Field>

            <div className="flex gap-3">
              <Input inputSize="sm" placeholder="Small" />
              <Input inputSize="md" placeholder="Medium" />
              <Input inputSize="lg" placeholder="Large" />
            </div>
          </div>
        </Section>

        <Section
          id="people"
          title="Avatars and presence"
          note="The light sits in a notch cut out of the portrait, not on top of it."
        >
          <div className="flex flex-col gap-6">
            <Row label="sizes">
              <div className="flex flex-wrap items-end gap-4">
                {(["2xs", "xs", "sm", "md", "lg", "xl"] as const).map((size) => (
                  <div key={size} className="flex flex-col items-center gap-2">
                    <Avatar name="Ada Okonjo" size={size} seed="u1" />
                    <span className="label text-fg-faint">{size}</span>
                  </div>
                ))}
              </div>
            </Row>

            <Row label="presence">
              <div className="flex flex-wrap items-end gap-6">
                {(["lit", "cooling", "dark"] as const).map((state) => (
                  <div key={state} className="flex flex-col items-center gap-2">
                    <Avatar name="Rafa Mendes" size="lg" seed={state} presence={state} />
                    <span className="label text-fg-faint">{state}</span>
                  </div>
                ))}
                <div className="flex flex-col items-center gap-2">
                  <Avatar name="Nour Haddad" size="lg" seed="ring" presence="lit" ring />
                  <span className="label text-fg-faint">ring</span>
                </div>
              </div>
            </Row>

            <Row label="ember only">
              <div className="flex items-center gap-6">
                {(["lit", "cooling", "dark"] as const).map((state) => (
                  <span key={state} className="flex items-center gap-2">
                    <PresenceEmber state={state} size="lg" />
                    <span className="text-xs text-fg-dim">{state}</span>
                  </span>
                ))}
              </div>
            </Row>

            <Row label="stack">
              <AvatarStack people={PEOPLE.map((p) => ({ name: p.name, seed: p.id }))} max={4} />
            </Row>
          </div>
        </Section>

        <Section
          id="badges"
          title="Badges"
          note="Words are tinted. Numbers are filled, mono and tabular."
        >
          <div className="flex flex-col gap-5">
            <Row label="tones">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>Friend</Badge>
                <Badge tone="ember">Host</Badge>
                <Badge tone="moss">Connected</Badge>
                <Badge tone="lantern">Away</Badge>
                <Badge tone="signal">Blocked</Badge>
                <Badge tone="plum">Couple</Badge>
                <Badge tone="ice">Playing</Badge>
              </div>
            </Row>
            <Row label="caps">
              <div className="flex flex-wrap items-center gap-2">
                <Badge caps tone="ember">
                  Beta
                </Badge>
                <Badge caps tone="moss">
                  Verified
                </Badge>
                <Badge caps>
                  <BadgeDot tone="lantern" /> Pending
                </Badge>
              </div>
            </Row>
            <Row label="counts">
              <div className="flex flex-wrap items-center gap-3">
                <CountBadge count={1} />
                <CountBadge count={12} />
                <CountBadge count={128} />
                <CountBadge count={3} tone="signal" label="missed calls" />
                <CountBadge count={7} tone="neutral" />
              </div>
            </Row>
          </div>
        </Section>

        <Section
          id="surfaces"
          title="Surfaces"
          note="Panels first. Cards are the exception, not the grid."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel padding="none">
              <PanelHeader>
                <span className="heading text-sm text-fg-loud">Panel with header</span>
                <Button size="sm" variant="ghost" iconOnly icon="more" aria-label="More" />
              </PanelHeader>
              <div className="px-4 py-4 text-sm text-fg-dim">
                Near-square corners, a hairline border, and a lit top edge when raised.
              </div>
              <PanelFooter>
                <Button size="sm" variant="ghost">
                  Cancel
                </Button>
                <Button size="sm" variant="primary">
                  Save
                </Button>
              </PanelFooter>
            </Panel>

            <div className="flex flex-col gap-3">
              <Card onClick={() => toast({ title: "Card pressed", tone: "neutral" })}>
                <div className="flex items-center gap-3">
                  <Avatar name="Jonas Vik" size="md" seed="u4" presence="lit" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg-loud">Jonas Vik</span>
                    <span className="truncate text-xs text-fg-dim">
                      Interactive card — soft radius, lifts on hover
                    </span>
                  </span>
                  <Icon name="chevronRight" size={16} className="text-fg-faint" />
                </div>
              </Card>

              <Panel tone="sunken" className="rounded-soft">
                <p className="text-sm text-fg-dim">
                  A sunken panel. Quoted content, code, anything recessed.
                </p>
              </Panel>
            </div>
          </div>
        </Section>

        <Section
          id="nav"
          title="Navigation"
          note="Active is a bar of light along the leading edge — never a filled pill."
        >
          <div className="flex flex-col gap-6">
            <div className="flex gap-6">
              <Panel padding="none" className="h-[30rem] overflow-hidden rounded-soft">
                <NavRail
                  activeKey="home"
                  counts={{ messages: 3, friends: 1 }}
                  people={PEOPLE}
                  me={{ name: "You" }}
                  className="border-r-0"
                />
              </Panel>
              <p className="max-w-[38ch] self-center text-sm leading-body text-fg-dim">
                Your people are pinned to the bottom of the rail permanently — not a list you open,
                just who is in the room. Destinations that do not exist yet render as pending rather
                than as links that go nowhere.
              </p>
            </div>

            <div>
              <p className="label mb-2 text-fg-faint">Mobile bar</p>
              <Panel padding="none" className="max-w-sm overflow-hidden rounded-soft">
                <NavBar counts={{ messages: 3 }} className="border-t-0" />
              </Panel>
            </div>
          </div>
        </Section>

        <Section
          id="overlays"
          title="Overlays"
          note="Native dialog for correctness; CSS @starting-style for motion."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="quiet" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>
              Destructive confirm
            </Button>

            <Menu
              label="Conversation actions"
              trigger={(props) => (
                <Button {...props} variant="quiet" trailingIcon="chevronDown">
                  Menu
                </Button>
              )}
            >
              <MenuLabel>Conversation</MenuLabel>
              <MenuItem icon="bell" hint="M">
                Mute notifications
              </MenuItem>
              <MenuItem icon="search">Search in conversation</MenuItem>
              <MenuItem icon="shield" disabled>
                Privacy settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon="block" tone="danger">
                Block Rafa
              </MenuItem>
            </Menu>

            <Button
              variant="quiet"
              onClick={() => toast({ title: "Message sent", tone: "success" })}
            >
              Toast: success
            </Button>
            <Button
              variant="quiet"
              onClick={() =>
                toast({
                  title: "Could not reach Nour",
                  description: "They went offline before the call connected.",
                  tone: "danger",
                })
              }
            >
              Toast: error
            </Button>
            <Button
              variant="quiet"
              onClick={() =>
                toast({
                  title: "Friend request sent",
                  description: "Priya will see it next time they are here.",
                  action: { label: "Undo", onClick: () => undefined },
                })
              }
            >
              Toast: with action
            </Button>
          </div>

          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Start a call with Ada?"
            description="They are online now."
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Not now
                </Button>
                <Button variant="primary" icon="calls" onClick={() => setDialogOpen(false)}>
                  Call
                </Button>
              </>
            }
          >
            <p className="leading-body text-fg-dim">
              The dialog is a native <code className="numeric text-fg">&lt;dialog&gt;</code>, so
              focus containment, <code className="numeric text-fg">inert</code> behind, Escape and
              the top layer all come from the platform rather than from code we would have to keep
              correct.
            </p>
          </Dialog>

          <Dialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Block Theo?"
            description="They will not be able to message or call you, and you will disappear from their room."
            size="sm"
            dismissible={false}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setConfirmOpen(false);
                    toast({ title: "Theo blocked", tone: "neutral" });
                  }}
                >
                  Block
                </Button>
              </>
            }
          />
        </Section>

        <Section
          id="loading"
          title="Loading"
          note="Skeletons match the geometry of what is coming. No spinners in the shell."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <div className="flex flex-col gap-4">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-3">
                    <SkeletonAvatar size="md" />
                    <div className="flex-1">
                      <SkeletonText lines={2} />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel className="flex flex-col gap-4">
              <Skeleton className="h-24 w-full rounded-soft" />
              <SkeletonText lines={3} />
              <div className="flex items-center gap-3 pt-2">
                <Pulse className="text-ember" />
                <span className="text-xs text-fg-dim">Pulse — the only working indicator</span>
              </div>
            </Panel>
          </div>
        </Section>

        <Section
          id="empty"
          title="Empty states"
          note="The first thing most people see. One headline, one line, one action."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel padding="none" className="rounded-soft">
              <EmptyState
                title="Nobody here yet"
                description="KITH is better with your people in it. Send someone an invitation and the room fills up."
                action={
                  <Button variant="primary" icon="plus">
                    Invite someone
                  </Button>
                }
              />
            </Panel>

            <Panel padding="none" className="rounded-soft">
              <EmptyState
                figure={null}
                title="No calls yet"
                description="When you call someone, it will show up here with who, when and how long."
              />
            </Panel>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-b border-line py-14 last:border-b-0">
      <div className="mb-8 flex flex-col gap-2">
        <h2 className="display text-d-xs text-fg-loud">{title}</h2>
        <p className="max-w-[56ch] text-sm text-fg-dim">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
      <span className="label w-32 shrink-0 pt-2 text-fg-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
