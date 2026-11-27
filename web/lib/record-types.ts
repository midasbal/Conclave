// The parts of the record API's responses that these pages read. The full contract is server/src/api/schema.mjs.
export type AsOf = { slot: number | null; builtAt: string };
export type Flag = { kind: string; detail: string; info: boolean; firstSeenAt: string | null };
export type Fee = { perEntry: string | null; totalOwed: string; token: { mint: string | null; status: "observed" | "unknown" } };
export type Validator = { key: string | null; status: "observed" | "unknown" | "unnamed" | "conflicting" };

export type SeasonSummary = {
  season: string;
  status: "final" | "provisional";
  kind: "settled" | "cancelled";
  finals: "none" | "played" | "voided" | null;
  reason: string | null;
  fieldSize: number;
  distinctEntrantWallets: number;
  creator: string;
  creatorIsAlsoAnEntrant: boolean;
  fee: Fee;
  createdAt: { unixTime: number } | null;
  validator: Validator;
  flags: Flag[];
};

export type SeasonList = { apiVersion: "v1"; asOf: AsOf; seasons: SeasonSummary[]; page: { total: number } };

export type Entry = { slot: number; strategyId: string; owner: string; codeCommitment: string; rank: number | null; seasonRank: number | null };

export type SeasonDetail = {
  apiVersion: "v1";
  asOf: AsOf;
  summary: SeasonSummary;
  facts: { episodes: number | null; finalsEpisodes: number; totalRefunded: string };
  receipt: {
    address: string;
    copy: { sha256: string; savedAt: string | null };
    events: { type: "created" | "delegated" | "bond-released"; signature: string }[];
  };
  entries: Entry[];
};
