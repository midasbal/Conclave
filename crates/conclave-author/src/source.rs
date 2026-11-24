//! Strategy source format v1 (ruleset 2): text in, canonical VM bytecode out. See docs/AUTHORING.md for the language reference.
//!
//!   conclave-strategy 1 ruleset 2        header, required, first statement; pins the format version and the ruleset the strategy is written for
//!   name "Momentum 20"                   optional metadata (name, author, note); never part of the bytecode
//!   state prev                           declare a register that carries its value from the previous tick (registers start at 0 every episode)
//!   x = sig T20                          one instruction per line:  [dst =] mnemonic operands     (# starts a comment)
//!   x = thr x 0.1
//!   pos x
//!
//! Register names are assigned to r0..r15 in order of introduction, lowest free index first (r0..r15 may also be written directly and are then reserved). The mapping is
//! deterministic, so the same source always assembles to the same bytes. Cost comes from the VM's own `op_work`, not from a copy of the weights.
use conclave_vm::{op, op_work, sg, validate, DIVISIONS, MAX_OPS, NREG, NSIG, RING, RULESET, VERSION, WORK_CAP};
use sha2::{Digest, Sha256};

pub const FORMAT: u32 = 1;
pub const SIGNALS: [(&str, u8); 13] = [("U1", sg::U1), ("CUM", sg::CUM), ("T5", sg::T5), ("T10", sg::T10), ("T20", sg::T20), ("MOM", sg::MOM), ("VOLR", sg::VOLR), ("ZSC", sg::ZSC), ("TLEFT", sg::TLEFT), ("POS", sg::POS), ("CASH", sg::CASH), ("PNL", sg::PNL), ("DD", sg::DD)];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Form { Nop, Const, Sig, Un, Bin, Sel, Imm5, Ema, Hist, Win, Act }
pub struct OpInfo { pub name: &'static str, pub code: u8, pub form: Form, pub usage: &'static str, pub doc: &'static str }
macro_rules! o { ($n:expr, $c:expr, $f:expr, $u:expr, $d:expr) => { OpInfo { name: $n, code: $c, form: $f, usage: $u, doc: $d } }; }
pub const OPS: [OpInfo; 34] = [
    o!("nop", op::NOP, Form::Nop, "nop", "does nothing"),
    o!("const", op::LDI, Form::Const, "d = const NUM", "d = NUM, quantised to 1/256, range -128 to 127.99609375"),
    o!("sig", op::SIG, Form::Sig, "d = sig NAME", "d = a market feature (U1 CUM T5 T10 T20 MOM VOLR ZSC TLEFT) or this seat's own POS CASH PNL DD"),
    o!("mov", op::MOV, Form::Un, "d = mov a", "d = a"), o!("add", op::ADD, Form::Bin, "d = add a b", "d = a + b, saturating"), o!("sub", op::SUB, Form::Bin, "d = sub a b", "d = a - b, saturating"),
    o!("mul", op::MUL, Form::Bin, "d = mul a b", "d = a * b in Q16.16, saturating"), o!("div", op::DIV, Form::Bin, "d = div a b", "d = a / b in Q16.16, saturating; division by zero gives 0"),
    o!("neg", op::NEG, Form::Un, "d = neg a", "d = -a"), o!("abs", op::ABS, Form::Un, "d = abs a", "d = |a|"), o!("sign", op::SIGN, Form::Un, "d = sign a", "d = +1, -1 or 0"),
    o!("min", op::MIN, Form::Bin, "d = min a b", "smaller of a and b"), o!("max", op::MAX, Form::Bin, "d = max a b", "larger of a and b"),
    o!("gt", op::GT, Form::Bin, "d = gt a b", "d = 1.0 if a > b else 0"), o!("lt", op::LT, Form::Bin, "d = lt a b", "d = 1.0 if a < b else 0"),
    o!("and", op::AND, Form::Bin, "d = and a b", "d = 1.0 if both are nonzero else 0"), o!("or", op::OR, Form::Bin, "d = or a b", "d = 1.0 if either is nonzero else 0"), o!("not", op::NOT, Form::Un, "d = not a", "d = 1.0 if a is zero else 0"),
    o!("sel", op::SEL, Form::Sel, "d = sel a b", "d = a if d is nonzero else b (d is read as the condition, so it must hold a value)"),
    o!("gti", op::GTI, Form::Imm5, "d = gti a NUM", "d = 1.0 if a > NUM else 0; NUM quantised to 1/32, range -4 to 3.96875"), o!("lti", op::LTI, Form::Imm5, "d = lti a NUM", "d = 1.0 if a < NUM else 0; NUM quantised to 1/32"),
    o!("thr", op::THR, Form::Imm5, "d = thr a NUM", "d = a if a >= NUM or a <= -NUM else 0 (a dead band of half-width NUM); NUM quantised to 1/32"),
    o!("ema", op::EMA, Form::Ema, "d = ema a SHIFT", "d += (a - d) >> SHIFT, SHIFT 0..15; d keeps its value between ticks"),
    o!("hist", op::HIST, Form::Hist, "d = hist LAG", "d = the return LAG ticks ago in vol units, LAG 0..31 (0 is this tick)"),
    o!("wsum", op::WSUM, Form::Win, "d = wsum N", "d = windowed sum of the last N returns, vol-normalised, N 1..32"), o!("volw", op::VOLW, Form::Win, "d = volw N", "d = mean absolute return over the last N ticks relative to smoothed vol, N 1..32"),
    o!("zw", op::ZW, Form::Win, "d = zw N", "d = z-score of the latest cumulative return against an N-tick window (mean absolute deviation), N 1..32"),
    o!("long", op::LONG, Form::Act, "long a", "if a is nonzero the direction becomes long"), o!("short", op::SHORT, Form::Act, "short a", "if a is nonzero the direction becomes short"), o!("flat", op::FLAT, Form::Act, "flat a", "if a is nonzero the direction becomes flat"),
    o!("size", op::SIZE, Form::Act, "size a", "size = a clamped to 0..1"), o!("pos", op::POS, Form::Act, "pos a", "direction and size from a, clamped to -1..1 (0 is flat)"),
    o!("stopset", op::STOPSET, Form::Act, "stopset a", "trade stop distance = max(a, 0) vol units; the seat is flattened once the open trade has lost that much"), o!("stopclr", op::STOPCLR, Form::Act, "stopclr a", "if a is nonzero a triggered stop is re-armed"),
];
pub fn op_by_name(n: &str) -> Option<&'static OpInfo> { OPS.iter().find(|o| o.name == n) }
pub fn op_by_code(c: u8) -> Option<&'static OpInfo> { OPS.iter().find(|o| o.code == c) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diag { pub line: usize, pub col: usize, pub msg: String }
impl Diag { pub fn render(&self, src: &str, kind: &str) -> String { let text = src.lines().nth(self.line.saturating_sub(1)).unwrap_or(""); let pad = " ".repeat(self.col.saturating_sub(1)); format!("{}: line {}, col {}: {}\n  {}\n  {}^", kind, self.line, self.col, self.msg, text, pad) } }

/// one assembled instruction with its cost
#[derive(Clone, Debug)]
pub struct OpLine { pub line: usize, pub text: String, pub op: &'static str, pub bytes: [u8; 4], pub work: u32 }

#[derive(Debug)]
pub struct Assembly {
    pub name: Option<String>, pub author: Option<String>, pub note: Option<String>,
    pub errors: Vec<Diag>, pub warnings: Vec<Diag>,
    pub ops: Vec<OpLine>, pub work: u32,
    /// the smallest division (work units 16, 32 or 64) the strategy fits, None when over the cap
    pub division: Option<u32>,
    /// None whenever there are errors
    pub code: Option<Vec<u8>>,
    pub registers: Vec<(String, u8)>,
    /// normalised source: comments and spacing removed, numbers shown as stored. Its hash identifies the source, whatever the author's formatting
    pub canonical: String, pub source_hash: [u8; 32], pub code_hash: Option<[u8; 32]>,
}
impl Assembly { pub fn is_ok(&self) -> bool { self.errors.is_empty() && self.code.is_some() } }
pub fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
pub fn division_for(work: u32) -> Option<u32> { DIVISIONS.iter().copied().find(|d| work <= *d) }

/// decimal to fixed point with integer arithmetic only (round half away from zero): returns (quantised value, exact?)
fn parse_fixed(s: &str, bits: u32) -> Result<(i64, bool), String> {
    let (neg, body) = match s.strip_prefix('-') { Some(r) => (true, r), None => (false, s.strip_prefix('+').unwrap_or(s)) };
    let (ip, fp) = match body.split_once('.') { Some((a, b)) => (a, b), None => (body, "") };
    if (ip.is_empty() && fp.is_empty()) || !ip.chars().all(|c| c.is_ascii_digit()) || !fp.chars().all(|c| c.is_ascii_digit()) || fp.len() > 12 || ip.len() > 9 { return Err(format!("'{}' is not a number (write it like 0.25 or -1.5)", s)); }
    let digits: i128 = format!("{}{}", if ip.is_empty() { "0" } else { ip }, fp).parse().map_err(|_| format!("'{}' is not a number", s))?; let den: i128 = 10i128.pow(fp.len() as u32);
    let scaled = digits * (1i128 << bits); let q = (scaled * 2 + den) / (2 * den); let exact = scaled % den == 0;
    let v = i64::try_from(q).map_err(|_| "number out of range".to_string())?; Ok((if neg { -v } else { v }, exact))
}
/// exact decimal text of v / 2^bits
pub fn fixed_text(v: i64, bits: u32) -> String {
    let neg = v < 0; let a = i128::from(v).abs(); let one = 1i128 << bits; let ip = a / one; let mut fr = a % one; let mut s = String::new();
    if fr != 0 { s.push('.'); while fr != 0 { fr *= 10; s.push(char::from(b'0' + u8::try_from(fr / one).unwrap_or(0))); fr %= one; } }
    format!("{}{}{}", if neg { "-" } else { "" }, ip, s)
}

fn is_reg_token(t: &str) -> Option<u8> { let d = t.strip_prefix('r')?; if d.is_empty() || !d.chars().all(|c| c.is_ascii_digit()) || d.len() > 3 { return None; } d.parse::<u32>().ok().filter(|n| (*n as usize) < NREG).map(|n| n as u8) }
fn looks_like_reg(t: &str) -> bool { t.strip_prefix('r').map(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) }
fn valid_name(t: &str) -> bool { let mut c = t.chars(); matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_') && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') && t.len() <= 24 }
const KEYWORDS: [&str; 5] = ["state", "free", "name", "author", "note"];

struct Tok { s: String, col: usize }
/// split one source line (comment removed) into tokens, with `=` always its own token and quoted strings kept whole
fn tokenize(line: &str) -> (Vec<Tok>, Option<String>) {
    let mut toks = vec![]; let mut cur = String::new(); let mut start = 0usize; let mut inq = false; let mut qstart = 0usize; let ch: Vec<char> = line.chars().collect(); let mut i = 0;
    let flush = |cur: &mut String, start: usize, toks: &mut Vec<Tok>| { if !cur.is_empty() { toks.push(Tok { s: std::mem::take(cur), col: start + 1 }); } };
    while i < ch.len() { let c = ch[i];
        if inq { cur.push(c); if c == '"' { inq = false; toks.push(Tok { s: std::mem::take(&mut cur), col: qstart + 1 }); } i += 1; continue; }
        if c == '#' { break; }
        if c == '"' { flush(&mut cur, start, &mut toks); inq = true; qstart = i; cur.push(c); i += 1; continue; }
        if c.is_whitespace() { flush(&mut cur, start, &mut toks); i += 1; continue; }
        if c == '=' { flush(&mut cur, start, &mut toks); toks.push(Tok { s: "=".into(), col: i + 1 }); i += 1; continue; }
        if cur.is_empty() { start = i; } cur.push(c); i += 1; }
    if inq { return (toks, Some("unterminated string".into())); }
    flush(&mut cur, start, &mut toks); (toks, None)
}

/// Assemble source text. Never panics: every problem is a Diag with line and column. Several errors are collected in one pass.
pub fn assemble(src: &str) -> Assembly {
    let mut a = Assembly { name: None, author: None, note: None, errors: vec![], warnings: vec![], ops: vec![], work: 0, division: None, code: None, registers: vec![], canonical: String::new(), source_hash: [0; 32], code_hash: None };
    let mut canon: Vec<String> = vec![]; let mut header_seen = false;
    // explicit r-names anywhere in the program are reserved, so automatic names never land on them
    let mut reserved = [false; NREG]; for l in src.lines() { let (toks, _) = tokenize(l); for t in &toks { if let Some(r) = is_reg_token(&t.s) { reserved[usize::from(r)] = true; } } }
    let mut names: Vec<(String, u8)> = vec![]; let mut used = reserved; let mut introduced = [false; NREG]; for r in 0..NREG { if reserved[r] { introduced[r] = true; } }
    let err = |a: &mut Assembly, line: usize, col: usize, msg: String| { if a.errors.len() < 25 { a.errors.push(Diag { line, col, msg }); } };
    for (li, raw) in src.lines().enumerate() { let line = li + 1; let (toks, unterminated) = tokenize(raw);
        if let Some(m) = unterminated { err(&mut a, line, 1, m); continue; } if toks.is_empty() { continue; }
        let t0 = toks[0].s.as_str();
        if !header_seen {
            if t0 != "conclave-strategy" { err(&mut a, line, toks[0].col, "the first statement must be the header: conclave-strategy 1 ruleset 2".into()); header_seen = true; continue; }
            header_seen = true; let ok = toks.len() == 4 && toks[2].s == "ruleset";
            if !ok { err(&mut a, line, toks[0].col, "malformed header, expected: conclave-strategy 1 ruleset 2".into()); continue; }
            match toks[1].s.parse::<u32>() { Ok(f) if f == FORMAT => {}, Ok(f) => err(&mut a, line, toks[1].col, format!("source format {} is not supported by this assembler (it reads format {})", f, FORMAT)), Err(_) => err(&mut a, line, toks[1].col, "format version must be a number".into()) }
            match toks[3].s.parse::<u32>() { Ok(r) if r == u32::from(RULESET) => {}, Ok(r) => err(&mut a, line, toks[3].col, format!("this strategy targets ruleset {} but this build is ruleset {}: strategies are pinned to the ruleset they were written for", r, RULESET)), Err(_) => err(&mut a, line, toks[3].col, "ruleset must be a number".into()) }
            canon.push(format!("conclave-strategy {} ruleset {}", FORMAT, RULESET)); continue; }
        if t0 == "conclave-strategy" { err(&mut a, line, toks[0].col, "the header may appear only once, as the first statement".into()); continue; }
        if matches!(t0, "name" | "author" | "note") {
            if toks.len() != 2 || !toks[1].s.starts_with('"') { err(&mut a, line, toks[0].col, format!("{} takes one quoted string, e.g. {} \"text\"", t0, t0)); continue; }
            let v = toks[1].s.trim_matches('"').to_string(); if v.len() > 80 || !v.chars().all(|c| c.is_ascii() && !c.is_control()) { err(&mut a, line, toks[1].col, format!("{} must be plain printable ASCII, at most 80 characters", t0)); continue; }
            let slot = match t0 { "name" => &mut a.name, "author" => &mut a.author, _ => &mut a.note }; if slot.is_some() { err(&mut a, line, toks[0].col, format!("{} is set twice", t0)); continue; } *slot = Some(v.clone()); canon.push(format!("{} \"{}\"", t0, v)); continue; }
        // register helpers (closures over names/used/introduced are awkward with the borrow checker, so small inline fns on explicit state)
        macro_rules! lookup { ($tok:expr, $write:expr) => {{
            let nm = $tok.s.as_str(); let col = $tok.col;
            if let Some(r) = is_reg_token(nm) { Some(r) }
            else if looks_like_reg(nm) { err(&mut a, line, col, format!("'{}' is not a register: the registers are r0..r{}", nm, NREG - 1)); None }
            else if !valid_name(nm) { err(&mut a, line, col, format!("'{}' is not a valid register name (letters, digits and _, starting with a letter, at most 24)", nm)); None }
            else if op_by_name(nm).is_some() || KEYWORDS.contains(&nm) { err(&mut a, line, col, format!("'{}' is a mnemonic or keyword and cannot be a register name", nm)); None }
            else if let Some((_, r)) = names.iter().find(|(n, _)| n == nm) { Some(*r) }
            else if $write { match (0..NREG).find(|i| !used[*i]) { Some(i) => { used[i] = true; introduced[i] = true; names.push((nm.to_string(), i as u8)); Some(i as u8) }
                None => { err(&mut a, line, col, format!("out of registers: all {} are in use ({}). Free one with `free NAME` once its value is no longer needed", NREG, names.iter().map(|(n, r)| format!("{}=r{}", n, r)).collect::<Vec<_>>().join(", "))); None } } }
            else { err(&mut a, line, col, format!("'{}' is read before it exists: assign it on an earlier line, or declare it with `state {}` if it should carry last tick's value", nm, nm)); None }
        }}; }
        if t0 == "state" { if toks.len() < 2 { err(&mut a, line, toks[0].col, "state needs at least one name".into()); continue; }
            let mut cn = String::from("state"); for t in &toks[1..] { if names.iter().any(|(n, _)| n == &t.s) { err(&mut a, line, t.col, format!("'{}' already exists", t.s)); continue; } if let Some(_r) = lookup!(t, true) { cn.push(' '); cn.push_str(&t.s); } } canon.push(cn); continue; }
        if t0 == "free" { if toks.len() != 2 { err(&mut a, line, toks[0].col, "free takes one name".into()); continue; } match names.iter().position(|(n, _)| n == &toks[1].s) { Some(p) => { let r = names[p].1; names.remove(p); used[usize::from(r)] = false; introduced[usize::from(r)] = false; canon.push(format!("free {}", toks[1].s)); } None => err(&mut a, line, toks[1].col, format!("'{}' is not a register that exists", toks[1].s)) } continue; }
        // instruction: [dst =] mnemonic operands
        let (dst_tok, mn_i) = if toks.len() >= 3 && toks[1].s == "=" { (Some(&toks[0]), 2) } else { (None, 0) };
        let Some(mn) = toks.get(mn_i) else { err(&mut a, line, toks[0].col, "expected a mnemonic after '='".into()); continue };
        let Some(info) = op_by_name(&mn.s) else { err(&mut a, line, mn.col, format!("unknown mnemonic '{}'{}", mn.s, did_you_mean(&mn.s))); continue };
        let args: Vec<&Tok> = toks[mn_i + 1..].iter().collect(); let want_dst = !matches!(info.form, Form::Act | Form::Nop);
        if want_dst && dst_tok.is_none() { err(&mut a, line, mn.col, format!("{} needs a destination: {}", info.name, info.usage)); continue; }
        if !want_dst && dst_tok.is_some() { err(&mut a, line, toks[0].col, format!("{} has no destination: {}", info.name, info.usage)); continue; }
        if toks.iter().skip(mn_i + 1).any(|t| t.s == "=") { err(&mut a, line, mn.col, "only one '=' is allowed per line".into()); continue; }
        let nargs = match info.form { Form::Nop => 0, Form::Const | Form::Sig | Form::Un | Form::Hist | Form::Win | Form::Act => 1, Form::Bin | Form::Sel | Form::Imm5 | Form::Ema => 2 };
        if args.len() != nargs { err(&mut a, line, mn.col, format!("{} takes {} operand{}: {}", info.name, nargs, if nargs == 1 { "" } else { "s" }, info.usage)); continue; }
        let mut bytes = [info.code, 0, 0, 0]; let mut ok = true; let mut shown = vec![];
        // destination first (it may introduce the register), then sources
        let dst_fresh = dst_tok.map(|t| is_reg_token(&t.s).is_none() && !names.iter().any(|(n, _)| n == &t.s)).unwrap_or(false);
        let d = if let Some(t) = dst_tok { let r = lookup!(t, true); if r.is_none() { ok = false; } r } else { None }; if let (Some(t), Some(r)) = (dst_tok, d) { bytes[1] = r; shown.push(t.s.clone()); }
        match info.form {
            Form::Nop => {}
            Form::Const => { let t = args[0]; match parse_fixed(&t.s, 8) { Ok((v, exact)) => { if !(-32768..=32767).contains(&v) { err(&mut a, line, t.col, format!("{} is outside the const range -128 to 127.99609375", t.s)); ok = false; } else { let u = (v as i16) as u16; bytes[2] = (u & 255) as u8; bytes[3] = (u >> 8) as u8; shown.push("=".into()); shown.push("const".into()); shown.push(fixed_text(v, 8));
                    if !exact { a.warnings.push(Diag { line, col: t.col, msg: format!("{} is not a multiple of 1/256 and is stored as {}", t.s, fixed_text(v, 8)) }); } } } Err(m) => { err(&mut a, line, t.col, m); ok = false; } } }
            Form::Sig => { let t = args[0]; match SIGNALS.iter().find(|(n, _)| n.eq_ignore_ascii_case(&t.s)) { Some((n, id)) => { debug_assert!(*id < NSIG); bytes[2] = *id; shown.push("=".into()); shown.push("sig".into()); shown.push((*n).into()); } None => { err(&mut a, line, t.col, format!("unknown signal '{}'; the signals are {}", t.s, SIGNALS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(" "))); ok = false; } } }
            Form::Un | Form::Bin | Form::Sel | Form::Ema | Form::Imm5 => {
                shown.push("=".into()); shown.push(info.name.into());
                if info.form == Form::Sel && dst_fresh { a.warnings.push(Diag { line, col: toks[0].col, msg: format!("sel reads its destination '{}' as the condition, but nothing has assigned it yet: the condition is always 0 and sel always picks its second operand", toks[0].s) }); }
                let ta = args[0]; let ra = lookup!(ta, false); match ra { Some(r) => { bytes[2] = r; shown.push(ta.s.clone()); } None => ok = false }
                match info.form {
                    Form::Bin => { let tb = args[1]; match lookup!(tb, false) { Some(r) => { bytes[3] = r; shown.push(tb.s.clone()); } None => ok = false } }
                    Form::Sel => { let tb = args[1]; match lookup!(tb, false) { Some(r) => { bytes[3] = r; shown.push(tb.s.clone()); } None => ok = false } }
                    Form::Imm5 => { let tb = args[1]; match parse_fixed(&tb.s, 5) { Ok((v, exact)) => { if !(-128..=127).contains(&v) { err(&mut a, line, tb.col, format!("{} is outside the threshold range -4 to 3.96875", tb.s)); ok = false; } else { bytes[3] = (v as i8) as u8; shown.push(fixed_text(v, 5)); if !exact { a.warnings.push(Diag { line, col: tb.col, msg: format!("{} is not a multiple of 1/32 and is stored as {}", tb.s, fixed_text(v, 5)) }); } } } Err(m) => { err(&mut a, line, tb.col, m); ok = false; } } }
                    Form::Ema => { let tb = args[1]; match tb.s.parse::<u8>() { Ok(v) if v <= 15 => { bytes[3] = v; shown.push(v.to_string()); } _ => { err(&mut a, line, tb.col, format!("ema shift must be a whole number 0..15, got '{}'", tb.s)); ok = false; } } }
                    _ => {} } }
            Form::Hist => { let t = args[0]; match t.s.parse::<u32>() { Ok(v) if (v as usize) < RING => { bytes[2] = v as u8; shown.push("=".into()); shown.push("hist".into()); shown.push(v.to_string()); } _ => { err(&mut a, line, t.col, format!("hist lag must be a whole number 0..{}, got '{}'", RING - 1, t.s)); ok = false; } } }
            Form::Win => { let t = args[0]; match t.s.parse::<u32>() { Ok(v) if v >= 1 && (v as usize) <= RING => { bytes[2] = v as u8; shown.push("=".into()); shown.push(info.name.into()); shown.push(v.to_string()); } _ => { err(&mut a, line, t.col, format!("{} window must be a whole number 1..{}, got '{}'", info.name, RING, t.s)); ok = false; } } }
            Form::Act => { let t = args[0]; shown.push(info.name.into()); match lookup!(t, false) { Some(r) => { bytes[2] = r; shown.push(t.s.clone()); } None => ok = false } }
        }
        if !ok { continue; }
        if matches!(info.form, Form::Nop) { shown.push("nop".into()); }
        if a.ops.len() >= MAX_OPS { let nth = a.ops.len() + 1; err(&mut a, line, mn.col, format!("too many instructions: a strategy has at most {} (this is number {})", MAX_OPS, nth)); continue; }
        let work = op_work(info.code, u32::from(bytes[2])); let text = shown.join(" "); canon.push(text.clone()); a.ops.push(OpLine { line, text, op: info.name, bytes, work });
    }
    if !header_seen && a.errors.is_empty() { err(&mut a, 1, 1, "empty source: the first statement must be the header: conclave-strategy 1 ruleset 2".into()); }
    a.work = a.ops.iter().map(|o| o.work).sum(); a.division = division_for(a.work);
    if a.errors.is_empty() && a.ops.is_empty() { a.warnings.push(Diag { line: 1, col: 1, msg: "the strategy has no instructions: it never takes a position".into() }); }
    if a.errors.is_empty() && !a.ops.iter().any(|o| matches!(o.op, "pos" | "long" | "short")) { a.warnings.push(Diag { line: 1, col: 1, msg: "no pos, long or short instruction: this strategy can never take a position".into() }); }
    if a.work > WORK_CAP && a.errors.is_empty() {
        let mut heavy: Vec<&OpLine> = a.ops.iter().filter(|o| o.work > 1).collect(); heavy.sort_by(|x, y| y.work.cmp(&x.work).then(x.line.cmp(&y.line)));
        let top = heavy.iter().take(4).map(|o| format!("line {} {} costs {}", o.line, o.op, o.work)).collect::<Vec<_>>().join(", ");
        let last = a.ops.last().map(|o| o.line).unwrap_or(1); a.errors.push(Diag { line: last, col: 1, msg: format!("work {} is over the cap of {} (by {}). Cost is the sum of per-instruction weights; the heaviest here: {}", a.work, WORK_CAP, a.work - WORK_CAP, if top.is_empty() { "none (many plain instructions at 1 each)".into() } else { top }) }); }
    a.registers = names.clone(); a.registers.sort_by_key(|(_, r)| *r);
    // unused-state and unread warnings are left to the simulator report; a fixed header, then canonical lines
    a.canonical = canon.join("\n"); a.canonical.push('\n'); a.source_hash = Sha256::digest(a.canonical.as_bytes()).into();
    if a.errors.is_empty() { let mut v = vec![VERSION, a.ops.len() as u8, 0, 0]; for o in &a.ops { v.extend_from_slice(&o.bytes); }
        match validate(&v) { Ok(_) => { a.code_hash = Some(Sha256::digest(&v).into()); a.code = Some(v); } Err(e) => a.errors.push(Diag { line: 1, col: 1, msg: format!("internal: the assembled program failed the VM's validation ({:?}); this is an assembler bug, please report it", e) }) } }
    a
}
fn did_you_mean(s: &str) -> String { let l = s.to_ascii_lowercase(); let best = OPS.iter().map(|o| (lev(&l, o.name), o.name)).min(); match best { Some((d, n)) if d <= 2 => format!(" (did you mean '{}'?)", n), _ => String::new() } }
fn lev(a: &str, b: &str) -> usize { let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect()); let mut prev: Vec<usize> = (0..=b.len()).collect(); for i in 1..=a.len() { let mut cur = vec![i]; for j in 1..=b.len() { cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]))); } prev = cur; } prev[b.len()] }

