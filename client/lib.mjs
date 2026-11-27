import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAuthToken, permissionPdaFromAccount, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID, delegateSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createMint, createAssociatedTokenAccountIdempotent, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl"; import crypto from "crypto"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
export { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction, permissionPdaFromAccount, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID, delegateSpl, createMint, createAssociatedTokenAccountIdempotent, mintTo, getAssociatedTokenAddressSync };
export const HOME = process.env.HOME;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** secrets live OUTSIDE the repository. Override with CONCLAVE_KEYS. Expected files: payer.json, conclave-program.json, players.json */
export const KEYS = process.env.CONCLAVE_KEYS || path.join(ROOT, "..", "conclave-keys");
/** generated artifacts (strategy pool, banks): produced by `conclave-lab`, git-ignored. Override with CONCLAVE_OUT. */
export const OUT = process.env.CONCLAVE_OUT || path.join(ROOT, "out");
export const LAB = path.join(ROOT, "target", "release", "conclave-lab");
export const EV = path.join(ROOT, "evidence") + "/"; fs.mkdirSync(EV, { recursive: true });
const readKey = f => JSON.parse(fs.readFileSync(path.join(KEYS, f), "utf8"));
/** CONCLAVE_PROGRAM_ID lets keyless callers (the canary, CI) name the program without holding its address keypair */
export const PROGRAM = process.env.CONCLAVE_PROGRAM_ID ? new PublicKey(process.env.CONCLAVE_PROGRAM_ID) : Keypair.fromSecretKey(Uint8Array.from(readKey("conclave-program.json"))).publicKey;
export const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"), TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const MAGIC = new PublicKey("Magic11111111111111111111111111111111111111"), MCTX = new PublicKey("MagicContext1111111111111111111111111111111");
export const VRF = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"), SLOTH = new PublicKey("SysvarS1otHashes111111111111111111111111111"), EQUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
/** CONCLAVE_BASE_URL overrides the base RPC (used by the custody crash test, which points it at a local port) */
export const BASE_URL = process.env.CONCLAVE_BASE_URL || "https://rpc.magicblock.app/devnet", TEE = "https://devnet-tee.magicblock.app";
export const base = new Connection(BASE_URL, "confirmed");
/** the acting wallet: payer.json by default; CONCLAVE_SIGNER (JSON key array in the environment) or CONCLAVE_SIGNER_FILE override it, which is how the canary runs under its throwaway wallet */
export const O = Keypair.fromSecretKey(Uint8Array.from(process.env.CONCLAVE_SIGNER ? JSON.parse(process.env.CONCLAVE_SIGNER) : process.env.CONCLAVE_SIGNER_FILE ? JSON.parse(fs.readFileSync(process.env.CONCLAVE_SIGNER_FILE, "utf8")) : readKey("payer.json")));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
import { Endpoint } from "./endpoint.mjs"; export { Endpoint };
import { readRecords, writeRecords, addRecord } from "./custody.mjs";
const urlOf = u => typeof u === "string" ? u : u.url, hdrOf = u => typeof u === "string" ? {} : u.headers();
export const rpc = async (u, m, p = []) => { for (let a = 0; a < 3; a++) { try { const r = await fetch(urlOf(u), { method: "POST", headers: { "content-type": "application/json", ...hdrOf(u) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return JSON.parse(await r.text()); } catch (e) { if (a == 2) return { error: String(e) }; await sleep(300); } } };
export const K = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
export const ixp = (tag, keys, data = Buffer.alloc(0)) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([Buffer.from([tag]), Buffer.from(data)]) });
export const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }; export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
export const hubPda = () => pda([Buffer.from("hub")]);
/** v2: strategy and registry accounts are keyed by the strategy id alone; the owner is a field. */
export const regPda = id => pda([Buffer.from("reg"), u64(id)]); export const stratPda = id => pda([Buffer.from("strat"), u64(id)]); export const receiptPda = sid => pda([Buffer.from("receipt"), u64(sid)]);
export const arenaPda = sid => pda([Buffer.from("arena"), u64(sid)]); export const poolPda = sid => pda([Buffer.from("pool"), u64(sid)]); export const identityPda = () => pda([Buffer.from("identity")]);
export const eataOf = (owner, mint) => pda([owner.toBuffer(), mint.toBuffer()], ESPL);
export const delegAccts = acct => ({ buffer: pda([Buffer.from("buffer"), acct.toBuffer()], PROGRAM), record: pda([Buffer.from("delegation"), acct.toBuffer()], DLP), meta: pda([Buffer.from("delegation-metadata"), acct.toBuffer()], DLP) });
export async function sendBase(ixs, signers, label) { for (let a = 0; ; a++) { const tx = new Transaction().add(...ixs); tx.feePayer = signers[0].publicKey; try { return await sendAndConfirmTransaction(base, tx, signers, { commitment: "confirmed" }); } catch (e) { if (a < 4 && /expired|block height|Blockhash not found|429/i.test(String(e))) { await sleep(1500); continue; } throw e; } } }
export async function sendTee(url, ixs, signers, { cu = 1_400_000, poll = 40 } = {}) { const tx = new Transaction(); tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu })); tx.add(...ixs); tx.feePayer = signers[0].publicKey;
  const bh = (await rpc(url, "getLatestBlockhash")).result.value.blockhash; tx.recentBlockhash = bh; tx.sign(...signers); const t0 = Date.now();
  const r = await rpc(url, "sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }]); const sig = r.result; if (!sig) return { sig: null, err: r.error?.message || JSON.stringify(r) };
  for (let i = 0; i < 300; i++) { const x = (await rpc(url, "getSignatureStatuses", [[sig]])).result?.value?.[0]; if (x?.confirmationStatus) return { sig, err: x.err, ms: Date.now() - t0, slot: x.slot }; await sleep(poll); } return { sig, err: "timeout" }; }
