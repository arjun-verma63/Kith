import { Reveal, Section, SectionHeader } from "@/features/landing/components/reveal";
import { FEATURES } from "@/features/landing/copy";

/**
 * Composes `Reveal`, which is the client component. This one is markup and
 * copy, so it renders on the server and only the wrapper ships.
 *
 * Features, as an editorial list rather than a card grid.
 *
 * Three equal cards in a row is the single most over-used layout on the web and
 * it flattens everything into the same weight. A numbered list with a hairline
 * between each row reads like a contents page: it has hierarchy, it scales to
 * any number of items, and it lets the type do the work.
 *
 * Hover lights the leading edge — the same "this one" language as the
 * navigation and the toasts, so the page teaches you one vocabulary.
 */
export function FeaturesSection() {
  return (
    <Section id="features">
      <SectionHeader
        index={FEATURES.index}
        eyebrow={FEATURES.eyebrow}
        title={FEATURES.title}
        lead={FEATURES.lead}
      />

      <ul className="mt-14 flex flex-col">
        {FEATURES.items.map((item, index) => (
          <Reveal key={item.number} delay={index * 0.05}>
            <li className="row-lit grid grid-cols-12 gap-x-6 gap-y-3 border-t border-line py-8 pl-4 sm:pl-6">
              <span className="numeric col-span-12 pt-1 text-2xs text-ember sm:col-span-2 lg:col-span-1">
                {item.number}
              </span>

              <h3 className="heading col-span-12 text-d-xs text-fg-loud sm:col-span-10 lg:col-span-4">
                {item.title}
              </h3>

              <p className="col-span-12 max-w-[54ch] leading-body text-fg-dim lg:col-span-7">
                {item.body}
              </p>
            </li>
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}
