// THE COUNTING POLICY. Separate from the record: it reads a record and never changes it, so it can be edited or replaced and re-run over the same data (node cli.mjs rank --policy ./mine.mjs).
// A policy is a module exporting evaluate(record, rules). It is a pure function: no network, no files, no clock.
//
// What this one counts: FINAL seasons, with no alarm flag, from a creator on the trusted list, whose observed validator is on the trusted list.
// Why a list: anyone can create a season, choose its fee and fill it with its own wallets. No number read off a receipt tells a farmed season from a real one, so this policy sets NO minimum on wallets or
// fee. Such a minimum would only be a price, and presenting it as protection would be false. Trusting a creator is the whole of the protection, and it is only as good as that trust.

export const NAME = "conclave-official-trusted-creators";
export const VERSION = 1;
const RULE_KEYS = ["name", "note", "trustedCreators", "trustedValidators", "countVoidedFinals"];

const keyList = (v, what) => { if (!Array.isArray(v)) throw new Error(`rules: ${what} must be a list`); return new Map(v.map(x => { const e = typeof x === "string" ? { key: x } : x; if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(e?.key ?? "")) throw new Error(`rules: ${what} holds something that is not a public key`); return [e.key, e.note ?? ""]; })); };
export function readRules(rules) {
  for (const k of Object.keys(rules)) if (!RULE_KEYS.includes(k)) throw new Error(`rules: unknown rule "${k}" (a misspelt rule must not be silently ignored)`);
  return { creators: keyList(rules.trustedCreators, "trustedCreators"), validators: keyList(rules.trustedValidators, "trustedValidators"), countVoidedFinals: rules.countVoidedFinals !== false };
}

/** every reason a season is left out; an empty list means it counts */
export function exclusions(season, r) {
  const why = [];
  if (season.status !== "final") why.push("provisional: not yet closed and back on base");
  for (const f of season.flags) if (!f.info) why.push("flagged: " + f.kind);
  if (!r.creators.has(season.facts.creator)) why.push("creator is not on the trusted list");
  const v = season.validator;
  if (v.status !== "observed") why.push("validator " + v.status);
  else if (!r.validators.has(v.key)) why.push("validator is not on the trusted list");
  if (season.kind === "cancelled") why.push("cancelled: it has no result");
  if (season.finals === "voided" && !r.countVoidedFinals) why.push("finals voided");
  if (season.kind === "settled" && season.facts.fieldSize < 2) why.push("a single entry: nothing was compared");
  return why;
}

const DISCLAIMERS = [
  "Counted seasons are those of the creators these rules trust. Remove that trust and the ranking means nothing: a creator can farm its own seasons with its own wallets.",
  "Field size, fee and distinct wallet counts are facts to judge a season by. None of them proves a field is not one person.",
  "The validator of each season is a trust input observed from history, not something the receipt proves.",
  "The fee is in base units of a stake token the receipt does not name, so fees of different seasons may not be comparable.",
  "Placements in different fields are not a measure of the same thing. This order is one chosen convention, not a measurement of skill.",
];

export function evaluate(record, rules) {
  const r = readRules(rules); const counted = [], excluded = [], rows = new Map();
  const anomalous = new Set(record.anomalies.map(a => a.strategyId));
  for (const s of record.seasons) {
    const why = exclusions(s, r);
    if (why.length) { excluded.push({ season: s.season, reasons: why }); continue; }
    counted.push(s.season); const n = s.facts.fieldSize;
    for (const e of s.entries) {
      const row = rows.get(e.strategyId) ?? { strategyId: e.strategyId, seasons: 0, wins: 0, podiums: 0, beaten: 0, ownersAtEntry: [], anomaly: anomalous.has(e.strategyId) };
      row.seasons++; if (e.rank === 1) row.wins++; if (e.rank <= 3) row.podiums++; row.beaten += (n - e.rank) / (n - 1); if (!row.ownersAtEntry.includes(e.owner)) row.ownersAtEntry.push(e.owner); rows.set(e.strategyId, row);
    }
  }
  // order: the sum over counted seasons of the share of the other entrants placed below (1 for a win, 0 for last), then wins, then id so that the order is stable
  const ranking = [...rows.values()].map(x => ({ ...x, beaten: Math.round(x.beaten * 10000) / 10000 })).sort((a, b) => b.beaten - a.beaten || b.wins - a.wins || a.strategyId.localeCompare(b.strategyId, "en", { numeric: true })).map((x, i) => ({ position: i + 1, ...x }));
  return { policy: { name: NAME, version: VERSION }, rules, counted, excluded, ranking, disclaimers: DISCLAIMERS };
}
