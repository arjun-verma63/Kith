import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope, Martian_Mono } from "next/font/google";

import { APP, DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/constants";
import { clientEnv } from "@/lib/env/client";
import { RouteProgress } from "@/components/layout/route-progress";
import { ServiceWorker } from "@/features/pwa/service-worker";

import "./globals.css";

/* Three voices, three jobs. Fraunces carries the identity (its SOFT/WONK axes are
   what stop the display type reading as a stock serif), Manrope carries the
   interface, Martian Mono carries anything numeric: durations, scores, counts. */
const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
  axes: ["SOFT", "WONK", "opsz"],
});

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});

const martianMono = Martian_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-martian-mono",
  weight: ["400", "500"],
});

/* Applies the stored theme before first paint. Dusk is what the server renders,
   so only a user who chose Daylight would otherwise see a flash. */
const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dusk"||t==="daylight"){document.documentElement.dataset.theme=t}}catch(e){}})();`;

export const metadata: Metadata = {
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_SITE_URL),
  title: { default: `${APP.name} — ${APP.tagline}`, template: `%s · ${APP.name}` },
  description: APP.description,
  applicationName: APP.name,
  // KITH is invite-only. There is nothing here for a search engine.
  robots: { index: false, follow: false },

  /*
   * iOS does not read the manifest for any of this.
   *
   * `capable` is what makes an icon added to the home screen open without
   * Safari's chrome; without it the manifest's `display: standalone` is ignored
   * and the app opens in a tab with an address bar.
   *
   * `statusBarStyle: "black-translucent"` lets the page draw under the status
   * bar, which is the other half of `viewport-fit: cover` and the reason the
   * header pads itself by `--safe-t`.
   */
  appleWebApp: {
    capable: true,
    title: APP.name,
    statusBarStyle: "black-translucent",
  },

  /*
   * iOS ignores the manifest icons too, and it does not respect transparency —
   * see scripts/generate-icons.mjs for why this is a different file from the
   * other two rather than the same one at another size.
   */
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },

  // Stops iOS and Android turning bare numbers into "call this" links, which on
  // a page full of scores and timestamps is a lot of false positives.
  formatDetection: { telephone: false },
  openGraph: {
    title: `${APP.name} — ${APP.tagline}`,
    description: APP.description,
    siteName: APP.name,
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  /*
   * The colour the browser paints its own chrome with — the status bar on
   * Android, the surround of an installed window.
   *
   * A static value here is only the starting point. KITH's theme is a stored
   * preference rather than a system one, so somebody who chose Daylight on a
   * dark-mode phone would get an ember-black status bar above a light app. The
   * appearance bootstrap rewrites this tag to match what was actually chosen;
   * this is what is painted before that runs.
   */
  themeColor: "#0e0b0a",
  /*
   * Lets the page reach under the notch and the home indicator, which is what
   * makes `env(safe-area-inset-*)` report anything other than zero. Every piece
   * of chrome that touches an edge then adds the inset back — see `--safe-b`.
   *
   * Without this the bottom navigation would sit above the home indicator on an
   * iPhone with a strip of background under it, which looks like a bug.
   */
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      data-motion="full"
      suppressHydrationWarning
      className={`${fraunces.variable} ${manrope.variable} ${martianMono.variable} h-full`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="room grain flex min-h-full flex-col text-fg">
        {/* Mounted at the root rather than in the signed-in shell: /login and
            /signup are navigations too, and the first one anybody makes. */}
        <RouteProgress />
        {children}
        {/* Registered from the root rather than the signed-in shell, so the app
            is installable from the page somebody actually lands on. */}
        <ServiceWorker />
      </body>
    </html>
  );
}
