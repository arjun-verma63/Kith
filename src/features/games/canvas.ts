/**
 * The canvas wire protocol.
 *
 * ── Why drawing does not go through the move pipeline ────────────────────────
 *
 * Every other action in KITH's games is a move: validated by an engine, written
 * to `game_sessions.state`, appended to `game_moves`, version-bumped, broadcast.
 * That is right for a guess, which happens a few times a round and decides who
 * scores.
 *
 * It would be catastrophic for a drawing. A hand moving across a canvas produces
 * dozens of points a second. Through that pipeline each one would be a row in an
 * append-only log, a rewrite of the whole state blob, and a version bump racing
 * every other player — for data that is worthless the moment the round ends.
 *
 * So strokes are broadcast client to client on `game:{id}` and never stored.
 * They are the same class of thing as a typing indicator or an ICE candidate:
 * transient, reconstructible, and explicitly excluded from the durability rule
 * in docs/ARCHITECTURE.md §6.
 *
 * What IS authoritative — the secret word, the guesses, who scored — goes
 * through the engine exactly like every other game.
 *
 * ── Four things that make the stream small ───────────────────────────────────
 *
 * 1. VECTORS, NOT PIXELS. Points, not image data. A stroke is a handful of
 *    numbers; a PNG of the same stroke is tens of kilobytes.
 *
 * 2. A NORMALISED INTEGER GRID. Coordinates are 0–1023 integers rather than
 *    floats in screen pixels. Two thirds smaller on the wire once serialised,
 *    and — the real reason — resolution-independent, so a phone and a laptop
 *    draw the same picture rather than one scaled wrongly.
 *
 * 3. SIMPLIFICATION. Points closer than a threshold to the last kept one are
 *    dropped. A slow, deliberate line is where the point count explodes, and it
 *    is exactly where the extra points carry no information.
 *
 * 4. BATCHING. Points accumulate and flush on a timer instead of sending one
 *    message each. The same trick trickle ICE uses, for the same reason: the
 *    free tier has a monthly message allowance and a drawing hand would eat it.
 *
 * Everything here is pure so the whole lot can be tested without a canvas.
 */

/** Coordinates live on a 0…1023 grid, whatever the canvas is actually sized. */
export const GRID = 1024;

/** How long points accumulate before being sent. Below the eye's threshold. */
export const FLUSH_MS = 60;

/**
 * Minimum movement, in grid units, before a point is worth keeping.
 *
 * Six on a 1024 grid is roughly half a percent of the canvas — well under a
 * stroke's own width, so nothing visible is lost, and it removes most of the
 * points a slow hand generates.
 */
export const MIN_DISTANCE = 6;

/** Guards against a pathological client filling the channel with one stroke. */
export const MAX_POINTS_PER_MESSAGE = 128;

export type Colour = string;

export interface StrokeStyle {
  colour: Colour;
  /** Grid units, so line weight scales with the canvas like everything else. */
  width: number;
}

/**
 * A stroke on the wire.
 *
 * `points` is a flat `[x, y, x, y, …]` array rather than `{x, y}` objects: JSON
 * for a hundred points is about a third the size, which matters when this is the
 * message being sent sixteen times a second.
 */
export interface StrokeChunk {
  /** Identifies the stroke a chunk belongs to, so chunks reassemble in order. */
  id: number;
  seq: number;
  colour: Colour;
  width: number;
  points: number[];
  /** True on the last chunk of a stroke. */
  end?: boolean;
}

export interface Stroke {
  id: number;
  colour: Colour;
  width: number;
  points: number[];
}

export type CanvasEvent =
  | { type: "chunk"; chunk: StrokeChunk }
  | { type: "clear" }
  | { type: "undo" }
  /** A late joiner asking somebody to catch them up. */
  | { type: "request" }
  | { type: "snapshot"; strokes: Stroke[] };

/* ========================================================================== */

/** Screen pixels to the shared grid. Clamped: a stray drag off-canvas is not art. */
export function toGrid(value: number, size: number): number {
  if (size <= 0) return 0;
  return Math.max(0, Math.min(GRID - 1, Math.round((value / size) * GRID)));
}

/** And back, for rendering at whatever size this browser's canvas happens to be. */
export function fromGrid(value: number, size: number): number {
  return (value / GRID) * size;
}

/** Squared distance, because comparing against a squared threshold avoids a sqrt. */
function farEnough(ax: number, ay: number, bx: number, by: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy >= MIN_DISTANCE * MIN_DISTANCE;
}

/**
 * Accumulates points and hands back batches worth sending.
 *
 * Deliberately not a React hook and not aware of a canvas: given a sequence of
 * points it produces the messages that should go on the wire, which is a thing a
 * test can check exactly.
 */
export class StrokeBuffer {
  private strokeId = 0;
  private seq = 0;
  private pending: number[] = [];
  private lastKept: [number, number] | null = null;
  private style: StrokeStyle = { colour: "#000000", width: 8 };
  private open = false;
  /**
   * Whether anything new has arrived since the last flush.
   *
   * A flush leaves the previous chunk's last point in the buffer so the next
   * chunk can join onto it. Without this flag that carried-over point looks like
   * pending work, and a hand resting still on the canvas would emit a chunk
   * containing one repeated point every 60ms — a steady stream of messages
   * saying nothing, which is precisely what this class exists to prevent.
   */
  private dirty = false;

