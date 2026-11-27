const REPO = "https://github.com/midasbal/Conclave";
const file = (p: string) => `${REPO}/blob/main/${p}`;

export const links = {
  repo: REPO,
  lifecycle: file("program/LIFECYCLE.md"),
  disclosure: file("program/LIFECYCLE.md#security-considerations-sealing-disclosure"),
  proofs: file("verifier/README.md"),
  api: file("docs/API.md"),
};

export const explorerAddress = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;
