// POST /api/drip: asks the operator service to send a visitor's fresh key a little devnet SOL. The browser talks only to this route: the operator's
// address and the shared secret are read here, on the server, and never reach a page (as with CONCLAVE_API_URL). Only a public address goes through.
// A request's other fields are not forwarded: the route builds the body itself, so a secret sent here by mistake stops here, unlogged.
import { PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** the operator waits up to 40 s for devnet to confirm */
export const maxDuration = 60;
const TIMEOUT_MS = 55_000;
const MAX_BODY = 1024;

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (status: number, code: string, message: string, retryable = false) => answer(status, { error: { code, message, retryable } });

function walletAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()) ? value : null;
  } catch {
    return null;
  }
}

/** the visitor's address, for the operator's per-address limit. It is a SOFT signal: it is as true as the platform in front of this route makes it
 *  (Vercel documents that it sets x-forwarded-for itself; another host may pass on whatever the visitor wrote), and addresses are cheap to change.
 *  The operator's daily cap is the limit that holds */
function visitorAddress(request: Request): string {
  const first = (name: string) => (request.headers.get(name) ?? "").split(",")[0].trim();
  const value = first("x-forwarded-for") || first("x-real-ip");
  return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : "";
}

function operatorEndpoint(): URL | null {
  const raw = (process.env.OPERATOR_API_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.replace(/\/+$/, "") + "/drip");
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** only the shapes the operator documents are passed back, field by field: nothing else it might say reaches the browser */
function relay(status: number, body: unknown): Response | null {
  const b = body as Record<string, unknown> | null;
  if (status === 200 && b?.status === "funded" && typeof b.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.signature) && Number.isSafeInteger(b.lamports)) return answer(200, { status: "funded", signature: b.signature, lamports: b.lamports });
  if (status === 200 && b?.status === "already-funded" && Number.isSafeInteger(b.balanceLamports)) return answer(200, { status: "already-funded", balanceLamports: b.balanceLamports });
  const error = b?.error as Record<string, unknown> | undefined;
  if (status >= 400 && status < 600 && typeof error?.code === "string" && /^[a-z-]{1,40}$/.test(error.code) && typeof error.message === "string") return failure(status, error.code, error.message.slice(0, 200), error.retryable === true);
  return null;
}

export async function POST(request: Request): Promise<Response> {
  // JSON only, and only from this site's own pages: another site cannot send JSON here without a preflight, which this route does not grant
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "bad-request", "Send JSON.");
  const origin = request.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* not a URL: refused below */ }
    if (host !== request.headers.get("host")) return failure(403, "cross-origin", "Not allowed from another site.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY) return failure(413, "too-large", "The request is too large.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return failure(400, "bad-request", "The body is not valid JSON."); }
  const pubkey = walletAddress((body as { pubkey?: unknown } | null)?.pubkey);
  if (!pubkey) return failure(400, "bad-address", "That is not a Solana wallet address.");

  const endpoint = operatorEndpoint();
  if (!endpoint) return failure(503, "not-configured", "Funding is not set up on this site.");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = (process.env.OPERATOR_SHARED_SECRET ?? "").trim();
  if (secret) headers["X-Operator-Secret"] = secret;
  const ip = visitorAddress(request);
  if (ip) {
    // x-forwarded-for as is conventional, and the same again under our own name: a proxy in front of the operator may rewrite the former, and the
    // operator believes the latter only from a caller holding the shared secret
    headers["X-Forwarded-For"] = ip;
    headers["X-Conclave-Client-Ip"] = ip;
  }

  try {
    // a redirect is an error: the secret must not follow one elsewhere
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ pubkey }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 401) {
      console.warn("operator: it refused this site's shared secret; check OPERATOR_SHARED_SECRET on both services");
      return failure(502, "misconfigured", "Funding is not set up correctly on this site.");
    }
    const relayed = relay(response.status, await response.json().catch(() => null));
    if (relayed) return relayed;
    console.warn(`operator: an answer this site does not understand, HTTP ${response.status}`);
    return failure(502, "operator-error", "The funding service gave an unreadable answer. Try again.", true);
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    console.warn(`operator: ${timedOut ? "no answer in time" : "unreachable"}`);
    return timedOut
      ? failure(504, "operator-timeout", "The funding service did not answer in time. Try again: the same address is not paid twice.", true)
      : failure(502, "operator-unreachable", "The funding service could not be reached. Try again.", true);
  }
}
