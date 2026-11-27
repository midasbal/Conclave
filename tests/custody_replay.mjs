// From a recovery bundle and a public season receipt ALONE: does the bundle's bytecode, replayed on the receipt's seeds, reproduce the score commitment the program wrote? (used by tests/svm/tests/client_flows.rs)
// usage: node tests/custody_replay.mjs '{"bundle":"..","passphrase":"..","receipt":"<hex>"}'
import fs from "node:fs";
const input = JSON.parse(process.argv[2]);
const C = await import("../client/custody.mjs"); const L = await import("../client/lib.mjs"); const A = await (await import("../client/author.mjs")).load();
const o = C.openBundle(fs.readFileSync(input.bundle), input.passphrase); const R = L.parseReceipt(Buffer.from(input.receipt, "hex")); const id = BigInt(o.public.id); const e = R.entries.find(x => x.id === id);
const total = A.season([o.code], R.seedA, R.seedB, R.neps).totals[0]; const played = !!e && e.finalist && R.finals.status === 1; const ftotal = played ? A.season([o.code], R.finals.seedA, R.finals.seedB, R.finals.neps).totals[0] : 0n;
process.stdout.write(JSON.stringify({ id: o.public.id, onReceipt: !!e, published: !!e?.published, finalist: played, codeCommitmentMatches: !!e && e.commit.toString("hex") === o.public.commitment, format: R.format, ownerMatches: !!e?.owner && new L.PublicKey(e.owner).toBase58() === o.public.owner, scoreCommitmentMatches: !!e && L.scoreCommit(o.salt, R.season, id, total, ftotal, R.neps, played ? R.finals.neps : 0).equals(e.score), total: total.toString(), finalsTotal: ftotal.toString() }));
