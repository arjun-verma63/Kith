import type { Metadata } from "next";

import { FriendsBoard } from "@/features/friends/components/friends-board";
import {
  listFriends,
  listIncomingRequests,
  listOutgoingRequests,
} from "@/features/friends/queries";

export const metadata: Metadata = { title: "Friends" };
export const dynamic = "force-dynamic";

export default async function FriendsPage() {
  // Fetched in parallel. Awaiting them in sequence would make the page wait for
  // three round trips that have nothing to say to each other.
  const [friends, incoming, outgoing] = await Promise.all([
    listFriends(),
    listIncomingRequests(),
    listOutgoingRequests(),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14 sm:px-10">
      <div className="mb-10 flex flex-col gap-2">
        <span className="label text-fg-faint">Your people</span>
        <h1 className="display text-d-xs text-fg-loud">Friends</h1>
      </div>

      <FriendsBoard friends={friends} incoming={incoming} outgoing={outgoing} />
    </div>
  );
}
