# KITH — Visual language and motion system

The token values live in `src/styles/tokens.css`. This document holds the parts a
stylesheet cannot: the idea, the rules, and the reasons.

---

## The organizing idea

> ### THE LIT ROOM
>
> A warm, dark interior where **light means presence**.

KITH is a room you walk into after dark. It is warm, built from real materials, and the
people in it are visible because they are _lit_. When someone comes online their light
comes up; when they drift away it cools; when they are in a call the room dims around
them. Presence — the feature at the centre of the product — is the visual mechanic of
the entire interface.

Three things follow for free:

1. **An anti-cliché position by construction.** Warm umber and ink pigments instead of
   the purple/blue SaaS gradient. Light modelling instead of glassmorphism. Illumination
   instead of drop shadows.
2. **A motion principle that is not decoration.** State change is expressed as a change
   in light before a change in position — which is also the cheapest thing to animate.
   Beauty and performance point the same way.
3. **Accessible semantics.** Lit / cooling / dark is a three-state system with luminance
   separation and a shape difference, so it survives colour blindness, greyscale and
   forced-colors. A green dot does not.

Two modes: **Dusk** (default) and **Daylight**. Not "dark mode" and "light mode" —
Daylight is re-authored, not inverted.

---

## Typography

| Role      | Face                                          | Why                                                                                                 |
| --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Display   | **Fraunces** (`opsz`, `wght`, `SOFT`, `WONK`) | A warm editorial serif with two personality axes. The strongest anti-generic decision in the system |
| Interface | **Manrope** _(stand-in for General Sans)_     | Humanist geometric, strong at 13–16px, not Inter                                                    |
| Numeric   | **Martian Mono**                              | Call duration, scores, countdowns. Tabular and slightly technical                                   |

Two scales, deliberately far apart — interface 11→20px, display 28→160px. **Nothing
lives between 20 and 28.** That void is what makes a headline land.

`.display-wonk` turns on the Fraunces personality axes and is reserved for the wordmark
and hero moments. Used everywhere, it stops meaning anything.

All-caps only at 11px with `+0.12em` tracking, via `.label`.

---

## Radius, elevation, texture

**Radius carries meaning.** Near-square (`--r-edge`, 2px) reads architectural — the room
itself: panels, inputs, the nav rail. Rounded (`--r-soft`, 10px) reads interactive —
things you touch. `--r-full` is avatars and pills only. Message bubbles use an
asymmetric radius that points at who said it. Uniform 12px on everything is the loudest
generated-UI tell.

**Elevation is light, not shadow.** A raised surface is one step lighter, plus a 1px
hairline catching light, plus a tight occlusion at the base. No diffuse grey blur stacks.
Exactly one glow token exists and it is reserved for genuinely lit states.

**Texture.** A static film grain at ~3.5% on one composited layer. Enough to read as a
material rather than a render; cheap enough to cost nothing. No `mix-blend-mode` —
blending a viewport-sized layer forces the whole page to composite.

---

## Motion

### Principles

1. **Light before movement.** Prefer a change in illumination to a change in position.
2. **Weight and settle.** Everything has mass. No cartoon bounce outside Games.
3. **Origin-anchored.** Things animate _from where they came from_ — menus from their
   trigger, sheets from their edge, a message from the composer. Nothing fades up 20px
   from nowhere. That generic scroll-fade is the most recognisable AI-slop signature and
   it is banned.
4. **One protagonist.** Per transition exactly one element moves; the rest support with
   opacity.
5. **Duration is a promise.** 80ms = heard you. 240ms = something changed. 620ms = you
   moved somewhere.

### Technology allocation

| Layer                           | Owns                                                                                                            | The test                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **CSS**                         | Hover, focus, press, disabled, skeletons, the ember pulse, colour/opacity                                       | One property, one element, responding to a pseudo-class                           |
| **Framer Motion**               | Enter/exit (`AnimatePresence`), dialogs, sheets, menus, toasts, tab indicators (`layoutId`), list reorder, drag | React decides whether it exists → Framer animates it                              |
| **GSAP** (+ScrollTrigger, Flip) | Landing hero, scroll narrative, call-connect sequence, game countdown and victory, cross-DOM-tree FLIP          | A multi-element timeline with sequencing, scrubbing, or travel across React trees |

Hard boundary: **GSAP never animates a button hover. Framer never does what CSS does.**

None of these libraries are installed yet. They arrive with the surfaces that need them,
scoped by route group — the marketing shell may carry GSAP/ScrollTrigger/Lenis/R3F; the
app shell ships Framer + CSS only, with GSAP core dynamically imported into the three
surfaces that genuinely need timelines.

### Reduced motion — three tiers, not a boolean

| Tier      | Trigger                              | Behaviour                                                                |
| --------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `full`    | default                              | Everything                                                               |
| `reduced` | `prefers-reduced-motion: reduce`     | No transform >8px, no parallax, no scroll-scrub. Opacity and colour only |
| `off`     | user setting (Settings → Appearance) | Instant                                                                  |

