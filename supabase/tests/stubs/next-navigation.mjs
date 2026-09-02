/** Stands in for `next/navigation` inside a server action under test. */
export { redirect } from "./registry.mjs";

export function notFound() {
  throw new Error("NEXT_NOT_FOUND");
}
