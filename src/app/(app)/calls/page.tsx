import { CallHistory } from "@/features/calls/components/call-history";
import { listCallHistory } from "@/features/calls/queries";

/**
 * The call log.
 *
 * Server-rendered so the first page is correct on first paint; everything older
 * is fetched on demand. `list_calls` filters by `auth.uid()` inside the database,
 * so there is no ownership check in this file and there must not be one.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Calls",
};

export default async function CallsPage() {
  const calls = await listCallHistory();

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:px-10">
      <header className="mb-2 flex flex-col gap-1">
        <h1 className="heading text-d-xs text-fg-loud">Calls</h1>
        <p className="text-sm text-fg-dim">Everyone you have spoken to, and everyone you missed.</p>
      </header>

      <CallHistory initial={calls} />
    </div>
  );
}
