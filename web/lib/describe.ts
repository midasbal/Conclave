// The record's codes, in words.
import type { SeasonSummary } from "./record-types";

const CANCELLED: Record<string, string> = {
  under_minimum: "Cancelled: too few entrants",
  seed_timeout: "Cancelled: no random seed in time",
  creator: "Cancelled by its creator",
  season_deadline: "Cancelled: the run missed its deadline",
};
const VOIDED: Record<string, string> = {
  finals_seed_timeout: "no seed for the finals in time",
  finals_deadline: "the finals missed their deadline",
  finals_too_few_qualifiers: "fewer than two entries qualified",
};

export function outcome(s: SeasonSummary): string {
  if (s.kind === "cancelled") return (s.reason && CANCELLED[s.reason]) || "Cancelled";
  if (s.finals === "played") return "Settled after finals";
  if (s.finals === "voided") return `Settled, finals void${s.reason && VOIDED[s.reason] ? `: ${VOIDED[s.reason]}` : ""}`;
  return "Settled";
}

export const entrants = (n: number) => (n === 0 ? "no entrants" : n === 1 ? "1 entrant" : `${n} entrants`);
export const units = (n: string) => (n === "1" ? "1 unit" : `${n} units`);
export const fee = (perEntry: string | null) => (perEntry === null ? "none recorded" : `${perEntry} stake ${perEntry === "1" ? "unit" : "units"}`);
export const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
export const day = (unixTime: number) => new Date(unixTime * 1000).toISOString().slice(0, 10);
export const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** how long ago, coarsely */
export function age(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h < 48) return h === 1 ? "an hour" : `${h} hours`;
  return `${Math.floor(h / 24)} days`;
}
