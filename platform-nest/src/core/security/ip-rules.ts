// DW-7h (FRONTEND-BFF-CONTRACT §52.7) — what IT may block. Only a single PUBLIC address: blocking a private, loopback or
// link-local one would cut the company's own network (every request through the office router, or platform-ui itself,
// arrives from such an address), and a range would block people nobody looked at. Pure, so the rules are tested without a
// server.
import { BlockList, isIP } from "node:net";
import { cleanIp } from "./client-context";

export type IpRefusal = "invalid" | "private" | "loopback" | "link_local" | "reserved";

export type IpCheck = { ok: true; ip: string } | { ok: false; reason: IpRefusal };

// BlockList does the prefix arithmetic and understands both families, so no hand-rolled bit twiddling here.
function list(entries: Array<[string, number, "ipv4" | "ipv6"]>): BlockList {
  const l = new BlockList();
  for (const [net, prefix, family] of entries) l.addSubnet(net, prefix, family);
  return l;
}

const PRIVATE = list([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["fc00::", 7, "ipv6"],
]);
const LOOPBACK = list([["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]]);
const LINK_LOCAL = list([["169.254.0.0", 16, "ipv4"], ["fe80::", 10, "ipv6"]]);
// Not a client's address at all: "this host", multicast and the reserved/broadcast block. Refused with the same 400.
const RESERVED = list([
  ["0.0.0.0", 8, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["ff00::", 8, "ipv6"],
]);

/** Validate an address typed by IT. IPv4-mapped IPv6 is unwrapped first (`::ffff:10.0.0.1` is the private 10.0.0.1), and a
 *  CIDR range, a hostname or anything else that is not one address is `invalid`. */
export function classifyBlockableIp(value: unknown): IpCheck {
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const ip = cleanIp(value);
  if (!ip) return { ok: false, reason: "invalid" };
  const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(ip, family)) return { ok: false, reason: "loopback" };
  if (LINK_LOCAL.check(ip, family)) return { ok: false, reason: "link_local" };
  if (PRIVATE.check(ip, family)) return { ok: false, reason: "private" };
  if (RESERVED.check(ip, family)) return { ok: false, reason: "reserved" };
  return { ok: true, ip };
}

/** Whether two address strings are the same address, however they are written (`2001:DB8::1` and `2001:db8:0::1`, or a
 *  mapped `::ffff:1.2.3.4` and `1.2.3.4`). Null never equals anything: an unknown address is not "yours". */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanIp(a);
  const y = cleanIp(b);
  if (!x || !y) return false;
  if (isIP(x) !== isIP(y)) return false;
  const l = new BlockList();
  l.addAddress(x, isIP(x) === 4 ? "ipv4" : "ipv6");
  return l.check(y, isIP(y) === 4 ? "ipv4" : "ipv6");
}

export const IP_REFUSAL_MESSAGE: Record<IpRefusal, string> = {
  invalid: "ip must be one valid IPv4 or IPv6 address (no range, no hostname)",
  private: "that is a private network address (10.x, 172.16-31.x, 192.168.x, fc00::/7); blocking it would cut the company's own network",
  loopback: "that is a loopback address and can never be a client",
  link_local: "that is a link-local address (169.254.x.x, fe80::/10) and can never be a client",
  reserved: "that is not a client address (unspecified, multicast or reserved)",
};