/// Canonical source for any valid program, with physical register names. `assemble(disassemble(c)) == c` for every program that passes `validate`.
pub fn disassemble(code: &[u8]) -> Result<String, conclave_vm::VmError> {
    let n = validate(code)?; let mut s = format!("conclave-strategy {} ruleset {}\n", FORMAT, RULESET);
    for i in 0..n { let o = &code[4 + 4 * i..8 + 4 * i]; let (c, d, a, b) = (o[0], o[1], o[2], o[3]); let info = match op_by_code(c) { Some(i) => i, None => continue };
        let line = match info.form { Form::Nop => "nop".to_string(), Form::Const => format!("r{} = const {}", d, fixed_text(i64::from(i16::from_le_bytes([a, b])), 8)), Form::Sig => format!("r{} = sig {}", d, SIGNALS.iter().find(|(_, id)| *id == a).map(|(n, _)| *n).unwrap_or("U1")),
            Form::Un => format!("r{} = {} r{}", d, info.name, a), Form::Bin | Form::Sel => format!("r{} = {} r{} r{}", d, info.name, a, b), Form::Imm5 => format!("r{} = {} r{} {}", d, info.name, a, fixed_text(i64::from(i8::from_le_bytes([b])), 5)),
            Form::Ema => format!("r{} = ema r{} {}", d, a, b), Form::Hist => format!("r{} = hist {}", d, a), Form::Win => format!("r{} = {} {}", d, info.name, a), Form::Act => format!("{} r{}", info.name, a) };
        s.push_str(&line); s.push('\n'); }
    Ok(s)
}

