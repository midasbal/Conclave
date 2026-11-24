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
export const PROGRAM = Keypair.fromSecretKey(Uint8Array.from(readKey("conclave-program.json"))).publicKey;
export const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2"), TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const MAGIC = new PublicKey("Magic11111111111111111111111111111111111111"), MCTX = new PublicKey("MagicContext1111111111111111111111111111111");
export const VRF = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"), SLOTH = new PublicKey("SysvarS1otHashes111111111111111111111111111"), EQUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const BASE_URL = "https://rpc.magicblock.app/devnet", TEE = "https://devnet-tee.magicblock.app";
export const base = new Connection(BASE_URL, "confirmed");
export const O = Keypair.fromSecretKey(Uint8Array.from(readKey("payer.json")));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const rpc = async (u, m, p = []) => { for (let a = 0; a < 3; a++) { try { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return JSON.parse(await r.text()); } catch (e) { if (a == 2) return { error: String(e) }; await sleep(300); } } };
export const K = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
export const ixp = (tag, keys, data = Buffer.alloc(0)) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([Buffer.from([tag]), Buffer.from(data)]) });
export const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }; export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
export const hubPda = () => pda([Buffer.from("hub")]); export const regPda = (owner, id) => pda([Buffer.from("reg"), owner.toBuffer(), u64(id)]); export const stratPda = (owner, id) => pda([Buffer.from("strat"), owner.toBuffer(), u64(id)]);
export const arenaPda = sid => pda([Buffer.from("arena"), u64(sid)]); export const poolPda = sid => pda([Buffer.from("pool"), u64(sid)]); export const identityPda = () => pda([Buffer.from("identity")]);
export const eataOf = (owner, mint) => pda([owner.toBuffer(), mint.toBuffer()], ESPL);
export const delegAccts = acct => ({ buffer: pda([Buffer.from("buffer"), acct.toBuffer()], PROGRAM), record: pda([Buffer.from("delegation"), acct.toBuffer()], DLP), meta: pda([Buffer.from("delegation-metadata"), acct.toBuffer()], DLP) });
export async function sendBase(ixs, signers, label) { for (let a = 0; ; a++) { const tx = new Transaction().add(...ixs); tx.feePayer = signers[0].publicKey; try { return await sendAndConfirmTransaction(base, tx, signers, { commitment: "confirmed" }); } catch (e) { if (a < 4 && /expired|block height|Blockhash not found|429/i.test(String(e))) { await sleep(1500); continue; } throw e; } } }
export async function sendTee(url, ixs, signers, { cu = 1_400_000, poll = 40 } = {}) { const tx = new Transaction(); tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu })); tx.add(...ixs); tx.feePayer = signers[0].publicKey;
  const bh = (await rpc(url, "getLatestBlockhash")).result.value.blockhash; tx.recentBlockhash = bh; tx.sign(...signers); const t0 = Date.now();
  const r = await rpc(url, "sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }]); const sig = r.result; if (!sig) return { sig: null, err: r.error?.message || JSON.stringify(r) };
  for (let i = 0; i < 300; i++) { const x = (await rpc(url, "getSignatureStatuses", [[sig]])).result?.value?.[0]; if (x?.confirmationStatus) return { sig, err: x.err, ms: Date.now() - t0, slot: x.slot }; await sleep(poll); } return { sig, err: "timeout" }; }
export async function cuOf(url, sig) { for (let i = 0; i < 20; i++) { const t = (await rpc(url, "getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }])).result; if (t?.meta) return { cu: t.meta.computeUnitsConsumed, err: t.meta.err, logs: t.meta.logMessages }; await sleep(300); } return null; }
export const tokenFor = async (url, kp) => (await getAuthToken(url, kp.publicKey, async m => nacl.sign.detached(m, kp.secretKey))).token;
export async function readAcct(url, a) { const r = (await rpc(url, "getAccountInfo", [a.toBase58(), { encoding: "base64" }])).result?.value; return r ? Buffer.from(r.data[0], "base64") : null; }
export function logger(file) { return (...a) => { const s = a.join(" "); console.log(s); fs.appendFileSync(file, s + "\n"); }; }
export function loadPool() { const pool = fs.readFileSync(path.join(OUT, "real_pool.bin")); const meta = JSON.parse(fs.readFileSync(path.join(OUT, "real_pool.json"))).strategies; const n = pool.readUInt16LE(0); const progs = []; let off = 2; for (let i = 0; i < n; i++) { const l = pool.readUInt16LE(off); off += 2; progs.push(pool.subarray(off, off + l)); off += l; } const by = {}; meta.forEach((s, i) => by[s.name] = { code: progs[i], ops: s.ops, i }); return by; }
export const sha256 = b => crypto.createHash("sha256").update(b).digest();
// arena layout (mirror of program/src/lib.rs)
export const A = { HDR: 1152, SLOT: 440, flags: d => d[4], ns: d => d[5], neps: d => d.readUInt32LE(80), curEp: d => d.readUInt32LE(88), curTick: d => d.readUInt32LE(92), ticks: d => d.readUInt32LE(152), start: d => Number(d.readBigUInt64LE(96)), seed: d => d.subarray(48, 80), pool: d => d.readBigUInt64LE(112),
  total: (d, i) => d.readBigInt64LE(1152 + i * 440 + 48), rank: (d, i) => d.readUInt32LE(1152 + i * 440 + 44) };
