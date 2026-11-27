// The only strategy the experiment seals. It is public here on purpose, does nothing of use (it compares a 5-tick trend with 42.5, so it never takes a
// position), and has bytes that are easy to find in whatever a wallet shows. Assembled by conclave-author from the source below.
export const TEST_STRATEGY = {
  name: "Throwaway wallet test",
  source: `conclave-strategy 1 ruleset 2
name "Throwaway wallet test"
x = const 42.5
y = sig T5
y = gt y x
long y
`,
  bytecode: "020400000100802a020102000d0101001b000100",
} as const;
