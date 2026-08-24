import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, resolving Tailwind conflicts so the last value wins.
 * Without this, a `className` prop can never reliably override a component default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
