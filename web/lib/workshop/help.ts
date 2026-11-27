// Every explanation behind a question mark, in one place so that it can be read and checked as a whole. Sources: crates/conclave-author/src/sim.rs
// (ranks, the two sets of worlds), crates/conclave-vm (work, ticks, episodes), crates/conclave-vm/RULESET.md.
export const HELP = {
  instructions: {
    label: "instructions",
    text: "Each line of your strategy that does something is one instruction. The first line, names, notes, comments and lines that only declare or free a register do not count. A strategy can have at most 64.",
  },
  work: {
    label: "work units per tick",
    text: "How much computing your strategy does on each tick, one step of the market. Most instructions cost 1. Those that look back over past price moves cost more. The limit is 64.",
  },
  division: {
    label: "division",
    text: "A season sets a ceiling on work units: 16, 32 or 64. This is the smallest one your strategy fits under. It fits any season with that ceiling or a higher one.",
  },
  volUnits: {
    label: "vol-units",
    text: "The unit of score. It measures gain or loss relative to how much the market was moving, which puts quiet and lively markets on one scale. A season total adds up every episode. It is not money.",
  },
  medianRank: {
    label: "median rank",
    text: "Your strategy gets a place in every practice world, 1 being best, and a tie counts against it. This is the middle one of those places: in about half the worlds it did at least this well.",
  },
  field: {
    label: "the built-in field",
    text: "44 reference strategies that come with the engine, run on the same worlds as yours. They are not other players, and beating them says nothing about how a real season would go.",
  },
  worlds: {
    label: "practice and unseen worlds",
    text: "A world is one made-up market history. Practice worlds are the same on every run, so edits compare fairly, but you can end up tuning to them. Unseen worlds are drawn from your assembled instructions, so changing those draws new ones. Doing well only in practice worlds may be luck or tuning.",
  },
  ruleset: {
    label: "ruleset",
    text: "The version of the rules: what each instruction does and costs, and how markets are made and scored. This engine runs ruleset 2. A strategy names the ruleset it was written for in its first line.",
  },
  seed: {
    label: "practice seed",
    text: "Any text or number. The same seed always draws the same markets, so you can replay a season. It is not the random seed a real season uses.",
  },
  episodes: {
    label: "episodes",
    text: "An episode is one stretch of market, 150 ticks long. A season plays several, and its total adds them up.",
  },
} as const;

export type HelpKey = keyof typeof HELP;
