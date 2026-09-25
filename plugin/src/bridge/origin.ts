/**
 * Origin trust for loopback clients.
 *
 * The bridge binds to 127.0.0.1, but that only stops *remote* machines: a web page in
 * the user's browser can still talk to `http://127.0.0.1:<port>` and to the plugin
 * WebSocket. Browsers always attach an `Origin` header to cross-origin requests and to
 * WebSocket handshakes, while command line clients (curl, Node, this repo's own scripts)
 * attach none — so "no Origin" or "an Origin we trust" is a workable gate that cannot
 * break CLI usage.
 *
 * Trusted origins:
 *   - absent / empty           → curl, Node, any non-browser client
 *   - "null"                    → sandboxed iframes
 *   - file://                   → Blockbench (Electron loads the app from disk)
 *   - http(s)://localhost[:port], http(s)://127.0.0.1[:port], http(s)://[::1][:port]
 *
 * Anything else (an attacker's website) is rejected.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isTrustedOrigin(origin: string | string[] | undefined): boolean {
  const raw = Array.isArray(origin) ? origin[0] : origin;
  const value = (raw ?? '').trim();
  if (!value || value === 'null') return true;
  if (value === 'file://' || value === 'file:') return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  return LOCAL_HOSTNAMES.has(parsed.hostname);
}

/** Human readable reason, used in logs when a client is turned away. */
export function describeOrigin(origin: string | string[] | undefined): string {
  const raw = Array.isArray(origin) ? origin[0] : origin;
  return raw ? String(raw) : '(none)';
}
