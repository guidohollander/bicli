import fs from "node:fs";
import path from "node:path";

export const loadDotEnv = (): void => {
  const candidates = [path.resolve(process.cwd(), ".env")];
  const seen = new Set<string>();

  for (const envPath of candidates) {
    if (seen.has(envPath) || !fs.existsSync(envPath)) {
      continue;
    }
    seen.add(envPath);

    const content = fs.readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
};

export const resolveBeInformedHome = (value?: string): string => {
  const resolved = value || process.env.BE_INFORMED_HOME || process.env.BI_HOME;
  if (!resolved) {
    throw new Error(
      "Be Informed installation path is required. Pass --be-informed-home/--bi-home or set BE_INFORMED_HOME in .env."
    );
  }
  return resolved;
};
