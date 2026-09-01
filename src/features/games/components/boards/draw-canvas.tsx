"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import {
  BRUSH_SIZES,
  FLUSH_MS,
  GRID,
  PALETTE,
  StrokeAssembler,
  StrokeBuffer,
  fromGrid,
  toGrid,
  type Colour,
  type Stroke,
  type StrokeChunk,
} from "@/features/games/canvas";
import { cn } from "@/lib/utils/cn";

/**
 * The canvas.
 *
 * Two jobs that have to stay separate: showing the picture, and putting it on
 * the wire. The drawer's own line is rendered from raw pointer events at full
 * fidelity — their hand should feel exact — while what gets broadcast is
 * simplified and batched. Nobody watching can tell, and the message rate drops
 * by an order of magnitude.
 *
 * ── Redrawn from strokes, never from pixels ──────────────────────────────────
 *
 * The whole picture is a list of strokes, and the canvas is repainted from it
 * whenever it changes size. That is what lets a phone and a laptop see the same
 * drawing: coordinates live on a 1024-unit grid and are scaled at paint time,
 * so there is no "correct" canvas size and no image to resample.
 */

export interface DrawCanvasProps {
  /** Only the drawer may draw. Everybody else gets the same surface, read-only. */
  canDraw: boolean;
  /** Broadcasts a canvas event to the table. Never stored. */
  send: (event: string, payload: unknown) => void;
  /** Registers the handler for inbound canvas traffic. */
  subscribe: (handler: (event: string, payload: unknown) => void) => () => void;
  /** Bumped by the board when a new round starts, to wipe the surface. */
  roundKey: number;
}

