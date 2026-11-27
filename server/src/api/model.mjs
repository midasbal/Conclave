// Record -> response. Pure functions: nothing here reads a file, the chain or the clock. Every mapper returns exactly the fields schema.mjs lists, and the honesty rules live here: a fee is never returned without its stake token
// (or an explicit "unknown"), a validator is always marked as a trust input, a strategy is always returned with the sealing-disclosure notice, and no function reads a strategy's secrets because the record holds none.
import { evaluate, NAME as POLICY_NAME, VERSION as POLICY_VERSION } from "../../../verifier/policy/official.mjs";
import { NOTICE, COMMITMENT_CAVEAT, RANKING_BASIS } from "./notices.mjs";

export const asOf = r => ({ slot: r.currentTo?.slot ?? null, builtAt: r.builtAt, recordVersion: r.version, archive: { copies: r.archive.copies, sha256: r.archive.sha256, recordSha256: r.archive.recordSha256 }, ledgerHead: r.ledger?.head ?? null });
const head = (r, permalink, notices) => ({ apiVersion: "v1", asOf: asOf(r), permalink, notices });
const seasonLink = id => `/v1/seasons/${id}`, strategyLink = id => `/v1/strategies/${id}`, walletLink = w => `/v1/wallets/${w}`, commitmentLink = c => `/v1/commitments/${c}`;

export function fee(s) {
  const token = s.stakeToken ?? { mint: null, status: "unknown", source: null, note: "this record does not say which token fees are paid in" };
  return { perEntry: s.facts.feePerEntry ?? null, totalOwed: s.facts.totalOwed, token: { mint: token.mint ?? null, status: token.status, recoveredFrom: token.source ?? null, note: token.note },
    unit: token.mint ? `Base units of the stake token ${token.mint}, recovered from base history: the receipt itself does not name a token.` : "Base units of a stake token that is unknown: neither the receipt nor base history names it, so this fee cannot be compared with another season's." };
}
export function validator(v) {
  const status = v.status === "observed" || v.status === "unknown" || v.status === "conflicting" ? v.status : v.status.startsWith("unnamed") ? "unnamed" : "unknown";
  return { key: v.key ?? null, status, detail: v.status, sources: v.sources ?? [], ...(v.candidates ? { candidates: v.candidates } : {}), trustInput: true, note: v.note };
}
const flag = f => ({ kind: f.kind, detail: f.detail, info: !!f.info, firstSeenAt: f.firstSeenAt ?? null });
export const registryOf = (r, id) => { const g = r.registries?.[id]; return g ? { status: g.status, closed: g.closed ?? null, delegated: !!g.delegated, slot: g.slot ?? null, note: g.note } : { status: "unchecked", closed: null, delegated: false, slot: null, note: "this record has no registry check for this strategy yet" }; };

export function seasonSummary(s) {
  return { season: s.season, permalink: seasonLink(s.season), status: s.status, kind: s.kind, finals: s.finals ?? null, reason: s.reason ?? null, fieldSize: s.facts.fieldSize, distinctEntrantWallets: s.facts.distinctEntrantWallets, creator: s.facts.creator, creatorIsAlsoAnEntrant: s.facts.creatorIsAlsoAnEntrant,
    fee: fee(s), createdAt: s.createdAt ? { unixTime: s.createdAt.unixTime, basis: s.createdAt.source } : null, validator: validator(s.validator), flags: s.flags.map(flag), alarm: s.flags.some(f => !f.info) };
}
export const entry = e => ({ slot: e.slot, strategyId: e.strategyId, strategy: strategyLink(e.strategyId), owner: e.owner, wallet: walletLink(e.owner), codeCommitment: e.codeCommitment, commitment: commitmentLink(e.codeCommitment), rank: e.rank ?? null, seasonRank: e.seasonRank ?? null, finalist: e.finalist, published: e.published, scoreCommitment: e.scoreCommitment ?? null });

