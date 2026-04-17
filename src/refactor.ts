import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildRepositoryModel } from "./repositoryModel.js";
import type { LintFinding, LintResult, ProjectNode } from "./types.js";

const INLINE_ATTRIBUTE_TAGS = [
  "stringattribute",
  "dateattribute",
  "datetimeattribute",
  "booleanattribute",
  "choiceattribute",
  "memoattribute",
  "integerattribute",
  "currencyattribute",
  "uploadattribute",
  "decimalattribute",
  "labelattribute",
] as const;

type RefactorOptions = {
  lintJson?: string;
  lintResult?: LintResult;
};

type RefactorChange = {
  action: string;
  artifactPath: string;
  status: "created" | "updated" | "skipped";
  message: string;
};

type RefactorResult = {
  repositoryName: string;
  repositoryPath: string;
  ok: boolean;
  appliedFindingCount: number;
  changes: RefactorChange[];
};

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const createStableId = (seed: string): string => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
};

const extractVersions = (xmlText: string): string[] =>
  [...xmlText.matchAll(/<\?plugin [^?]*?_(\d+\.\d+\.\d+(?:\.\d+)?)\?>/g)].map((match) => match[1]);

const findInlineAttributeBlock = (
  xmlText: string,
  functionalId: string
): { tagName: string; block: string } | null => {
  for (const tagName of INLINE_ATTRIBUTE_TAGS) {
    const pattern = new RegExp(
      `<(${tagName})\\b[\\s\\S]*?<functional-id>${functionalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/functional-id>[\\s\\S]*?<\\/\\1>`,
      "i"
    );
    const match = pattern.exec(xmlText);
    if (match) {
      return { tagName, block: match[0] };
    }
  }
  return null;
};

const buildAttributeGroupRefBlock = (artifactLink: string, seed: string): string => `    <attributegroup-ref>
        <id>${createStableId(`ref:${seed}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(artifactLink)}</link>
        <readonly>false</readonly>
        <attribute-mapping>
            <freeze-contents>false</freeze-contents>
            <rows/>
            <order/>
            <deleted-rows/>
        </attribute-mapping>
    </attributegroup-ref>`;

const buildAttributeGroupContent = (label: string, attributeBlock: string, version: string | null): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.common.attributes_${version}?>`].join("")
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<attributegroup>
    <label>${xmlEscape(label)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
${attributeBlock
  .split(/\r?\n/)
  .map((line) => `    ${line}`)
  .join("\n")}
</attributegroup>
`;
};

const parseLintInput = (raw: string): LintResult => JSON.parse(raw) as LintResult;

const selectFindings = (lintResult: LintResult): LintFinding[] => {
  const seen = new Set<string>();
  const selected: LintFinding[] = [];
  for (const finding of lintResult.findings) {
    if (!finding.remediation) {
      continue;
    }
    const key = `${finding.project || ""}::${finding.functionalId || ""}::${finding.remediation.targetFolder}::${finding.remediation.action}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(finding);
  }
  return selected;
};

const loadLintResult = async (options: RefactorOptions): Promise<LintResult> => {
  if (options.lintResult) {
    return options.lintResult;
  }
  if (options.lintJson) {
    return parseLintInput(await readFile(path.resolve(options.lintJson), "utf8"));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("No lint JSON provided. Use --input <path> or pipe `bicli lint` output to stdin.");
  }
  return parseLintInput(raw);
};

const findProject = (projects: ProjectNode[], name: string | undefined): ProjectNode => {
  if (!name) {
    throw new Error("Lint finding is missing a project name.");
  }
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) {
    throw new Error(`Project not found in repository model: ${name}`);
  }
  return project;
};

export const applyLintRefactor = async (repoPath: string, options: RefactorOptions = {}): Promise<RefactorResult> => {
  const lintResult = await loadLintResult(options);
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 4000 });
  const findings = selectFindings(lintResult);
  const changes: RefactorChange[] = [];
  const sourcePathSet = new Set<string>();

  for (const finding of findings) {
    for (const sourcePath of finding.remediation?.sourcePaths || []) {
      sourcePathSet.add(path.resolve(model.repositoryPath, sourcePath));
    }
  }

  const originalSourceXmlByPath = new Map<string, string>();
  for (const sourcePath of sourcePathSet) {
    originalSourceXmlByPath.set(sourcePath, await readFile(sourcePath, "utf8"));
  }
  const workingSourceXmlByPath = new Map(originalSourceXmlByPath);

  for (const finding of findings) {
    const remediation = finding.remediation;
    if (!remediation) {
      continue;
    }

    const project = findProject(model.projects, finding.project);
    const projectRoot = path.resolve(project.path);
    const targetAbsolutePath = path.join(projectRoot, ...remediation.targetFolder.split("/"), remediation.suggestedArtifactFileName);
    const targetLink = `/${path.relative(model.repositoryPath, targetAbsolutePath).replace(/\\/g, "/")}`;

    let exemplarBlock: string | null = null;
    let version: string | null = null;
    for (const sourcePath of remediation.sourcePaths) {
      const absoluteSourcePath = path.resolve(model.repositoryPath, sourcePath);
      const sourceXml = originalSourceXmlByPath.get(absoluteSourcePath);
      if (!sourceXml) {
        continue;
      }
      const match = findInlineAttributeBlock(sourceXml, finding.functionalId || "");
      if (match) {
        exemplarBlock = match.block;
        version = extractVersions(sourceXml)[0] || project.versionHints[0] || model.dominantVersionProfile?.version || null;
        break;
      }
    }

    if (!exemplarBlock) {
      changes.push({
        action: remediation.action,
        artifactPath: targetAbsolutePath,
        status: "skipped",
        message: `No inline attribute block could be found for ${finding.functionalId || remediation.suggestedArtifactLabel}.`,
      });
      continue;
    }

    try {
      await readFile(targetAbsolutePath, "utf8");
      changes.push({
        action: remediation.action,
        artifactPath: targetAbsolutePath,
        status: "skipped",
        message: "Target attribute-group artifact already exists.",
      });
    } catch {
      await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
      await writeFile(
        targetAbsolutePath,
        buildAttributeGroupContent(remediation.suggestedArtifactLabel, exemplarBlock, version),
        "utf8"
      );
      changes.push({
        action: remediation.action,
        artifactPath: targetAbsolutePath,
        status: "created",
        message: "Created shared attribute-group artifact.",
      });
    }

    for (const sourcePath of remediation.sourcePaths) {
      const absoluteSourcePath = path.resolve(model.repositoryPath, sourcePath);
      const sourceXml = workingSourceXmlByPath.get(absoluteSourcePath);
      if (!sourceXml) {
        continue;
      }
      const match = findInlineAttributeBlock(sourceXml, finding.functionalId || "");
      if (!match) {
        continue;
      }
      const replacement = buildAttributeGroupRefBlock(targetLink, `${sourcePath}:${finding.functionalId || remediation.suggestedArtifactLabel}`);
      const updated = sourceXml.replace(match.block, replacement);
      if (updated !== sourceXml) {
        await writeFile(absoluteSourcePath, updated, "utf8");
        workingSourceXmlByPath.set(absoluteSourcePath, updated);
        changes.push({
          action: remediation.action,
          artifactPath: absoluteSourcePath,
          status: "updated",
          message: `Replaced inline attribute ${finding.functionalId || remediation.suggestedArtifactLabel} with attributegroup-ref.`,
        });
      }
    }
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    ok: true,
    appliedFindingCount: findings.length,
    changes,
  };
};
