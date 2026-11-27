// The statements the API must not leave out. Each response that needs one carries it, in the response itself, so that no client has to remember to show it.
export const NOTICE = {
  sealing: { id: "sealing-disclosure", text: "A strategy is private only while it is open. Closing it makes its salt and bytecode permanently and publicly readable from devnet's own transaction history, to anyone. This service never serves or links them." },
  sealingClosed: { id: "sealing-disclosure", text: "This strategy has been closed. Its salt and bytecode are permanently and publicly readable from devnet's own transaction history, to anyone. This service does not serve or link them, and a strategy's result is no proof that its code was ever secret." },
  validator: { id: "validator-trust-input", text: "A season's validator is chosen by its creator and is not recorded on the receipt. It is shown as recovered from base history. It is a trust input to decide on, not something the receipt proves, and no TEE attestation has been checked." },
  fee: { id: "fee-token", text: "The receipt records a fee as a bare number. Its unit is the stake token named here, recovered from the season's InitPool transaction on base. Where none was found the unit is unknown, and fees of different seasons may not be comparable." },
  counts: { id: "counts-not-proof", text: "Field size, fee and the number of distinct wallets are facts to judge a season by. None of them proves a field is not one person, and none is used as a threshold." },
  legacy: { id: "legacy-not-verified", text: "These receipts were written by earlier builds. They record no owner, and a commitment only where a result was published. They are not verified history and are in no ranking." },
  provisional: { id: "provisional", text: "A provisional result is still held by the rollup and can still change. It is never counted." },
  ownerAtEntry: { id: "owner-at-entry", text: "A wallet is the owner recorded on a receipt at that entry. It is not who owns the strategy now, and one person can use many wallets." },
};
export const COMMITMENT_CAVEAT = "The same commitment means the same salt and bytecode. Different commitments say nothing: identical code under a new salt looks unrelated. This is not a way to find copied code.";
export const RANKING_BASIS = "Strategies are ordered by the sum, over counted seasons, of the share of the other entrants placed below them (1 for a win, 0 for last), then by wins, then by id. It is one chosen convention, not a measurement of skill, and placings in different fields are not the same thing.";