export function seasonDetail(r, s) {
  const notices = [NOTICE.validator, NOTICE.fee, NOTICE.counts, ...(s.status === "provisional" ? [NOTICE.provisional] : [])];
  return { ...head(r, seasonLink(s.season), notices), summary: seasonSummary(s),
    facts: { distinctCodeCommitments: s.facts.distinctCodeCommitments, publishedEntries: s.facts.publishedEntries, episodes: s.facts.episodes ?? null, finalsEpisodes: s.facts.finalsEpisodes, division: s.facts.division, bondLamports: s.facts.bondLamports, bondForfeitedLamports: s.facts.bondForfeitedLamports, totalRefunded: s.facts.totalRefunded, vmRules: s.facts.vmRules },
    receipt: { address: s.address, copy: { from: s.copy.from, sha256: s.copy.sha256, savedAt: s.copy.savedAt ?? null, finalizedSlot: s.copy.finalizedSlot ?? null }, currentSha256: s.current?.sha256 ?? null, historyProblem: s.history.problem ?? null,
      events: s.history.events.map(e => ({ type: e.type, slot: e.slot, signature: e.signature, ...(e.validator !== undefined ? { validator: e.validator } : {}) })) },
    entries: s.entries.map(entry) };
}
const row = x => ({ season: x.season, seasonPermalink: seasonLink(x.season), slot: x.slot, strategyId: x.strategyId, owner: x.owner, codeCommitment: x.codeCommitment, kind: x.kind, finals: x.finals ?? null, fieldSize: x.fieldSize, creator: x.creator, rank: x.rank ?? null, seasonRank: x.seasonRank ?? null, finalist: x.finalist, published: x.published, seasonFlagged: !!x.flagged });
const results = v => ({ final: (v?.final ?? []).map(row), provisional: (v?.provisional ?? []).map(row) });

