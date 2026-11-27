const REPO = "https://github.com/midasbal/Conclave";
const file = (p: string) => `${REPO}/blob/main/${p}`;

export const links = {
  repo: REPO,
  x: "https://x.com/wjmdiary",
  lifecycle: file("program/LIFECYCLE.md"),
  disclosure: file("program/LIFECYCLE.md#security-considerations-sealing-disclosure"),
  proofs: file("verifier/README.md"),
  api: file("docs/API.md"),
  readme: file("README.md"),
  authoring: file("docs/AUTHORING.md"),
  custody: file("docs/CUSTODY.md"),
  records: file("docs/RECORD_SERVICE.md"),
  reproducible: file("program/REPRODUCIBLE.md"),
  ruleset: file("crates/conclave-vm/RULESET.md"),
  examples: `${REPO}/tree/main/strategies`,
};

export const explorerAddress = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;
export const explorerTransaction = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

/** the deployed program and the hash program/BUILD_HASH records for it */
export const PROGRAM_ID = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
export const BUILD_SHA256 = "68d37e0fdf8a79c5d96ab78092f29b2fd954b1f06521d9d6c5ecabbddae499fb";
