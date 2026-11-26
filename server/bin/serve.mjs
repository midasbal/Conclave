#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs"; import { createAuth } from "../src/auth.mjs"; import { createApp } from "../src/server.mjs";
const c = loadConfig(); const auth = createAuth({ audience: c.audience, secret: c.secret });
const app = createApp({ auth, upstream: c.upstream, rollupUpstream: c.rollupUpstream, programId: c.programId, origins: c.origins, limits: c.limits, trustProxy: c.trustProxy, log: l => console.log(l) });
app.listen(c.port, c.host, () => console.log(`conclave-server listening on ${c.host}:${c.port} audience=${c.audience} origins=${c.origins.length} (upstream and secret loaded, not printed)`));
