// The decision to send, and the sending. It fails closed: anything that cannot be read or written means no transfer.
//
// A transfer is signed and written to disk as pending, with its signature, BEFORE it is sent. So whatever happens next (a lost reply, a crash, a timeout)
// the next request for that address can ask the chain what became of it, and can only send again once the first transaction can no longer land. A
// success is reported only for a transfer the cluster has confirmed.
//
// About the limits: a visitor makes a fresh key for every seal, so "once per address" stops only repeat requests for one address, not a person. The
// per-IP limit is a soft signal that can be spoofed or rotated. The daily cap, kept on disk, is the limit that actually bounds what can be spent.
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DEVNET_GENESIS, FEE_LAMPORTS } from "./config.mjs";
import { createWindow } from "./limits.mjs";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

/** an answer for the caller: a fixed code and message, never anything an RPC said */
export class Refusal extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    Object.assign(this, { status, code, retryable });
  }
}

export function createDripper({ config, keypair, store, connection, redact, log, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const sends = createWindow(config.sendsPerIpPerHour, now);
  const inFlight = new Set();
  let queue = Promise.resolve();
  /** one reservation at a time, so that two requests cannot both fit under the cap */
  const exclusive = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };

  const rpc = async (what, work) => {
    try { return await work(); } catch (e) {
      log(`rpc ${what} failed: ${redact(e)}`);
      throw new Refusal(502, "rpc-unavailable", "The network could not be read, so nothing new was sent. Try again.", true);
    }
  };

  // proven once: this is devnet, and the key is not the one that can replace the program
  let proven = false;
  async function prove() {
    if (proven) return;
    const genesis = await rpc("genesis", () => connection.getGenesisHash());
    if (genesis !== DEVNET_GENESIS) throw new Refusal(503, "not-devnet", "The operator is not connected to devnet. Nothing will be sent.");
    const program = await rpc("program account", () => connection.getAccountInfo(new PublicKey(config.programId), "confirmed"));
    if (!program || program.owner.toBase58() !== UPGRADEABLE_LOADER) throw new Refusal(503, "program-unreadable", "The operator could not check the program. Nothing will be sent.", true);
    const data = await rpc("program data", () => connection.getAccountInfo(new PublicKey(program.data.subarray(4, 36)), "confirmed"));
    if (!data) throw new Refusal(503, "program-unreadable", "The operator could not check the program. Nothing will be sent.", true);
    if (data.data[12] === 1 && new PublicKey(data.data.subarray(13, 45)).equals(keypair.publicKey)) throw new Refusal(503, "wrong-key", "The operator key is the program's upgrade authority, which must never be on a server. Nothing will be sent.");
    proven = true;
  }

  const statusOf = async signature => (await rpc("signature status", () => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
  const settled = s => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

  const complete = (address, entry) => store.commit(s => {
    delete s.pending[address];
    s.funded[address] = { signature: entry.signature, lamports: entry.lamports, at: new Date(now()).toISOString() };
  });
  /** gives the day's total back what a transfer that will never land had reserved (a failed one still paid its fee) */
  const release = (address, entry, keptFee) => store.commit(s => {
    delete s.pending[address];
    if (entry.day === s.day) s.spentLamports = Math.max(0, s.spentLamports - entry.lamports - (keptFee ? 0 : FEE_LAMPORTS));
  });

  /** what became of a transfer left pending: "confirmed", "failed", "expired" (it can never land) or "unknown" (it still might) */
  async function fate(entry) {
    let status = await statusOf(entry.signature);
    if (!status) {
      // the finalized height, which trails: "it can never land" must err on the side of waiting, since being wrong means paying twice
      const height = await rpc("block height", () => connection.getBlockHeight("finalized"));
      if (height <= entry.lastValidBlockHeight) return "unknown";
      status = await statusOf(entry.signature); // asked again after the height, so that a transfer landing in between is not missed
      if (!status) return "expired";
    }
    if (status.err) return "failed";
    return settled(status) ? "confirmed" : "unknown";
  }

  const funded = entry => ({ status: "funded", signature: entry.signature, lamports: entry.lamports });
  const notConfirmed = () => new Refusal(504, "not-confirmed", "The transfer was sent but is not confirmed yet. Try again shortly: it will not be sent twice.", true);

  async function awaitConfirmation(address, entry) {
    const deadline = now() + config.confirmTimeoutMs;
    while (now() < deadline) {
      let what = "unknown";
      try { what = await fate(entry); } catch (e) { if (!(e instanceof Refusal)) throw e; }
      if (what === "confirmed") { complete(address, entry); log(`confirmed ${entry.signature}`); return funded(entry); }
      if (what === "failed") { release(address, entry, true); throw new Refusal(502, "transfer-failed", "The transfer failed on devnet. Try again.", true); }
      if (what === "expired") { release(address, entry, false); throw new Refusal(502, "transfer-expired", "The transfer did not reach devnet. Try again.", true); }
      await sleep(1000);
    }
    throw notConfirmed();
  }

  async function operatorBalance() {
    return rpc("operator balance", () => connection.getBalance(keypair.publicKey, "confirmed"));
  }

  async function drip(recipient, ip) {
    const address = recipient.toBase58();
    await prove();
    if (recipient.equals(keypair.publicKey)) throw new Refusal(400, "bad-address", "That address cannot be funded.");
    if (inFlight.has(address)) throw new Refusal(409, "in-progress", "A request for this address is already being handled. Try again shortly.", true);
    inFlight.add(address);
    try {
      store.roll();
      const waiting = store.state.pending[address];
      if (waiting) {
        const what = await fate(waiting);
        if (what === "confirmed") { complete(address, waiting); return funded(waiting); }
        if (what === "unknown") return await awaitConfirmation(address, waiting);
        release(address, waiting, what === "failed");
      }

      // the balance gate
      const account = await rpc("recipient account", () => connection.getAccountInfo(recipient, "confirmed"));
      if (account && (account.executable || !account.owner.equals(SystemProgram.programId))) throw new Refusal(400, "bad-address", "That address is not a wallet.");
      const balance = account?.lamports ?? 0;
      if (balance >= config.thresholdLamports) return { status: "already-funded", balanceLamports: balance };
      if (Object.hasOwn(store.state.funded, address)) throw new Refusal(409, "already-used", "This address has been funded once already and is not funded again. Start with a new key.");

      const entry = await exclusive(async () => {
        store.roll();
        if (store.state.spentLamports + config.topupLamports + FEE_LAMPORTS > config.dailyCapLamports) throw new Refusal(429, "daily-cap", "Today's funding limit has been reached. It starts again at 00:00 UTC.");
        if (sends.full(ip)) throw new Refusal(429, "ip-limit", "Too many funding requests from your network in the last hour. Try again later.", true);
        if ((await operatorBalance()) < config.topupLamports + FEE_LAMPORTS) throw new Refusal(503, "operator-empty", "The funding wallet is out of devnet SOL. Nothing was sent.");
        const { blockhash, lastValidBlockHeight } = await rpc("blockhash", () => connection.getLatestBlockhash("confirmed"));
        const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
        tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: recipient, lamports: config.topupLamports }));
        tx.sign(keypair);
        const pending = { signature: bs58.encode(tx.signature), lamports: config.topupLamports, lastValidBlockHeight, day: store.state.day, at: new Date(now()).toISOString() };
        try {
          store.commit(s => { s.spentLamports += config.topupLamports + FEE_LAMPORTS; s.pending[address] = pending; });
        } catch (e) {
          log(`not sent: ${redact(e)}`);
          throw new Refusal(503, "state-unwritable", "The operator could not record the transfer, so it was not sent.", true);
        }
        sends.add(ip);
        return { ...pending, raw: tx.serialize() };
      });

      try {
        await connection.sendRawTransaction(entry.raw, { preflightCommitment: "confirmed", maxRetries: 5 });
        log(`sent ${entry.lamports} lamports, signature ${entry.signature}`);
      } catch (e) {
        // the node may have it even though the reply was lost: it stays pending until the chain says which
        log(`send reported an error for ${entry.signature}: ${redact(e)}`);
      }
      const { raw, ...kept } = entry;
      return await awaitConfirmation(address, kept);
    } finally {
      inFlight.delete(address);
    }
  }

  return {
    drip,
    prove,
    operatorBalance,
    spentToday() { store.roll(); return store.state.spentLamports; },
    pendingCount: () => Object.keys(store.state.pending).length,
  };
}
