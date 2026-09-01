import Link from "next/link";

import { Icon } from "@/components/ui/icon";

/**
 * The only trace couple mode leaves anywhere else in KITH.
 *
 * One line in the profile's list of facts, in the same shape as "in the room
 * since" — no heart, no banner, no colour beyond the icon. It appears only when
 * the couple chose `friends` visibility and the viewer is one of those friends,
 * so for the default configuration it never appears at all.
 *
 * The temptation is to make this bigger. Resisting it is the feature.
 */
export function CoupleMarker({
  partnerUsername,
  partnerDisplayName,
  isOwn,
}: {
  partnerUsername: string;
  partnerDisplayName: string;
  isOwn: boolean;
}) {
  return (
    <div className="flex items-baseline gap-4 border-b border-line py-4 last:border-b-0">
      <dt className="flex w-40 shrink-0 items-center gap-2 text-sm text-fg-faint">
        <Icon name="couple" size={14} className="text-plum" />
        {isOwn ? "Paired with" : "Paired with"}
      </dt>
      <dd className="text-sm text-fg">
        <Link
          href={`/u/${partnerUsername}`}
          className="control-focus link-grow rounded-edge text-fg-loud"
        >
          {partnerDisplayName}
        </Link>
      </dd>
    </div>
  );
}
