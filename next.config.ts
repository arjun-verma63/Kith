import type { NextConfig } from "next";

/**
 * Baseline security headers.
 *
 * A Content-Security-Policy is deliberately NOT set here yet: a useful CSP for KITH
 * needs a per-request nonce (issued from middleware) and the final list of connect-src
 * origins (Supabase REST + Realtime WebSocket, TURN). Both arrive in Phase 2, and a
 * placeholder CSP that has to be widened to `unsafe-inline` is worse than none.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // Camera/mic/display-capture are granted to our own origin only — WebRTC (Phase 7+)
    // will not work without these, and nothing else should be able to ask.
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()",
  },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  async headers() {
    return [{ source: "/:path*", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
