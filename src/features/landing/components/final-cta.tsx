import { PresenceEmber } from "@/components/ui/presence-ember";
import { AuthCta } from "@/features/landing/components/auth-cta";
import { Reveal } from "@/features/landing/components/reveal";
import { FINAL_CTA, FOOTER, NAV_LINKS } from "@/features/landing/copy";
import { KithMark } from "@/components/ui/icon";

/**
 * Composes `Reveal` and `AuthCta`, both client components. This one is markup,
 * so it renders on the server.
 *
 * The close.
 *
 * The only centred composition on the page — which is exactly why it lands.
 * Everything above it is left-aligned and off-axis, so a single centred moment
 * at the end reads as arrival rather than as the default.
 *
 * No gradient panel, no boxed card. Just the room lighting, six lights, one
 * sentence in Fraunces and the action.
 */
export function FinalCta() {
  return (
    <section className="border-t border-line px-6 py-28 sm:px-10 sm:py-36 lg:px-16">
      <Reveal className="mx-auto flex max-w-2xl flex-col items-center gap-7 text-center">
        <div aria-hidden="true" className="flex items-center gap-2.5">
          <PresenceEmber state="lit" size="lg" />
          <PresenceEmber state="lit" size="lg" />
          <PresenceEmber state="lit" size="lg" />
          <PresenceEmber state="cooling" size="lg" />
          <PresenceEmber state="lit" size="lg" />
          <PresenceEmber state="lit" size="lg" />
        </div>

        <h2 className="display-wonk text-[clamp(2.5rem,7vw,5rem)] text-fg-loud">
          {FINAL_CTA.title}
        </h2>

        <p className="max-w-[46ch] text-md leading-body text-fg-dim">{FINAL_CTA.lead}</p>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <AuthCta intent="request-invite" variant="primary" size="lg" trailingIcon="arrowRight">
            {FINAL_CTA.primaryCta}
          </AuthCta>
          <AuthCta intent="sign-in" variant="ghost" size="lg">
            {FINAL_CTA.secondaryCta}
          </AuthCta>
        </div>
      </Reveal>
    </section>
  );
}

/**
 * Footer.
 *
 * Every link here goes somewhere real — they are the page's own sections. A
 * footer full of dead links to pages that do not exist is the fastest way to
 * make a finished-looking product feel like a template.
 */
export function LandingFooter() {
  return (
    <footer className="border-t border-line px-6 py-12 sm:px-10 lg:px-16">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <KithMark size={16} className="text-ember" />
            <span className="display-wonk text-md text-fg-loud">KITH</span>
          </div>
          <p className="display text-sm text-fg-dim">{FOOTER.tagline}</p>
          <p className="text-2xs text-fg-faint">{FOOTER.note}</p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="link-grow text-sm text-fg-dim">
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
