import { notFound } from "next/navigation";

import { StyleguideClient } from "@/app/styleguide/styleguide-client";

/**
 * The design system, on one page.
 *
 * A development tool, not an application page — it is 404 in production. Its
 * job is to make the system reviewable in one scroll: every token, every
 * component, every state, in both modes. Regressions in a design system are
 * invisible until you see two things side by side that should match and do not.
 */
export const metadata = { title: "Styleguide", robots: { index: false, follow: false } };

export default function StyleguidePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <StyleguideClient />;
}
