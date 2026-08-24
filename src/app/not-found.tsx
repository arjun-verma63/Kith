import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-6 px-6 sm:px-12 lg:px-16">
      <span className="label text-fg-faint">404</span>
      <h1 className="display max-w-[14ch] text-d-sm text-fg-loud sm:text-d-md">
        There is no room here.
      </h1>
      <p className="max-w-[42ch] text-base text-fg-dim">
        The page you were looking for does not exist, or you do not have a key to it.
      </p>
      <Link
        href="/"
        className="label text-ember underline-offset-4 transition-colors duration-[var(--t-quick)] hover:underline"
      >
        Back to the door
      </Link>
    </main>
  );
}