export const tokenFor = async (url, kp) => (await getAuthToken(url, kp.publicKey, async m => nacl.sign.detached(m, kp.secretKey))).token;
export async function readAcct(url, a) { const r = (await rpc(url, "getAccountInfo", [a.toBase58(), { encoding: "base64" }])).result?.value; return r ? Buffer.from(r.data[0], "base64") : null; }
export function logger(file) { return (...a) => { const s = a.join(" "); console.log(s); fs.appendFileSync(file, s + "\n"); }; }
export function loadPool() { const pool = fs.readFileSync(path.join(OUT, "real_pool.bin")); const meta = JSON.parse(fs.readFileSync(path.join(OUT, "real_pool.json"))).strategies; const n = pool.readUInt16LE(0); const progs = []; let off = 2; for (let i = 0; i < n; i++) { const l = pool.readUInt16LE(off); off += 2; progs.push(pool.subarray(off, off + l)); off += l; } const by = {}; meta.forEach((s, i) => by[s.name] = { code: progs[i], ops: s.ops, i }); return by; }
export const sha256 = b => crypto.createHash("sha256").update(b).digest();
// ---- commitments (must match program/src/lib.rs) ----
const DOM_CODE = Buffer.from("CNCL-CODE-v1"), DOM_SCORE = Buffer.from("CNCL-SCORE-v3"), DOM_SCORE_SALT = Buffer.from("CNCL-SSALT-v1"), DOM_SCORE_V2 = Buffer.from("CNCL-SCORE-v2");
export const codeCommit = (salt, code) => sha256(Buffer.concat([DOM_CODE, salt, code]));
const le = (n, f) => { const x = Buffer.alloc(n); f(x); return x; };
const scoreHash = (domain, key, season, id, total, finalsTotal, neps, finalsEps) => sha256(Buffer.concat([domain, key, le(8, x => x.writeBigUInt64LE(BigInt(season))), le(8, x => x.writeBigUInt64LE(BigInt(id))), le(8, x => x.writeBigInt64LE(BigInt(total))), le(8, x => x.writeBigInt64LE(BigInt(finalsTotal))), le(4, x => x.writeUInt32LE(neps)), le(4, x => x.writeUInt32LE(finalsEps))]));
/** the salt one season's score commitments are keyed by, derived from the sealed salt. Handing it out proves that season's totals; it does not open the code commitment or any other season */
export const scoreSalt = (salt, season) => sha256(Buffer.concat([DOM_SCORE_SALT, Buffer.from(salt), le(8, x => x.writeBigUInt64LE(BigInt(season)))]));
/** what a verifier recomputes from ONLY the season's score salt and the claimed totals (format 3 receipts) */
export const scoreCommitWith = (ssalt, season, id, total, finalsTotal, neps, finalsEps) => scoreHash(DOM_SCORE, Buffer.from(ssalt), season, id, total, finalsTotal, neps, finalsEps);
/** total: season-phase total; finalsTotal and finalsEps are 0 for an entry that did not play the finals (not a qualifier, no finals, or voided) */
export const scoreCommit = (salt, season, id, total, finalsTotal, neps, finalsEps) => scoreCommitWith(scoreSalt(salt, season), season, id, total, finalsTotal, neps, finalsEps);
/** receipts written by earlier builds (format 2): keyed by the sealed salt itself, so proving such a score also hands out the salt behind the code commitment */
export const scoreCommitV2 = (salt, season, id, total, finalsTotal, neps, finalsEps) => scoreHash(DOM_SCORE_V2, Buffer.from(salt), season, id, total, finalsTotal, neps, finalsEps);
/** the rule the receipt in hand was written under */
export const scoreCommitFor = (format, ...args) => (format === 3 ? scoreCommit : scoreCommitV2)(...args);
/** strategy ids are random 64-bit numbers (the namespace is global); the secret salts live with the keys, outside the repo */
export const newId = () => crypto.randomBytes(8).readBigUInt64LE();
/** the key file. Writes are durable and serialised, and no write may drop a secret it holds (client/custody.mjs) */
export const stratFile = () => process.env.CONCLAVE_STRATS_FILE || path.join(KEYS, "strategies.json"); // the canary points this at its own file, so its secrets are saved the same way (before the first send) without touching the real key file
export const loadStrats = () => readRecords(stratFile());
export const saveStrats = a => writeRecords(stratFile(), a);
export const addStrat = rec => addRecord(stratFile(), rec);
export const players = () => readKey("players.json").map(a => Keypair.fromSecretKey(Uint8Array.from(a)));
// arena / receipt layouts (mirror of program/src/lib.rs)
export const A = { HDR: 1280, SLOT: 440 };
export { parseReceipt, parseReceiptMoney, parseClaims, receiptFormat, parseTerms, termsHash } from "./layouts.mjs";
/** the season roster: private in the rollup (no members), it holds each entry's code commitment until Settle or Cancel writes it to the receipt */
export const rosterPda = sid => pda([Buffer.from("roster"), u64(sid)]);
export const claimsPda = sid => pda([Buffer.from("claims"), u64(sid)]);
export const termsPda = sid => pda([Buffer.from("terms"), u64(sid)]);
