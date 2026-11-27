// Files that hold a reveal (a score salt, or a sealed salt and bytecode) are secrets: mode 0600, never overwritten, never inside this repository.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
export function assertOutsideRepo(file) {
  let d = path.dirname(path.resolve(file)); const tail = [path.basename(file)]; while (!fs.existsSync(d)) { tail.unshift(path.basename(d)); d = path.dirname(d); }
  const real = path.join(fs.realpathSync(d), ...tail); if (real === REPO || real.startsWith(REPO + path.sep)) throw new Error("a file that reveals a secret may not be written inside the repository");
  return real;
}
export function writeSecret(file, value) { const to = assertOutsideRepo(file); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.writeFileSync(to, JSON.stringify(value, null, 1) + "\n", { flag: "wx", mode: 0o600 }); return to; }
export const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
export const writeJson = (f, v, opts = {}) => { fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n", opts); };
