import { Icon } from "@/components/ui/icon";
import { Reveal, Section, SectionHeader } from "@/features/landing/components/reveal";
import { PRIVACY } from "@/features/landing/copy";

/**
 * Composes `Reveal`, which is the client component. This one is markup and
 * copy, so it renders on the server and only the wrapper ships.
 *
 * Privacy.
 *
 * Laid out as a specification, not as three padlock icons with adjectives under
 * them. Mono labels, hairlines, plain statements of what the system actually
 * does — the format signals "this is a fact you can check" rather than "this is
 * a feeling we would like you to have".
 *
 * The last block is the important one. It states plainly what KITH does *not*
 * do, because messages are not end-to-end encrypted and saying so is both true
 * and more persuasive than any claim we could make instead. A privacy section
 * that only lists strengths is the one nobody should believe.
 */
export function PrivacySection() {
  return (
    <Section id="privacy">
      <SectionHeader
        index={PRIVACY.index}
        eyebrow={PRIVACY.eyebrow}
        title={PRIVACY.title}
        lead={PRIVACY.lead}
      />

      <dl className="mt-14 flex flex-col">
        {PRIVACY.specs.map((spec, index) => (
          <Reveal key={spec.label} delay={index * 0.04}>
            <div className="row-lit grid grid-cols-12 gap-x-6 gap-y-2 border-t border-line py-6 pl-4 sm:pl-6">
              <dt className="col-span-12 lg:col-span-4">
                <span className="label text-fg-loud">{spec.label}</span>
              </dt>
              <dd className="col-span-12 max-w-[58ch] text-sm leading-body text-fg-dim lg:col-span-8">
                {spec.body}
              </dd>
            </div>
          </Reveal>
        ))}
      </dl>

      <Reveal delay={0.16}>
        <div className="panel mt-10 rounded-soft border-dashed p-6">
          <div className="flex items-center gap-2 pb-3">
            <Icon name="info" size={15} className="text-lantern" />
            <span className="label text-lantern">{PRIVACY.honest.label}</span>
          </div>
          <p className="max-w-[66ch] text-sm leading-body text-fg-dim">{PRIVACY.honest.body}</p>
        </div>
      </Reveal>
    </Section>
  );
}
