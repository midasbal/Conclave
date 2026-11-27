# The operator: the only service that holds a spendable key. Its own image, from this folder only, so that nothing of the record service (or the other
# way round) is ever in it. The key arrives as a runtime variable (OPERATOR_SECRET_KEY); it is never part of the image or a build argument.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src src
COPY bin bin
# Runs as root on purpose: a Railway volume is mounted as root, and the state file must be written to it. Exec form, so SIGTERM reaches the process.
CMD ["node", "bin/operator.mjs"]