  /** Starts a stroke. The first point is always kept. */
  begin(x: number, y: number, style: StrokeStyle): void {
    this.strokeId += 1;
    this.style = style;
    this.pending = [x, y];
    this.lastKept = [x, y];
    this.open = true;
    this.dirty = true;
  }

  /**
   * Adds a point, or discards it as too close to the last one.
   *
   * Returns whether it was kept, which is only useful to a test — the caller
   * draws locally regardless, because the person drawing should see their own
   * line at full fidelity even though the wire gets a simplified one.
   */
  extend(x: number, y: number): boolean {
    if (!this.open) return false;

    const last = this.lastKept;
    if (last && !farEnough(x, y, last[0], last[1])) return false;

    this.pending.push(x, y);
    this.lastKept = [x, y];
    this.dirty = true;
    return true;
  }

  /**
   * The chunk to send now, or null when there is nothing new.
   *
   * A chunk always repeats the last point of the previous one, so the receiver
   * can join them into a continuous line instead of drawing disconnected
   * segments with gaps at every flush boundary.
   */
  flush(): StrokeChunk | null {
    if (!this.open || !this.dirty || this.pending.length < 2) return null;

    const points = this.pending.slice(0, MAX_POINTS_PER_MESSAGE * 2);
    const tail = points.slice(-2);

    this.pending = [...tail];
    this.dirty = false;
    this.seq += 1;

    return {
      id: this.strokeId,
      seq: this.seq,
      colour: this.style.colour,
      width: this.style.width,
      points,
    };
  }

  /** Ends the stroke, returning whatever is left plus the end marker. */
  end(): StrokeChunk | null {
    if (!this.open) return null;

    // Flushed BEFORE closing, because `flush` refuses to run on a closed buffer.
    // Doing it the other way round silently drops the last segment of every
    // stroke — the drawer sees a complete line, everybody else sees one that
    // stops short, and nothing anywhere reports a problem.
    const chunk = this.flush();

    this.open = false;
    this.pending = [];
    this.lastKept = null;
    this.dirty = false;

    if (chunk) return { ...chunk, end: true };

    // Nothing left to send, but the receiver still needs to know the stroke is
    // finished so it stops joining new points onto it.
    this.seq += 1;
    return {
      id: this.strokeId,
      seq: this.seq,
      colour: this.style.colour,
      width: this.style.width,
      points: [],
      end: true,
    };
  }

  get isDrawing(): boolean {
    return this.open;
  }
}

/* ========================================================================== */

/**
 * Rebuilds a picture from chunks.
 *
 * Broadcast is not ordered end to end, so chunks can arrive out of order or not
 * at all. This joins them by stroke id and keeps them sorted by sequence, which
 * makes a late chunk land in the right place rather than drawing a line back
 * across the canvas.
 */
export class StrokeAssembler {
  private strokes = new Map<number, Stroke>();
  private seen = new Map<number, Set<number>>();
  private order: number[] = [];

  apply(chunk: StrokeChunk): void {
    // Dropping a duplicate matters: a resend would otherwise double a segment,
    // which on a thick brush is visible.
    const seenForStroke = this.seen.get(chunk.id) ?? new Set<number>();
    if (seenForStroke.has(chunk.seq)) return;
    seenForStroke.add(chunk.seq);
    this.seen.set(chunk.id, seenForStroke);

    const existing = this.strokes.get(chunk.id);

    if (!existing) {
      this.strokes.set(chunk.id, {
        id: chunk.id,
        colour: chunk.colour,
        width: chunk.width,
        points: [...chunk.points],
      });
      this.order.push(chunk.id);
      return;
    }

    // The repeated point at a chunk boundary is dropped so the line is not
    // stitched with a zero-length segment.
    const points = chunk.points;
    const overlap =
      existing.points.length >= 2 &&
      points.length >= 2 &&
      existing.points.at(-2) === points[0] &&
      existing.points.at(-1) === points[1];

    existing.points.push(...(overlap ? points.slice(2) : points));
  }

  clear(): void {
    this.strokes.clear();
    this.seen.clear();
    this.order = [];
  }

  /** Removes the most recent stroke. */
  undo(): void {
    const last = this.order.pop();
    if (last === undefined) return;
    this.strokes.delete(last);
    this.seen.delete(last);
  }

  /** Everything, in the order it was drawn. */
  snapshot(): Stroke[] {
    return this.order.flatMap((id) => {
      const stroke = this.strokes.get(id);
      return stroke ? [{ ...stroke, points: [...stroke.points] }] : [];
    });
  }

  /** Replaces everything — how a reconnecting client is caught up. */
  restore(strokes: Stroke[]): void {
    this.clear();
    for (const stroke of strokes) {
      this.strokes.set(stroke.id, { ...stroke, points: [...stroke.points] });
      this.order.push(stroke.id);
    }
  }

  get isEmpty(): boolean {
    return this.order.length === 0;
  }
}

/* ========================================================================== */

/** The palette. Small on purpose: a colour picker is a distraction at 75 seconds. */
export const PALETTE: Colour[] = [
  "#1a1a1a",
  "#e8503a",
  "#f0a020",
  "#3f9b4f",
  "#3a7fd5",
  "#8c5bd8",
  "#c0553f",
  "#f5f5f5",
];

export const BRUSH_SIZES = [4, 10, 22, 40];
