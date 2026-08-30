import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope, Martian_Mono } from "next/font/google";

import { APP, DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/constants";
import { clientEnv } from "@/lib/env/client";

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
  openGraph: {
    title: `${APP.name} — ${APP.tagline}`,
    description: APP.description,
    siteName: APP.name,
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: "#0e0b0a",
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
      <body className="room grain flex min-h-full flex-col text-fg">{children}</body>
    </html>
  );
}
