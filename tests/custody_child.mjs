// A child process for tests/custody.test.mjs. "register": the client's real register() against whatever CONCLAVE_BASE_URL points at. "add": one real writer of the key file.
import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const client = process.env.CONCLAVE_CLIENT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client"); const load = f => import(pathToFileURL(path.join(client, f)));
const L = await load("lib.mjs"); const mode = process.argv[2];
if (mode === "register") { const F = await load("flows.mjs"); const kp = L.Keypair.generate(); const code = Buffer.from(process.argv[3], "hex"); try { await F.register({ players: [kp], validator: kp.publicKey }, 0, "crash-test", code); console.log("registered"); } catch (e) { console.log("register failed: " + String(e.message || e).slice(0, 80)); process.exit(3); } }
if (mode === "add") { const k = process.argv[3]; for (let i = 0; i < 5; i++) L.addStrat({ id: `${k}${i}`, owner: 0, name: "w", salt: "ab".repeat(32), code: "0200000000" }); }
