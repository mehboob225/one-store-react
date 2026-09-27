/**
 * DomainConfiguration — where the backend is.
 *
 * Resolves the two endpoints the client needs:
 *   api   REST base, always ends with "/"   e.g. "/api/" or "https://api.example.com/api/"
 *   sock  WebSocket push endpoint            e.g. "ws://localhost:3000/push"
 *
 * Each endpoint is resolved independently, most explicit source first:
 *   1. build-time env      BUN_PUBLIC_API_URL / BUN_PUBLIC_SOCK_URL
 *                          (Bun inlines BUN_PUBLIC_* in `bun dev` and `bun run build`)
 *   2. runtime injection   window.__APP_CONFIG__ = { api?, sock? }
 *                          (a <script> the host page emits per deployment)
 *   3. hostname map        HOSTNAME_MAP[location.hostname]
 *   4. same-origin         "/api/" and ws(s)://<host>/push
 *
 * Everything that talks to the network imports this module first; it is
 * imported for its side effect at the top of `src/frontend.tsx`.
 */

export interface DomainConfig {
  /** REST base path or URL. Always ends with "/". */
  api: string;
  /** Absolute WebSocket URL for push. */
  sock: string;
}

/** Partial config; any field may be omitted and falls through to the next source. */
export type PartialDomainConfig = Partial<DomainConfig>;

declare global {
  interface Window {
    __APP_CONFIG__?: PartialDomainConfig;
  }
}

/**
 * Per-hostname overrides for builds that serve the app and the API from
 * different origins. Keys are `location.hostname`. Empty by default.
 */
export const HOSTNAME_MAP: Record<string, PartialDomainConfig> = {
  // "app.example.com": { api: "https://api.example.com/api/", sock: "wss://api.example.com/push" },
};

export interface ResolveInputs {
  /** Build-time env values (already inlined by Bun). */
  env?: { BUN_PUBLIC_API_URL?: string; BUN_PUBLIC_SOCK_URL?: string };
  /** `window.__APP_CONFIG__`. */
  injected?: PartialDomainConfig;
  /** Hostname map to consult; defaults to HOSTNAME_MAP. */
  hostnameMap?: Record<string, PartialDomainConfig>;
  /** The page location; only protocol, host and hostname are read. */
  location: Pick<Location, "protocol" | "host" | "hostname">;
}

/** Pure resolver — exported for tests; the app uses the `DomainConfiguration` singleton. */
export function resolveDomainConfiguration(inputs: ResolveInputs): DomainConfig {
  const { env = {}, injected = {}, hostnameMap = HOSTNAME_MAP, location } = inputs;
  const fromHost = hostnameMap[location.hostname] ?? {};

  const api = firstNonEmpty(env.BUN_PUBLIC_API_URL, injected.api, fromHost.api) ?? "/api/";
  const sock = firstNonEmpty(env.BUN_PUBLIC_SOCK_URL, injected.sock, fromHost.sock) ?? "/push";

  return {
    api: withTrailingSlash(api),
    sock: toWebSocketUrl(sock, location),
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => typeof v === "string" && v.trim() !== "")?.trim();
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Accepts an absolute ws(s):// or http(s):// URL, or a path. Paths are
 * resolved against the page origin; http(s) schemes are mapped to ws(s).
 */
function toWebSocketUrl(value: string, location: ResolveInputs["location"]): string {
  if (/^wss?:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http/i, "ws");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const path = value.startsWith("/") ? value : `/${value}`;
  return `${scheme}://${location.host}${path}`;
}

function currentLocation(): ResolveInputs["location"] {
  if (typeof window !== "undefined" && window.location) return window.location;
  // Non-browser evaluation (SSR, scripts): same-origin defaults relative to nothing.
  return { protocol: "http:", host: "localhost", hostname: "localhost" };
}

/**
 * Bun inlines `process.env.BUN_PUBLIC_*` member expressions at build time,
 * but only for variables that are set. Unset ones are left as literal
 * `process.env.X` reads, and browsers have no `process` global, so that read
 * throws. Each read is wrapped in try/catch: an inlined value is returned
 * as-is (the inliner matches the member expression syntactically), and an
 * unresolved read falls through to `undefined`. A `typeof process` guard
 * would not work — it would also discard inlined values in the browser.
 */
function readBuildTimeEnv(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function buildTimeEnv(): NonNullable<ResolveInputs["env"]> {
  return {
    BUN_PUBLIC_API_URL: readBuildTimeEnv(() => process.env.BUN_PUBLIC_API_URL),
    BUN_PUBLIC_SOCK_URL: readBuildTimeEnv(() => process.env.BUN_PUBLIC_SOCK_URL),
  };
}

export const DomainConfiguration: DomainConfig = resolveDomainConfiguration({
  env: buildTimeEnv(),
  injected: typeof window !== "undefined" ? window.__APP_CONFIG__ : undefined,
  location: currentLocation(),
});
