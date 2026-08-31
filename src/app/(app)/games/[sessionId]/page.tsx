import { notFound, redirect } from "next/navigation";

import { GameSessionView } from "@/features/games/components/game-session-view";
import { getGameSession } from "@/features/games/queries";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * One game session.
 *
 * Server-rendered so the lobby and the board are right on first paint, then kept
 * live over the socket. `get_game_session` applies Row Level Security: somebody
 * who cannot see the room gets nothing, and a spectator gets everything except
 * the state.
 */
export const dynamic = "force-dynamic";

export default async function GameSessionPage({ params }: PageProps<"/games/[sessionId]">) {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const session = await getGameSession(sessionId);
  if (!session) notFound();

  return <GameSessionView initial={session} userId={user.id} />;
}
