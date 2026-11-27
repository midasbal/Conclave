#!/usr/bin/env node
// Writes the contract as OpenAPI 3.1 to server/openapi.v1.json. The file is committed, and a test fails if it differs from what schema.mjs generates, so a change to the API cannot be made without changing this file in the same commit.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { openapi } from "../src/api/schema.mjs";
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "openapi.v1.json"); fs.writeFileSync(file, JSON.stringify(openapi(), null, 2) + "\n"); console.log("wrote " + file);
