import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildRepositoryModel } from "./repositoryModel.js";
import type { ArtifactNode, LintFinding, LintResult, LintRule, LintSeverity, ProjectRole } from "./types.js";

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

type InlineAttributeOccurrence = {
  project: string;
  artifactPath: string;
  rootElement: string | null;
  tagName: string;
  functionalId: string | null;
  label: string | null;
  signature: string;
};

type LintOptions = {
  project?: string;
  rulesPath?: string;
  maxArtifacts?: number;
};

const DEFAULT_LINT_RULES: LintRule[] = [
  {
    id: "duplicate-inline-attribute",
    kind: "duplicate_inline_attribute",
    severity: "warning",
    minOccurrences: 2,
    message:
      "Inline attribute '{functionalId}' appears {count} times in project '{project}'. Consider extracting it into a shared attribute-group artifact.",
  },
  {
    id: "no-inline-interface-attributes",
    kind: "inline_attribute_presence",
    severity: "error",
    projectRoles: ["interface"],
    message:
      "Inline attribute '{functionalId}' appears in interface project '{project}'. Use a shared attribute-group artifact instead.",
  },
];

const mergeRulesById = (rules: LintRule[]): LintRule[] => {
  const merged = new Map<string, LintRule>();
  for (const rule of rules) {
    merged.set(rule.id, rule);
  }
  return [...merged.values()];
};

const parseScalarValue = (raw: string): string | number | boolean | string[] => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) =>
        (item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))
          ? item.slice(1, -1)
          : item
      );
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
};

const parseYamlLikeRuleBlock = (block: string): Partial<LintRule> => {
  const result: Record<string, unknown> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    result[key] = parseScalarValue(value);
  }
  return result as Partial<LintRule>;
};

