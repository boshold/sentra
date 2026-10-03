import type { NetworkInterfaceInfo } from "node:os";

import { lanAddresses } from "#src/config.js";

function entry(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return family === "IPv4"
    ? { address, family, internal, netmask: "255.255.0.0", mac: "00:00:00:00:00:00", cidr: null }
    : {
        address,
        family,
        internal,
        netmask: "ffff::",
        mac: "00:00:00:00:00:00",
        cidr: null,
        scopeid: 0,
      };
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => ({
      lo: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
      eth0: [entry("192.168.1.10", "IPv4"), entry("fe80::1", "IPv6"), entry("fd00::5", "IPv6")],
      wlan0: [entry("169.254.12.3", "IPv4"), entry("10.0.0.7", "IPv4")],
      down: undefined,
    }),
  };
});

describe("lanAddresses", () => {
  it("keeps routable IPv4 addresses only", () => {
    expect(lanAddresses()).toEqual(["192.168.1.10", "10.0.0.7"]);
  });
});
