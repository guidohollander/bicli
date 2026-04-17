#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const compiledEntry = path.join(projectRoot, "dist", "src", "index.js");

if (!existsSync(compiledEntry)) {
  console.error('Compiled entrypoint not found. Run "npm run build" first, or use "bicli-dev".');
  process.exit(1);
}

const result = spawnSync(process.execPath, [compiledEntry, ...process.argv.slice(2)], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
