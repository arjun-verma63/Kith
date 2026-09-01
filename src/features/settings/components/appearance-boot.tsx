import {
  resolveTheme,
  type MotionPreference,
  type ThemePreference,
} from "@/features/settings/preferences";

/**
 * Applies the saved theme and motion setting to the document.
 *
 * ── Why a script tag and not a class on a div ────────────────────────────────
 *
 * Both settings are read from `<html>` by CSS — `data-theme` and `data-motion`
 * are the single source of truth so the stylesheet and any JavaScript cannot
 * disagree. A layout below `<html>` cannot set an attribute on it, so it has to
 * be one line of script.
 *
 * ── Why the flash is small and not zero ─────────────────────────────────────
 *
 * The root layout writes the theme from `localStorage` before first paint, which
 * covers the case that matters: the same person on the same browser. This runs
 * afterwards and reconciles it with what the database says, which is what makes
 * the setting follow somebody to their phone.
 *
 * So the only visible correction is the first load on a NEW device after
 * changing the theme on an old one — and this writes `localStorage` on the way
 * through, so it happens once. The alternative is reading the database in the
 * root layout, which would make the public landing page dynamic for the sake of
 * a preference no signed-out visitor has.
 */
export function AppearanceBoot({
  theme,
  motion,
}: {
  theme: ThemePreference;
  motion: MotionPreference;
}) {
  /*
   * Both values come from enum columns, so they cannot be arbitrary strings —
   * but they are still interpolated into a script, so they go through
   * JSON.stringify rather than into a template literal on trust.
   */
  const script = `(function(){try{
var t=${JSON.stringify(theme)},m=${JSON.stringify(motion)},r=document.documentElement;
r.dataset.theme=t==="system"?(matchMedia("(prefers-color-scheme: light)").matches?"daylight":"dusk"):t;
r.dataset.motion=m;
localStorage.setItem("kith-theme",t);
}catch(e){}})();`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

/** Kept beside the component so the bootstrap and the form agree. */
export { resolveTheme };
