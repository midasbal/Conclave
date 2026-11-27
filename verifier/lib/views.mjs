// The three ways of reading the same verified entries. Pure functions over the record's seasons. Final and provisional results are never mixed in one list.
//   strategies   by the permanent strategy id. An id outlives any change of owner, so its history stays in one place; each result still says who owned it at entry
//   wallets      by the owner wallet written on each receipt, at the time of that entry
//   commitments  by code commitment = sha256(salt, bytecode). The same commitment means the same salt and bytecode. DIFFERENT commitments say nothing: the same code under a new salt looks unrelated
const bucket = (map, k, extra) => (map[k] ??= { ...extra(), final: [], provisional: [] });
const addTo = (list, v) => { if (!list.includes(v)) list.push(v); };

export function buildViews(seasons) {
  const strategies = {}, wallets = {}, commitments = {};
  for (const s of seasons) for (const e of s.entries) {
    const row = { season: s.season, slot: e.slot, strategyId: e.strategyId, owner: e.owner, codeCommitment: e.codeCommitment, kind: s.kind, finals: s.finals, fieldSize: s.facts.fieldSize, creator: s.facts.creator, rank: e.rank, seasonRank: e.seasonRank, finalist: e.finalist, published: e.published, flagged: s.flags.some(f => !f.info) };
    const a = bucket(strategies, e.strategyId, () => ({ codeCommitments: [], ownersAtEntry: [] })); addTo(a.codeCommitments, e.codeCommitment); addTo(a.ownersAtEntry, e.owner); a[s.status].push(row);
    bucket(wallets, e.owner, () => ({}))[s.status].push(row);
    const c = bucket(commitments, e.codeCommitment, () => ({ strategyIds: [], ownersAtEntry: [] })); addTo(c.strategyIds, e.strategyId); addTo(c.ownersAtEntry, e.owner); c[s.status].push(row);
  }
  const anomalies = [];
  // a strategy id's commitment is fixed when it is registered, and a retired id cannot be registered again, so two commitments under one id should not happen
  for (const [id, v] of Object.entries(strategies)) if (v.codeCommitments.length > 1) anomalies.push({ strategyId: id, what: "one strategy id appears with more than one code commitment" });
  return { views: { strategies, wallets, commitments }, anomalies };
}
