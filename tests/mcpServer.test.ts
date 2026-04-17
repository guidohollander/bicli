import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const tempDirs: string[] = [];

const createSampleRepository = async (): Promise<{ root: string; repoPath: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bicli-mcp-"));
  tempDirs.push(root);
  const repoPath = path.join(root, "gd_sample");
  await mkdir(repoPath, { recursive: true });
  await mkdir(path.join(repoPath, "SC Foo"), { recursive: true });
  await mkdir(path.join(repoPath, "_CONTINUOUS_DELIVERY", "_STUDIO"), { recursive: true });
  await writeFile(
    path.join(repoPath, "SC Foo", ".project"),
    `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>SC Foo</name>
  <projects>
    <project>SC Library</project>
  </projects>
  <buildSpec>
    <buildCommand>
      <name>nl.beinformed.builder</name>
    </buildCommand>
  </buildSpec>
  <natures>
    <nature>nl.beinformed.nature</nature>
  </natures>
</projectDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(repoPath, "SC Foo", "work-items.bixml"),
    `<?plugin nl.beinformed.bi.knowledge_23.2.9?>
<knowledge-model-type>
  <label>Work items</label>
  <identifier>workItems</identifier>
  <referenced-concept>SC Library</referenced-concept>
</knowledge-model-type>`,
    "utf8"
  );
  await writeFile(
    path.join(repoPath, "_CONTINUOUS_DELIVERY", "_STUDIO", "studio.json"),
    JSON.stringify({ version: "23.2.9", type: "local" }, null, 2),
    "utf8"
  );
  return { root, repoPath };
};

afterEach(async () => {
  vi.resetModules();
});

describe("mcpInternals", () => {
  test("indexes, warms, and answers repository questions from bicli", async () => {
    const { root, repoPath } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { mcpInternals } = await import("../src/mcpServer.js");

    const repositories = mcpInternals.discoverRepositories() as unknown as Array<{ path: string; name: string }>;
    expect(repositories).toHaveLength(1);
    expect(repositories[0].path).toBe(repoPath);

    const index = mcpInternals.buildRepositoryIndex(repoPath, { force: true });
    expect(index.files.some((file: { relativePath: string }) => file.relativePath.endsWith("work-items.bixml"))).toBe(true);

    const warm = mcpInternals.prepareRepository(repositories[0], { force: true });
    expect(warm.prepared).toBe(true);
    expect(warm.fileCount).toBeGreaterThan(0);

    const answer = await mcpInternals.answerRepositoryQuestion(
      repositories[0],
      "Where is the work items model defined?",
      5
    );
    expect(answer.enrichedMatches[0].relativePath).toContain("work-items.bixml");
    expect(answer.synthesis).toContain("work-items.bixml");
  });

  test("reuses warm repository model cache for repeated model calls", async () => {
    const { root, repoPath } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { mcpInternals } = await import("../src/mcpServer.js");

    const first = await mcpInternals.getCachedRepositoryModel(repoPath, {
      includeArtifacts: true,
      maxArtifacts: 50,
      force: true
    });
    const second = await mcpInternals.getCachedRepositoryModel(repoPath, {
      includeArtifacts: true,
      maxArtifacts: 50
    });

    expect(second).toBe(first);
  });

  test("invalidates cached repository model when repository files change", async () => {
    const { root, repoPath } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { mcpInternals } = await import("../src/mcpServer.js");

    const first = await mcpInternals.getCachedRepositoryModel(repoPath, {
      includeArtifacts: true,
      maxArtifacts: 50,
      force: true
    });

    await writeFile(
      path.join(repoPath, "SC Foo", "second-model.bixml"),
      `<?plugin nl.beinformed.bi.knowledge_23.2.9?>
<knowledge-model-type>
  <label>Second model</label>
  <identifier>secondModel</identifier>
</knowledge-model-type>`,
      "utf8"
    );

    const second = await mcpInternals.getCachedRepositoryModel(repoPath, {
      includeArtifacts: true,
      maxArtifacts: 50
    });

    expect(second).not.toBe(first);
    expect(second.artifactIndex.length).toBeGreaterThan(first.artifactIndex.length);
  });
});

describe("MCP protocol", () => {
  test("handles initialize, tools/list, and tool calls through the protocol surface", async () => {
    const { root } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { processMcpMessage } = await import("../src/mcpServer.js");

    const init = await processMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });
    expect(init[0].result.serverInfo.name).toBe("beinformed-repository-mcp");

    const list = await processMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "prepare_repository")).toBe(true);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "describe_case_model_patterns")).toBe(true);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "create_web_application")).toBe(true);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "create_interface_operation")).toBe(true);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "plan_change_intent")).toBe(false);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "apply_change_intent")).toBe(false);
    expect(list[0].result.tools.some((tool: { name: string }) => tool.name === "index_repository")).toBe(false);

    const prepare = await processMcpMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "prepare_repository",
        arguments: { repository: "gd_sample", force: true }
      }
    });
    const prepared = JSON.parse(prepare[0].result.content[0].text);
    expect(prepared.prepared).toBe(true);

    const answer = await processMcpMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "answer_repository_question",
        arguments: {
          repository: "gd_sample",
          question: "Explain the repository architecture and work items model"
        }
      }
    });
    const payload = JSON.parse(answer[0].result.content[0].text);
    expect(payload.synthesis).toContain("work-items.bixml");
    expect(payload.matches.length).toBeGreaterThan(0);
  });

  test("returns repository-grounded pattern summaries through MCP tools", async () => {
    const { root } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { processMcpMessage } = await import("../src/mcpServer.js");

    const casePatterns = await processMcpMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "describe_case_model_patterns",
        arguments: { repository: "gd_sample", force: true, maxArtifacts: 100 }
      }
    });
    const casePayload = JSON.parse(casePatterns[0].result.content[0].text);
    expect(casePayload.repositoryName).toBe("gd_sample");
    expect(typeof casePayload.caseTypeCount).toBe("number");

    const workflowPatterns = await processMcpMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "describe_case_workflow_pattern",
        arguments: { repository: "gd_sample", project: "SC Foo", force: true, maxArtifacts: 100 }
      }
    });
    const workflowPayload = JSON.parse(workflowPatterns[0].result.content[0].text);
    expect(workflowPayload.project).toBe("SC Foo");
    expect(typeof workflowPayload.formCount).toBe("number");
  });

  test("returns normalized bounded-write results for direct creation tools", async () => {
    const { root } = await createSampleRepository();
    process.env.BI_REPO_ROOT = root;

    const { processMcpMessage } = await import("../src/mcpServer.js");

    const created = await processMcpMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "create_test_bixml",
        arguments: {
          repository: "gd_sample",
          project: "SC Foo",
          fileRelativePath: "Tests\\Example test artifact.bixml",
          rootElement: "knowledge-model-type",
          label: "Example test artifact"
        }
      }
    });
    const payload = JSON.parse(created[0].result.content[0].text);
    expect(payload.mode).toBe("bounded-write");
    expect(payload.tool).toBe("create_test_bixml");
    expect(payload.summary.repositoryValidationOk).toBeDefined();
    expect(Array.isArray(payload.mutatedPaths)).toBe(true);
  });
});
