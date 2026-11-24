// Authority tool for the access guards. The authority is a single key for now (the program upgrade authority); the multisig move is Admin sub-command 4.
//   node client/admin.mjs init                   create the config on base (upgrade authority only) and delegate it to the rollup
//   node client/admin.mjs show                   print the config as the rollup sees it
//   node client/admin.mjs allow <mint> | disallow <mint> | pause | unpause | set-authority <pubkey>
//   node client/admin.mjs recover <season>       authority-only: close the books on a stranded bond (orphaned receipt); the creator is then paid by ReleaseBond
import * as L from "./lib.mjs"; import * as F from "./flows.mjs";
const { O } = L; const log = L.logger(L.EV + "admin.txt"); const cmd = process.argv[2]; const arg = process.argv[3]; const c = await F.ctx();
const tee = async (ix, what) => { const r = await L.sendTee(c.URL, [ix], [O]); log(`${r.err ? "FAILED" : "ok"} ${what}: ${r.sig}${r.err ? " " + JSON.stringify(r.err) : ""}`); return r; };
log(`\n== ADMIN ${cmd} ${arg || ""} ${new Date().toISOString()} authority ${O.publicKey.toBase58()} SOL ${(await L.base.getBalance(O.publicKey)) / 1e9}`);
if (cmd === "init") { log("SIG base InitConfig:", await L.sendBase([F.initConfigIx()], [O])); log("SIG base Delegate config:", await F.delegateConfig(c)); }
else if (cmd === "allow") await tee(F.adminIx(2, new L.PublicKey(arg).toBuffer()), `allow mint ${arg}`);
else if (cmd === "disallow") await tee(F.adminIx(3, new L.PublicKey(arg).toBuffer()), `disallow mint ${arg}`);
else if (cmd === "pause") await tee(F.adminIx(0), "pause");
else if (cmd === "unpause") await tee(F.adminIx(1), "unpause");
else if (cmd === "set-authority") await tee(F.adminIx(4, new L.PublicKey(arg).toBuffer()), `set authority ${arg}`);
else if (cmd === "recover") { const sid = BigInt(arg); const before = await L.base.getAccountInfo(L.receiptPda(sid)); const R0 = L.parseReceipt(before.data); log(`receipt before: owner ${before.owner.toBase58()} state ${R0.state} bond ${R0.bond} release ${R0.release} creator ${new L.PublicKey(R0.creator).toBase58()} lamports ${before.lamports}`);
  const r = await tee(F.recoverBondIx(sid), `RecoverBond season ${sid}`); if (r.err) process.exit(1);
  const cu = await tee(F.commitUndelegateIx([L.receiptPda(sid)]), "commit+undelegate the recovered receipt"); let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) break; await L.sleep(1500); }
  const R = L.parseReceipt(a.data); const creator = new L.PublicKey(R.creator); const bal = k => L.base.getBalance(k); const [c0, p0, l0] = [await bal(creator), await bal(O.publicKey), a.lamports];
  log(`on base: state ${R.state} release ${R.release} creator ${creator.toBase58()} authority ${O.publicKey.toBase58()} (same wallet: ${creator.equals(O.publicKey)})`);
  const rel = await L.sendBase([F.releaseBondIx(sid, creator)], [O]); const [c1, p1, l1] = [await bal(creator), await bal(O.publicKey), await L.base.getBalance(L.receiptPda(sid))];
  log(`SIG base ReleaseBond: ${rel} | receipt ${l0} -> ${l1} (moved ${l0 - l1}) | creator ${c0} -> ${c1} (${c1 - c0 >= 0 ? "+" : ""}${c1 - c0}) | authority ${p0} -> ${p1}`); }
else if (cmd !== "show") { console.error("init | show | allow <mint> | disallow <mint> | pause | unpause | set-authority <pk> | recover <season>"); process.exit(2); }
const cfg = await F.readConfig(c); log("config:", cfg ? JSON.stringify({ paused: cfg.paused, authority: cfg.authority.toBase58(), mints: cfg.mints.map(m => m.toBase58()) }) : "not delegated or not created");
