"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * Toasts.
 *
 * They arrive from the edge they live on rather than fading up from nowhere —
 * bottom-right on desktop, top on mobile where the thumb is not. Remaining time
 * is drawn as a draining hairline instead of a number, because nobody reads a
 * countdown but everybody understands a shortening line.
 *
 * Accessibility: the region is a polite live region, and error toasts are
 * promoted to `role="alert"` so they interrupt. Anything with an action gets no
 * auto-dismiss at all — a disappearing "Undo" is a broken affordance.
 */

const TONE: Record<string, { icon: IconName; accent: string; text: string }> = {
  neutral: { icon: "info", accent: "bg-fg-faint", text: "text-fg-dim" },
  success: { icon: "check", accent: "bg-moss", text: "text-moss" },
  danger: { icon: "alert", accent: "bg-signal", text: "text-signal" },
  info: { icon: "info", accent: "bg-ice", text: "text-ice" },
};

export type ToastTone = "neutral" | "success" | "danger" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds. Ignored when an action is present. Defaults to 5000. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: string;
  state: "open" | "closing";
}

interface ToastApi {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>.");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, number>());

  const remove = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      setToasts((current) =>
        current.map((item) => (item.id === id ? { ...item, state: "closing" } : item)),
      );
      // Long enough for the exit transition; the record is gone either way.
      window.setTimeout(() => remove(id), 200);
    },
    [remove],
  );

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { ...options, id, state: "open" }]);

      if (!options.action) {
        const duration = options.duration ?? 5000;
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), duration),
        );
      }

      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        role="region"
        aria-label="Notifications"
        className={cn(
          "pointer-events-none fixed z-[var(--z-toast)] flex flex-col gap-2",
          "inset-x-4 top-4 sm:inset-x-auto sm:top-auto sm:right-6 sm:bottom-6 sm:w-[22rem]",
        )}
      >
        {toasts.map((item) => (
          <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  const tone = TONE[toast.tone ?? "neutral"] ?? TONE["neutral"]!;
  const duration = toast.duration ?? 5000;

  return (
    <div
      data-state={toast.state}
      role={toast.tone === "danger" ? "alert" : "status"}
      aria-live={toast.tone === "danger" ? "assertive" : "polite"}
      className={cn(
        "toast panel panel-overlay pointer-events-auto relative overflow-hidden rounded-soft",
      )}
    >
      {/* Lit edge in the tone colour: the same "this one" language as the nav. */}
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-[2px]", tone.accent)} />

      <div className="flex items-start gap-3 py-3 pr-2 pl-4">
        <Icon name={tone.icon} size={16} className={cn("mt-0.5", tone.text)} />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium text-fg-loud">{toast.title}</p>
          {toast.description ? (
            <p className="text-xs leading-body text-fg-dim">{toast.description}</p>
          ) : null}

          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                onDismiss();
              }}
              className="control-focus mt-1.5 self-start rounded-edge text-xs font-medium text-ember underline-offset-4 hover:underline"
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="control-focus -mt-0.5 rounded-edge p-1 text-fg-faint transition-colors duration-[var(--t-tap)] hover:text-fg"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {toast.action ? null : (
        <span
          aria-hidden="true"
          className={cn("toast-progress absolute inset-x-0 bottom-0 h-px", tone.accent)}
          style={{ "--toast-duration": `${duration}ms` } as CSSProperties}
        />
      )}
    </div>
  );
}
