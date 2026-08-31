/**
 * The game engine contract.
 *
 * Everything the lobby, the session screen, the move route and the database
 * already know how to do is game-agnostic: seating people, readying up,
 * starting, taking turns, scoring, declaring a winner, offering a rematch. A new
 * game should have to supply only the part that is actually about that game.
 *
 * That part is this interface. Implement it, register it, and the whole surface
 * works — no route, no table, no lobby code.
 *
 * ── The rules that make it safe ──────────────────────────────────────────────
 *
 * 1. AN ENGINE IS PURE. `reduce` is a function of (state, move, context) with no
 *    clock, no randomness, no network and no storage. Everything variable is
 *    passed in: `seed` for shuffling, `now` for timing. That is what makes a
 *    session replayable from its move log, and what makes every rule testable
 *    without a database.
 *
 * 2. AN ENGINE NEVER RUNS IN A BROWSER. It is loaded by the server action that
 *    validates moves. A client that could run `reduce` could also run it on a
 *    state of its choosing, and hidden information would have to be shipped to
 *    everybody in order to be checkable — which is the same as not hiding it.
 *
 * 3. AN ENGINE OWNS WHAT IS SECRET. `viewFor` decides what each player may see;
 *    `publicView` decides what a spectator sees. The transport uses those to
 *    split one state into a public broadcast and per-player private ones. An
 *    engine that returns the whole state from `publicView` has published its own
 *    hidden information, and no amount of care elsewhere will fix that.
 *
 * ── What the database enforces regardless ────────────────────────────────────
 *
 * A buggy or hostile engine still cannot let somebody move out of turn, move in
 * a game they are not in, move in a finished game, or overwrite a state that has
 * moved on. Those are checked in `commit_game_move`, which does not know what
 * game it is. See migration 0017.
 */

/** Move rejected. `reason` is shown to the player who tried it. */
export interface MoveRejected {
  ok: false;
  reason: string;
}

export interface MoveAccepted<TState> {
  ok: true;
  state: TState;
  /**
   * Whose turn is next, or null for a game where everybody acts at once.
   *
   * Written to a column and enforced by the database on the NEXT move, so this
   * is not advisory — an engine that returns the wrong seat locks the game, and
   * an engine that returns null has opted every player into acting whenever.
   */
  turnSeat: number | null;
  /** Set when the game is over. The session is closed and scores are final. */
  outcome?: GameOutcome;
}

export type MoveResult<TState> = MoveAccepted<TState> | MoveRejected;

export interface GameOutcome {
  /** Seat to final score. Written to `game_players.score`. */
  scores: Record<number, number>;
  /**
   * Seat to placement, 1 for first. Ties share a placement.
   * Omitted seats are recorded as unplaced, which is what leaving mid-game is.
   */
  placements: Record<number, number>;
  /** Empty for a draw, several for a shared win. */
  winnerSeats: number[];
}

export interface PlayerSeat {
  seat: number;
  userId: string;
  displayName: string;
}

export interface SetupContext {
  players: PlayerSeat[];
  /**
   * Deterministic randomness. Stored on the session, so the same seed and the
   * same moves reproduce the same game exactly — which is what makes a bug
   * report reproducible instead of a story about a shuffle.
   */
  seed: number;
  config: Record<string, unknown>;
  now: number;
}

export interface MoveContext {
  /** The seat that submitted the move. Already verified by the database. */
  seat: number;
  players: PlayerSeat[];
  seed: number;
  config: Record<string, unknown>;
  now: number;
}

/**
 * One game.
 *
 * `TState` is whatever that game needs, as long as it survives `JSON.stringify`
 * — it is stored as `jsonb` and broadcast over a socket. `TMove` is likewise
 * whatever a turn is, and arrives from a browser, so `validateMove` is the
 * boundary where it stops being untrusted.
 */
export interface GameEngine<TState = unknown, TMove = unknown> {
  /** Must match a row in the `games` catalogue. */
  key: string;

  /** The opening position. Called once, when the host starts the game. */
  createInitialState(context: SetupContext): TState;

  /** Whose turn it is at the start, or null for a realtime game. */
  initialTurnSeat(state: TState, context: SetupContext): number | null;

  /**
   * Narrows an untrusted payload from a browser into a move, or returns null.
   *
   * Separate from `reduce` on purpose: `reduce` may then be written against a
   * real type instead of `unknown`, and every game gets one obvious place where
   * input stops being arbitrary JSON.
   */
  validateMove(payload: unknown): TMove | null;

  /** Apply a move, or explain why not. Pure. */
  reduce(state: TState, move: TMove, context: MoveContext): MoveResult<TState>;

  /**
   * What a spectator sees.
   *
   * Broadcast to `game:{id}`, which everybody who can see the room receives. If
   * this returns hidden information, that information is no longer hidden.
   */
  publicView(state: TState): unknown;

  /**
   * What one player sees.
   *
   * Sent down that player's own `user:{id}` channel, which nobody else can read.
   * A game with no secrets can return `publicView(state)` and be done.
   */
  viewFor(state: TState, seat: number): unknown;

  /** Live scores, for the scoreboard during play. Seat to score. */
  scores(state: TState): Record<number, number>;

  /**
   * A short line describing where the game is up to, for the session header.
   * Optional; the shell falls back to the status.
   */
  describe?(state: TState, context: { players: PlayerSeat[] }): string;
}
