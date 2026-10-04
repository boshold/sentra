import { parseAllowedHost } from "@bosdev/sentra-core";
import {
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";

type GuardResult =
  | { ok: true }
  | { ok: false; code: "forbidden_host" | "forbidden_origin"; message: string };

type Guard = (headers: { host: string | undefined; origin: string | undefined }) => GuardResult;

/** SDK allowlist form: lowercase hostname, IPv6 bracketed; `null` for unusable entries. */
function toAllowedHostname(entry: string): string | null {
  const hostname = parseAllowedHost(entry);
  return hostname === null ? null : hostname.toLowerCase();
}

/** Host/Origin check against DNS rebinding and cross-site reads (ports are ignored). */
function createGuard(options: { boundHost: string; allowedHosts: string[] }): Guard {
  const allowed = [
    ...new Set(
      [...localhostAllowedHostnames(), options.boundHost, ...options.allowedHosts]
        .map(toAllowedHostname)
        .filter((hostname) => hostname !== null),
    ),
  ];
  return function guard(headers) {
    const host = validateHostHeader(headers.host, allowed);
    if (!host.ok) {
      return { ok: false, code: "forbidden_host", message: host.message };
    }
    const origin = validateOriginHeader(headers.origin, allowed);
    if (!origin.ok) {
      return { ok: false, code: "forbidden_origin", message: origin.message };
    }
    return { ok: true };
  };
}

export { createGuard };
export type { Guard, GuardResult };
