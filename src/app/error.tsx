"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Phase 11 replaces this with the Sentry client. Until then the digest is the
    // only handle we have on a production failure, so make sure it gets recorded.
    console.error("[kith] unhandled error", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-6 px-6 sm:px-12 lg:px-16">
      <span className="label text-signal">Something broke</span>
      <h1 className="display max-w-[16ch] text-d-sm text-fg-loud sm:text-d-md">
        The lights went out.
      </h1>
      <p className="max-w-[42ch] text-base text-fg-dim">
        This one is on us, not on you. Try again, and if it keeps happening the reference below will
        tell us what went wrong.
      </p>
      <div className="flex items-center gap-4">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        {error.digest ? <code className="label text-fg-faint">{error.digest}</code> : null}
      </div>
    </main>
  );
}
