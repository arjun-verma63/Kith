/**
 * Whether a click on an anchor means "navigate here".
 *
 * Pulled out of `RouteProgress` so it can be tested. It is the part of a
 * progress bar that goes wrong: every branch below is a way a click can look
 * like navigation and not be one, and getting any of them wrong shows a bar for
 * something that is not happening — which then sits there until a timeout, which
 * is worse than never having shown it.
 *
 * Pure, and takes the current location rather than reading `window`, so a test
 * can ask about a link from a page without being on that page.
 */

export interface ClickModifiers {
  defaultPrevented: boolean;
  /** 0 is the primary button. Middle-click opens a tab and is not ours. */
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface AnchorIntent {
  /** The resolved absolute href, as the DOM reports it. */
  href: string;
  /** The raw attribute — `#top` and `` are only visible here. */
  rawHref: string | null;
  target: string | null;
  download: boolean;
}

export function isNavigationClick(
  event: ClickModifiers,
  anchor: AnchorIntent,
  currentUrl: string,
): boolean {
  // Somebody already handled it — a menu, a dialog, a form.
  if (event.defaultPrevented) return false;

  // Middle and right buttons, and every "open somewhere else" modifier. These
  // leave the current page exactly where it is.
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.download) return false;

  // An anchor with no href is a button wearing the wrong element.
  if (!anchor.rawHref) return false;
  // `#section` scrolls; it does not navigate.
  if (anchor.rawHref.startsWith("#")) return false;

  let destination: URL;
  let current: URL;
  try {
    current = new URL(currentUrl);
    destination = new URL(anchor.href, currentUrl);
  } catch {
    return false;
  }

  // Another site. The browser leaves; our progress bar goes with the page.
  if (destination.origin !== current.origin) return false;

  // Not a page at all — mailto:, tel:, blob:, data:.
  if (destination.protocol !== "http:" && destination.protocol !== "https:") return false;

  /*
   * Same path, whatever the query.
   *
   * This is stricter than "same URL" on purpose, and the reason is the caller:
   * `RouteProgress` ends the bar when `usePathname` changes, and that does not
   * fire for a query-only navigation. Starting a bar there would leave it
   * running until the give-up timer — a worse outcome than the silence it was
   * added to fix.
   *
   * Nothing in KITH navigates by query today, so this costs nothing now. The
   * honest framing is that the bar tracks PATH changes, so it starts on exactly
   * those. Widening it means giving the caller a completion signal that can see
   * the query, and the two have to move together.
   */
  if (destination.pathname === current.pathname) return false;

  return true;
}
