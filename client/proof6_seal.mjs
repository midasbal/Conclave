// Phase 6, step 1 on devnet: the FIRST Seal of the new build. Does the rollup accept the owner's registry (a program-owned, delegated PDA) as the rent sponsor of the sealed account and its permission?
// Observed here: the registry's balance in the rollup before and after, the hub's before and after, the sealed account, and its payer flag. No mocks: the real deployed program and the real TEE.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const L = await import("./lib.mjs"); const F = await import("./flows.mjs"); const { O } = L; const here = path.dirname(fileURLToPath(import.meta.url));
const codes = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, "canary_codes.json"), "utf8"))).map(([k, v]) => [k, Buffer.from(v, "hex")]));
const log0 = L.logger(L.EV + "proof6_seal_" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt"); const log = (...a) => log0(...a);
const lam = async (url, k) => (await L.rpc(url, "getAccountInfo", [k.toBase58(), { encoding: "base64" }])).result?.value?.lamports ?? null;
const OWNER = Number(process.env.P6_OWNER ?? 0); const NAME = "Mom20th";
log(`== PHASE 6 FIRST SEAL ${new Date().toISOString()} program ${L.PROGRAM.toBase58()}`);
const c = await F.ctx(); const owner = c.players[OWNER]; log("owner", owner.publicKey.toBase58(), "base SOL", (await L.base.getBalance(owner.publicKey)) / 1e9, "validator", c.validator.toBase58());
// P6_ID: seal a strategy that is already registered and delegated (the first attempt, sent minutes after the upgrade, reached the rollup while it still ran the previous program: NotEnoughAccountKeys)
let r; if (process.env.P6_ID) { const rec = L.loadStrats().find(x => x.id === process.env.P6_ID); r = { id: BigInt(rec.id), salt: Buffer.from(rec.salt, "hex") }; log("sealing the already registered strategy", rec.id); } else { r = await F.register(c, OWNER, "p6-first-seal", codes[NAME]); log("registered strategy id", r.id.toString()); log("SIG Register", r.sigs[0]); log("SIG Delegate registry", r.sigs[1]); }
// wait until the rollup serves the delegated registry
let regRaw = null; for (let i = 0; i < 80 && !regRaw; i++) { regRaw = await L.readAcct(c.URL, L.regPda(r.id)); if (!regRaw) await L.sleep(700); } log("registry visible in the rollup:", !!regRaw);
const [reg0, hub0] = [await lam(c.URL, L.regPda(r.id)), await F.hubLamports(c)]; log(`BEFORE  registry ${reg0} lamports (rollup)  hub ${hub0} lamports (rollup)`);
const s = await F.seal(c, OWNER, r.id, r.salt, codes[NAME], false); log("SIG Seal:", s.sig, s.err ? "FAILED " + JSON.stringify(s.err) : "ok");
const [reg1, hub1] = [await lam(c.URL, L.regPda(r.id)), await F.hubLamports(c)]; log(`AFTER   registry ${reg1} lamports  hub ${hub1} lamports`);
const sealed = await L.readAcct(c.ptok[OWNER], L.stratPda(r.id)); log("sealed account readable by its owner:", !!sealed, sealed ? `${sealed.length} bytes, bytes 6..8 = 0x${sealed.readUInt16LE(6).toString(16)}` : "");
const out = { id: r.id.toString(), seal: s, registryDelta: reg1 - reg0, hubDelta: hub1 - hub0, flag: sealed ? sealed.readUInt16LE(6) : null };
const ok = !s.err && reg0 - reg1 === 20_000 && hub1 === hub0 && sealed && sealed.readUInt16LE(6) === 0x8000;
log(`RESULT ${ok ? "PASS" : "FAIL"}: registry debited ${reg0 - reg1} (want 20000), hub moved ${hub1 - hub0} (want 0), flag 0x${(out.flag ?? 0).toString(16)} (want 0x8000)`); fs.writeFileSync(L.EV + "proof6_first_seal.json", JSON.stringify(out, null, 1)); process.exit(ok ? 0 : 1);
