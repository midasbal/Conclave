// The one spendable key, read from OPERATOR_SECRET_KEY at start. Nothing here generates a key, writes one or prints one, and no error repeats
// any part of what was given.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function parseSecretKey(value) {
  const text = (value ?? "").trim();
  if (text === "") return { keypair: null, problem: "OPERATOR_SECRET_KEY is not set" };
  let bytes;
  try {
    if (text.startsWith("[")) {
      const list = JSON.parse(text);
      if (!Array.isArray(list) || list.length !== 64 || !list.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
      bytes = Uint8Array.from(list);
    } else {
      bytes = bs58.decode(text);
    }
    if (bytes.length !== 64) throw new Error();
    return { keypair: Keypair.fromSecretKey(bytes), problem: null }; // fromSecretKey checks that the public half belongs to the secret half
  } catch {
    return { keypair: null, problem: "OPERATOR_SECRET_KEY is not a 64-byte secret key (a JSON array of 64 numbers, or base58)" };
  }
}
