import { notFound, redirect } from "next/navigation";

import { GameSessionView } from "@/features/games/components/game-session-view";
import { viewsForRender } from "@/features/games/engine/runtime";
import { getGameSession } from "@/features/games/queries";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * One game session.
 *
 * Server-rendered so the lobby and the board are right on first paint, then kept
 * live over the socket.
 *
 * Two reads, in this order and for a reason. `get_game_session` runs as the
 * person asking, so Row Level Security decides whether they may see the session
 * at all. Only once it says yes does the engine run — and the engine reads with
 * the service role, which no policy constrains.
 *
 * The engine is also the only thing that can redact: it returns the public view
 * and, for somebody seated, their own private one. The raw state never travels
 * this path.
 */
export const dynamic = "force-dynamic";

export default async function GameSessionPage({ params }: PageProps<"/games/[sessionId]">) {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const session = await getGameSession(sessionId);
  if (!session) notFound();

  // Visibility is decided above, by the caller's own client. Only then does the
  // engine run — it reads with the service role, so it must never be reached by
  // somebody the database would have turned away.
  const views = await viewsForRender(sessionId, user.id);

  return <GameSessionView initial={session} initialViews={views} userId={user.id} />;
}