const parseRulesMarkdown = (markdown: string): LintRule[] => {
  const rules: LintRule[] = [];
  const fencePattern = /```(?:yaml|yml)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = fencePattern.exec(markdown);
  while (match) {
    const parsed = parseYamlLikeRuleBlock(match[1] || "");
    if (typeof parsed.id === "string" && typeof parsed.kind === "string" && typeof parsed.severity === "string") {
      rules.push({
        id: parsed.id,
        kind: parsed.kind as LintRule["kind"],
        severity: parsed.severity as LintSeverity,
        minOccurrences: typeof parsed.minOccurrences === "number" ? parsed.minOccurrences : undefined,
        projectRoles: Array.isArray(parsed.projectRoles) ? (parsed.projectRoles as ProjectRole[]) : undefined,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        targetFolder: typeof parsed.targetFolder === "string" ? parsed.targetFolder : undefined,
      });
    }
    match = fencePattern.exec(markdown);
  }
  return rules;
};

const loadLintRules = async (rulesPath?: string): Promise<LintRule[]> => {
  const rules = [...DEFAULT_LINT_RULES];
  if (!rulesPath) {
    return mergeRulesById(rules);
  }

  const markdown = await readFile(path.resolve(rulesPath), "utf8");
  const customRules = parseRulesMarkdown(markdown);
  return mergeRulesById([...rules, ...customRules]);
};

const extractTopLevelValue = (xmlText: string, tagName: string): string | null => {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(xmlText);
  return match ? match[1].trim() : null;
};

const isDedicatedAttributeArtifact = (artifact: ArtifactNode): boolean => {
  const normalized = artifact.path.replace(/\\/g, "/");
  return (
    artifact.rootElement === "attributegroup" &&
    (normalized.includes("/Data/Attribute groups/Attributes/") ||
      normalized.includes("/Behavior/_Case/Data/Attribute groups/Attributes/"))
  );
};

const collectInlineAttributes = async (
  repoPath: string,
  artifacts: ArtifactNode[]
): Promise<InlineAttributeOccurrence[]> => {
  const occurrences: InlineAttributeOccurrence[] = [];

  for (const artifact of artifacts) {
    if (!artifact.project || isDedicatedAttributeArtifact(artifact)) {
      continue;
    }

    const xmlText = await readFile(path.resolve(repoPath, artifact.path), "utf8");
    for (const tagName of INLINE_ATTRIBUTE_TAGS) {
      const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi");
      const blocks = xmlText.match(pattern) || [];
      for (const block of blocks) {
        const functionalId = extractTopLevelValue(block, "functional-id");
        const label = extractTopLevelValue(block, "label");
        const signature = JSON.stringify({
          tagName,
          functionalId,
          label,
          mandatory: extractTopLevelValue(block, "mandatory"),
          readonly: extractTopLevelValue(block, "readonly"),
          maxlength: extractTopLevelValue(block, "maxlength"),
        });
        occurrences.push({
          project: artifact.project,
          artifactPath: artifact.path,
          rootElement: artifact.rootElement,
          tagName,
          functionalId,
          label,
          signature,
        });
      }
    }
  }

  return occurrences;
};

const fillTemplate = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{([A-Za-z0-9_]+)\}/g, (_full, key) => String(values[key] ?? ""));

const inferSuggestedFolder = (paths: string[], configuredTargetFolder?: string): string => {
  if (configuredTargetFolder) {
    return configuredTargetFolder;
  }
  const normalized = paths.map((item) => item.replace(/\\/g, "/"));
  if (normalized.every((item) => item.includes("/Behavior/_Case/"))) {
    return "Behavior/_Case/Data/Attribute groups/Attributes";
  }
  return "Data/Attribute groups/Attributes";
};

const humanizeIdentifier = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const toSuggestedAttributeArtifactFileName = (labelOrId: string): string =>
  `${labelOrId.replace(/[\\/:*?"<>|]+/g, " ").trim()}.bixml`;

export const lintRepository = async (repoPath: string, options: LintOptions = {}): Promise<LintResult> => {
  const model = await buildRepositoryModel(repoPath, {
    includeArtifacts: true,
    maxArtifacts: Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : 3000,
  });
  const rules = await loadLintRules(options.rulesPath);
  const projectByName = new Map(model.projects.map((project) => [project.name, project]));
  const artifacts = model.artifactIndex.filter(
    (artifact) => artifact.project && (!options.project || artifact.project === options.project)
  );
  const occurrences = await collectInlineAttributes(model.repositoryPath, artifacts);
  const findings: LintFinding[] = [];

  for (const rule of rules) {
    if (rule.kind === "duplicate_inline_attribute") {
      const grouped = new Map<string, InlineAttributeOccurrence[]>();
      for (const occurrence of occurrences) {
        const project = projectByName.get(occurrence.project);
        if (rule.projectRoles && (!project || !rule.projectRoles.includes(project.role))) {
          continue;
        }
        const key = `${occurrence.project}::${occurrence.signature}`;
        const bucket = grouped.get(key) || [];
        bucket.push(occurrence);
        grouped.set(key, bucket);
      }

      for (const bucket of grouped.values()) {
        const uniquePaths = [...new Set(bucket.map((item) => item.artifactPath))];
        const minOccurrences = rule.minOccurrences ?? 2;
        if (uniquePaths.length < minOccurrences) {
          continue;
        }
        const exemplar = bucket[0];
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          project: exemplar.project,
          artifactPath: exemplar.artifactPath,
          functionalId: exemplar.functionalId || exemplar.label || exemplar.tagName,
          occurrences: uniquePaths.length,
          paths: uniquePaths,
          message: fillTemplate(
            rule.message ||
              "Inline attribute '{functionalId}' appears {count} times in project '{project}'. Consider extracting it to {targetFolder}.",
            {
              functionalId: exemplar.functionalId || exemplar.label || exemplar.tagName,
              count: uniquePaths.length,
              project: exemplar.project,
              targetFolder: inferSuggestedFolder(uniquePaths, rule.targetFolder),
            }
          ),
          remediation: {
            action: "extract_attribute_group",
            targetFolder: inferSuggestedFolder(uniquePaths, rule.targetFolder),
            suggestedArtifactLabel: humanizeIdentifier(exemplar.label || exemplar.functionalId || exemplar.tagName),
            suggestedArtifactFileName: toSuggestedAttributeArtifactFileName(
              humanizeIdentifier(exemplar.label || exemplar.functionalId || exemplar.tagName)
            ),
            sourcePaths: uniquePaths,
          },
        });
      }
    }

    if (rule.kind === "inline_attribute_presence") {
      for (const occurrence of occurrences) {
        const project = projectByName.get(occurrence.project);
        if (rule.projectRoles && (!project || !rule.projectRoles.includes(project.role))) {
          continue;
        }
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          project: occurrence.project,
          artifactPath: occurrence.artifactPath,
          functionalId: occurrence.functionalId || occurrence.label || occurrence.tagName,
          paths: [occurrence.artifactPath],
          message: fillTemplate(
            rule.message ||
              "Inline attribute '{functionalId}' appears in project '{project}' at '{path}'. Consider using a shared attribute-group artifact.",
            {
              functionalId: occurrence.functionalId || occurrence.label || occurrence.tagName,
              project: occurrence.project,
              path: occurrence.artifactPath,
            }
          ),
          remediation: {
            action: "replace_inline_attribute_with_ref",
            targetFolder: inferSuggestedFolder([occurrence.artifactPath], rule.targetFolder),
            suggestedArtifactLabel: humanizeIdentifier(occurrence.label || occurrence.functionalId || occurrence.tagName),
            suggestedArtifactFileName: toSuggestedAttributeArtifactFileName(
              humanizeIdentifier(occurrence.label || occurrence.functionalId || occurrence.tagName)
            ),
            sourcePaths: [occurrence.artifactPath],
          },
        });
      }
    }
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    ok: !findings.some((finding) => finding.severity === "error"),
    ruleCount: rules.length,
    findingCount: findings.length,
    findings,
    loadedRules: rules,
  };
};
