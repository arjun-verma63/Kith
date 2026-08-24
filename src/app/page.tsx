import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PresenceEmber, type PresenceState } from "@/components/ui/presence-ember";
import { APP } from "@/lib/constants";

/* Ambient brand motif, not data. Hidden from assistive technology so it never
   claims that six specific people are online. */
const AMBIENT_LIGHTS: PresenceState[] = ["lit", "lit", "cooling", "lit", "dark", "dark"];

export default function LandingPage() {
  return (
    <main className="flex min-h-dvh flex-col justify-between px-6 py-8 sm:px-12 sm:py-12 lg:px-16">
      <header className="flex items-center justify-between">
        <span className="label text-fg-dim">Private &middot; Invitation only</span>
        <ThemeToggle />
      </header>

      <div className="grid grid-cols-12 py-24">
        {/* Off-axis: content starts at column 3 on wide viewports so the page has an
            optical spine instead of being centred inside a box. */}
        <div className="col-span-12 lg:col-span-9 lg:col-start-3">
          <div aria-hidden="true" className="mb-8 flex items-center gap-2">
            {AMBIENT_LIGHTS.map((state, index) => (
              <PresenceEmber key={index} state={state} size="lg" />
            ))}
          </div>

          <h1 className="display-wonk text-[clamp(4.5rem,17vw,10rem)] text-fg-loud">{APP.name}</h1>

          <p className="display mt-6 max-w-[18ch] text-d-xs text-ember sm:text-d-sm">
            {APP.tagline}
          </p>

          <p className="mt-8 max-w-[46ch] text-md leading-body text-fg-dim">
            Six people, one room. Messages that stay between you, calls that connect without a
            middleman, and games worth staying up for. No feed, no algorithm, no strangers.
          </p>
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-line pt-6">
        <span className="label text-fg-faint">{APP.name}</span>
        <span className="label text-fg-faint">Foundation</span>
      </footer>
    </main>
  );
}