export function DrawCanvas({ canDraw, send, subscribe, roundKey }: DrawCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assembler = useRef(new StrokeAssembler());
  const buffer = useRef(new StrokeBuffer());
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [colour, setColour] = useState<Colour>(PALETTE[0]!);
  const [width, setWidth] = useState(BRUSH_SIZES[1]!);

  /* --------------------------------------------------------------- painting */

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const { width: w, height: h } = canvas;
    context.clearRect(0, 0, w, h);
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const stroke of assembler.current.snapshot()) {
      if (stroke.points.length < 2) continue;

      context.strokeStyle = stroke.colour;
      // Line weight is in grid units too, so a thick brush stays thick on a
      // small screen instead of turning into a hairline.
      context.lineWidth = Math.max(1, fromGrid(stroke.width, Math.min(w, h)));
      context.beginPath();

      context.moveTo(fromGrid(stroke.points[0]!, w), fromGrid(stroke.points[1]!, h));

      if (stroke.points.length === 2) {
        // A single tap. Without this it would draw nothing at all.
        context.lineTo(fromGrid(stroke.points[0]!, w) + 0.1, fromGrid(stroke.points[1]!, h));
      } else {
        for (let i = 2; i < stroke.points.length; i += 2) {
          context.lineTo(fromGrid(stroke.points[i]!, w), fromGrid(stroke.points[i + 1]!, h));
        }
      }

      context.stroke();
    }
  }, []);

  /*
   * Size the backing store to the element, in device pixels.
   *
   * A canvas has two sizes — its CSS box and its pixel buffer — and letting the
   * browser scale between them is what makes a drawing look soft. Repainting on
   * resize is free because the picture is strokes, not an image.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      paint();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  /* -------------------------------------------------------------- receiving */

  useEffect(() => {
    return subscribe((event, payload) => {
      switch (event) {
        case "draw.chunk":
          assembler.current.apply(payload as StrokeChunk);
          paint();
          break;
        case "draw.clear":
          assembler.current.clear();
          paint();
          break;
        case "draw.undo":
          assembler.current.undo();
          paint();
          break;
        case "draw.snapshot":
          // Somebody caught us up. Replaces rather than merges: a partial
          // picture plus a full one is a picture with doubled strokes.
          assembler.current.restore((payload as { strokes: Stroke[] }).strokes ?? []);
          paint();
          break;
        case "draw.request":
          // Only the drawer holds the whole picture, so only they answer.
          if (canDraw) {
            send("draw.snapshot", { strokes: assembler.current.snapshot() });
          }
          break;
      }
    });
  }, [subscribe, paint, canDraw, send]);

  /*
   * A new round wipes the surface.
   *
   * Local, not broadcast: everybody's round changed at the same moment, so
   * everybody clears themselves and the wire stays quiet.
   */
  useEffect(() => {
    assembler.current.clear();
    paint();
  }, [roundKey, paint]);

  /*
   * Ask to be caught up on arrival.
   *
   * A guesser who joined late, refreshed, or dropped their connection has missed
   * every stroke so far — they are broadcast and never stored, so there is
   * nothing to fetch. The drawer still has the picture, so they are asked for it.
   */
  useEffect(() => {
    if (canDraw) return;
    const timer = setTimeout(() => send("draw.request", {}), 250);
    return () => clearTimeout(timer);
  }, [canDraw, roundKey, send]);

  /* ---------------------------------------------------------------- drawing */

  const positionOf = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return [
      toGrid(event.clientX - rect.left, rect.width),
      toGrid(event.clientY - rect.top, rect.height),
    ];
  };

  /** Sends whatever has accumulated. Called on a timer, not per point. */
  const flush = useCallback(() => {
    const chunk = buffer.current.flush();
    if (!chunk) return;
    assembler.current.apply(chunk);
    send("draw.chunk", chunk);
  }, [send]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    const [x, y] = positionOf(event);
    buffer.current.begin(x, y, { colour, width });

    flushTimer.current ??= setInterval(flush, FLUSH_MS);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || !buffer.current.isDrawing) return;

    const [x, y] = positionOf(event);
    // The point is offered to the buffer, which decides whether it is far enough
    // from the last to be worth sending. Either way it is drawn locally, so the
    // person drawing sees their own line exactly.
    buffer.current.extend(x, y);
    paintLocalTip(x, y);
  };

  /**
   * Draws the segment under the pointer immediately.
   *
   * Waiting for the next flush would put up to 60ms of lag between the hand and
   * the line, which is the difference between a canvas that feels responsive and
   * one that feels broken.
   */
  const lastLocal = useRef<[number, number] | null>(null);
  const paintLocalTip = (x: number, y: number) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const previous = lastLocal.current;
    lastLocal.current = [x, y];
    if (!previous) return;

    context.strokeStyle = colour;
    context.lineWidth = Math.max(1, fromGrid(width, Math.min(canvas.width, canvas.height)));
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(fromGrid(previous[0], canvas.width), fromGrid(previous[1], canvas.height));
    context.lineTo(fromGrid(x, canvas.width), fromGrid(y, canvas.height));
    context.stroke();
  };

  const endStroke = () => {
    if (!canDraw || !buffer.current.isDrawing) return;

    const chunk = buffer.current.end();
    if (chunk) {
      assembler.current.apply(chunk);
      send("draw.chunk", chunk);
    }

    lastLocal.current = null;

    if (flushTimer.current !== null) {
      clearInterval(flushTimer.current);
      flushTimer.current = null;
    }
    // Repaint from the assembled strokes so the local preview and the shared
    // picture cannot drift apart.
    paint();
  };

  useEffect(() => {
    return () => {
      if (flushTimer.current !== null) clearInterval(flushTimer.current);
    };
  }, []);

  /* ----------------------------------------------------------------- render */

  return (
    <div className="flex flex-col gap-2">
      <div className="panel panel-sunken relative overflow-hidden rounded-soft">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          aria-label={canDraw ? "Drawing canvas" : "The drawing"}
          className={cn(
            "block aspect-[4/3] w-full touch-none bg-[#fbfaf7]",
            canDraw ? "cursor-crosshair" : "cursor-default",
          )}
        />
      </div>

      {canDraw ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                onClick={() => setColour(swatch)}
                aria-label={`Colour ${swatch}`}
                aria-pressed={colour === swatch}
                className={cn(
                  "control-focus size-6 rounded-full border transition-transform",
                  colour === swatch ? "scale-110 border-fg-loud" : "border-line hover:scale-105",
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {BRUSH_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setWidth(size)}
                aria-label={`Brush size ${size}`}
                aria-pressed={width === size}
                className={cn(
                  "control-focus grid size-7 place-items-center rounded-full border",
                  width === size ? "border-ember bg-[var(--wash-accent)]" : "border-line",
                )}
              >
                <span
                  aria-hidden="true"
                  className="rounded-full bg-fg"
                  style={{
                    width: `${Math.max(3, (size / GRID) * 90)}px`,
                    height: `${Math.max(3, (size / GRID) * 90)}px`,
                  }}
                />
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                assembler.current.undo();
                paint();
                send("draw.undo", {});
              }}
              className="control-focus flex items-center gap-1.5 rounded-inset border border-line px-2.5 py-1 text-2xs text-fg-dim hover:text-fg"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                assembler.current.clear();
                paint();
                send("draw.clear", {});
              }}
              className="control-focus flex items-center gap-1.5 rounded-inset border border-line px-2.5 py-1 text-2xs text-fg-dim hover:text-signal"
            >
              <Icon name="close" size={11} />
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
