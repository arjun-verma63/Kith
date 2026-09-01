import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import type { FiledReport } from "@/features/safety/queries";
import { REASON_LABELS } from "@/features/safety/reasons";

/**
 * Reports you have filed.
 *
 * Server-rendered and read-only, because there is nothing to do to a report once
 * it exists: `reports` has no UPDATE or DELETE policy at all. A report the
 * reporter can withdraw is a report somebody can be pressured into withdrawing.
 *
 * The status is shown because "did that go anywhere" is the question this list
 * answers, and it will say **Open** for every row until there is an admin
 * dashboard to move it — which is honest rather than encouraging.
 */

const STATUS: Record<FiledReport["status"], { label: string; tone: BadgeTone }> = {
  open: { label: "Open", tone: "neutral" },
  reviewing: { label: "Being looked at", tone: "lantern" },
  actioned: { label: "Actioned", tone: "moss" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export function ReportHistory({ reports }: { reports: FiledReport[] }) {
  if (reports.length === 0) return null;

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Reports you have sent</span>
      </header>

      <ul className="flex flex-col">
        {reports.map((report) => {
          const status = STATUS[report.status];
          const label =
            REASON_LABELS.find((option) => option.key === report.reason)?.label ?? report.reason;

          return (
            <li
              key={report.id}
              className="flex items-baseline gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="text-sm text-fg">{label}</span>
                {report.detail ? (
                  <span className="mt-0.5 block truncate text-2xs text-fg-faint">
                    {report.detail}
                  </span>
                ) : null}
              </span>

              <Badge tone={status.tone}>{status.label}</Badge>

              <time
                dateTime={report.createdAt}
                className="numeric shrink-0 text-2xs text-fg-faint tabular-nums"
              >
                {new Date(report.createdAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                })}
              </time>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
