// The OWNER's side: make a level 3 or level 4 reveal from a recovery bundle. It needs the client's dependencies (npm ci in client/) for the bundle format. Verifying never needs this file.
import fs from "fs";
import { scoreSaltOf, verifyCode, verifyTotals, entryOf } from "./proofs.mjs";

export async function openOwnBundle(file, passphrase) { const C = await import("../../client/custody.mjs"); const o = C.openBundle(fs.readFileSync(file), passphrase); return { id: String(o.public.id), salt: Buffer.from(o.salt).toString("hex"), code: Buffer.from(o.code).toString("hex"), program: o.public.program, genesis: o.public.cluster.genesisHash }; }

/** a reveal is only written if it verifies against the receipt the prover just read */
export function makeReveal(level, found, secret, { genesis, program, author, localVmRules = null }) {
  const { season, seeds } = found; const e = entryOf(season, { id: secret.id }); if (!e) throw new Error("this strategy is not on that receipt");
  const head = { genesis, program, season: season.season, strategyId: e.strategyId, slot: e.slot };
  const code = verifyCode(season, seeds, { id: secret.id, slot: e.slot, salt: secret.salt, code: secret.code }, { author, localVmRules });
  if (!code.verified) throw new Error("this salt and code do not verify against the receipt: " + code.checks.filter(c => !c.ok).map(c => c.name).join("; "));
  if (level === "code") return { type: "conclave-code-reveal", ...head, salt: secret.salt, code: secret.code };
  if (!e.published || !code.replay) throw new Error("this entry has no score commitment to prove totals against (not published, or the season was cancelled)");
  const proof = { type: "conclave-totals-reveal", ...head, total: code.replay.total, finalsTotal: code.replay.finalsTotal, scoreSalt: scoreSaltOf(Buffer.from(secret.salt, "hex"), season.season).toString("hex") };
  if (!verifyTotals(season, { id: proof.strategyId, slot: proof.slot, ...proof }).verified) throw new Error("the totals reveal does not verify");
  return proof;
}
