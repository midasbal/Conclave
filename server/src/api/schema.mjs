// THE CONTRACT. Every response of the v1 API is described here, in JSON Schema, and nowhere else: the router takes its routes and cache policy from this file, the OpenAPI document is generated from it, and the
// tests validate every response against it. A response with a field that is not listed here is a contract failure (additionalProperties is false everywhere), so the contract cannot drift without this file changing.
// No field anywhere is named salt, code, bytecode or source: nothing in this API can carry a strategy's secrets.
const str = (extra = {}) => ({ type: "string", ...extra }), int = (extra = {}) => ({ type: "integer", ...extra }), bool = { type: "boolean" }, num = { type: "number" };
const nullable = s => ({ anyOf: [s, { type: "null" }] }); const ref = n => ({ $ref: `#/$defs/${n}` }); const arr = items => ({ type: "array", items }); const enm = (...v) => ({ type: "string", enum: v });
const obj = (props, { optional = [] } = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter(k => !optional.includes(k)), additionalProperties: false });
const PUBKEY = "^[1-9A-HJ-NP-Za-km-z]{32,44}$", SIG = "^[1-9A-HJ-NP-Za-km-z]{80,90}$", HEX32 = "^[0-9a-f]{64}$", U64 = "^[0-9]{1,20}$", I64 = "^-?[0-9]{1,20}$", ISO = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$";

