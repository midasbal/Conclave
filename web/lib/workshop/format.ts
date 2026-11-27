/** vol-units to one decimal, always signed: a score is a gain or a loss */
export const vol = (v: number | null | undefined, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}` : "n/a");
export const pct = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}%` : "n/a");
export const whole = (v: number) => String(Math.round(v * 10) / 10);
/** raw fixed point, as ca_season returns it, to vol-units: 65,536 raw units make one */
export const fromFixed = (raw: string) => Number(BigInt(raw)) / 65536;
