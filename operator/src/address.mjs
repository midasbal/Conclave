import { PublicKey } from "@solana/web3.js";

/** a wallet address: 32 bytes of base58, written canonically, that is a point on the ed25519 curve (so not a program-derived address) */
export function parseAddress(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()) ? key : null;
  } catch {
    return null;
  }
}
