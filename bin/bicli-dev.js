#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const sourceEntry = path.join(projectRoot, "src", "index.ts");

const result = spawnSync(process.execPath, ["--import", "tsx", sourceEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: projectRoot
});

process.exit(result.status ?? 1);
