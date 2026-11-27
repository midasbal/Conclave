// Generated from `conclave-author ops`, the engine's own instruction reference. Do not edit the entries here.
export const INSTRUCTIONS = [
  { group: "Values and signals", ops: [
    { usage: "d = const NUM", does: "d = NUM, quantised to 1/256, range -128 to 127.99609375" },
    { usage: "d = sig NAME", does: "d = a market feature (U1 CUM T5 T10 T20 MOM VOLR ZSC TLEFT) or this seat's own POS CASH PNL DD" },
    { usage: "d = mov a", does: "d = a" },
  ] },
  { group: "Arithmetic", ops: [
    { usage: "d = add a b", does: "d = a + b, saturating" },
    { usage: "d = sub a b", does: "d = a - b, saturating" },
    { usage: "d = mul a b", does: "d = a * b in Q16.16, saturating" },
    { usage: "d = div a b", does: "d = a / b in Q16.16, saturating; division by zero gives 0" },
    { usage: "d = neg a", does: "d = -a" },
    { usage: "d = abs a", does: "d = |a|" },
    { usage: "d = sign a", does: "d = +1, -1 or 0" },
    { usage: "d = min a b", does: "smaller of a and b" },
    { usage: "d = max a b", does: "larger of a and b" },
  ] },
  { group: "Comparisons and choices", ops: [
    { usage: "d = gt a b", does: "d = 1.0 if a > b else 0" },
    { usage: "d = lt a b", does: "d = 1.0 if a < b else 0" },
    { usage: "d = and a b", does: "d = 1.0 if both are nonzero else 0" },
    { usage: "d = or a b", does: "d = 1.0 if either is nonzero else 0" },
    { usage: "d = not a", does: "d = 1.0 if a is zero else 0" },
    { usage: "d = sel a b", does: "d = a if d is nonzero else b (d is read as the condition, so it must hold a value)" },
    { usage: "d = gti a NUM", does: "d = 1.0 if a > NUM else 0; NUM quantised to 1/32, range -4 to 3.96875" },
    { usage: "d = lti a NUM", does: "d = 1.0 if a < NUM else 0; NUM quantised to 1/32" },
    { usage: "d = thr a NUM", does: "d = a if a >= NUM or a <= -NUM else 0 (a dead band of half-width NUM); NUM quantised to 1/32" },
  ] },
  { group: "Smoothing and rolling windows", ops: [
    { usage: "d = ema a SHIFT", does: "d += (a - d) >> SHIFT, SHIFT 0..15; d keeps its value between ticks" },
    { usage: "d = hist LAG", does: "d = the return LAG ticks ago in vol units, LAG 0..31 (0 is this tick)" },
    { usage: "d = wsum N", does: "d = windowed sum of the last N returns, vol-normalised, N 1..32" },
    { usage: "d = volw N", does: "d = mean absolute return over the last N ticks relative to smoothed vol, N 1..32" },
    { usage: "d = zw N", does: "d = z-score of the latest cumulative return against an N-tick window (mean absolute deviation), N 1..32" },
  ] },
  { group: "Position", ops: [
    { usage: "long a", does: "if a is nonzero the direction becomes long" },
    { usage: "short a", does: "if a is nonzero the direction becomes short" },
    { usage: "flat a", does: "if a is nonzero the direction becomes flat" },
    { usage: "size a", does: "size = a clamped to 0..1" },
    { usage: "pos a", does: "direction and size from a, clamped to -1..1 (0 is flat)" },
  ] },
  { group: "Stops", ops: [
    { usage: "stopset a", does: "trade stop distance = max(a, 0) vol units; the seat is flattened once the open trade has lost that much" },
    { usage: "stopclr a", does: "if a is nonzero a triggered stop is re-armed" },
  ] },
  { group: "Other", ops: [
    { usage: "nop", does: "does nothing" },
  ] },
] as const;

export const WORK_NOTE = "work per instruction: plain 1, hist 5, wsum 5+ceil(n/3), volw 6+ceil(2n/5), zw 11+n ; cap 64 ; divisions [16, 32, 64]";
