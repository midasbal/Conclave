//! Minimal JSON value and writer (no dependencies). Numbers use Rust's shortest round-trip formatting, identical on every target.
pub enum J { Null, Bool(bool), Num(f64), Str(String), Arr(Vec<J>), Obj(Vec<(String, J)>) }
impl J {
    pub fn n(x: f64) -> J { J::Num(x) } pub fn s(x: &str) -> J { J::Str(x.to_string()) } pub fn arr(v: Vec<J>) -> J { J::Arr(v) } pub fn obj(v: Vec<(&str, J)>) -> J { J::Obj(v.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) }
    pub fn to_string(&self) -> String { let mut o = String::new(); self.w(&mut o); o }
    fn w(&self, o: &mut String) { match self { J::Null => o.push_str("null"), J::Bool(b) => o.push_str(if *b { "true" } else { "false" }), J::Num(x) => { if x.is_finite() { if *x == 0.0 { o.push('0'); } else { o.push_str(&format!("{}", x)); } } else { o.push_str("null"); } }
        J::Str(s) => esc(s, o), J::Arr(v) => { o.push('['); for (i, x) in v.iter().enumerate() { if i > 0 { o.push(','); } x.w(o); } o.push(']'); }
        J::Obj(v) => { o.push('{'); for (i, (k, x)) in v.iter().enumerate() { if i > 0 { o.push(','); } esc(k, o); o.push(':'); x.w(o); } o.push('}'); } } }
}
pub fn esc(s: &str, o: &mut String) { o.push('"'); for c in s.chars() { match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), '\r' => o.push_str("\\r"), '\t' => o.push_str("\\t"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) } } o.push('"'); }
