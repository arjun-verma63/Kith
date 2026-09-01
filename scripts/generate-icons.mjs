#!/usr/bin/env node
/**
 * Renders the app icon set from the brand mark.
 *
 *     npm run icons
 *
 * Committed output, not a build step. The manifest and the iOS `<link>` need
 * stable URLs, and a build-time image route gives you hashed ones — so these are
 * generated once, checked in, and regenerated only when the mark changes.
 *
 * ── Why three shapes and not one scaled file ─────────────────────────────────
 *
 * The platforms disagree about what an icon is, and the disagreement is not
 * cosmetic:
 *
 *   `any`       Drawn as supplied, corners and all. What a browser tab, a task
 *               switcher and a desktop shortcut show.
 *
 *   `maskable`  Android crops it to whatever shape the launcher uses — circle,
 *               squircle, teardrop — and only the central 80% is guaranteed to
 *               survive. A rounded square handed to a circular launcher loses
 *               its corners; the same mark on a full-bleed background does not.
 *               So this variant fills the canvas and shrinks the mark.
 *
 *   Apple touch iOS applies its own rounding and does NOT respect transparency —
 *               a transparent PNG comes out on a black square. So this one is
 *               square, opaque, and unrounded, and iOS does the rest.
 *
 * Shipping one file for all three is the most common PWA icon mistake and it
 * looks like a bug on exactly one platform, which is how it survives review.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

const OUT = join(process.cwd(), "public", "icons");

/** Dusk background and ember stroke, lifted from tokens.css. */
const BG = "#0e0b0a";
const INK = "#e8613c";

/**
 * The mark, on a 32-unit grid — the same path as `src/app/icon.svg`.
 *
 * `scale` shrinks it about the centre so the maskable variant keeps its whole
 * shape inside Android's safe circle. The mark's ink spans x 11→19.5 and
 * y 7→25, so it is centred on roughly (15.25, 16) rather than dead centre; the
 * translate below corrects for that, which matters once it is being cropped to
 * a circle rather than sitting in a square.
 *
 * The safe circle is 80% of the canvas, so at 512px its radius is 204.8. Half
 * the mark's diagonal — including the 3-unit stroke — is 191.5·scale px, which
 * means even scale 1 would fit. 0.82 is chosen for how it looks with real
 * headroom for a launcher that crops tighter than the spec, not because the
 * geometry demanded it; the first pass used 0.62 and drew a timid little K in
 * the middle of a lot of nothing.
 */
function mark(scale = 1) {
  const cx = 15.25;
  const cy = 16;
  const transform = `translate(${16 - cx * scale} ${16 - cy * scale}) scale(${scale})`;

  return `<g transform="${transform}">
    <path d="M11 7v18M11 16.2l8.5-9M11 15.8l8.5 9"
          stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"/>
  </g>`;
}

/** A rounded tile, the way the mark is drawn everywhere else in the app. */
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${BG}"/>
  ${mark()}
</svg>`;

/** Full bleed. Android will cut whatever shape it likes out of this. */
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BG}"/>
  ${mark(0.82)}
</svg>`;

/** Square and opaque. iOS rounds it itself and ignores any transparency. */
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BG}"/>
  ${mark(0.86)}
</svg>`;

const TARGETS = [
  { file: "icon-192.png", svg: rounded, size: 192 },
  { file: "icon-512.png", svg: rounded, size: 512 },
  { file: "icon-maskable-192.png", svg: maskable, size: 192 },
  { file: "icon-maskable-512.png", svg: maskable, size: 512 },
  { file: "apple-touch-icon.png", svg: apple, size: 180 },
  // The one raster favicon still worth shipping: Safari's tab bar and any
  // browser that ignores the SVG.
  { file: "favicon-32.png", svg: rounded, size: 32 },
];

mkdirSync(OUT, { recursive: true });

for (const { file, svg, size } of TARGETS) {
  // The SVG is rendered at the target size rather than rasterised once and
  // resampled, so the 3px stroke stays crisp at 32 and at 512.
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);

  const png = await sharp(Buffer.from(sized)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(OUT, file), png);

  console.log(`  ${file.padEnd(26)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
}

console.log(`\nWrote ${TARGETS.length} icons to public/icons/`);