`data-motion` on `<html>` is the single source of truth so CSS and JS can never disagree.
**No state is ever communicated by motion alone.**

---

## Smooth scroll

Lenis on **marketing routes only**. Not in the app shell. Scroll hijacking breaks scroll
anchoring (new messages would jump the viewport), `scrollIntoView`, keyboard paging and
mobile momentum. Hijacked scroll in a chat app _is_ the polish failure. Not initialised
at all under reduced motion; `syncTouch` off so mobile keeps native momentum.

---

## Three.js

Three placements, total.

1. **Landing hero — "The Constellation Room."** A loose volumetric point-field reading as
   the wireframe of a room, with six warm light nodes drifting inside and faint filaments
   connecting them on cursor movement. The product's thesis, rendered. Not a sphere.
2. **Physical game pieces**, only where simulation is the mechanic.
3. Nothing else. No WebGL in chat, calls, settings, or behind any section.

Constraints: dynamic import with `ssr: false`, static poster painted first, never blocks
LCP, DPR capped at 1.5, rAF paused on tab-hide and off-screen, hard-disabled on low-end
devices and under reduced motion, ≤120KB gzipped.

---

## React Bits

A reference source, not a dependency. Anything adopted is copied into `components/ui/`,
stripped of its styling and rebuilt on KITH tokens. A pasted-in showcase component is
exactly what makes a UI look assembled rather than designed. If it cannot be made to look
like it was always ours, we do not take it.

---

## Layout

**No repeating card grids.** The default composition is a 12-column grid with the first
two columns held empty as an optical gutter, so the page has an axis. Selected elements
break full-bleed to escape it.

The app shell is **not** three columns:

- **Rail** — an architectural column. Wordmark at top, the seven destinations in the
  middle, and _your people as presence embers pinned at the bottom, permanently_. They
  are always in the room with you. That single decision does more for "private clubhouse"
  than any styling, and it is only possible because the user count is six.
- **Stage** — one thing at a time, editorially composed.
- **Context slot** — appears only for a live call, a game panel or a profile peek, then
  leaves. Not a permanent member list.

Mobile is re-authored, not scaled: rail becomes a bottom bar of five, people move to a
horizontal presence strip on Home, the context slot becomes a dismissible sheet.

---

## Surface direction

| Surface      | The idea                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entering** | The lights come up. One 620ms beat, once per session                                                                                                                |
| **Home**     | An editorial "tonight" page in large display type, not a feed or a card grid                                                                                        |
| **Friends**  | A light board of portrait tiles ordered by warmth. Requests slide in as a slip from the rail                                                                        |
| **Messages** | The composer is a lit surface; the sent message physically originates from it. Asymmetric bubble radii. Typing = their ember warming                                |
| **Calls**    | The room dims, the rail recedes. Speaker tile large and **off-centre** — never a symmetric grid. Active speaker shown by light on the tile edge, not a green border |
| **Games**    | Where playfulness is licensed: `--e-play` unlocked, mono numerals go huge, `--ice` enters the palette                                                               |
| **Couple**   | Differentiated by **material, not motif**: accent swaps to `--plum`, ground warms half a step, leading widens, durations ×1.15. No hearts. No pink                  |

---

## Feedback inventory

Every important state has a designed response. If a state is not in this table it is not
designed yet.

| State                | Feedback                                                                        | Tech            |
| -------------------- | ------------------------------------------------------------------------------- | --------------- |
| Button hover / press | Surface lifts one step / scale 0.97 at 80ms                                     | CSS             |
| Focus                | 2px ember ring, 2px offset                                                      | CSS             |
| Message sent         | Bubble travels from the composer, moss tick settles                             | GSAP Flip       |
| Message failed       | Single 6px shudder, signal hairline, inline retry                               | Framer          |
| Request sent         | Button collapses into a pending pill in place                                   | Framer `layout` |
| Request accepted     | Their ember ignites in the rail. The reward is _presence_                       | GSAP + CSS      |
| Incoming call        | Full-screen takeover, the caller's ember floods the room                        | GSAP            |
| Call connected       | Ring collapses, tile wakes, mono duration starts                                | GSAP            |
| Joining game         | Avatar Flips from the rail into its seat                                        | GSAP Flip       |
| Countdown / victory  | Full-bleed numerals; colour flood and display type slam                         | GSAP            |
| Notification         | Slides from its rail origin, auto-dismiss with a progress hairline              | Framer          |
| Loading              | Ember-tinted skeletons matching real content geometry. No spinners in the shell | CSS             |
| Empty                | Designed compositions with real display type and one action                     | Static          |

---

## Performance budgets

- LCP < 1.8s landing, < 1.2s in-app · INP < 200ms · CLS < 0.05
- App-shell JS ≤ 180KB gzipped; marketing route ≤ 320KB including the lazy hero
- Animate `transform` and `opacity`. **No animated `blur()` above icon size**
- `will-change` applied on interaction start and removed on completion
- Long lists virtualised; `content-visibility: auto` off-screen
- 60fps verified on a mid-range Android, not only on a laptop

