//! Strategy pool: every strategy is assembled from the real op set and validated. Families are parameterised so a tuner (= what a competitor would do) can search them.
use crate::asm::Asm; use conclave_vm::{op, sg};
pub struct Spec { pub name: String, pub tier: u8, pub fam: &'static str, pub tuned: bool, pub params: Vec<f64>, pub code: Vec<u8>, pub regs: usize }

fn sign_or_scale(a: &mut Asm, x: u8, mode: u8, gain: f64) { // x -> direction/size value in place
    if mode == 0 { a.e(op::SIGN, x, x, 0); } else { let g = a.r(); a.ldi(g, gain); a.e(op::MUL, x, x, g); a.ldi(g, 1.0); a.e(op::MIN, x, x, g); a.e(op::NEG, g, g, 0); a.e(op::MAX, x, x, g); a.f(g); }
}
/// tail: apply optional trade stop with re-arm on direction change, then POS
fn tail(a: &mut Asm, x: u8, stop: f64) {
    if stop > 0.0 {
        let s = a.r(); a.ldi(s, stop); a.e(op::STOPSET, 0, s, 0);
        let p = a.r(); let d = a.r(); a.e(op::SIGN, d, x, 0); a.e(op::SUB, s, d, p); a.e(op::ABS, s, s, 0); a.e(op::STOPCLR, 0, s, 0); a.e(op::MOV, p, d, 0); a.f(d); a.f(s); a.f(p);
        // note: p stays allocated conceptually (persistent state): re-reserve
        a.keep(p);
    }
    a.e(op::POS, 0, x, 0);
}
impl Asm { pub fn keep(&mut self, r: u8) { self.reserve(r); } }
fn win_sig(w: usize) -> u8 { [sg::T5, sg::T10, sg::T20][w.min(2)] }

// ---- families (each returns a finished Asm) ----
pub fn mom(p: &[f64]) -> Asm { let mut a = Asm::new(); let x = a.r(); a.sig(x, win_sig(p[0] as usize)); if p[1] > 0.0 { a.thr(x, x, p[1]); } sign_or_scale(&mut a, x, p[2] as u8, p[3]); tail(&mut a, x, p[4]); a }
pub fn rev(p: &[f64]) -> Asm { let mut a = Asm::new(); let x = a.r(); match p[0] as usize { 0 => a.sig(x, sg::ZSC), 1 => a.e(op::ZW, x, 8, 0), 2 => a.e(op::ZW, x, 16, 0), _ => a.e(op::ZW, x, 32, 0) } if p[1] > 0.0 { a.thr(x, x, p[1]); } a.e(op::NEG, x, x, 0); sign_or_scale(&mut a, x, p[2] as u8, p[3]); tail(&mut a, x, p[4]); a }
pub fn cross(p: &[f64]) -> Asm { let mut a = Asm::new(); let c = a.r(); let ef = a.r(); let es = a.r(); a.sig(c, sg::CUM); a.e(op::EMA, ef, c, p[0] as u8); a.e(op::EMA, es, c, p[1] as u8); a.e(op::SUB, c, ef, es); if p[2] > 0.0 { a.thr(c, c, p[2]); } a.e(op::SIGN, c, c, 0); tail(&mut a, c, p[3]); a }
pub fn brk(p: &[f64]) -> Asm { let mut a = Asm::new(); let x = a.r(); a.e(op::ZW, x, p[0] as u8, 0); a.thr(x, x, p[1]); a.e(op::SIGN, x, x, 0); if p[2] > 0.5 { a.e(op::NEG, x, x, 0); } tail(&mut a, x, p[3]); a }
pub fn volf(p: &[f64]) -> Asm { let mut a = Asm::new(); let x = a.r(); let v = a.r(); a.sig(x, win_sig(p[0] as usize)); a.thr(x, x, p[1]); a.e(op::SIGN, x, x, 0); a.sig(v, sg::VOLR);
    match p[3] as usize { 0 => a.lti(v, v, p[2]), 1 => a.gti(v, v, p[2]), _ => { a.gti(v, v, p[2]); let n = a.r(); a.ldi(n, -2.0); a.e(op::MUL, n, v, n); a.ldi(v, 1.0); a.e(op::ADD, v, v, n); a.f(n); } }
    a.e(op::MUL, x, x, v); tail(&mut a, x, 0.0); a }
pub fn tsw(p: &[f64]) -> Asm { let mut a = Asm::new(); let t = a.r(); let f = a.r(); let z = a.r(); a.sig(t, sg::T20); a.e(op::ABS, f, t, 0); a.gti(f, f, p[0]); a.e(op::SIGN, t, t, 0); a.sig(z, sg::ZSC); a.thr(z, z, p[1]); a.e(op::SIGN, z, z, 0); a.e(op::NEG, z, z, 0); a.e(op::SEL, f, t, z); tail(&mut a, f, p[2]); a }
pub fn acsw(p: &[f64]) -> Asm { let mut a = Asm::new(); let prev = a.r(); let c = a.r(); let v = a.r(); let u = a.r(); let t = a.r(); let g = a.r(); let l = a.r();
    a.sig(u, sg::U1); a.e(op::MUL, t, u, prev); a.e(op::EMA, c, t, p[0] as u8); a.e(op::MUL, t, u, u); a.e(op::EMA, v, t, p[0] as u8); a.e(op::MOV, prev, u, 0);
    a.e(op::DIV, t, c, v); a.gti(g, t, p[1]); a.lti(l, t, -p[1]); a.e(op::SUB, g, g, l); a.sig(t, sg::T5); a.e(op::SIGN, t, t, 0); a.e(op::MUL, g, g, t);
    tail(&mut a, g, p[2]); a }
pub fn jump(p: &[f64]) -> Asm { let mut a = Asm::new(); let u = a.r(); let j = a.r(); let j2 = a.r(); let cnt = a.r(); let d = a.r(); let one = a.r(); let z = a.r(); let h = a.r();
    a.sig(u, sg::U1); a.e(op::ABS, j, u, 0); a.gti(j, j, p[0]); a.e(op::MOV, j2, j, 0); a.ldi(one, 1.0); a.e(op::ADD, cnt, cnt, one); a.ldi(z, 0.0); a.e(op::SEL, j, z, cnt); a.e(op::MOV, cnt, j, 0);
    a.e(op::SIGN, z, u, 0); a.e(op::SEL, j2, z, d); a.e(op::MOV, d, j2, 0);
    a.ldi(h, p[1]); a.e(op::LT, h, cnt, h); a.e(op::NEG, z, d, 0); a.sig(u, win_sig(p[2] as usize)); a.e(op::SIGN, u, u, 0); a.e(op::SEL, h, z, u); tail(&mut a, h, 0.0); a }
pub fn ens(p: &[f64]) -> Asm { let mut a = Asm::new(); let s = a.r(); let x = a.r(); let ef = a.r(); let es = a.r(); a.sig(x, sg::T20); a.e(op::SIGN, s, x, 0); a.sig(x, sg::ZSC); a.thr(x, x, p[0]); a.e(op::SIGN, x, x, 0); a.e(op::NEG, x, x, 0); a.e(op::ADD, s, s, x);
    a.sig(x, sg::CUM); a.e(op::EMA, ef, x, 2); a.e(op::EMA, es, x, 4); a.e(op::SUB, x, ef, es); a.thr(x, x, p[1]); a.e(op::SIGN, x, x, 0); a.e(op::ADD, s, s, x); a.ldi(x, 0.3333); a.e(op::MUL, s, s, x); tail(&mut a, s, p[2]); a }

#[derive(Clone, Copy, Debug)] pub enum Ex { Mom(u8, f64), Rev(f64), Cross(u8, u8), Ac(u8), Brk(u8, f64), FadeLast }
/// Expert-switching composite. p = [perf_shift, gate, dd_thr(0=off), stop, mode(0 argmax,1 blend,2 anti-argmin)]. experts chosen by `set`.
pub fn xsw(set: &[Ex], p: &[f64]) -> Asm {
    let mut a = Asm::new(); let n = set.len(); let u1 = a.r(); a.sig(u1, sg::U1);
    let mut perf = vec![]; let mut prev = vec![]; let mut s = vec![];
    for _ in 0..n { perf.push(a.r()); prev.push(a.r()); }
    for _ in 0..n { s.push(a.r()); }
    let t = a.r();
    for k in 0..n { a.e(op::MUL, t, prev[k], u1); a.e(op::EMA, perf[k], t, p[0] as u8); }
    a.f(u1);
    let mut extra: Vec<u8> = vec![]; // persistent expert state regs (cross: ef,es ; ac: c,v,prev)
    for k in 0..n { let sk = s[k];
        match set[k] {
            Ex::Mom(w, th) => { a.sig(sk, win_sig(w as usize)); if th > 0.0 { a.thr(sk, sk, th); } a.e(op::SIGN, sk, sk, 0); }
            Ex::Rev(th) => { a.sig(sk, sg::ZSC); a.thr(sk, sk, th); a.e(op::SIGN, sk, sk, 0); a.e(op::NEG, sk, sk, 0); }
            Ex::Cross(fs, ss) => { let ef = a.r(); let es = a.r(); extra.push(ef); extra.push(es); a.sig(sk, sg::CUM); a.e(op::EMA, ef, sk, fs); a.e(op::EMA, es, sk, ss); a.e(op::SUB, sk, ef, es); a.thr(sk, sk, 0.1); a.e(op::SIGN, sk, sk, 0); }
            Ex::Brk(nn, th) => { a.e(op::ZW, sk, nn, 0); a.thr(sk, sk, th); a.e(op::SIGN, sk, sk, 0); }
            Ex::FadeLast => { a.sig(sk, sg::U1); a.e(op::SIGN, sk, sk, 0); a.e(op::NEG, sk, sk, 0); }
            Ex::Ac(sh) => { // autocorr gate on T5 direction; state: prev u, c, v
                let pu = a.r(); let c = a.r(); let v = a.r(); extra.push(pu); extra.push(c); extra.push(v);
                a.sig(sk, sg::U1); a.e(op::MUL, t, sk, pu); a.e(op::EMA, c, t, sh); a.e(op::MUL, t, sk, sk); a.e(op::EMA, v, t, sh); a.e(op::MOV, pu, sk, 0);
                a.e(op::DIV, t, c, v); a.sig(sk, sg::T5); a.e(op::SIGN, sk, sk, 0);
                let g = a.r(); a.gti(g, t, 0.1); let l = a.r(); a.lti(l, t, -0.1); a.e(op::SUB, g, g, l); a.e(op::MUL, sk, sk, g); a.f(g); a.f(l);
            }
        }
    }
    // pick
    let out = a.r();
    if p[4] as u8 == 1 { // blend: sum max(perf,0)*s / sum max(perf,0)
        let num = out; let den = a.r(); let z = a.r(); a.ldi(z, 0.0); a.ldi(num, 0.0); a.ldi(den, 0.0);
        for k in 0..n { a.e(op::MAX, t, perf[k], z); a.e(op::ADD, den, den, t); a.e(op::MUL, t, t, s[k]); a.e(op::ADD, num, num, t); }
        a.e(op::DIV, num, num, den); a.f(den); a.f(z);
    } else {
        let best = a.r(); let c = a.r(); a.e(op::MOV, out, s[0], 0); a.e(op::MOV, best, perf[0], 0);
        for k in 1..n { if p[4] as u8 == 2 { a.e(op::LT, c, perf[k], best); a.e(op::MIN, best, best, perf[k]); } else { a.e(op::GT, c, perf[k], best); a.e(op::MAX, best, best, perf[k]); } a.e(op::SEL, c, s[k], out); a.e(op::MOV, out, c, 0); }
        if p[1] > 0.0 && p[4] as u8 != 2 { a.gti(c, best, p[1]); a.e(op::MUL, out, out, c); }
        a.f(best); a.f(c);
    }
    // store prev signals AFTER selection
    for k in 0..n { a.e(op::MOV, prev[k], s[k], 0); }
    if p[2] > 0.0 { let c = a.r(); let h = a.r(); a.sig(c, sg::DD); a.gti(c, c, p[2]); a.ldi(h, 0.5); a.e(op::MUL, h, h, c); a.ldi(c, 1.0); a.e(op::SUB, c, c, h); a.e(op::MUL, out, out, c); a.f(c); a.f(h); }
    let _ = extra;
    tail(&mut a, out, p[3]); a
}

// ---------------- pool definition ----------------
fn mk(name: &str, tier: u8, fam: &'static str, tuned: bool, params: Vec<f64>, a: Asm) -> Option<Spec> { let regs = a.peak; if a.finish().is_none() { eprintln!("DOES NOT ASSEMBLE: {} ({} ops emitted, err={:?}, regs peak {})", name, a.ops.len(), a.err, a.peak); } a.finish().map(|code| Spec { name: name.to_string(), tier, fam, tuned, params, code, regs }) }
fn simple(f: impl Fn(&mut Asm)) -> Asm { let mut a = Asm::new(); f(&mut a); a }
pub fn set0() -> Vec<Ex> { vec![Ex::Mom(2, 0.0), Ex::Rev(0.3), Ex::Cross(2, 4)] }
pub fn set_brk() -> Vec<Ex> { vec![Ex::Mom(1, 0.0), Ex::Rev(0.3), Ex::Brk(16, 1.0)] }
pub fn set_two() -> Vec<Ex> { vec![Ex::Mom(2, 0.0), Ex::Rev(0.3)] }
pub fn set_fade() -> Vec<Ex> { vec![Ex::Mom(2, 0.0), Ex::Rev(0.3), Ex::FadeLast] }
pub fn set_four() -> Vec<Ex> { vec![Ex::Mom(2, 0.0), Ex::Rev(0.3), Ex::Cross(2, 4), Ex::Ac(4)] }
pub fn set_mom2() -> Vec<Ex> { vec![Ex::Mom(0, 0.0), Ex::Mom(2, 0.0), Ex::Rev(0.3)] }
pub struct Fam { pub name: &'static str, pub tier: u8, pub space: Vec<Vec<f64>>, pub build: Box<dyn Fn(&[f64]) -> Asm + Sync> }
pub fn tunable() -> Vec<Fam> {
    let th = vec![0.0, 0.3, 0.6, 1.0, 1.5, 2.0]; let stops = vec![0.0, 2.0, 3.0, 5.0, 8.0]; let g = vec![0.2, 0.4, 0.7, 1.0];
    vec![
        Fam { name: "mom", tier: 2, space: vec![vec![0., 1., 2.], th.clone(), vec![0., 1.], g.clone(), stops.clone()], build: Box::new(mom) },
        Fam { name: "rev", tier: 2, space: vec![vec![0., 1., 2., 3.], th.clone(), vec![0., 1.], g.clone(), stops.clone()], build: Box::new(rev) },
        Fam { name: "cross", tier: 2, space: vec![vec![1., 2., 3.], vec![3., 4., 5., 6.], vec![0., 0.1, 0.3, 0.6], stops.clone()], build: Box::new(cross) },
        Fam { name: "brk", tier: 2, space: vec![vec![8., 16., 32.], th.clone(), vec![0., 1.], stops.clone()], build: Box::new(brk) },
        Fam { name: "volf", tier: 2, space: vec![vec![0., 1., 2.], th.clone(), vec![0.8, 1.0, 1.3, 1.6, 2.0], vec![0., 1., 2.]], build: Box::new(volf) },
        Fam { name: "tsw", tier: 3, space: vec![vec![0.8, 1.2, 1.5, 2.0, 2.5], vec![0.0, 0.3, 0.6, 1.0], stops.clone()], build: Box::new(tsw) },
        Fam { name: "acsw", tier: 3, space: vec![vec![2., 3., 4., 5.], vec![0.05, 0.1, 0.2, 0.3], stops.clone()], build: Box::new(acsw) },
        Fam { name: "jump", tier: 3, space: vec![vec![2.5, 3.0, 4.0, 5.0], vec![3., 5., 8., 12.], vec![0., 1., 2.]], build: Box::new(jump) },
        Fam { name: "ens", tier: 3, space: vec![vec![0.0, 0.3, 0.6], vec![0.0, 0.1, 0.3], stops.clone()], build: Box::new(ens) },
        Fam { name: "xsw0", tier: 4, space: vec![vec![3., 4., 5., 6., 7.], vec![0.0, 0.02, 0.05, 0.1], vec![0., 3., 6.], stops.clone(), vec![0., 1.]], build: Box::new(|p| xsw(&set0(), p)) },
        Fam { name: "xswBrk", tier: 4, space: vec![vec![3., 4., 5., 6., 7.], vec![0.0, 0.02, 0.05, 0.1], vec![0., 3., 6.], stops.clone(), vec![0., 1.]], build: Box::new(|p| xsw(&set_brk(), p)) },
        Fam { name: "xswTwo", tier: 4, space: vec![vec![3., 4., 5., 6., 7.], vec![0.0, 0.02, 0.05, 0.1], vec![0., 3., 6.], stops.clone(), vec![0., 1.]], build: Box::new(|p| xsw(&set_two(), p)) },
        Fam { name: "xswFade", tier: 4, space: vec![vec![3., 4., 5., 6., 7.], vec![0.0, 0.02, 0.05, 0.1], vec![0., 3., 6.], stops.clone(), vec![0., 1.]], build: Box::new(|p| xsw(&set_fade(), p)) },
    ]
}
pub fn fixed_pool() -> Vec<Spec> {
    let mut v: Vec<Option<Spec>> = vec![];
    // T0 naive
    v.push(mk("LongOnly", 0, "direction", false, vec![], simple(|a| { let x = a.r(); a.ldi(x, 1.0); a.e(op::POS, 0, x, 0); })));
    v.push(mk("ShortOnly", 0, "direction", false, vec![], simple(|a| { let x = a.r(); a.ldi(x, -1.0); a.e(op::POS, 0, x, 0); })));
    v.push(mk("Flat", 0, "direction", false, vec![], simple(|a| { let x = a.r(); a.ldi(x, 0.0); a.e(op::POS, 0, x, 0); })));
    v.push(mk("TimeSplit", 0, "noise", false, vec![], simple(|a| { let c = a.r(); let o = a.r(); a.sig(c, sg::TLEFT); a.gti(c, c, 16.0 / 32.0); a.ldi(o, 1.0); a.e(op::ADD, c, c, c); a.e(op::SUB, c, c, o); a.e(op::POS, 0, c, 0); })));
    v.push(mk("FadeLast", 0, "reversion", false, vec![], simple(|a| { let x = a.r(); a.sig(x, sg::U1); a.e(op::SIGN, x, x, 0); a.e(op::NEG, x, x, 0); a.e(op::POS, 0, x, 0); })));
    v.push(mk("FollowLast", 0, "momentum", false, vec![], simple(|a| { let x = a.r(); a.sig(x, sg::U1); a.e(op::SIGN, x, x, 0); a.e(op::POS, 0, x, 0); })));
    // T1 single signal, untuned
    for (n, w) in [("Mom5", 0.), ("Mom10", 1.), ("Mom20", 2.)] { v.push(mk(n, 1, "momentum", false, vec![w], mom(&[w, 0., 0., 1., 0.]))); }
    v.push(mk("RevT5", 1, "reversion", false, vec![], simple(|a| { let x = a.r(); a.sig(x, sg::T5); a.e(op::SIGN, x, x, 0); a.e(op::NEG, x, x, 0); a.e(op::POS, 0, x, 0); })));
    v.push(mk("RevZ", 1, "reversion", false, vec![], rev(&[0., 0., 0., 1., 0.])));
    v.push(mk("RevCum", 1, "reversion", false, vec![], simple(|a| { let x = a.r(); a.sig(x, sg::CUM); a.e(op::SIGN, x, x, 0); a.e(op::NEG, x, x, 0); a.e(op::POS, 0, x, 0); })));
    // T2 hand-tuned singles
    v.push(mk("Mom20th", 2, "momentum", false, vec![], mom(&[2., 1.0, 0., 1., 0.])));
    v.push(mk("Mom10th", 2, "momentum", false, vec![], mom(&[1., 0.8, 0., 1., 0.])));
    v.push(mk("Mom20conf", 2, "momentum", false, vec![], mom(&[2., 0.5, 1., 0.4, 0.])));
    v.push(mk("Mom20stop", 2, "momentum", false, vec![], mom(&[2., 0.5, 0., 1., 3.])));
    v.push(mk("RevZth", 2, "reversion", false, vec![], rev(&[0., 0.3, 0., 1., 0.])));
    v.push(mk("RevZW16", 2, "reversion", false, vec![], rev(&[2., 0.5, 0., 1., 0.])));
    v.push(mk("EMAcross", 2, "momentum", false, vec![], cross(&[2., 4., 0.3, 0.])));
    v.push(mk("EMAcrossFast", 2, "momentum", false, vec![], cross(&[1., 3., 0.2, 0.])));
    v.push(mk("Breakout16", 2, "momentum", false, vec![], brk(&[16., 1.0, 0., 0.])));
    v.push(mk("FadeBreak16", 2, "reversion", false, vec![], brk(&[16., 1.5, 1., 0.])));
    v.push(mk("VolQuietMom", 2, "momentum", false, vec![], volf(&[2., 1.0, 1.5, 0.])));
    v.push(mk("VolHotMom", 2, "momentum", false, vec![], volf(&[1., 0.8, 1.4, 1.])));
    v.push(mk("VolFlip", 2, "switch", false, vec![], volf(&[1., 0.5, 1.4, 2.])));
    // T3 composites
    v.push(mk("TrendSwitch", 3, "switch", false, vec![], tsw(&[1.5, 0.3, 0.])));
    v.push(mk("TrendSwitch2", 3, "switch", false, vec![], tsw(&[1.0, 0.5, 5.])));
    v.push(mk("AutoCorrSw", 3, "switch", false, vec![], acsw(&[3., 0.1, 0.])));
    v.push(mk("AutoCorrSw2", 3, "switch", false, vec![], acsw(&[4., 0.15, 5.])));
    v.push(mk("JumpAware", 3, "switch", false, vec![], jump(&[3., 5., 1.])));
    v.push(mk("Ensemble3", 3, "switch", false, vec![], ens(&[0.3, 0.1, 0.])));
    v.push(mk("Ensemble3stop", 3, "switch", false, vec![], ens(&[0.3, 0.1, 5.])));
    // T4 regime-switching composite family (hand params) + adversarial variants
    let sw = |n: &str, set: Vec<Ex>, p: [f64; 5]| mk(n, 4, "xswitch", false, p.to_vec(), xsw(&set, &p));
    v.push(sw("ExpertSwitch", set0(), [5., 0.02, 0., 0., 0.]));
    v.push(sw("FastSwitch", set0(), [3., 0.05, 0., 0., 0.]));
    v.push(sw("SlowSwitch", set0(), [7., 0.02, 0., 0., 0.]));
    v.push(sw("ExpertBlend", set0(), [5., 0., 0., 0., 1.]));
    v.push(sw("RiskAwareSwitch", set0(), [5., 0.02, 4., 0., 0.]));
    v.push(sw("SwitchStop", set0(), [5., 0.02, 0., 3., 0.]));
    v.push(sw("SwitchRiskStop", set0(), [5., 0.02, 4., 5., 0.]));
    v.push(sw("SwitchBrk", set_brk(), [5., 0.02, 0., 0., 0.]));
    v.push(sw("SwitchTwo", set_two(), [5., 0.02, 0., 0., 0.]));
    v.push(sw("SwitchFade", set_fade(), [5., 0.02, 0., 0., 0.]));
    v.push(sw("SwitchMom2", set_mom2(), [5., 0.02, 0., 0., 0.]));
    v.push(sw("AntiSwitch", set0(), [5., 0., 0., 0., 2.]));
    v.push(sw("Switch4Ac", set_four(), [5., 0.02, 0., 0., 0.]));
    v.into_iter().flatten().collect()
}
