// Reads the public record API (docs/API.md) from the SERVER only: a server component calls these, so the browser never talks to the API and there is
// nothing for CORS to refuse. The base address is the environment variable CONCLAVE_API_URL (no NEXT_PUBLIC_ prefix: it is never sent to a browser).
//
// Caching: each address is read at most once every REVALIDATE_SECONDS; requests in between are answered from Next's data cache. Only successful
// answers are cached. When a refresh fails, the last good answer keeps being served, so the pages also show when the record was built.
import type { SeasonDetail, SeasonList } from "./record-types";

export const REVALIDATE_SECONDS = 60;
const TIMEOUT_MS = 6000;
const LIST_LIMIT = 200; // the API's largest page

export type Problem =
  | "unconfigured"   // CONCLAVE_API_URL is not set, or is not an address
  | "unreachable"    // no answer in time, or an error answer
  | "no-record"      // the service answers but has no usable record yet
  | "not-found"      // the record holds no such season
  | "unexpected";    // an answer that is not the record API's

export type Result<T> = { ok: true; data: T } | { ok: false; problem: Problem };

/** the configured base, without a trailing slash (or a trailing /v1, which is an easy thing to paste in) */
function base(): string | null {
  const raw = process.env.CONCLAVE_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
  } catch {
    return null;
  }
}

/** logged on the server for the operator; a visitor is told only the kind of problem */
function fail(problem: Problem, why: string): { ok: false; problem: Problem } {
  console.warn(`record API: ${problem}: ${why}`);
  return { ok: false, problem };
}

async function read<T>(path: string, looksRight: (body: unknown) => boolean): Promise<Result<T>> {
  const root = base();
  if (!root) return fail("unconfigured", "CONCLAVE_API_URL is unset or is not an http(s) address");
  let res: Response;
  try {
    res = await fetch(root + path, { headers: { accept: "application/json" }, next: { revalidate: REVALIDATE_SECONDS }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return fail("unreachable", `${path}: ${e instanceof Error ? e.name : "request failed"}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail(res.ok ? "unexpected" : "unreachable", `${path}: HTTP ${res.status}, not JSON`);
  }
  const type = (body as { error?: { type?: string } } | null)?.error?.type;
  if (res.status === 404 && type === "season_not_in_record") return { ok: false, problem: "not-found" };
  if (res.status === 503 && typeof type === "string" && type.startsWith("store_")) return fail("no-record", `${path}: ${type}`);
  if (!res.ok) return fail("unreachable", `${path}: HTTP ${res.status}`);
  if (!looksRight(body)) return fail("unexpected", `${path}: HTTP 200 with an unfamiliar shape`);
  return { ok: true, data: body as T };
}

// Enough of a check that a wrong address or another service cannot be drawn as a record. The contract itself is enforced by the API's own tests.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEnvelope = (v: unknown) => isObject(v) && v.apiVersion === "v1" && isObject(v.asOf) && typeof v.asOf.builtAt === "string";
const isSummary = (s: unknown) => isObject(s) && typeof s.season === "string" && (s.kind === "settled" || s.kind === "cancelled") && (s.status === "final" || s.status === "provisional")
  && typeof s.fieldSize === "number" && typeof s.creator === "string" && isObject(s.fee) && isObject(s.validator) && Array.isArray(s.flags);

export const readSeasons = () =>
  read<SeasonList>(`/v1/seasons?limit=${LIST_LIMIT}&order=desc`, v => isEnvelope(v) && Array.isArray((v as SeasonList).seasons) && (v as SeasonList).seasons.every(isSummary) && isObject((v as SeasonList).page));

/** id must already be known to be digits: it goes into the path */
export const readSeason = (id: string) =>
  read<SeasonDetail>(`/v1/seasons/${id}`, v => {
    const d = v as SeasonDetail;
    return isEnvelope(v) && isSummary(d.summary) && isObject(d.facts) && isObject(d.receipt) && Array.isArray(d.receipt.events) && Array.isArray(d.entries)
      && d.entries.every(e => typeof e.strategyId === "string" && typeof e.codeCommitment === "string" && typeof e.owner === "string" && typeof e.slot === "number");
  });
