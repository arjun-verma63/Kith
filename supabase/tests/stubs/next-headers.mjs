/**
 * Stands in for `next/headers`.
 *
 * `recordSecurityEvent` reads the forwarded IP and user agent off the request so
 * the security log can say where something happened from. Outside a request
 * there is no request; an empty header set exercises the null branches, which is
 * the behaviour when a proxy sends neither.
 */
const EMPTY = new Map();

export async function headers() {
  return { get: (name) => EMPTY.get(name.toLowerCase()) ?? null };
}

export async function cookies() {
  return { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} };
}
