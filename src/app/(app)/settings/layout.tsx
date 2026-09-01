import { SettingsNav } from "@/components/layout/settings-nav";

/**
 * The settings shell.
 *
 * Two sections so far — who you are, and how you get in. They are genuinely
 * different jobs and were always going to separate; `/settings/profile` was
 * simply the only one that existed until two-factor landed.
 */
export const dynamic = "force-dynamic";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-14 sm:px-10">
      <div className="mb-8 flex flex-col gap-2">
        <span className="label text-fg-faint">Settings</span>
      </div>

      <SettingsNav />

      <div className="mt-8">{children}</div>
    </div>
  );
}
