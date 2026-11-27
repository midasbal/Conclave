# The Railway image: the capture daemon (verifier/) and the record API (server/) in one container, started by deploy/supervisor.mjs.
# Only what they import is copied: verifier/, server/, and the one pure layout module of client/ that the verifier reads. No program source, no keys, no test data.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY verifier/package.json verifier/package-lock.json verifier/
COPY server/package.json server/package-lock.json server/
RUN (cd verifier && npm ci --omit=dev --no-audit --no-fund) && (cd server && npm ci --omit=dev --no-audit --no-fund)
COPY verifier verifier
COPY server server
COPY client/layouts.mjs client/layouts.mjs
COPY deploy deploy
# Runs as root on purpose: a Railway volume is mounted as root, and the daemon must write to it (docs/DEPLOY_RAILWAY.md). Exec form, so the supervisor is PID 1 and receives the platform's SIGTERM itself.
CMD ["node", "deploy/supervisor.mjs"]
