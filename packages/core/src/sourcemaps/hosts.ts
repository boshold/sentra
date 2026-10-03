const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** Accepts `host`, `host:port`, `[v6]`, `[v6]:port` and bare IPv6; `null` for anything URL-like. */
function parseAllowedHost(entry: string): string | null {
  const value = entry.trim();
  if (value === "" || /[/\\@?#\s]/.test(value)) {
    return null;
  }
  const isBareIpv6 = !value.startsWith("[") && value.split(":").length > 2;
  const hostname = URL.parse(`http://${isBareIpv6 ? `[${value}]` : value}`)?.hostname;
  return hostname === undefined || hostname === "" ? null : hostname;
}

function addHost(hosts: Set<string>, entry: string): void {
  const hostname = parseAllowedHost(entry);
  if (hostname === null) {
    return;
  }
  hosts.add(hostname);
  if (hostname.startsWith("[")) {
    hosts.add(hostname.slice(1, -1));
  }
}

function normalizeAllowedHosts(extra: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const entry of [...LOOPBACK_HOSTS, ...extra]) {
    addHost(hosts, entry);
  }
  return hosts;
}

/** Port-agnostic: a `host:port` entry allows its hostname on any port. */
function isAllowedHostname(url: URL, allowedHosts: ReadonlySet<string>): boolean {
  return allowedHosts.has(url.hostname.toLowerCase());
}

function isAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    isAllowedHostname(url, allowedHosts)
  );
}

export { LOOPBACK_HOSTS, isAllowedHostname, isAllowedUrl, normalizeAllowedHosts, parseAllowedHost };
