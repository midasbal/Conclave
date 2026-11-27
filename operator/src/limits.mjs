// Sliding-window counts, in memory. They are soft: a caller's address is only as true as whoever reported it, addresses are cheap to change, and the
// counts start again when the process does. The daily cap, which is kept on disk, is the limit that holds.
import net from "node:net";

const HOUR = 60 * 60 * 1000;

export function createWindow(limit, now = () => Date.now()) {
  const hits = new Map();
  const recent = key => {
    const cut = now() - HOUR;
    const list = (hits.get(key) ?? []).filter(t => t > cut);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    full: key => recent(key).length >= limit,
    add(key) {
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
      if (hits.size > 50_000) hits.clear(); // a flood of made-up addresses must not grow this without bound; the global limit still applies
    },
  };
}

/** one bucket for each IPv4 address and for each IPv6 /64, which is what one subscriber usually holds */
export function addressKey(value) {
  const text = (value ?? "").trim();
  const kind = net.isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return "unknown";
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [head, tail = ""] = text.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = text.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}
