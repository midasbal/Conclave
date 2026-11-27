#!/usr/bin/env node
import { loadConfig, startupLine } from "../src/config.mjs"; import { createAuth } from "../src/auth.mjs"; import { createApp } from "../src/server.mjs"; import { createHealth } from "../src/health.mjs";
import { createApi } from "../src/api/index.mjs"; import { RecordStore, RulesSource } from "../src/api/store.mjs";
const c = loadConfig(); const auth = c.recordOnly ? null : createAuth({ audience: c.audience, secret: c.secret });
// the record API reads the store the capture loop writes. Without CONCLAVE_STORE_DIR it answers 404 store_not_configured
const api = createApi({ store: new RecordStore({ dir: c.storeDir, genesis: c.genesis, program: c.programId, staleAfterSeconds: c.staleAfterSeconds }), rules: new RulesSource(c.rulesFile), genesis: c.genesis, program: c.programId, staleAfterSeconds: c.staleAfterSeconds });
const health = createHealth({ dir: c.storeDir, genesis: c.genesis, program: c.programId, staleAfterSeconds: c.staleAfterSeconds, pollSecondsDefault: c.pollSecondsDefault, minFreeBytes: c.minFreeMb * 1048576, log: l => console.log(l) });
const app = createApp({ auth, upstream: c.upstream, rollupUpstream: c.rollupUpstream, api, programId: c.programId, origins: c.origins, limits: c.limits, clientIp: c.clientIp, recordOnly: c.recordOnly, health, gpaCacheSeconds: c.gpaCacheSeconds, log: l => console.log(l) });
app.listen(c.port, c.host, () => console.log(startupLine(c)));
