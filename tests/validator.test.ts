import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { loadInstallationMetadata } from "../src/beInformedInstallation.js";
import { validateBixmlFile } from "../src/validator.js";
import type { InstallationMetadata } from "../src/types.js";

const biHome = "C:\\bi\\Be Informed AMS 23.2.9";
const fixture = (name: string): string => path.join(process.cwd(), "tests", "fixtures", name);

describe("TEST-0001 BIXML validator", () => {
  let metadata: InstallationMetadata;

  beforeAll(async () => {
    metadata = await loadInstallationMetadata(biHome);
  }, 30000);

  it("accepts a known mapping-driven document", async () => {
    const result = await validateBixmlFile(fixture("valid-knowledge-model.bixml"), metadata);

    expect(result.ok).toBe(true);
  });

  it("rejects malformed XML", async () => {
    const result = await validateBixmlFile(fixture("malformed.bixml"), metadata);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("Malformed XML");
  });

  it("rejects an unknown element name", async () => {
    const result = await validateBixmlFile(fixture("invalid-tag.bixml"), metadata);

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Unknown element "totally-unknown-node"'))).toBe(true);
  });

  it("rejects an unknown namespace URI", async () => {
    const result = await validateBixmlFile(fixture("invalid-namespace.bixml"), metadata);

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("Unknown Be Informed namespace URI"))).toBe(true);
  });
});
