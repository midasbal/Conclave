// Starts the operator. A bad setting does not stop it: /health answers so that a deploy can come up, /healthz and /drip say 503 until all is well.
import { loadConfig } from "../src/config.mjs";
import { createOperator } from "../src/server.mjs";

const config = loadConfig(process.env);
const secretKey = process.env.OPERATOR_SECRET_KEY;
delete process.env.OPERATOR_SECRET_KEY; // read once; nothing later, and no child process, finds it in the environment

const { server, startupLines } = createOperator({ config, secretKey });
for (const line of startupLines) console.log(line);
server.listen(config.port, config.host, () => console.log(`listening on ${config.host}:${config.port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
