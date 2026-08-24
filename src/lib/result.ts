/**
 * Typed results for anything that can fail in a way the UI must handle.
 *
 * Server actions return `Result` rather than throwing: a thrown error crosses the
 * server/client boundary as an opaque digest in production, which is exactly the
 * wrong thing for "username already taken" or "you are blocked". Genuinely
 * exceptional conditions still throw and hit the error boundary.
 */

export type AppErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "unknown";

export interface AppError {
  code: AppErrorCode;
  /** Safe to show a user. Never interpolate internal detail into this. */
  message: string;
  /** Field-level messages, keyed by form field name. */
  fieldErrors?: Record<string, string[]>;
}

export type Ok<T> = { readonly ok: true; readonly data: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err<E = AppError>(error: E): Err<E> {
  return { ok: false, error };
}

export function fail(code: AppErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
  return err<AppError>(fieldErrors ? { code, message, fieldErrors } : { code, message });
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