---

## Accessibility

- 4.5:1 for all body copy in both modes, verified per token pair. Tokens marked "3:1
  only" in `tokens.css` are for hairlines, disabled states and large display type.
- Presence never relies on colour or glow alone — fill/ring shape plus a text label.
- Focus is visible and designed everywhere. Full keyboard paths through calls and games,
  including answer, decline, mute and leave.
- Dialogs trap and restore focus. Live regions announce incoming messages and calls.
- `forced-colors` supported: texture and glow drop out, structure survives.
- Touch targets ≥44px; call controls ≥56px.

---

## The component library

Built in `src/components/ui/` and `src/components/layout/`. Every value comes from a
token; there is not one literal colour, size, radius or duration below the token layer.

| Component                      | The decision worth knowing                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Icon`, `KithMark`             | Drawn, not installed. 24px box, 1.5px stroke, one hand. Home is a room, Games is a die, Couple is two rings, Settings is sliders                                                                   |
| `Button`                       | 5 variants, 3 sizes, icon-only, loading. `primary` carries a 1px inset top highlight — a lit key, not a coloured rectangle. Label keeps its width while loading                                    |
| `Input`, `Textarea`            | A _sunken_ surface: the one place light goes away from you. Focus is an ember hairline plus halo, never blue                                                                                       |
| `Field`                        | Generates the ids and hands back `id` / `aria-describedby` / `aria-invalid` through a render prop, so a control cannot end up unlabelled. Error replaces the hint rather than stacking under it    |
| `Panel`, `Card`                | Near-square panels are the default; the soft-radius `Card` is the exception you justify. `panel-raised` gets a hairline of light along its top edge                                                |
| `Avatar`, `AvatarStack`        | The presence light sits in a **notch cut out of the portrait**, not a dot pasted on the corner. Fallback tints hash deterministically from the person's id, drawn from the palette                 |
| `PresenceEmber`                | lit / cooling / dark, carried by fill-and-ring _shape_ as well as colour, with a text label                                                                                                        |
| `Badge`, `CountBadge`          | Words are tinted (wash + hairline + tone text). Numbers are filled, mono and tabular so a count does not jump width from 9 to 10                                                                   |
| `NavItem`, `NavRail`, `NavBar` | Active is a **bar of light on the leading edge**, never a filled pill. Your people are pinned to the bottom of the rail permanently. Unbuilt destinations render as pending, not as links that 404 |
| `Dialog`                       | Native `<dialog>` + `showModal()`                                                                                                                                                                  |
| `Menu`                         | Origin-anchored, full keyboard support, stays mounted and toggles `display`                                                                                                                        |
| `ToastProvider` / `useToast`   | Arrives from its own edge; draining hairline instead of a countdown; anything with an action never auto-dismisses                                                                                  |
| `Skeleton`, `Pulse`            | Skeletons match the geometry of what is coming. `Pulse` is the only "working" indicator in the system                                                                                              |
| `EmptyState`                   | A drawn figure in the system's own language, a Fraunces headline, one line, exactly one action                                                                                                     |

### Why no animation library yet

The motion allocation above still stands, but the overlay primitives did not need
Framer Motion to reach it, so it is not installed.

`Dialog` is a native `<dialog>`. `showModal()` supplies focus containment (including
from the browser chrome), `inert` on everything behind, Escape, and the top layer —
correctness we would otherwise be hand-writing and keeping correct forever. Enter _and_
exit animate in pure CSS via `@starting-style` and `transition-behavior: allow-discrete`,
which is precisely the gap that used to force a library. `Menu` uses the same technique
by staying mounted and toggling `display`.

Framer Motion arrives when there is something CSS genuinely cannot do — shared-element
`layoutId` transitions, list reorder, drag — which is the app shell, not the primitives.
Installing it now would have bought nothing and cost every user the bytes.

The one honest limitation: `Menu` positions with plain absolute layout inside a relative
wrapper. That is correct for triggers in headers, toolbars and rails, which is every menu
in KITH today. A menu that must escape a scroll container is the point to reach for CSS
anchor positioning — not before.

### Verifying it

`/styleguide` renders every component, state and token on one page, in both modes. It is
a development tool and returns 404 in production. Regressions in a design system are
invisible until two things that should match are seen side by side.

---

## The anti-slop checklist

Run this before merging any component. Any _yes_ is a redesign, not a tweak.

- [ ] Is it a centred heading over a three-column card grid?
- [ ] Rounded 12px card with a soft grey shadow on a gradient background?
- [ ] Does anything fade-up-20px on scroll?
- [ ] Purple/blue gradient, floating blob, or glowing orb anywhere?
- [ ] Is a headline set in the UI font instead of Fraunces?
- [ ] Is there an animation nobody would miss if it were removed?
- [ ] Are all four corners the same radius when they should not be?
- [ ] Is a green dot doing presence?
- [ ] Is the empty state a grey box with a shrug?
- [ ] Could this have come out of "build me a modern SaaS landing page"?