use crate::json::J;
/// machine-readable assembler result (also what the WASM build returns)
pub fn assembly_json(a: &Assembly) -> String {
    let d = |v: &Vec<Diag>| J::arr(v.iter().map(|x| J::obj(vec![("line", J::n(x.line as f64)), ("col", J::n(x.col as f64)), ("msg", J::s(&x.msg))])).collect());
    J::obj(vec![("ok", J::Bool(a.is_ok())), ("format", J::n(f64::from(FORMAT))), ("ruleset", J::n(f64::from(RULESET))), ("name", a.name.as_deref().map(J::s).unwrap_or(J::Null)), ("author", a.author.as_deref().map(J::s).unwrap_or(J::Null)), ("note", a.note.as_deref().map(J::s).unwrap_or(J::Null)),
        ("errors", d(&a.errors)), ("warnings", d(&a.warnings)),
        ("ops", J::arr(a.ops.iter().map(|o| J::obj(vec![("line", J::n(o.line as f64)), ("op", J::s(o.op)), ("work", J::n(f64::from(o.work))), ("text", J::s(&o.text)), ("bytes", J::s(&hex(&o.bytes)))])).collect())),
        ("work", J::n(f64::from(a.work))), ("work_cap", J::n(f64::from(WORK_CAP))), ("division", match a.division { Some(v) => J::n(f64::from(v)), None => J::Null }),
        ("registers", J::arr(a.registers.iter().map(|(n, r)| J::obj(vec![("name", J::s(n)), ("reg", J::n(f64::from(*r)))])).collect())),
        ("bytecode", match &a.code { Some(c) => J::s(&hex(c)), None => J::Null }), ("code_sha256", match &a.code_hash { Some(h) => J::s(&hex(h)), None => J::Null }), ("source_sha256", J::s(&hex(&a.source_hash))), ("canonical", J::s(&a.canonical))]).to_string()
}
/// the per-instruction cost table the author sees
pub fn listing(a: &Assembly, src: &str) -> String {
    let mut o = String::new();
    if !a.ops.is_empty() { o += " line  op        work  instruction\n"; for l in &a.ops { o += &format!(" {:>4}  {:<8} {:>5}  {}\n", l.line, l.op, l.work, l.text); } }
    o += &format!(" total work {} of the {} cap", a.work, WORK_CAP);
    match a.division { Some(d) => o += &format!(" -> fits division {} ({} work units to spare in it; divisions are {})\n", d, d - a.work, DIVISIONS.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")), None => o += &format!(" -> OVER THE CAP, refused (divisions are {})\n", DIVISIONS.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")) }
    if !a.registers.is_empty() { o += &format!(" registers: {}\n", a.registers.iter().map(|(n, r)| format!("{}=r{}", n, r)).collect::<Vec<_>>().join(" ")); }
    for w in &a.warnings { o += &format!("{}\n", w.render(src, "warning")); }
    for e in &a.errors { o += &format!("{}\n", e.render(src, "error")); }
    if let (Some(c), Some(h)) = (&a.code, &a.code_hash) { o += &format!(" bytecode ({} bytes): {}\n code sha256   {}\n source sha256 {}\n", c.len(), hex(c), hex(h), hex(&a.source_hash)); }
    o
}