export function strategyPage(r, id) {
  const v = r.views.strategies[id]; if (!v) return null; const registry = registryOf(r, id);
  const disclosure = registry.closed === true ? { closed: true, text: NOTICE.sealingClosed.text } : registry.closed === false ? { closed: false, text: "This strategy is open, so its salt and bytecode are not publicly readable. Closing it would make them permanently public from devnet's own transaction history, to anyone." } : { closed: null, text: "Whether this strategy has been closed could not be determined. If it has, its salt and bytecode are permanently and publicly readable from devnet's own transaction history, to anyone. This service does not serve or link them." };
  return { ...head(r, strategyLink(id), [registry.closed === true ? NOTICE.sealingClosed : NOTICE.sealing, NOTICE.ownerAtEntry]), strategyId: id, registry, disclosure, codeCommitments: v.codeCommitments, ownersAtEntry: v.ownersAtEntry, results: results(v), anomaly: v.codeCommitments.length > 1 ? "one strategy id appears with more than one code commitment" : null };
}
export function walletPage(r, w) {
  const v = r.views.wallets[w]; if (!v) return null; const ids = [...new Set([...v.final, ...v.provisional].map(x => x.strategyId))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return { ...head(r, walletLink(w), [NOTICE.ownerAtEntry, NOTICE.sealing]), wallet: w, strategies: ids.map(id => ({ strategyId: id, permalink: strategyLink(id), registry: registryOf(r, id) })), results: results(v) };
}
export function commitmentPage(r, c) {
  const v = r.views.commitments[c]; if (!v) return null;
  return { ...head(r, commitmentLink(c), [NOTICE.sealing, NOTICE.ownerAtEntry]), commitment: c, caveat: COMMITMENT_CAVEAT, strategyIds: v.strategyIds, ownersAtEntry: v.ownersAtEntry, results: results(v) };
}

const normKeys = list => (list ?? []).map(x => typeof x === "string" ? { key: x, note: "" } : { key: x.key, note: x.note ?? "" });
export function rulesView(src) { const x = src.rules; return { configured: src.configured, name: x.name ?? null, note: x.note ?? null, trustedCreators: normKeys(x.trustedCreators), trustedValidators: normKeys(x.trustedValidators), countVoidedFinals: x.countVoidedFinals !== false }; }
export function leaderboard(r, rulesSrc, { limit, offset }) {
  const out = evaluate(r, rulesSrc.rules); const by = new Map(r.seasons.map(s => [s.season, s])); const page = out.ranking.slice(offset, offset + limit);
  return { ...head(r, "/v1/leaderboard", [NOTICE.counts, NOTICE.validator, NOTICE.fee, NOTICE.sealing]), policy: { name: POLICY_NAME, version: POLICY_VERSION }, rules: rulesView(rulesSrc), rankingBasis: RANKING_BASIS, disclaimers: out.disclaimers,
    counted: out.counted.map(id => seasonSummary(by.get(id))), excluded: out.excluded.map(x => ({ season: x.season, permalink: seasonLink(x.season), reasons: x.reasons, summary: seasonSummary(by.get(x.season)) })),
    ranking: page.map(x => ({ position: x.position, strategyId: x.strategyId, permalink: strategyLink(x.strategyId), seasons: x.seasons, wins: x.wins, podiums: x.podiums, beatenShare: x.beaten, ownersAtEntry: x.ownersAtEntry, anomaly: !!x.anomaly, registry: registryOf(r, x.strategyId) })), page: { limit, offset, total: out.ranking.length } };
}
export function seasonList(r, { status, kind, creator, order, limit, offset }) {
  let list = r.seasons.filter(s => (!status || s.status === status) && (!kind || s.kind === kind) && (!creator || s.facts.creator === creator)); if (order === "desc") list = [...list].reverse();
  return { ...head(r, "/v1/seasons", [NOTICE.validator, NOTICE.fee]), seasons: list.slice(offset, offset + limit).map(seasonSummary), page: { limit, offset, total: list.length } };
}
export function legacy(r) {
  return { ...head(r, "/v1/legacy", [NOTICE.legacy]), label: r.legacy.label, verified: false, receipts: r.legacy.receipts.map(x => ({ address: x.address, season: x.season, format: x.format, size: x.size, delegated: x.delegated, label: x.label, entries: x.entries.map(e => ({ strategyId: e.id, commitment: e.commitment ?? null })) })), unverifiable: r.rejected.map(x => ({ address: x.address, reason: x.reason })) };
}

/** `chain` is the one live read the API makes: the current finalized slot, for freshness only */
export function status({ record, st, problem, genesis, program, staleAfterSeconds, rulesConfigured, chain, nowMs }) {
  const age = record ? Math.max(0, Math.floor((nowMs - Date.parse(record.builtAt)) / 1000)) : null; const sl = chain.currentSlot != null && record?.currentTo?.slot != null ? chain.currentSlot - record.currentTo.slot : null;
  return { apiVersion: "v1", permalink: "/v1/status", notices: [],
    store: { configured: problem !== "store_not_configured", usable: !!record, problem: problem ?? null, genesis: record?.genesis ?? genesis ?? null, program: record?.program ?? program ?? null, recordVersion: record?.version ?? null, builtAt: record?.builtAt ?? null, ageSeconds: age, stale: age == null ? null : age > staleAfterSeconds, staleAfterSeconds,
      currentTo: record?.currentTo ? { slot: record.currentTo.slot ?? null, at: record.currentTo.at } : null, lastSweep: record?.service?.lastSweep ? { at: record.service.lastSweep.at, slot: record.service.lastSweep.slot ?? null } : null, nextSweepAt: st?.nextSweepAt ?? null,
      service: st ? { state: st.state, updatedAt: st.updatedAt, cycles: st.cycles ?? 0, lastError: st.lastError ? { at: st.lastError.at, message: st.lastError.message, rateLimitedUntil: st.lastError.rateLimited ?? null } : null } : null,
      counts: record ? { final: record.counts.final, provisional: record.counts.provisional, legacy: record.counts.legacy, empty: record.counts.empty, rejected: record.counts.rejected } : null, archive: record ? { copies: record.archive.copies, sha256: record.archive.sha256, recordSha256: record.archive.recordSha256 } : null, ledger: record?.ledger ? { entries: record.ledger.entries, head: record.ledger.head } : null,
      alarms: { record: (record?.seasons ?? []).flatMap(s => s.flags.filter(f => !f.info).map(f => ({ season: s.season, kind: f.kind, detail: f.detail }))), backup: (st?.backup?.alarms ?? []).map(a => ({ kind: a.kind, address: a.address ?? null, detail: a.detail })) }, backupConfigured: st?.backup ? !!st.backup.configured : null },
    chain: { currentSlot: chain.currentSlot ?? null, lagSlots: sl, checkedAt: chain.checkedAt ?? null, error: chain.error ?? null }, rules: { configured: rulesConfigured } };
}
