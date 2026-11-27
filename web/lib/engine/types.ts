// The shapes the engine returns, as crates/conclave-author writes them (source.rs, sim.rs). Numbers in a report are already in vol-units;
// season totals from ca_season are raw fixed point, as decimal strings, with 65,536 to one vol-unit.
export type Diagnostic = { line: number; col: number; msg: string };

export type Assembly = {
  ok: boolean;
  format: number;
  ruleset: number;
  name: string | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  ops: { line: number; op: string; work: number; text: string; bytes: string }[];
  work: number;
  work_cap: number;
  division: number | null;
  registers: { name: string; reg: number }[];
  bytecode: string | null;
  code_sha256: string | null;
  canonical: string;
};

export type Spread = { n: number; mean: number; sd: number; min: number; p5: number; p25: number; p50: number; p75: number; p95: number; max: number; positive_share: number; cvar5: number };

export type Ensemble = { label: string; worlds: number; episodes_per_world: number; base: string; season_total: Spread; episode: Spread; edge_t: number; ci90_mean: [number, number]; ruin_rate: number };

export type SimReport = {
  work: number;
  division: number | null;
  ops: number;
  code_sha256: string;
  config: { worlds: number; episodes: number; base: string; field: boolean; pack_episodes: number };
  dev: Ensemble;
  holdout: Ensemble;
  dev_vs_holdout_z: number;
  luck_gap_pct: number;
  packs: { pack: number; n: number; mean: number; win_rate: number; ruin_rate: number }[];
  regimes: { regime: number; name: string; tick_share: number; held_share: number; pnl_per_tick: number }[] | null;
  turnover_per_tick: number;
  cost_share_of_gross: number;
  held_share: number;
  field: { size: number; median_rank: number; p25_rank: number; p75_rank: number; top_tenth_share: number; top_half_share: number } | null;
  fragility: string[];
};

export type SimResult = { report: SimReport; raw: string; fingerprint: string; ms: number };

/** one season played together: totals[k][i] is strategy i's raw total after k + 1 episodes */
export type SeasonResult = { packs: [number, number]; totals: string[][]; ms: number };
