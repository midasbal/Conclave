// The explanations behind the question marks on the sealing experiment.
export const SEAL_HELP = {
  devnet: { label: "devnet", text: "Solana's test network. Its SOL has no value and comes from a public faucet. Use a wallet you keep only for testing." },
  lamports: { label: "lamports", text: "The smallest unit of SOL: 1 SOL is 1,000,000,000 lamports." },
  registry: { label: "registry", text: "A small public account on Solana for your strategy. It holds your wallet, a number for the strategy and the commitment. Not the code." },
  delegate: { label: "delegate", text: "Handing the registry to the private rollup, so that the rollup can change it while the strategy is sealed there." },
  login: { label: "enclave login", text: "You sign a short text, not a transaction. It proves the wallet is yours, so the rollup will show you your own private data." },
  seal: { label: "seal", text: "The transaction that puts the code and its salt into the private rollup, readable only by your wallet while the strategy is open." },
  salt: { label: "salt", text: "32 random bytes sealed with the code. Without it nobody can match the public commitment to a guess of the code." },
  commitment: { label: "commitment", text: "A fingerprint of the salt and code together. It is public, and shows later which code was sealed without revealing it." },
} as const;
