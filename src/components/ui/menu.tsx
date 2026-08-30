"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils/cn";

/**
 * Dropdown menu.
 *
 * Origin-anchored: the panel grows from the corner nearest its trigger, so it
 * reads as having come *from the button* rather than appearing from nowhere.
 * That is the motion principle the whole system runs on, at its smallest scale.
 *
 * The panel stays mounted and is toggled with `display`, which lets the same
 * CSS handle enter and exit (`@starting-style` + `allow-discrete`) with no
 * animation library and no unmount timing to get wrong. While closed it is
 * `display: none`, so it is out of the accessibility tree and out of the tab
 * order.
 *
 * Keyboard: Arrow keys move between items, Home/End jump, Escape closes and
 * returns focus to the trigger, Tab closes and moves on. Items are read from
 * the DOM at the moment a key is pressed, so a conditionally rendered item can
 * never desynchronise from a registry.
 *
 * Positioning is plain absolute layout against a relatively positioned wrapper.
 * That is correct for triggers in headers, toolbars and rails, which is every
 * menu in KITH. If a menu ever needs to escape a scroll container, that is the
 * point to reach for anchor positioning — not before.
 */

const ALIGN = {
  start: { panel: "left-0", origin: "top left" },
  end: { panel: "right-0", origin: "top right" },
} as const;

export interface MenuProps {
  /** Receives the props the trigger must spread. Usually a Button. */
  trigger: (props: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    onClick: () => void;
    onKeyDown: (event: ReactKeyboardEvent) => void;
    ref: Ref<HTMLButtonElement>;
  }) => ReactNode;
  children: ReactNode;
  align?: keyof typeof ALIGN;
  /** Accessible name for the menu itself, e.g. "Conversation actions". */
  label: string;
  className?: string;
}

export function Menu({ trigger, children, align = "start", label, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const items = useCallback(
    () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([aria-disabled="true"])',
        ) ?? [],
      ),
    [],
  );

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openAt = useCallback(
    (edge: "first" | "last") => {
      setOpen(true);
      // The panel is display:none until the attribute lands; an element with no
      // box cannot take focus, so wait for the style flush before reaching in.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const list = items();
          const target = edge === "first" ? list[0] : list[list.length - 1];
          target?.focus();
        });
      });
    },
    [items],
  );

  // Dismiss on an outside pointer press or a scroll that would detach the panel
  // from its trigger.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  function onPanelKeyDown(event: ReactKeyboardEvent) {
    const list = items();
    if (list.length === 0) return;

    const index = list.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        list[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        list[list.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt("last");
    }
  }

  return (
    <div className={cn("relative inline-flex", className)}>
      {trigger({
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        onClick: () => (open ? close(false) : setOpen(true)),
        onKeyDown: onTriggerKeyDown,
        ref: triggerRef,
      })}

      <div
        ref={panelRef}
        id={menuId}
        role="menu"
        aria-label={label}
        data-open={open}
        onKeyDown={onPanelKeyDown}
        onClick={(event) => {
          const item = (event.target as HTMLElement).closest('[role="menuitem"]');
          if (item && item.getAttribute("aria-disabled") !== "true") close(true);
        }}
        style={{ "--menu-origin": ALIGN[align].origin } as CSSProperties}
        className={cn(
          "menu-panel panel panel-overlay absolute top-[calc(100%+0.375rem)]",
          "z-[var(--z-overlay)] min-w-[12rem] rounded-soft p-1",
          ALIGN[align].panel,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export interface MenuItemProps extends Omit<ComponentProps<"button">, "children"> {
  icon?: IconName;
  /** Right-aligned hint: a shortcut, a count, a check. */
  hint?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  children: ReactNode;
}

export function MenuItem({
  icon,
  hint,
  tone = "default",
  disabled = false,
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      data-tone={tone}
      className={cn("menu-item px-2.5 py-2 text-sm", className)}
      {...props}
    >
      {icon ? <Icon name={icon} size={16} className="text-fg-faint" /> : null}
      <span className="flex-1 truncate">{children}</span>
      {hint ? <span className="label text-fg-faint">{hint}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="label px-2.5 pt-2 pb-1 text-fg-faint">{children}</div>;
}