export const defs = {
  Pubkey: str({ pattern: PUBKEY }), Hex32: str({ pattern: HEX32 }), Signature: str({ pattern: SIG }), DecimalU64: str({ pattern: U64 }), DecimalI64: str({ pattern: I64 }), IsoTime: str({ pattern: ISO }),
  Notice: obj({ id: enm("sealing-disclosure", "validator-trust-input", "fee-token", "counts-not-proof", "legacy-not-verified", "provisional", "owner-at-entry"), text: str({ minLength: 20 }) }),
  AsOf: obj({ slot: nullable(int({ minimum: 0 })), builtAt: ref("IsoTime"), recordVersion: int({ const: 2 }), archive: obj({ copies: int({ minimum: 0 }), sha256: ref("Hex32"), recordSha256: ref("Hex32") }), ledgerHead: nullable(ref("Hex32")) }),
  Page: obj({ limit: int({ minimum: 1 }), offset: int({ minimum: 0 }), total: int({ minimum: 0 }) }),

  StakeToken: obj({ mint: nullable(ref("Pubkey")), status: enm("observed", "unknown"), recoveredFrom: nullable(str()), note: str() }),
  Fee: obj({ perEntry: nullable(ref("DecimalU64")), totalOwed: ref("DecimalU64"), token: ref("StakeToken"), unit: str({ minLength: 20 }) }),
  Validator: obj({ key: nullable(ref("Pubkey")), status: enm("observed", "unknown", "unnamed", "conflicting"), detail: str(), sources: arr(str()), candidates: arr(ref("Pubkey")), trustInput: { const: true }, note: str() }, { optional: ["candidates"] }),
  Flag: obj({ kind: str(), detail: str(), info: bool, firstSeenAt: nullable(ref("IsoTime")) }),
  Registry: obj({ status: enm("open", "closed", "retired", "unknown", "unchecked"), closed: nullable(bool), delegated: bool, slot: nullable(int({ minimum: 0 })), note: str() }),
  CreatedAt: nullable(obj({ unixTime: int({ minimum: 0 }), basis: str() })),

  SeasonSummary: obj({
    season: ref("DecimalU64"), permalink: str({ pattern: "^/v1/seasons/[0-9]{1,20}$" }), status: enm("final", "provisional"), kind: enm("settled", "cancelled"), finals: nullable(enm("none", "played", "voided")), reason: nullable(str()),
    fieldSize: int({ minimum: 0, maximum: 20 }), distinctEntrantWallets: int({ minimum: 0, maximum: 20 }), creator: ref("Pubkey"), creatorIsAlsoAnEntrant: bool, fee: ref("Fee"), createdAt: ref("CreatedAt"), validator: ref("Validator"), flags: arr(ref("Flag")), alarm: bool,
  }),
  SeasonEvent: obj({ type: enm("created", "delegated", "bond-released"), slot: int({ minimum: 0 }), signature: ref("Signature"), validator: nullable(ref("Pubkey")) }, { optional: ["validator"] }),
  Entry: obj({
    slot: int({ minimum: 0, maximum: 19 }), strategyId: ref("DecimalU64"), strategy: str({ pattern: "^/v1/strategies/[0-9]{1,20}$" }), owner: ref("Pubkey"), wallet: str({ pattern: "^/v1/wallets/" }), codeCommitment: ref("Hex32"), commitment: str({ pattern: "^/v1/commitments/[0-9a-f]{64}$" }),
    rank: nullable(int({ minimum: 1 })), seasonRank: nullable(int({ minimum: 1 })), finalist: bool, published: bool, scoreCommitment: nullable(ref("Hex32")),
  }),
  SeasonDetail: obj({
    apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")),
    summary: ref("SeasonSummary"),
    facts: obj({ distinctCodeCommitments: int({ minimum: 0 }), publishedEntries: int({ minimum: 0 }), episodes: nullable(int({ minimum: 1 })), finalsEpisodes: int({ minimum: 0 }), division: int({ minimum: 0 }), bondLamports: ref("DecimalU64"), bondForfeitedLamports: ref("DecimalU64"), totalRefunded: ref("DecimalU64"), vmRules: str({ pattern: "^[0-9a-f]+$" }) }),
    receipt: obj({ address: ref("Pubkey"), copy: obj({ from: str(), sha256: ref("Hex32"), savedAt: nullable(ref("IsoTime")), finalizedSlot: nullable(int({ minimum: 0 })) }), currentSha256: nullable(ref("Hex32")), historyProblem: nullable(str()), events: arr(ref("SeasonEvent")) }),
    entries: arr(ref("Entry")),
  }),
  HistoryRow: obj({
    season: ref("DecimalU64"), seasonPermalink: str(), slot: int({ minimum: 0 }), strategyId: ref("DecimalU64"), owner: ref("Pubkey"), codeCommitment: ref("Hex32"), kind: enm("settled", "cancelled"), finals: nullable(enm("none", "played", "voided")), fieldSize: int({ minimum: 0 }), creator: ref("Pubkey"),
    rank: nullable(int({ minimum: 1 })), seasonRank: nullable(int({ minimum: 1 })), finalist: bool, published: bool, seasonFlagged: bool,
  }),
  Results: obj({ final: arr(ref("HistoryRow")), provisional: arr(ref("HistoryRow")) }),
  StrategyPage: obj({
    apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")), strategyId: ref("DecimalU64"), registry: ref("Registry"),
    disclosure: obj({ closed: nullable(bool), text: str({ minLength: 20 }) }), codeCommitments: arr(ref("Hex32")), ownersAtEntry: arr(ref("Pubkey")), results: ref("Results"), anomaly: nullable(str()),
  }),
  WalletStrategy: obj({ strategyId: ref("DecimalU64"), permalink: str(), registry: ref("Registry") }),
  WalletPage: obj({ apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")), wallet: ref("Pubkey"), strategies: arr(ref("WalletStrategy")), results: ref("Results") }),
  CommitmentPage: obj({ apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")), commitment: ref("Hex32"), caveat: str({ minLength: 20 }), strategyIds: arr(ref("DecimalU64")), ownersAtEntry: arr(ref("Pubkey")), results: ref("Results") }),

  Rules: obj({ configured: bool, name: nullable(str()), note: nullable(str()), trustedCreators: arr(obj({ key: ref("Pubkey"), note: str() })), trustedValidators: arr(obj({ key: ref("Pubkey"), note: str() })), countVoidedFinals: bool }),
  RankRow: obj({ position: int({ minimum: 1 }), strategyId: ref("DecimalU64"), permalink: str(), seasons: int({ minimum: 1 }), wins: int({ minimum: 0 }), podiums: int({ minimum: 0 }), beatenShare: num, ownersAtEntry: arr(ref("Pubkey")), anomaly: bool, registry: ref("Registry") }),
  ExcludedSeason: obj({ season: ref("DecimalU64"), permalink: str(), reasons: arr(str()), summary: ref("SeasonSummary") }),
  Leaderboard: obj({
    apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")),
    policy: obj({ name: str(), version: int({ minimum: 1 }) }), rules: ref("Rules"), rankingBasis: str({ minLength: 20 }), disclaimers: arr(str()),
    counted: arr(ref("SeasonSummary")), excluded: arr(ref("ExcludedSeason")), ranking: arr(ref("RankRow")), page: ref("Page"),
  }),
  SeasonList: obj({ apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")), seasons: arr(ref("SeasonSummary")), page: ref("Page") }),
  LegacyReceipt: obj({ address: ref("Pubkey"), season: ref("DecimalU64"), format: int({ enum: [1, 2] }), size: int(), delegated: bool, label: str(), entries: arr(obj({ strategyId: ref("DecimalU64"), commitment: nullable(ref("Hex32")) })) }),
  Legacy: obj({
    apiVersion: { const: "v1" }, asOf: ref("AsOf"), permalink: str(), notices: arr(ref("Notice")), label: str({ minLength: 20 }), verified: { const: false },
    receipts: arr(ref("LegacyReceipt")), unverifiable: arr(obj({ address: ref("Pubkey"), reason: str() })),
  }),
  Status: obj({
    apiVersion: { const: "v1" }, permalink: str(), notices: arr(ref("Notice")),
    store: obj({ configured: bool, usable: bool, problem: nullable(str()), genesis: nullable(str()), program: nullable(ref("Pubkey")), recordVersion: nullable(int()), builtAt: nullable(ref("IsoTime")), ageSeconds: nullable(int({ minimum: 0 })), stale: nullable(bool), staleAfterSeconds: int({ minimum: 1 }),
      currentTo: nullable(obj({ slot: nullable(int({ minimum: 0 })), at: ref("IsoTime") })), lastSweep: nullable(obj({ at: ref("IsoTime"), slot: nullable(int({ minimum: 0 })) })), nextSweepAt: nullable(ref("IsoTime")), service: nullable(obj({ state: str(), updatedAt: ref("IsoTime"), cycles: int({ minimum: 0 }), lastError: nullable(obj({ at: ref("IsoTime"), message: str(), rateLimitedUntil: nullable(int()) })) })),
      counts: nullable(obj({ final: int(), provisional: int(), legacy: int(), empty: int(), rejected: int() })), archive: nullable(obj({ copies: int({ minimum: 0 }), sha256: ref("Hex32"), recordSha256: ref("Hex32") })), ledger: nullable(obj({ entries: int({ minimum: 0 }), head: ref("Hex32") })),
      alarms: obj({ record: arr(obj({ season: ref("DecimalU64"), kind: str(), detail: str() })), backup: arr(obj({ kind: str(), address: nullable(str()), detail: str() })) }), backupConfigured: nullable(bool) }),
    chain: obj({ currentSlot: nullable(int({ minimum: 0 })), lagSlots: nullable(int()), checkedAt: nullable(ref("IsoTime")), error: nullable(str()) }),
    rules: obj({ configured: bool }),
  }),

  ProofCheck: obj({ name: str(), ok: bool, detail: str() }, { optional: ["detail"] }),
  ProofResult: obj({
    apiVersion: { const: "v1" }, level: enm("recorded", "wallet", "totals"), verified: bool, checks: arr(ref("ProofCheck")), blockers: arr(str()), establishes: arr(str()), doesNot: arr(str()),
    receipt: obj({ address: ref("Pubkey"), status: enm("final", "provisional"), from: str(), sha256: ref("Hex32"), alarms: arr(str()) }), entry: nullable(ref("Entry")), claimed: nullable(obj({ total: ref("DecimalI64"), finalsTotal: ref("DecimalI64") })), notes: arr(str()),
  }),
  ChallengeIssued: obj({
    apiVersion: { const: "v1" }, singleUse: { const: true }, expiresAt: ref("IsoTime"), challenge: obj({ type: { const: "conclave-wallet-challenge" }, genesis: str(), program: ref("Pubkey"), season: ref("DecimalU64"), strategyId: ref("DecimalU64"), askedBy: str(), nonce: ref("Hex32"), issuedAt: ref("IsoTime"), expiresAt: ref("IsoTime") }),
    signThis: obj({ encoding: { const: "base64" }, bytes: str({ minLength: 8 }), text: str({ minLength: 8 }), howTo: str() }), verifyAt: { const: "/v1/proofs/wallet/verify" }, signatureEncoding: { const: "hex" },
  }),
  ProofLevels: obj({ apiVersion: { const: "v1" }, levels: arr(obj({ level: int({ minimum: 1, maximum: 4 }), name: enm("recorded", "wallet", "totals", "code"), where: enm("server", "browser-or-cli"), endpoint: nullable(str()), establishes: arr(str()), doesNot: arr(str()) })), level4: str({ minLength: 20 }) }),

  RecordedRequest: obj({ season: ref("DecimalU64"), strategyId: ref("DecimalU64"), codeCommitment: ref("Hex32"), allowProvisional: bool }, { optional: ["codeCommitment", "allowProvisional"] }),
  TotalsRequest: obj({ season: ref("DecimalU64"), strategyId: ref("DecimalU64"), slot: int({ minimum: 0, maximum: 19 }), total: ref("DecimalI64"), finalsTotal: ref("DecimalI64"), scoreSalt: ref("Hex32"), allowProvisional: bool }, { optional: ["slot", "allowProvisional"] }),
  ChallengeRequest: obj({ season: ref("DecimalU64"), strategyId: ref("DecimalU64"), askedBy: str({ minLength: 3, maxLength: 120 }) }),
  WalletVerifyRequest: obj({ nonce: ref("Hex32"), signature: str({ pattern: "^[0-9a-f]{128}$" }), allowProvisional: bool }, { optional: ["allowProvisional"] }),
  ErrorBody: obj({ apiVersion: { const: "v1" }, error: obj({ type: str({ pattern: "^[a-z0-9_]+$" }), message: str({ minLength: 3 }) }) }),
};

const LONG = "public, max-age=3600", DATA = "public, max-age=30, s-maxage=60, stale-while-revalidate=300", NO = "no-store";
/** Every route. `response` names a def. `cache` is the Cache-Control of a 200: this is public data that changes at most once a poll, so it is shareable and revalidated with an ETag; a proof or a challenge is never cached */
export const routes = [
  { id: "leaderboard", method: "GET", path: "/v1/leaderboard", response: "Leaderboard", cache: DATA, query: ["limit", "offset"], summary: "The counting policy's output: the ranking, every excluded season with its reasons, and the exact rules in force." },
  { id: "seasons", method: "GET", path: "/v1/seasons", response: "SeasonList", cache: DATA, query: ["status", "kind", "creator", "order", "limit", "offset"], summary: "Every season in the verified record, with its raw facts." },
  { id: "season", method: "GET", path: "/v1/seasons/{season}", response: "SeasonDetail", cache: DATA, summary: "One season: raw facts, entries, the validator as a trust input, and flags." },
  { id: "strategy", method: "GET", path: "/v1/strategies/{id}", response: "StrategyPage", cache: DATA, summary: "A strategy by its permanent id: full history, the owner at each entry, whether it is closed, and flags." },
  { id: "wallet", method: "GET", path: "/v1/wallets/{pubkey}", response: "WalletPage", cache: DATA, summary: "Results by the owner recorded on each receipt." },
  { id: "commitment", method: "GET", path: "/v1/commitments/{commitment}", response: "CommitmentPage", cache: DATA, summary: "Results grouped by code commitment (same salt and bytecode only)." },
  { id: "legacy", method: "GET", path: "/v1/legacy", response: "Legacy", cache: DATA, summary: "Receipts of earlier builds, labelled as not verified history." },
  { id: "status", method: "GET", path: "/v1/status", response: "Status", cache: "public, max-age=5", summary: "Freshness, last build, alarms and archive digests." },
  { id: "proofLevels", method: "GET", path: "/v1/proofs", response: "ProofLevels", cache: LONG, summary: "The four proof levels, what each establishes and does not, and where each runs." },
  { id: "proofRecorded", method: "POST", path: "/v1/proofs/recorded", request: "RecordedRequest", response: "ProofResult", cache: NO, summary: "Level 1, stateless: the receipt lists this strategy (and commitment)." },
  { id: "proofTotals", method: "POST", path: "/v1/proofs/totals", request: "TotalsRequest", response: "ProofResult", cache: NO, summary: "Level 3, stateless: the score commitment binds these totals, given the season's score salt." },
  { id: "proofChallenge", method: "POST", path: "/v1/proofs/wallet/challenges", request: "ChallengeRequest", response: "ChallengeIssued", cache: NO, summary: "Level 2, step 1: a single-use, expiring challenge to sign with the entering wallet." },
  { id: "proofWallet", method: "POST", path: "/v1/proofs/wallet/verify", request: "WalletVerifyRequest", response: "ProofResult", cache: NO, summary: "Level 2, step 2: the signature over that challenge." },
  { id: "proofCode", method: "POST", path: "/v1/proofs/code", response: "ErrorBody", cache: NO, status: 422, summary: "Level 4 is never accepted here: it runs in the browser or CLI, and the server never receives a salt or code." },
  { id: "openapi", method: "GET", path: "/v1/openapi.json", response: null, cache: LONG, summary: "This contract as an OpenAPI 3.1 document." },
];

const toOpenApiRef = x => JSON.parse(JSON.stringify(x).replaceAll("#/$defs/", "#/components/schemas/"));
/** the contract as OpenAPI 3.1, generated, never written by hand */
export function openapi() {
  const paths = {}; const params = { season: "Decimal season id", id: "Decimal strategy id", pubkey: "Base58 wallet", commitment: "Lowercase hex, 64 characters" };
  for (const r of routes) {
    const p = (r.path.match(/\{(\w+)\}/g) ?? []).map(m => m.slice(1, -1)).map(n => ({ name: n, in: "path", required: true, description: params[n], schema: { type: "string" } })); const q = (r.query ?? []).map(n => ({ name: n, in: "query", required: false, schema: { type: n === "limit" || n === "offset" ? "integer" : "string" } }));
    const ok = r.response ? { description: "OK", headers: { "Cache-Control": { schema: { type: "string", const: r.cache } }, ...(r.cache === NO ? {} : { ETag: { schema: { type: "string" } } }) }, content: { "application/json": { schema: { $ref: `#/components/schemas/${r.response}` } } } } : { description: "OK", content: { "application/json": { schema: { type: "object" } } } };
    paths[r.path] ??= {}; paths[r.path][r.method.toLowerCase()] = { operationId: r.id, summary: r.summary, parameters: [...p, ...q], ...(r.request ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${r.request}` } } } } } : {}),
      responses: { [String(r.status ?? 200)]: ok, ...(r.status === 422 ? {} : { "400": { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } }, "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } }, "503": { description: "No usable record store", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } } }) } };
  }
  return { openapi: "3.1.0", info: { title: "Conclave record API", version: "v1", description: "Public, read-only. Everything here is derived from public on-chain receipts. No secret, no rollup token and no strategy code is ever served or accepted." }, paths, components: { schemas: toOpenApiRef(defs) } };
}
