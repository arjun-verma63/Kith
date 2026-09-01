"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

/**
 * Modal dialog, built on the native `<dialog>` element.
 *
 * Deliberately not a div-with-a-focus-trap. `showModal()` gives us, from the
 * platform and therefore correct: focus containment (including from the browser
 * chrome), `inert` on everything behind, Escape to dismiss, and the top layer —
 * which means no z-index arithmetic and no portal.
 *
 * The animation is CSS. `@starting-style` plus `transition-behavior:
 * allow-discrete` animates an element in *and* out across a `display` change,
 * which is the one thing that historically forced an animation library here.
 *
 * `open` is the single source of truth: every dismissal path just calls
 * `onClose`, and one effect plays the exit before handing the element back to
 * the browser. The exit duration is read from the motion token, so a user on
 * reduced motion (where the tokens are zeroed) closes instantly and correctly
 * rather than sitting through a hard-coded delay.
 */

const WIDTH = {
  sm: "24rem",
  md: "34rem",
  lg: "46rem",
} as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional supporting line under the title. Wired to aria-describedby. */
  description?: string;
  size?: keyof typeof WIDTH;
  /** Actions. Rendered in a footer with a hairline above. */
  footer?: ReactNode;
  /** Set false for a destructive confirm that must be answered deliberately. */
  dismissible?: boolean;
  children?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  dismissible = true,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open) {
      if (!node.open) node.showModal();
      return;
    }

    if (!node.open) return;

    node.dataset["closing"] = "true";
    const exitMs = Number.parseFloat(getComputedStyle(node).getPropertyValue("--t-quick")) || 0;

    const timer = window.setTimeout(() => {
      delete node.dataset["closing"];
      node.close();
    }, exitMs);

    return () => {
      window.clearTimeout(timer);
      delete node.dataset["closing"];
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // showModal() blocks interaction behind the dialog but does not reliably
    // stop the page beneath from scrolling.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className="dialog m-auto"
      style={{ "--dialog-w": WIDTH[size] } as CSSProperties}
      onCancel={(event) => {
        // Escape. Taken over so the exit transition runs and `open` stays honest.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        // A click landing on the dialog element itself is a backdrop click —
        // the panel inside covers the whole visible surface.
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      <div
        className={cn(
          "dialog-panel panel panel-overlay flex max-h-[calc(100dvh-2rem)] flex-col rounded-soft",
        )}
      >
        {/* The grabber. Purely a signal: this is a sheet attached to the bottom
            edge and it can be dismissed downward. Hidden from `sm`, where the
            same component is a centred dialog and the affordance would be a
            lie. Not interactive — the backdrop and Escape are the real
            dismissals, and a decorative bar that looked draggable but was not
            would be worse than no bar. */}
        <div aria-hidden="true" className="flex justify-center pt-2 sm:hidden">
          <span className="h-1 w-9 rounded-full bg-line-lit" />
        </div>

        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-4 sm:pt-5">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="heading text-lg text-fg-loud">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-fg-dim">
                {description}
              </p>
            ) : null}
          </div>

          {dismissible ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 -mr-1"
            />
          ) : null}
        </header>

        {children ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 text-sm text-fg">
            {children}
          </div>
        ) : null}

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
