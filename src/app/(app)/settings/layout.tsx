import { SettingsNav } from "@/components/layout/settings-nav";

/**
 * The settings shell.
 *
 * A rail and a column from `lg` up; stacked below it, with the section list as a
 * scrolling strip. The content column is capped at `max-w-2xl` rather than
 * filling the space — a form field 900px wide is harder to read than one at 640,
 * and settings is nearly all form fields.
 *
 * The grid uses a fixed rail width rather than a fraction so the content does
 * not shift as section names change length.
 */
export const dynamic = "force-dynamic";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10 sm:py-14">
      <header className="mb-6 flex flex-col gap-2 lg:mb-10">
        <span className="label text-fg-faint">Settings</span>
        <h1 className="display text-d-xs text-fg-loud">Your KITH</h1>
      </header>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
        <SettingsNav />
        <div className="max-w-2xl min-w-0">{children}</div>
      </div>
    </div>
  );
}
