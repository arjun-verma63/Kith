"use client";

/**
 * Catches failures in the root layout itself, which means it must render its own
 * html and body elements and cannot rely on globals.css having been applied.
 * The inline styles here are deliberate, not laziness.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "1.5rem",
          padding: "2rem 1.5rem",
          background: "#0e0b0a",
          color: "#e8e0da",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "2rem", color: "#fbf7f2" }}>KITH could not start.</h1>
        <p style={{ margin: 0, maxWidth: "42ch", color: "#8a7c76" }}>
          Something failed before the application shell could render.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            alignSelf: "flex-start",
            padding: "0.625rem 1rem",
            borderRadius: 10,
            border: "none",
            background: "#e8613c",
            color: "#1a0d08",
            font: "inherit",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
