import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ArtifactKind,
  ArtifactLink,
  ArtifactNode,
  ArtifactTrace,
  CaseListNode,
  CaseTypeNode,
  CaseViewNode,
  DatastoreListNode,
  CreatedCaseFormWorkflowResult,
  CreatedInterfaceOperationResult,
  CreatedListResult,
  CreatedTestBixmlFile,
  CreatedWebApplicationResult,
  ProjectNode,
  ProjectRole,
  RepositoryModel,
  RepositoryValidationIssue,
  RepositoryValidationResult,
  StudioConfig,
  TabNode,
  PanelNode,
  EventNode,
  FormNode,
  WebApplicationNode,
  VersionProfile
} from "./types.js";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".metadata",
  ".next",
  ".nuxt",
  ".svn",
  "bin",
  "build",
  "cache",
  "dist",
  "node_modules",
  "release",
  "target"
]);

const TEXT_SAMPLE_LIMIT = 400_000;

type WalkOptions = {
  maxDepth?: number;
};

type ParsedProject = {
  name: string;
  projectFilePath: string;
  dependencies: string[];
  builders: string[];
  natures: string[];
  isBeInformed: boolean;
  explicitEncoding: string | null;
  hasProjectEncodingPreference: boolean;
  hasDotProjectEncodingPreference: boolean;
};

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const readBoundedText = async (filePath: string, maxLength = TEXT_SAMPLE_LIMIT): Promise<string | null> => {
  try {
    const text = await readFile(filePath, "utf8");
    return text.length <= maxLength ? text : text.slice(0, maxLength);
  } catch {
    return null;
  }
};

const walkDirectory = async (
  rootPath: string,
  visit: (fullPath: string, entry: Dirent<string>, depth: number) => Promise<boolean | void>,
  depth = 0,
  maxDepth = Number.POSITIVE_INFINITY
): Promise<void> => {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    const result = await visit(fullPath, entry, depth);
    if (result === false) {
      continue;
    }
    if (entry.isDirectory() && depth < maxDepth) {
      await walkDirectory(fullPath, visit, depth + 1, maxDepth);
    }
  }
};

const extractTopLevelValue = (xmlText: string, tagName: string): string | null => {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(xmlText);
  return match?.[1]?.trim() || null;
};

const extractTopLevelBlock = (xmlText: string, tagName: string): string | null => {
  const match = new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`, "i").exec(xmlText);
  return match?.[0] || null;
};

const extractBlockInnerXml = (block: string): string => {
  const start = block.indexOf(">");
  const end = block.lastIndexOf("</");
  if (start < 0 || end < 0 || end <= start) {
    return "";
  }
  return block.slice(start + 1, end);
};

const splitTopLevelXmlChildren = (xmlText: string): string[] => {
  const children: string[] = [];
  let index = 0;

  while (index < xmlText.length) {
    while (index < xmlText.length && /\s/.test(xmlText[index])) {
      index += 1;
    }
    if (index >= xmlText.length) {
      break;
    }
    if (xmlText[index] !== "<") {
      index += 1;
      continue;
    }

    const openTagEnd = xmlText.indexOf(">", index);
    if (openTagEnd < 0) {
      break;
    }
    const openTag = xmlText.slice(index, openTagEnd + 1);
    if (openTag.startsWith("</")) {
      index = openTagEnd + 1;
      continue;
    }
    if (openTag.endsWith("/>")) {
      children.push(xmlText.slice(index, openTagEnd + 1));
      index = openTagEnd + 1;
      continue;
    }

    const tagNameMatch = /^<([A-Za-z0-9:_-]+)/.exec(openTag);
    if (!tagNameMatch) {
      index = openTagEnd + 1;
      continue;
    }
    const rootTagName = tagNameMatch[1];
    const tagPattern = /<\/?([A-Za-z0-9:_-]+)(?:\s[^>]*)?>/g;
    tagPattern.lastIndex = index;
    let depth = 0;
    let endIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(xmlText)) !== null) {
      const fullTag = match[0];
      const tagName = match[1];
      const isClosing = fullTag.startsWith("</");
      const isSelfClosing = fullTag.endsWith("/>");
      if (tagName !== rootTagName) {
        continue;
      }
      if (isClosing) {
        depth -= 1;
        if (depth === 0) {
          endIndex = tagPattern.lastIndex;
          break;
        }
      } else if (!isSelfClosing) {
        depth += 1;
      }
    }

    if (endIndex > index) {
      children.push(xmlText.slice(index, endIndex));
      index = endIndex;
    } else {
      index = openTagEnd + 1;
    }
  }

  return children.map((child) => child.trim()).filter(Boolean);
};

const extractRootElement = (xmlText: string): string | null =>
  xmlText
    .replace(/<\?[\s\S]*?\?>/g, "")
    .trimStart()
    .match(/^<([a-zA-Z0-9:_-]+)/)?.[1] || null;

const collectTagValues = (xmlText: string, tagName: string, limit = 20): string[] =>
  Array.from(xmlText.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi")))
    .slice(0, limit)
    .map((match) => match[1].trim())
    .filter(Boolean);

const extractTopLevelChildElementNames = (xmlText: string, rootElement: string | null): string[] => {
  if (!rootElement) {
    return [];
  }

  const rootBlockMatch = new RegExp(`<${rootElement}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${rootElement}>`, "i").exec(xmlText);
  if (!rootBlockMatch?.[1]) {
    return [];
  }

  const innerXml = rootBlockMatch[1];
  const names: string[] = [];
  let depth = 0;
  const tagPattern = /<\/?([A-Za-z0-9:_-]+)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(innerXml)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    const isClosing = fullTag.startsWith("</");
    const isSelfClosing = fullTag.endsWith("/>");

    if (isClosing) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0) {
      names.push(tagName);
    }

    if (!isSelfClosing) {
      depth += 1;
    }
  }

  return names;
};

export const deriveProjectRole = (projectName: string): ProjectRole => {
  const lower = String(projectName || "").toLowerCase().trim();

  if (!lower) {
    return "other";
  }
  if (lower.includes("frontend")) {
    return "frontend";
  }
  if (lower.includes("_continuous_delivery")) {
    return "delivery";
  }
  if (lower.includes("development related")) {
    return "development";
  }
  if (lower.includes("interaction layer")) {
    return "interaction_layer";
  }
  if (lower.includes("portal")) {
    return "portal";
  }
  if (lower.includes("interface definitions") || lower.includes("interface definition")) {
    return "interface";
  }
  if (lower.includes("specific")) {
    return lower.startsWith("dsc ") ? "dsc_specific" : "specific";
  }
  if (lower === "sc library") {
    return "shared_core";
  }
  if (lower === "sc library - specific") {
    return "shared_specific";
  }
  if (lower.startsWith("dsc ")) {
    return "dsc_core";
  }
  if (lower.startsWith("sc ")) {
    return "domain_core";
  }
  return "other";
};

export const deriveModuleFamily = (projectName: string): string =>
  String(projectName || "")
    .replace(/\s+-\s+Interface definitions?$/i, "")
    .replace(/\s+-\s+Specific$/i, "")
    .replace(/\s+-\s+Mock$/i, "")
    .replace(/\s+-\s+Documentation$/i, "")
    .replace(/\s+-\s+reference implementation$/i, "")
    .trim();

const parseProjectFile = async (projectFilePath: string): Promise<ParsedProject | null> => {
  const xml = await readBoundedText(projectFilePath, 200_000);
  if (!xml) {
    return null;
  }

  const name = xml.match(/<name>([^<]+)<\/name>/)?.[1] || path.basename(path.dirname(projectFilePath));
  const dependencies = Array.from(xml.matchAll(/<project>([^<]+)<\/project>/g)).map((match) => match[1]);
  const builders = Array.from(xml.matchAll(/<name>([^<]+)<\/name>/g))
    .map((match) => match[1])
    .filter((value) => value.includes("."));
  const natures = Array.from(xml.matchAll(/<nature>([^<]+)<\/nature>/g)).map((match) => match[1]);
  const prefsPath = path.join(path.dirname(projectFilePath), ".settings", "org.eclipse.core.resources.prefs");
  const prefs = await readBoundedText(prefsPath, 20_000);
  const projectEncodingMatch = prefs?.match(/^encoding\/<project>=(.+)$/m);
  const dotProjectEncodingMatch = prefs?.match(/^encoding\/\.project=(.+)$/m);

  return {
    name,
    projectFilePath,
    dependencies,
    builders,
    natures,
    isBeInformed:
      builders.some((builder) => builder.includes("nl.beinformed")) ||
      natures.some((nature) => nature.includes("nl.beinformed")),
    explicitEncoding: projectEncodingMatch?.[1]?.trim() || null,
    hasProjectEncodingPreference: Boolean(projectEncodingMatch),
    hasDotProjectEncodingPreference: Boolean(dotProjectEncodingMatch)
  };
};

const parseStudioConfigs = async (repoPath: string): Promise<StudioConfig[]> => {
  const studioDir = path.join(repoPath, "_CONTINUOUS_DELIVERY", "_STUDIO");

  try {
    const entries = await readdir(studioDir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(studioDir, entry.name);
          const raw = await readBoundedText(fullPath, 500_000);
          if (!raw) {
            return null;
          }

          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            return {
              path: fullPath,
              version: typeof parsed.version === "string" ? parsed.version : null,
              type: typeof parsed.type === "string" ? parsed.type : null,
              port:
                typeof parsed.port === "number" || typeof parsed.port === "string"
                  ? parsed.port
                  : null,
              webApps: Array.isArray(parsed.webApps)
                ? parsed.webApps.filter((value): value is string => typeof value === "string")
                : [],
              camelContext: typeof parsed.camelContext === "string" ? parsed.camelContext : null,
              excludeProjects: Array.isArray(parsed.excludeProjects)
                ? parsed.excludeProjects.filter((value): value is string => typeof value === "string")
                : []
            } satisfies StudioConfig;
          } catch {
            return {
              path: fullPath,
              version: null,
              type: null,
              port: null,
              webApps: [],
              camelContext: null,
              excludeProjects: []
            } satisfies StudioConfig;
          }
        })
    );

    return results.filter((value): value is StudioConfig => value !== null);
  } catch {
    return [];
  }
};

export const extractBeInformedVersionsFromText = (text: string): string[] =>
  unique(
    Array.from(String(text || "").matchAll(/<\?plugin\s+[^?]*?_(\d+\.\d+\.\d+(?:\.\d+)*)\?>/g)).map(
      (match) => match[1]
    )
  );

const classifyArtifactKind = (rootElement: string | null, filePath: string, xmlText: string): ArtifactKind => {
  const root = String(rootElement || "").toLowerCase();
  const lowerPath = filePath.toLowerCase();
  const lowerXml = xmlText.toLowerCase();

  if (root.includes("taxonomy") || lowerXml.includes("<taxonomy-type>")) {
    return "taxonomy";
  }
  if (root.includes("knowledge") || root.includes("concept") || root.includes("relation-type")) {
    return "knowledge";
  }
  if (root.includes("object") || root.includes("attribute") || root.includes("datastore")) {
    return "data";
  }
  if (root.includes("handler") || root.includes("activity") || root.includes("event") || root.includes("process")) {
    return "behavior";
  }
  if (
    root.includes("panel") ||
    root.includes("form") ||
    root.includes("case-view") ||
    root.includes("tab") ||
    root.includes("view")
  ) {
    return "ui";
  }
  if (root.includes("application") || lowerPath.includes("portal")) {
    return "application";
  }
  if (
    root.includes("service") ||
    root.includes("request") ||
    root.includes("response") ||
    lowerXml.includes("<execute-handler-group>")
  ) {
    return "integration";
  }
  if (root.includes("configuration") || lowerPath.includes("_continuous_delivery")) {
    return "configuration";
  }
  return "unknown";
};

const buildArtifactLinks = (sourcePath: string, xmlText: string): ArtifactLink[] => {
  const definitions: Array<{ tagName: string; type: string; confidence: ArtifactLink["confidence"] }> = [
    { tagName: "referenced-concept", type: "artifact_links_to_artifact", confidence: "high" },
    { tagName: "concept-type-identifier", type: "artifact_uses_concept_type", confidence: "medium" },
    { tagName: "relation-type-id", type: "artifact_uses_relation_type", confidence: "medium" },
    { tagName: "object-id", type: "artifact_uses_object", confidence: "low" },
    { tagName: "attribute-set-identifier", type: "artifact_uses_attribute_set", confidence: "medium" },
    { tagName: "attribute-group-identifier", type: "artifact_uses_attribute_group", confidence: "medium" },
    { tagName: "knowledge-model-identifier", type: "artifact_uses_knowledge_model", confidence: "medium" },
    { tagName: "case-view-identifier", type: "artifact_uses_case_view", confidence: "medium" },
    { tagName: "panel-identifier", type: "artifact_uses_panel", confidence: "medium" },
    { tagName: "form-identifier", type: "artifact_uses_form", confidence: "medium" },
    { tagName: "handler-group-identifier", type: "artifact_executes_handler_group", confidence: "medium" }
  ];

  return definitions.flatMap((definition) =>
    collectTagValues(xmlText, definition.tagName, 24).map((target) => ({
      source: sourcePath,
      target,
      type: definition.type,
      confidence: definition.confidence
    }))
  );
};

const buildCaseTypeNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<CaseTypeNode[]> => {
  const nodes: CaseTypeNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "case") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 500_000);
    if (!xmlText) {
      continue;
    }

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      functionalId: extractTopLevelValue(xmlText, "functional-id"),
      stateCount: collectTagValues(xmlText, "state", 500).length,
      stateIds: collectTagValues(xmlText, "state", 500)
        .map((block) => extractTopLevelValue(block, "id") || extractTopLevelValue(block, "functional-id"))
        .filter((value): value is string => Boolean(value)),
      stateLinks: collectTagValues(xmlText, "state-ref", 500)
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      documentTypeCount: collectTagValues(xmlText, "document-type", 500).length,
      recordTypeLinks: collectTagValues(xmlText, "record-type-link", 500),
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildCaseViewNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<CaseViewNode[]> => {
  const nodes: CaseViewNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "case-view") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      caseTypeLink: extractTopLevelValue(xmlText, "case-type"),
      casePropertiesPanelCount: collectTagValues(xmlText, "case-properties-panel", 500).length,
      caseRelatedDatastoreListPanelRefCount: collectTagValues(xmlText, "case-related-datastore-list-panel-ref", 500).length,
      eventListPanelRefCount: collectTagValues(xmlText, "event-list-panel-ref", 500).length,
      taskGroupCount: collectTagValues(xmlText, "taskgroup", 500).length,
      relatedCaseViewCount: collectTagValues(xmlText, "related-case-view", 500).length,
      caseRelatedDatastoreListPanelLinks: collectTagValues(xmlText, "case-related-datastore-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "case-related-datastore-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
      eventListPanelLinks: collectTagValues(xmlText, "event-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "event-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
      groupingPanelLinks: collectTagValues(xmlText, "grouping-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "grouping-panel-link"))
        .filter((value): value is string => Boolean(value)),
      recordListPanelLinks: collectTagValues(xmlText, "record-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "record-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const PANEL_ROOT_ELEMENTS = new Set([
  "case-related-datastore-list",
  "event-list-panel",
  "grouping-panel",
  "record-list-panel"
]);

const buildPanelNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<PanelNode[]> => {
  const nodes: PanelNode[] = [];

  for (const artifact of artifacts) {
    if (!artifact.rootElement || !PANEL_ROOT_ELEMENTS.has(artifact.rootElement)) {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      rootElement: artifact.rootElement,
      uriPart: extractTopLevelValue(xmlText, "uri-part"),
      caseRelatedDatastoreListPanelLinks: collectTagValues(xmlText, "case-related-datastore-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "case-related-datastore-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
      eventListPanelLinks: collectTagValues(xmlText, "event-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "event-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
      groupingPanelLinks: collectTagValues(xmlText, "grouping-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "grouping-panel-link"))
        .filter((value): value is string => Boolean(value)),
      recordListPanelLinks: collectTagValues(xmlText, "record-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "record-list-panel-link"))
        .filter((value): value is string => Boolean(value)),
      formLinks: [
        ...collectTagValues(xmlText, "general-panel-task", 500)
          .map((block) => extractTopLevelValue(block, "link"))
          .filter((value): value is string => Boolean(value)),
        ...collectTagValues(xmlText, "form-ref", 500)
          .map((block) => extractTopLevelValue(block, "link"))
          .filter((value): value is string => Boolean(value))
      ]
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildEventNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<EventNode[]> => {
  const nodes: EventNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "event") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    const newCaseHandlerBlocks = collectTagValues(xmlText, "new-case-handler", 500);
    const inputRoleBlocks = collectTagValues(xmlText, "attributeset-input-role", 500);
    const eventRepoLink = `/${artifact.path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      newCaseTypeLinks: newCaseHandlerBlocks
        .map((block) => extractTopLevelValue(block, "case-type-link"))
        .filter((value): value is string => Boolean(value)),
      newCaseStateLinks: newCaseHandlerBlocks
        .map((block) => extractTopLevelValue(block, "state-type-link"))
        .filter((value): value is string => Boolean(value)),
      newCaseHandlers: newCaseHandlerBlocks.map((block) => ({
        caseTypeLink: extractTopLevelValue(block, "case-type-link"),
        stateTypeLink: extractTopLevelValue(block, "state-type-link")
      })),
      inputAttributeSetRefs: inputRoleBlocks.flatMap((block) => [
        ...collectTagValues(block, "attributeset-ref", 500)
          .map((refBlock) => extractTopLevelValue(refBlock, "id"))
          .filter((id): id is string => Boolean(id))
          .map((id) => `${eventRepoLink}#${id}`)
          .filter((value): value is string => Boolean(value)),
        ...collectTagValues(block, "attributeset", 500)
          .map((inlineBlock) => extractTopLevelValue(inlineBlock, "id"))
          .filter((id): id is string => Boolean(id))
          .map((id) => `${eventRepoLink}#${id}`)
      ])
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildFormNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<FormNode[]> => {
  const nodes: FormNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "form") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    const requestParametersBlock = extractTopLevelBlock(xmlText, "request-parameters");
    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      eventTypeLink: extractTopLevelValue(xmlText, "eventtypelink"),
      requestParameterAttributeSetLink: requestParametersBlock
        ? extractTopLevelValue(requestParametersBlock, "attribute-set-type-link")
        : null,
      questionAttributeSetLinks: collectTagValues(xmlText, "eventquestion", 500)
        .map((block) => extractTopLevelValue(block, "attribute-set-type-link"))
        .filter((value): value is string => Boolean(value))
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildCaseListNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<CaseListNode[]> => {
  const nodes: CaseListNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "case-list2") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    const createCaseTaskBlocks = collectTagValues(xmlText, "create-case-task", 500);
    const generalPanelTaskBlocks = collectTagValues(xmlText, "general-panel-task", 500);

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      recordTypeLink: extractTopLevelValue(xmlText, "record-type-link"),
      createCaseTaskCaseTypeLinks: createCaseTaskBlocks
        .map((block) => extractTopLevelValue(block, "caseTypeLink"))
        .filter((value): value is string => Boolean(value)),
      createCaseTaskFormLinks: createCaseTaskBlocks
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      generalPanelTaskFormLinks: generalPanelTaskBlocks
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value))
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildDatastoreListNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<DatastoreListNode[]> => {
  const nodes: DatastoreListNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "datastore-list") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    const createDataStoreTaskBlocks = collectTagValues(xmlText, "create-data-store-task", 500);

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      datastoreLink: extractTopLevelValue(xmlText, "datastore-link"),
      caseContextAttributeLink: extractTopLevelValue(xmlText, "case-context-attribute-link"),
      createDataStoreTaskFormLinks: createDataStoreTaskBlocks
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value))
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildTabNodes = async (repoPath: string, artifacts: ArtifactNode[]): Promise<TabNode[]> => {
  const nodes: TabNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "tab") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      caseViewLinks: collectTagValues(xmlText, "case-view-ref", 500)
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      caseListLinks: collectTagValues(xmlText, "case-list-ref", 500)
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      datastoreListPanelLinks: collectTagValues(xmlText, "datastore-list-panel-ref", 500)
        .map((block) => extractTopLevelValue(block, "datastore-list-panel-link") || extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      formTaskLinks: collectTagValues(xmlText, "form-ref", 500)
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value))
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const buildWebApplicationNodes = async (
  repoPath: string,
  artifacts: ArtifactNode[]
): Promise<WebApplicationNode[]> => {
  const nodes: WebApplicationNode[] = [];

  for (const artifact of artifacts) {
    if (artifact.rootElement !== "webapplication") {
      continue;
    }
    const xmlText = await readBoundedText(path.resolve(repoPath, artifact.path), 800_000);
    if (!xmlText) {
      continue;
    }

    nodes.push({
      path: artifact.path,
      project: artifact.project,
      label: artifact.label,
      uriPart: extractTopLevelValue(xmlText, "uri-part"),
      tabLinks: collectTagValues(xmlText, "tab-ref", 500)
        .map((block) => extractTopLevelValue(block, "link"))
        .filter((value): value is string => Boolean(value)),
      userProviderLink: extractTopLevelValue(xmlText, "user-provider"),
      loginMandatory:
        extractTopLevelValue(xmlText, "login-mandatory") === null
          ? null
          : extractTopLevelValue(xmlText, "login-mandatory") === "true",
      loginPanelUriPart: collectTagValues(xmlText, "login-panel", 1)
        .map((block) => extractTopLevelValue(block, "uri-part"))
        .find((value): value is string => Boolean(value)) || null,
      loginEventLinks: collectTagValues(xmlText, "execute-login-event", 500)
        .map((block) => extractTopLevelValue(block, "event-type-link"))
        .filter((value): value is string => Boolean(value))
    });
  }

  return nodes.sort((left, right) => left.path.localeCompare(right.path));
};

const collectProjectFiles = async (repoPath: string): Promise<ParsedProject[]> => {
  const projectFiles: string[] = [];

  await walkDirectory(
    repoPath,
    async (fullPath, entry) => {
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        return false;
      }
      if (entry.isFile() && entry.name === ".project") {
        projectFiles.push(fullPath);
      }
      return undefined;
    },
    0,
    5
  );

  const parsed = await Promise.all(projectFiles.map((projectFile) => parseProjectFile(projectFile)));
  return parsed.filter((project): project is ParsedProject => project !== null);
};

type BuildRepositoryOptions = {
  includeArtifacts?: boolean;
  maxArtifacts?: number;
};

type CreateTestBixmlOptions = {
  rootElement?: string;
  label?: string;
  version?: string;
};

type CreateInterfaceOperationOptions = {
  withResponse?: boolean;
};

type CreateCaseFormWorkflowOptions = {
  secure?: boolean;
  templateForm?: string;
  templateEvent?: string;
};

type CreateWebApplicationOptions = {
  userProvider?: string;
  loginMandatory?: boolean;
};

type CreateTabOptions = {
  secure?: boolean;
  layoutHint?: string;
  webApplication?: string;
  datastoreListLinks?: Array<{ link: string; uriPart: string }>;
  caseViewLinks?: Array<{ link: string; uriPart: string }>;
  caseListLinks?: Array<{ link: string; uriPart: string }>;
  formTasks?: Array<{ link: string; label: string; uriPart: string }>;
};

type CreateCaseListOptions = {
  createFormLink?: string;
  updateFormLink?: string;
};

type CreateDatastoreListOptions = {
  createFormLink?: string;
  caseContextAttributeLink?: string;
};

const collectVersionSamplePaths = async (repoPath: string, maxSamples = 12): Promise<string[]> => {
  const samples: string[] = [];

  await walkDirectory(
    repoPath,
    async (fullPath, entry) => {
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        return false;
      }
      if (samples.length >= maxSamples) {
        return false;
      }
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".bixml") {
        samples.push(fullPath);
      }
      return undefined;
    },
    0,
    5
  );

  return samples;
};

export const buildRepositoryModel = async (
  repoPathInput: string,
  options: BuildRepositoryOptions = {}
): Promise<RepositoryModel> => {
  const repoPath = path.resolve(repoPathInput);
  const repoStat = await stat(repoPath);
  if (!repoStat.isDirectory()) {
    throw new Error(`Repository root is not a directory: ${repoPath}`);
  }

  const parsedProjects = await collectProjectFiles(repoPath);
  const beProjects = parsedProjects.filter((project) => project.isBeInformed);
  const projectNodes: ProjectNode[] = beProjects
    .map((project) => ({
      name: project.name,
      path: path.dirname(project.projectFilePath),
      role: deriveProjectRole(project.name),
      family: deriveModuleFamily(project.name),
      dependencies: project.dependencies,
      builders: project.builders,
      natures: project.natures,
      isBeInformed: project.isBeInformed,
      versionHints: [],
      explicitEncoding: project.explicitEncoding,
      hasProjectEncodingPreference: project.hasProjectEncodingPreference,
      hasDotProjectEncodingPreference: project.hasDotProjectEncodingPreference
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const projectByRoot = new Map(projectNodes.map((project) => [path.resolve(project.path), project]));
  const studioConfigs = await parseStudioConfigs(repoPath);
  const artifactIndex: ArtifactNode[] = [];
  const versionCounts = new Map<string, number>();
  const filesByVersion = new Map<string, string[]>();
  const maxArtifacts = options.maxArtifacts ?? 500;
  const versionSamplePaths = await collectVersionSamplePaths(repoPath);

  for (const samplePath of versionSamplePaths) {
    const sampleText = await readBoundedText(samplePath, 24_000);
    if (!sampleText) {
      continue;
    }
    const relativePath = path.relative(repoPath, samplePath);
    for (const version of extractBeInformedVersionsFromText(sampleText)) {
      versionCounts.set(version, (versionCounts.get(version) || 0) + 1);
      if (!filesByVersion.has(version)) {
        filesByVersion.set(version, []);
      }
      const bucket = filesByVersion.get(version);
      if (bucket && !bucket.includes(relativePath) && bucket.length < 5) {
        bucket.push(relativePath);
      }
    }
  }

  if (options.includeArtifacts !== false) {
    await walkDirectory(
      repoPath,
      async (fullPath, entry) => {
        if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          return false;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".bixml") {
          return undefined;
        }
        if (artifactIndex.length >= maxArtifacts) {
          return undefined;
        }

        const xmlText = await readBoundedText(fullPath);
        if (!xmlText) {
          return undefined;
        }

        const relativePath = path.relative(repoPath, fullPath);
        const rootElement = extractRootElement(xmlText);
        const versions = extractBeInformedVersionsFromText(xmlText);
        for (const version of versions) {
          versionCounts.set(version, (versionCounts.get(version) || 0) + 1);
          if (!filesByVersion.has(version)) {
            filesByVersion.set(version, []);
          }
          const bucket = filesByVersion.get(version);
          if (bucket && bucket.length < 5) {
            if (!bucket.includes(relativePath)) {
              bucket.push(relativePath);
            }
          }
        }

        let owningProject: string | null = null;
        for (let current = path.dirname(fullPath); current.startsWith(repoPath); current = path.dirname(current)) {
          const project = projectByRoot.get(path.resolve(current));
          if (project) {
            owningProject = project.name;
            if (versions.length > 0) {
              project.versionHints = unique([...project.versionHints, ...versions]).sort();
            }
            break;
          }
          if (current === repoPath) {
            break;
          }
        }

        artifactIndex.push({
          path: relativePath,
          project: owningProject,
          rootElement,
          artifactKind: classifyArtifactKind(rootElement, relativePath, xmlText),
          label: extractTopLevelValue(xmlText, "label"),
          identifier: extractTopLevelValue(xmlText, "identifier"),
          versionHints: versions,
          links: buildArtifactLinks(relativePath, xmlText),
          childElementNames: extractTopLevelChildElementNames(xmlText, rootElement)
        });

        return undefined;
      },
      0,
      8
    );
  }

  const artifactsByIdentifier = new Map<string, ArtifactNode>();
  for (const artifact of artifactIndex) {
    if (artifact.identifier && !artifactsByIdentifier.has(artifact.identifier)) {
      artifactsByIdentifier.set(artifact.identifier, artifact);
    }
  }

  for (const artifact of artifactIndex) {
    artifact.links = artifact.links.map((link) => {
      const resolvedArtifact = artifactsByIdentifier.get(link.target);
      if (!resolvedArtifact) {
        return link;
      }
      return {
        ...link,
        resolvedPath: resolvedArtifact.path,
        confidence: link.confidence === "low" ? "medium" : link.confidence
      };
    });
  }

  const versionProfiles: VersionProfile[] = Array.from(versionCounts.entries())
    .map(([version, fileCount]) => ({
      id: version,
      version,
      baseFamily: version.split(".").slice(0, 2).join("."),
      fileCount,
      sampleFiles: filesByVersion.get(version) || []
    }))
    .sort((left, right) => right.fileCount - left.fileCount || left.version.localeCompare(right.version));
  const sortedArtifacts = artifactIndex.sort((left, right) => left.path.localeCompare(right.path));
  const caseTypes = await buildCaseTypeNodes(repoPath, sortedArtifacts);
  const caseViews = await buildCaseViewNodes(repoPath, sortedArtifacts);
  const caseLists = await buildCaseListNodes(repoPath, sortedArtifacts);
  const datastoreLists = await buildDatastoreListNodes(repoPath, sortedArtifacts);
  const tabs = await buildTabNodes(repoPath, sortedArtifacts);
  const webApplications = await buildWebApplicationNodes(repoPath, sortedArtifacts);
  const panels = await buildPanelNodes(repoPath, sortedArtifacts);
  const events = await buildEventNodes(repoPath, sortedArtifacts);
  const forms = await buildFormNodes(repoPath, sortedArtifacts);

  return {
    repositoryName: path.basename(repoPath),
    repositoryPath: repoPath,
    dominantVersionProfile: versionProfiles[0] || null,
    versionProfiles,
    studioConfigs,
    projects: projectNodes,
    artifactIndex: sortedArtifacts,
    caseTypes,
    caseViews,
    caseLists,
    datastoreLists,
    tabs,
    webApplications,
    panels,
    events,
    forms
  };
};

export const traceRepositoryArtifacts = async (
  repoPath: string,
  query: string,
  options: BuildRepositoryOptions = {}
): Promise<ArtifactTrace> => {
  const model = await buildRepositoryModel(repoPath, {
    includeArtifacts: true,
    maxArtifacts: options.maxArtifacts ?? 1500
  });
  const normalizedQuery = query.toLowerCase().trim();
  const matches = model.artifactIndex
    .filter((artifact) => {
      const haystacks = [
        artifact.path,
        artifact.project || "",
        artifact.rootElement || "",
        artifact.label || "",
        artifact.identifier || ""
      ];
      return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .slice(0, 20);
  const matchPaths = new Set(matches.map((artifact) => artifact.path));
  const matchIdentifiers = new Set(matches.flatMap((artifact) => (artifact.identifier ? [artifact.identifier] : [])));
  const outboundLinks = matches.flatMap((artifact) => artifact.links).slice(0, 60);
  const inboundLinks = model.artifactIndex
    .flatMap((artifact) =>
      artifact.links.filter(
        (link) =>
          matchPaths.has(link.resolvedPath || "") ||
          matchIdentifiers.has(link.target) ||
          matchPaths.has(link.target)
      )
    )
    .slice(0, 60);

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    query,
    matches,
    inboundLinks,
    outboundLinks
  };
};

export const validateRepositoryModel = (model: RepositoryModel): RepositoryValidationResult => {
  const issues: RepositoryValidationIssue[] = [];
  const projectNames = new Set(model.projects.map((project) => project.name));
  const projectByName = new Map(model.projects.map((project) => [project.name, project]));
  const artifactByPath = new Map(model.artifactIndex.map((artifact) => [path.normalize(artifact.path), artifact]));
  const caseTypeByPath = new Map(model.caseTypes.map((caseType) => [path.normalize(caseType.path), caseType]));
  const eventByPath = new Map(model.events.map((event) => [path.normalize(event.path), event]));
  const attributeContainerMemberNames = new Set([
    "stringattribute",
    "numberattribute",
    "dateattribute",
    "datetimeattribute",
    "booleanattribute",
    "choiceattribute",
    "memoattribute",
    "moneyattribute",
    "uploadattribute",
    "auto-generated-numberattribute",
    "currencyattribute",
    "helptext",
    "attributegroup-ref",
    "attributegroup",
    "attributeset-ref",
    "attributeset"
  ]);

  for (const project of model.projects) {
    for (const dependency of project.dependencies) {
      if (!projectNames.has(dependency)) {
        issues.push({
          type: "missing_project_dependency",
          severity: "error",
          message: `Project "${project.name}" depends on missing project "${dependency}".`,
          project: project.name,
          target: dependency
        });
      }
    }

    if (project.versionHints.length > 1) {
      issues.push({
        type: "mixed_version_project",
        severity: "warning",
        message: `Project "${project.name}" contains mixed Be Informed version hints: ${project.versionHints.join(", ")}.`,
        project: project.name
      });
    }

    if (!project.hasProjectEncodingPreference || !project.hasDotProjectEncodingPreference || project.explicitEncoding !== "UTF-8") {
      issues.push({
        type: "missing_project_encoding",
        severity: "warning",
        message: `Project "${project.name}" should declare explicit Eclipse resource encoding with UTF-8 for both <project> and .project.`,
        project: project.name
      });
    }
  }

  for (const artifact of model.artifactIndex) {
    if (!artifact.project) {
      issues.push({
        type: "artifact_without_project",
        severity: "warning",
        message: `Artifact "${artifact.path}" could not be mapped to a Be Informed project.`,
        artifactPath: artifact.path
      });
    }

    for (const link of artifact.links) {
      if (!link.resolvedPath && link.confidence !== "low") {
        issues.push({
          type: "unresolved_artifact_link",
          severity: "warning",
          message: `Artifact "${artifact.path}" has unresolved link "${link.target}" (${link.type}).`,
          artifactPath: artifact.path,
          target: link.target,
          project: artifact.project || undefined
        });
      }
    }

    if (artifact.rootElement === "attributeset" || artifact.rootElement === "attributegroup") {
      const childNames = artifact.childElementNames || [];
      const hasMember = childNames.some((name) => attributeContainerMemberNames.has(String(name).toLowerCase()));
      if (!hasMember) {
        issues.push({
          type: "empty_attribute_container",
          severity: "error",
          message: `Artifact "${artifact.path}" is an empty ${artifact.rootElement}; Studio expects at least one attribute or attribute group.`,
          artifactPath: artifact.path,
          project: artifact.project || undefined
        });
      }
    }
  }

  for (const caseView of model.caseViews) {
    if (!caseView.caseTypeLink) {
      issues.push({
        type: "invalid_case_view_target",
        severity: "warning",
        message: `Case view "${caseView.path}" does not declare a case-type link.`,
        artifactPath: caseView.path,
        project: caseView.project || undefined
      });
      continue;
    }
    const targetArtifact = artifactByPath.get(
      path.normalize(caseView.caseTypeLink.split("#")[0].replace(/^\/+/, "").replace(/\//g, path.sep))
    );
    if (!targetArtifact || targetArtifact.rootElement !== "case") {
      issues.push({
        type: "invalid_case_view_target",
        severity: "error",
        message: `Case view "${caseView.path}" references "${caseView.caseTypeLink}" as case-type, but the target is not a case artifact.`,
        artifactPath: caseView.path,
        target: caseView.caseTypeLink,
        project: caseView.project || undefined
      });
    }

    for (const panelLink of caseView.caseRelatedDatastoreListPanelLinks) {
      const panelArtifact = findArtifactByRepoLink(model, panelLink);
      if (!panelArtifact || panelArtifact.rootElement !== "case-related-datastore-list") {
        issues.push({
          type: "invalid_case_view_panel_target",
          severity: "error",
          message: `Case view "${caseView.path}" references "${panelLink}" as case-related-datastore-list-panel, but the target is not a case-related-datastore-list artifact.`,
          artifactPath: caseView.path,
          target: panelLink,
          project: caseView.project || undefined
        });
      }
    }

    for (const panelLink of caseView.eventListPanelLinks) {
      const panelArtifact = findArtifactByRepoLink(model, panelLink);
      if (!panelArtifact || panelArtifact.rootElement !== "event-list-panel") {
        issues.push({
          type: "invalid_case_view_panel_target",
          severity: "error",
          message: `Case view "${caseView.path}" references "${panelLink}" as event-list-panel, but the target is not an event-list-panel artifact.`,
          artifactPath: caseView.path,
          target: panelLink,
          project: caseView.project || undefined
        });
      }
    }

    for (const panelLink of caseView.groupingPanelLinks) {
      const panelArtifact = findArtifactByRepoLink(model, panelLink);
      if (!panelArtifact || panelArtifact.rootElement !== "grouping-panel") {
        issues.push({
          type: "invalid_case_view_panel_target",
          severity: "error",
          message: `Case view "${caseView.path}" references "${panelLink}" as grouping-panel, but the target is not a grouping-panel artifact.`,
          artifactPath: caseView.path,
          target: panelLink,
          project: caseView.project || undefined
        });
      }
    }

    for (const panelLink of caseView.recordListPanelLinks) {
      const panelArtifact = findArtifactByRepoLink(model, panelLink);
      if (!panelArtifact || panelArtifact.rootElement !== "record-list-panel") {
        issues.push({
          type: "invalid_case_view_panel_target",
          severity: "error",
          message: `Case view "${caseView.path}" references "${panelLink}" as record-list-panel, but the target is not a record-list-panel artifact.`,
          artifactPath: caseView.path,
          target: panelLink,
          project: caseView.project || undefined
        });
      }
    }
  }

  for (const caseList of model.caseLists) {
    if (!caseList.recordTypeLink) {
      issues.push({
        type: "invalid_case_list_target",
        severity: "warning",
        message: `Case list "${caseList.path}" does not declare a record-type-link.`,
        artifactPath: caseList.path,
        project: caseList.project || undefined
      });
    } else {
      const targetArtifact = findArtifactByRepoLink(model, caseList.recordTypeLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case") {
        issues.push({
          type: "invalid_case_list_target",
          severity: "error",
          message: `Case list "${caseList.path}" references "${caseList.recordTypeLink}" as record-type-link, but the target is not a case artifact.`,
          artifactPath: caseList.path,
          target: caseList.recordTypeLink,
          project: caseList.project || undefined
        });
      }
    }

    for (const caseTypeLink of caseList.createCaseTaskCaseTypeLinks) {
      const targetArtifact = findArtifactByRepoLink(model, caseTypeLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case") {
        issues.push({
          type: "invalid_case_list_target",
          severity: "error",
          message: `Case list "${caseList.path}" references "${caseTypeLink}" as create-case-task case type, but the target is not a case artifact.`,
          artifactPath: caseList.path,
          target: caseTypeLink,
          project: caseList.project || undefined
        });
      }
    }
  }

  for (const tab of model.tabs) {
    for (const caseViewLink of tab.caseViewLinks) {
      const targetArtifact = findArtifactByRepoLink(model, caseViewLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case-view") {
        issues.push({
          type: "invalid_tab_case_view_target",
          severity: "error",
          message: `Tab "${tab.path}" references "${caseViewLink}" as case-view-ref, but the target is not a case-view artifact.`,
          artifactPath: tab.path,
          target: caseViewLink,
          project: tab.project || undefined
        });
      }
    }

    for (const caseListLink of tab.caseListLinks) {
      const targetArtifact = findArtifactByRepoLink(model, caseListLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case-list2") {
        issues.push({
          type: "invalid_tab_case_list_target",
          severity: "error",
          message: `Tab "${tab.path}" references "${caseListLink}" as case-list-ref, but the target is not a case-list2 artifact.`,
          artifactPath: tab.path,
          target: caseListLink,
          project: tab.project || undefined
        });
      }
    }

    for (const datastoreListLink of tab.datastoreListPanelLinks) {
      const targetArtifact = findArtifactByRepoLink(model, datastoreListLink);
      if (!targetArtifact || targetArtifact.rootElement !== "datastore-list") {
        issues.push({
          type: "invalid_tab_datastore_list_target",
          severity: "error",
          message: `Tab "${tab.path}" references "${datastoreListLink}" as datastore-list-panel-ref, but the target is not a datastore-list artifact.`,
          artifactPath: tab.path,
          target: datastoreListLink,
          project: tab.project || undefined
        });
      }
    }
  }

  for (const datastoreList of model.datastoreLists) {
    if (!datastoreList.datastoreLink) {
      issues.push({
        type: "invalid_datastore_list_target",
        severity: "warning",
        message: `Datastore list "${datastoreList.path}" does not declare a datastore-link.`,
        artifactPath: datastoreList.path,
        project: datastoreList.project || undefined
      });
    } else {
      const targetArtifact = findArtifactByRepoLink(model, datastoreList.datastoreLink);
      if (!targetArtifact || targetArtifact.rootElement !== "datastore") {
        issues.push({
          type: "invalid_datastore_list_target",
          severity: "error",
          message: `Datastore list "${datastoreList.path}" references "${datastoreList.datastoreLink}" as datastore-link, but the target is not a datastore artifact.`,
          artifactPath: datastoreList.path,
          target: datastoreList.datastoreLink,
          project: datastoreList.project || undefined
        });
      }
    }

    if (datastoreList.caseContextAttributeLink) {
      const targetArtifact = findArtifactByRepoLink(model, datastoreList.caseContextAttributeLink);
      if (!targetArtifact || targetArtifact.rootElement !== "datastore") {
        issues.push({
          type: "invalid_datastore_list_case_context_target",
          severity: "error",
          message: `Datastore list "${datastoreList.path}" references "${datastoreList.caseContextAttributeLink}" as case-context-attribute-link, but the target is not a datastore artifact.`,
          artifactPath: datastoreList.path,
          target: datastoreList.caseContextAttributeLink,
          project: datastoreList.project || undefined
        });
      }
    }
  }

  for (const webApplication of model.webApplications) {
    for (const tabLink of webApplication.tabLinks) {
      const targetArtifact = findArtifactByRepoLink(model, tabLink);
      if (!targetArtifact || targetArtifact.rootElement !== "tab") {
        issues.push({
          type: "invalid_web_application_tab_target",
          severity: "error",
          message: `Web application "${webApplication.path}" references "${tabLink}" as tab-ref, but the target is not a tab artifact.`,
          artifactPath: webApplication.path,
          target: tabLink,
          project: webApplication.project || undefined
        });
      }
    }

    if (!webApplication.userProviderLink) {
      issues.push({
        type: "invalid_web_application_user_provider_target",
        severity: "warning",
        message: `Web application "${webApplication.path}" does not declare a user-provider link.`,
        artifactPath: webApplication.path,
        project: webApplication.project || undefined
      });
    } else {
      const targetArtifact = findArtifactByRepoLink(model, webApplication.userProviderLink);
      if (!targetArtifact) {
        issues.push({
          type: "invalid_web_application_user_provider_target",
          severity: "error",
          message: `Web application "${webApplication.path}" references missing user-provider "${webApplication.userProviderLink}".`,
          artifactPath: webApplication.path,
          target: webApplication.userProviderLink,
          project: webApplication.project || undefined
        });
      } else if (targetArtifact.rootElement !== "database-user-service") {
        issues.push({
          type: "invalid_web_application_user_provider_target",
          severity: "error",
          message: `Web application "${webApplication.path}" references "${webApplication.userProviderLink}" as user-provider, but the target is not a database-user-service artifact.`,
          artifactPath: webApplication.path,
          target: webApplication.userProviderLink,
          project: webApplication.project || undefined
        });
      }
    }

    if (webApplication.loginPanelUriPart?.trim().toLowerCase() === "login") {
      issues.push({
        type: "reserved_web_application_login_uri",
        severity: "error",
        message: `Web application "${webApplication.path}" uses reserved login-panel uri-part "login". Use an application-specific login URI instead.`,
        artifactPath: webApplication.path,
        project: webApplication.project || undefined
      });
    }
  }

  for (const panel of model.panels) {
    for (const panelLink of panel.caseRelatedDatastoreListPanelLinks) {
      const targetArtifact = findArtifactByRepoLink(model, panelLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case-related-datastore-list") {
        issues.push({
          type: "invalid_panel_reference_target",
          severity: "error",
          message: `Panel "${panel.path}" references "${panelLink}" as case-related-datastore-list-panel, but the target is not a case-related-datastore-list artifact.`,
          artifactPath: panel.path,
          target: panelLink,
          project: panel.project || undefined
        });
      }
    }
    for (const panelLink of panel.eventListPanelLinks) {
      const targetArtifact = findArtifactByRepoLink(model, panelLink);
      if (!targetArtifact || targetArtifact.rootElement !== "event-list-panel") {
        issues.push({
          type: "invalid_panel_reference_target",
          severity: "error",
          message: `Panel "${panel.path}" references "${panelLink}" as event-list-panel, but the target is not an event-list-panel artifact.`,
          artifactPath: panel.path,
          target: panelLink,
          project: panel.project || undefined
        });
      }
    }
    for (const panelLink of panel.groupingPanelLinks) {
      const targetArtifact = findArtifactByRepoLink(model, panelLink);
      if (!targetArtifact || targetArtifact.rootElement !== "grouping-panel") {
        issues.push({
          type: "invalid_panel_reference_target",
          severity: "error",
          message: `Panel "${panel.path}" references "${panelLink}" as grouping-panel, but the target is not a grouping-panel artifact.`,
          artifactPath: panel.path,
          target: panelLink,
          project: panel.project || undefined
        });
      }
    }
    for (const panelLink of panel.recordListPanelLinks) {
      const targetArtifact = findArtifactByRepoLink(model, panelLink);
      if (!targetArtifact || targetArtifact.rootElement !== "record-list-panel") {
        issues.push({
          type: "invalid_panel_reference_target",
          severity: "error",
          message: `Panel "${panel.path}" references "${panelLink}" as record-list-panel, but the target is not a record-list-panel artifact.`,
          artifactPath: panel.path,
          target: panelLink,
          project: panel.project || undefined
        });
      }
    }
  }

  for (const event of model.events) {
    for (const caseTypeLink of event.newCaseTypeLinks) {
      const targetArtifact = findArtifactByRepoLink(model, caseTypeLink);
      if (!targetArtifact || targetArtifact.rootElement !== "case") {
        issues.push({
          type: "invalid_event_new_case_target",
          severity: "error",
          message: `Event "${event.path}" references "${caseTypeLink}" in new-case-handler, but the target is not a case artifact.`,
          artifactPath: event.path,
          target: caseTypeLink,
          project: event.project || undefined
        });
      }
    }

    for (const handler of event.newCaseHandlers) {
      if (!handler.stateTypeLink) {
        continue;
      }
      const targetArtifact = findArtifactByRepoLink(model, handler.stateTypeLink);
      const caseArtifact = handler.caseTypeLink ? findArtifactByRepoLink(model, handler.caseTypeLink) : null;
      const caseType =
        caseArtifact && caseArtifact.rootElement === "case"
          ? caseTypeByPath.get(path.normalize(caseArtifact.path)) || null
          : null;
      const stateAvailableInCaseType =
        !caseType
          ? false
          : targetArtifact?.rootElement === "state"
            ? caseType.stateLinks.some((stateLink) => repoLinksEqual(stateLink, handler.stateTypeLink))
            : targetArtifact?.rootElement === "case"
              ? repoLinksEqual(handler.caseTypeLink, handler.stateTypeLink) ||
                (handler.stateTypeLink.includes("#") &&
                  repoLinksEqual(handler.caseTypeLink, handler.stateTypeLink.split("#")[0]) &&
                  caseType.stateIds.includes(handler.stateTypeLink.split("#")[1] || ""))
              : false;
      if (
        !targetArtifact ||
        (targetArtifact.rootElement !== "state" && targetArtifact.rootElement !== "case") ||
        !stateAvailableInCaseType
      ) {
        issues.push({
          type: "invalid_event_state_target",
          severity: "error",
          message: `Event "${event.path}" references "${handler.stateTypeLink}" in new-case-handler state-type-link, but the target is not available as a state of the selected case type.`,
          artifactPath: event.path,
          target: handler.stateTypeLink,
          project: event.project || undefined
        });
      }
    }
  }

  for (const form of model.forms) {
    const eventArtifact = form.eventTypeLink ? findArtifactByRepoLink(model, form.eventTypeLink) : null;
    if (!eventArtifact || eventArtifact.rootElement !== "event") {
      issues.push({
        type: "invalid_form_event_target",
        severity: "error",
        message: `Form "${form.path}" references "${form.eventTypeLink || "(missing)"}" as eventtypelink, but the target is not an event artifact.`,
        artifactPath: form.path,
        target: form.eventTypeLink || undefined,
        project: form.project || undefined
      });
      continue;
    }

    const eventNode = eventByPath.get(path.normalize(eventArtifact.path)) || null;
    const validInputRefs = new Set((eventNode?.inputAttributeSetRefs || []).map((link) => normalizeRepoLink(link)));

    if (
      !form.requestParameterAttributeSetLink ||
      !validInputRefs.has(normalizeRepoLink(form.requestParameterAttributeSetLink))
    ) {
      issues.push({
        type: "invalid_form_request_parameters_target",
        severity: "error",
        message: `Form "${form.path}" request-parameters must point to an input attribute set of event "${eventArtifact.path}".`,
        artifactPath: form.path,
        target: form.requestParameterAttributeSetLink || undefined,
        project: form.project || undefined
      });
    }

    for (const questionLink of form.questionAttributeSetLinks) {
      if (!validInputRefs.has(normalizeRepoLink(questionLink))) {
        issues.push({
          type: "invalid_form_question_target",
          severity: "error",
          message: `Form "${form.path}" question attribute-set-type-link "${questionLink}" is not an input attribute set of event "${eventArtifact.path}".`,
          artifactPath: form.path,
          target: questionLink,
          project: form.project || undefined
        });
      }
    }
  }

  const validateReferenceDependency = (
    sourceProjectName: string | null,
    sourcePath: string,
    targetLink: string,
    referenceType: string
  ): void => {
    if (!sourceProjectName) {
      return;
    }
    const targetProjectName = extractProjectNameFromRepoLink(targetLink);
    if (!targetProjectName || targetProjectName === sourceProjectName) {
      return;
    }
    const sourceProject = projectByName.get(sourceProjectName);
    if (!sourceProject || sourceProject.dependencies.includes(targetProjectName)) {
      return;
    }
    issues.push({
      type: "missing_reference_project_dependency",
      severity: "error",
      message: `Project "${sourceProjectName}" references "${targetLink}" from "${sourcePath}" (${referenceType}) but does not declare dependency on "${targetProjectName}" in .project.`,
      project: sourceProjectName,
      artifactPath: sourcePath,
      target: targetLink
    });
  };

  for (const caseView of model.caseViews) {
    if (caseView.caseTypeLink) {
      validateReferenceDependency(caseView.project, caseView.path, caseView.caseTypeLink, "case-type");
    }
    for (const panelLink of [
      ...caseView.caseRelatedDatastoreListPanelLinks,
      ...caseView.eventListPanelLinks,
      ...caseView.groupingPanelLinks,
      ...caseView.recordListPanelLinks
    ]) {
      validateReferenceDependency(caseView.project, caseView.path, panelLink, "case-view panel reference");
    }
  }

  for (const caseList of model.caseLists) {
    if (caseList.recordTypeLink) {
      validateReferenceDependency(caseList.project, caseList.path, caseList.recordTypeLink, "record-type-link");
    }
    for (const caseTypeLink of caseList.createCaseTaskCaseTypeLinks) {
      validateReferenceDependency(caseList.project, caseList.path, caseTypeLink, "create-case-task caseTypeLink");
    }
    for (const formLink of [...caseList.createCaseTaskFormLinks, ...caseList.generalPanelTaskFormLinks]) {
      validateReferenceDependency(caseList.project, caseList.path, formLink, "case-list task form link");
    }
  }

  for (const tab of model.tabs) {
    for (const caseViewLink of tab.caseViewLinks) {
      validateReferenceDependency(tab.project, tab.path, caseViewLink, "case-view-ref");
    }
    for (const caseListLink of tab.caseListLinks) {
      validateReferenceDependency(tab.project, tab.path, caseListLink, "case-list-ref");
    }
    for (const datastoreListLink of tab.datastoreListPanelLinks) {
      validateReferenceDependency(tab.project, tab.path, datastoreListLink, "datastore-list-panel-ref");
    }
    for (const formLink of tab.formTaskLinks) {
      validateReferenceDependency(tab.project, tab.path, formLink, "taskgroup form-ref");
    }
  }

  for (const datastoreList of model.datastoreLists) {
    if (datastoreList.datastoreLink) {
      validateReferenceDependency(datastoreList.project, datastoreList.path, datastoreList.datastoreLink, "datastore-link");
    }
    if (datastoreList.caseContextAttributeLink) {
      validateReferenceDependency(
        datastoreList.project,
        datastoreList.path,
        datastoreList.caseContextAttributeLink,
        "case-context-attribute-link"
      );
    }
    for (const formLink of datastoreList.createDataStoreTaskFormLinks) {
      validateReferenceDependency(datastoreList.project, datastoreList.path, formLink, "create-data-store-task");
    }
  }

  for (const webApplication of model.webApplications) {
    for (const tabLink of webApplication.tabLinks) {
      validateReferenceDependency(webApplication.project, webApplication.path, tabLink, "tab-ref");
    }
    if (webApplication.userProviderLink) {
      validateReferenceDependency(webApplication.project, webApplication.path, webApplication.userProviderLink, "user-provider");
    }
    for (const loginEventLink of webApplication.loginEventLinks) {
      validateReferenceDependency(webApplication.project, webApplication.path, loginEventLink, "execute-login-event");
    }
  }

  for (const panel of model.panels) {
    for (const panelLink of [
      ...panel.caseRelatedDatastoreListPanelLinks,
      ...panel.eventListPanelLinks,
      ...panel.groupingPanelLinks,
      ...panel.recordListPanelLinks
    ]) {
      validateReferenceDependency(panel.project, panel.path, panelLink, "panel reference");
    }
    for (const formLink of panel.formLinks) {
      validateReferenceDependency(panel.project, panel.path, formLink, "panel form link");
    }
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    ok: !issues.some((issue) => issue.severity === "error"),
    issueCount: issues.length,
    issues
  };
};

const toSafeIdentifier = (label: string): string =>
  label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "test_bixml";

const createStableId = (seed: string): string =>
  createHash("sha1").update(seed).digest("hex").slice(0, 8);

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const buildTestBixmlContent = (rootElement: string, label: string, version: string | null): string => {
  const identifier = toSafeIdentifier(label);
  const pluginLine = version ? `<?plugin nl.beinformed.bi.knowledge_${version}?>\n` : "";
  const identifierBlock =
    rootElement === "knowledge-model" || rootElement === "knowledge-model-type" || rootElement === "serviceapplication"
      ? `  <identifier>${identifier}</identifier>\n`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>\n${pluginLine}<${rootElement}>\n  <label>${label}</label>\n${identifierBlock}</${rootElement}>\n`;
};

export const createTestBixmlFile = async (
  repoPath: string,
  projectName: string,
  fileRelativePath: string,
  options: CreateTestBixmlOptions = {}
): Promise<CreatedTestBixmlFile> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: false, maxArtifacts: 0 });
  const project = model.projects.find((candidate) => candidate.name === projectName);

  if (!project) {
    throw new Error(`Project not found in repository model: ${projectName}`);
  }

  const normalizedRelativePath = fileRelativePath.replace(/\//g, path.sep);
  const projectRoot = path.resolve(project.path);
  const outputPath = path.resolve(projectRoot, normalizedRelativePath);
  if (!outputPath.startsWith(projectRoot)) {
    throw new Error("Target file path escapes the project root.");
  }
  if (path.extname(outputPath).toLowerCase() !== ".bixml") {
    throw new Error("Target file must use the .bixml extension.");
  }

  const version =
    options.version ||
    project.versionHints[0] ||
    model.dominantVersionProfile?.version ||
    model.studioConfigs.find((config) => typeof config.version === "string")?.version ||
    null;
  const rootElement = options.rootElement || "knowledge-model-type";
  const label = options.label || path.basename(outputPath, ".bixml");

  await ensureProjectExplicitEncoding(project);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildTestBixmlContent(rootElement, label, version), "utf8");

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    projectPath: project.path,
    filePath: outputPath,
    relativePath: path.relative(model.repositoryPath, outputPath),
    rootElement,
    label,
    version
  };
};

const toBixmlFileName = (name: string): string => `${name}.bixml`.replace(/[\\/:*?"<>|]+/g, " ").trim();

const buildAtomicStringAttributeGroupContent = (
  label: string,
  functionalId: string,
  version: string | null,
  options: {
    attributeLabel?: string;
    attributeFunctionalId?: string;
  } = {}
): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.common.attributes_${version}?>`].join("")
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<attributegroup>
    <label>${xmlEscape(label)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <stringattribute>
        <id>${createStableId(`attribute-group-field:${functionalId}`)}</id>
        <label>${xmlEscape(options.attributeLabel || label)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <functional-id>${xmlEscape(options.attributeFunctionalId || functionalId)}</functional-id>
        <mandatory>false</mandatory>
        <key>false</key>
        <master>false</master>
        <readonly>false</readonly>
        <assistant/>
        <layout-hint/>
        <size>50</size>
        <maxlength>255</maxlength>
        <minlength>0</minlength>
    </stringattribute>
</attributegroup>
`;
};

const buildAttributesetContent = (
  label: string,
  functionalId: string,
  attributeGroupLinks: string[],
  version: string | null
): string => {
  const pluginLine = version
    ? [`<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.common.attributes_${version}?>`].join("")
    : "";
  const refs = attributeGroupLinks
    .map(
      (link, index) => `    <attributegroup-ref>
        <id>${createStableId(`attributeset-ref:${functionalId}:${index}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(link)}</link>
        <readonly>false</readonly>
        <attribute-mapping>
            <freeze-contents>false</freeze-contents>
            <rows/>
            <order/>
            <deleted-rows/>
        </attribute-mapping>
    </attributegroup-ref>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>${pluginLine}<attributeset>
    <label>${xmlEscape(label)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
${refs}
    <functional-id>${xmlEscape(functionalId)}</functional-id>
    <repeatable>false</repeatable>
    <repeat-number/>
    <optional>false</optional>
</attributeset>
`;
};

const buildHandlerGroupContent = (
  operationName: string,
  requestLink: string,
  version: string | null
): string => {
  const plugins = version
    ? [
        `<?plugin nl.beinformed.bi.services.core_${version}?>`,
        `<?plugin nl.beinformed.bi.framework.remoting.connector_${version}?>`,
        `<?plugin nl.beinformed.bi.common.attributes_${version}?>`,
        `<?plugin nl.beinformed.bi.casemanagement_${version}?>`,
      ].join("")
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<handler-group>
    <label>Call ${xmlEscape(operationName)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <attributeset-input-role>
        <id>${createStableId(`input-role:${operationName}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <attributeset-ref>
            <id>${createStableId(`request-ref:${operationName}`)}</id>
            <permissions/>
            <default-allowed>true</default-allowed>
            <link>${xmlEscape(requestLink)}</link>
        </attributeset-ref>
    </attributeset-input-role>
    <functionality xml:space="preserve">Generated interface operation skeleton for ${xmlEscape(operationName)}</functionality>
</handler-group>
`;
};

const buildEventContent = (
  operationName: string,
  requestLink: string,
  executeLink: string,
  version: string | null
): string => {
  const plugins = version
    ? [
        `<?plugin nl.beinformed.bi.core.configuration_${version}?>`,
        `<?plugin nl.beinformed.bi.common.attributes_${version}?>`,
        `<?plugin nl.beinformed.bi.casemanagement_${version}?>`,
      ].join("")
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<event>
    <label>${xmlEscape(operationName)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>${xmlEscape(operationName)}</functional-id>
    <store-type>noEventLogging</store-type>
    <attributeset-input-role>
        <id>${createStableId(`event-input:${operationName}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <attributeset-ref>
            <id>${createStableId(`event-input-ref:${operationName}`)}</id>
            <permissions/>
            <default-allowed>true</default-allowed>
            <link>${xmlEscape(requestLink)}</link>
        </attributeset-ref>
    </attributeset-input-role>
    <store-handlers>
        <id>${createStableId(`store-handlers:${operationName}`)}</id>
        <label/>
        <permissions/>
        <default-allowed>true</default-allowed>
        <execute-handler-group-handler>
            <id>${createStableId(`execute-handler:${operationName}`)}</id>
            <label>Execute ${xmlEscape(operationName)}</label>
            <permissions/>
            <default-allowed>true</default-allowed>
            <handler-group-link>${xmlEscape(executeLink)}</handler-group-link>
        </execute-handler-group-handler>
    </store-handlers>
</event>
`;
};

const buildServiceOperationEntry = (
  operationName: string,
  eventLink: string,
  responseLink: string | null
): string => {
  const responseNode = responseLink
    ? `
        <event-operation-response-node>
            <id>${createStableId(`service-response:${operationName}`)}</id>
            <label>Response</label>
            <permissions/>
            <default-allowed>true</default-allowed>
            <custom-response-object-attribute-set-ref>
                <id>${createStableId(`service-response-ref:${operationName}`)}</id>
                <permissions/>
                <default-allowed>true</default-allowed>
                <link>${xmlEscape(responseLink)}</link>
            </custom-response-object-attribute-set-ref>
            <use-result-definition-from-event>false</use-result-definition-from-event>
            <attachment-style>Inline</attachment-style>
            <include-eventid-caseid>true</include-eventid-caseid>
        </event-operation-response-node>`
    : "";

  return `
    <event-operation>
        <id>${createStableId(`service-operation:${operationName}`)}</id>
        <label>${xmlEscape(operationName)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <event-type-link>${xmlEscape(eventLink)}</event-type-link>
        <event-operation-request-node>
            <id>${createStableId(`service-request:${operationName}`)}</id>
            <label>Request</label>
            <permissions/>
            <default-allowed>true</default-allowed>
            <use-input-definition-from-event>true</use-input-definition-from-event>
            <validate-dataset>false</validate-dataset>
        </event-operation-request-node>${responseNode}
    </event-operation>`;
};

const normalizeOperationName = (operationName: string): string => {
  const trimmed = operationName.trim();
  if (!trimmed) {
    throw new Error("Operation name is required.");
  }
  return trimmed;
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const writeFileIfMissing = async (outputPath: string, content: string): Promise<boolean> => {
  if (await pathExists(outputPath)) {
    return false;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  return true;
};

const extractProjectNameFromRepoLink = (link: string): string | null => {
  const normalized = String(link || "").trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const withoutFragment = normalized.split("#")[0];
  const parts = withoutFragment.split("/").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return parts[0] || null;
};

const resolveRepoLinkPath = (model: RepositoryModel, link: string): string | null => {
  const normalized = String(link || "").trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const withoutFragment = normalized.split("#")[0];
  const relativePath = withoutFragment.replace(/^\/+/, "").replace(/\//g, path.sep);
  return path.resolve(model.repositoryPath, relativePath);
};

const findArtifactByRepoLink = (model: RepositoryModel, link: string): ArtifactNode | null => {
  const resolved = resolveRepoLinkPath(model, link);
  if (!resolved) {
    return null;
  }
  const relativePath = path.relative(model.repositoryPath, resolved);
  return model.artifactIndex.find((artifact) => path.normalize(artifact.path) === path.normalize(relativePath)) || null;
};

const normalizeRepoLink = (link: string): string => {
  const normalized = String(link || "").trim();
  if (!normalized) {
    return normalized;
  }
  const [basePath, fragment] = normalized.split("#");
  const normalizedBasePath = basePath.startsWith("/")
    ? `/${basePath.replace(/^\/+/, "").replace(/\\/g, "/")}`
    : `/${basePath.replace(/^\/+/, "").replace(/\\/g, "/")}`;
  return fragment ? `${normalizedBasePath}#${fragment}` : normalizedBasePath;
};

const repoLinksEqual = (left: string | null | undefined, right: string | null | undefined): boolean => {
  if (!left || !right) {
    return false;
  }
  return normalizeRepoLink(left) === normalizeRepoLink(right);
};

const repoLinkExists = async (model: RepositoryModel, link: string): Promise<boolean> => {
  const resolved = resolveRepoLinkPath(model, link);
  return resolved ? pathExists(resolved) : false;
};

const ensureRequiredRepoLinkExists = async (model: RepositoryModel, link: string, description: string): Promise<void> => {
  if (!(await repoLinkExists(model, link))) {
    throw new Error(`${description} does not resolve in repository: ${link}`);
  }
};

const ensureRequiredRepoLinkRootElement = async (
  model: RepositoryModel,
  link: string,
  description: string,
  expectedRootElement: string
): Promise<void> => {
  const artifact = findArtifactByRepoLink(model, link);
  if (!artifact) {
    throw new Error(`${description} does not resolve in repository: ${link}`);
  }
  if (artifact.rootElement !== expectedRootElement) {
    throw new Error(
      `${description} must point to a ${expectedRootElement} artifact, but "${link}" resolves to ${artifact.rootElement || "unknown"}.`
    );
  }
};

const ensureProjectDependencies = async (
  model: RepositoryModel,
  project: ProjectNode,
  referencedLinks: string[]
): Promise<string[]> => {
  const requiredProjects = unique(
    referencedLinks
      .map((link) => extractProjectNameFromRepoLink(link))
      .filter((value): value is string => Boolean(value) && value !== project.name)
  ).sort();
  if (requiredProjects.length === 0) {
    return [];
  }

  const projectFilePath = path.join(project.path, ".project");
  const original = await readBoundedText(projectFilePath, 200_000);
  if (!original) {
    return [];
  }

  const existingDependencies = new Set(project.dependencies);
  const missingDependencies = requiredProjects.filter((dependency) => !existingDependencies.has(dependency));
  if (missingDependencies.length === 0) {
    return [];
  }

  const dependencyBlock = missingDependencies.map((dependency) => `\n\t\t<project>${xmlEscape(dependency)}</project>`).join("");
  const patched = original.replace(/<projects>([\s\S]*?)<\/projects>/i, (_match, inner) => `<projects>${inner}${dependencyBlock}\n\t</projects>`);
  await writeFile(projectFilePath, patched, "utf8");
  project.dependencies = unique([...project.dependencies, ...missingDependencies]).sort();
  return [projectFilePath];
};

const ensureProjectExplicitEncoding = async (project: ProjectNode): Promise<string[]> => {
  const settingsDir = path.join(project.path, ".settings");
  const prefsPath = path.join(settingsDir, "org.eclipse.core.resources.prefs");
  const desired = ["eclipse.preferences.version=1", "encoding/.project=UTF-8", "encoding/<project>=UTF-8"].join("\n") + "\n";
  const current = await readBoundedText(prefsPath, 20_000);

  if (current === desired) {
    project.explicitEncoding = "UTF-8";
    project.hasProjectEncodingPreference = true;
    project.hasDotProjectEncodingPreference = true;
    return [];
  }

  await mkdir(settingsDir, { recursive: true });
  await writeFile(prefsPath, desired, "utf8");
  project.explicitEncoding = "UTF-8";
  project.hasProjectEncodingPreference = true;
  project.hasDotProjectEncodingPreference = true;
  return [prefsPath];
};

const ensureUriPartAvailable = async (model: RepositoryModel, uriPart: string): Promise<void> => {
  const normalized = uriPart.trim().toLowerCase();
  if (!normalized) {
    throw new Error("URI part is required.");
  }

  for (const artifact of model.artifactIndex) {
    const absolutePath = path.resolve(model.repositoryPath, artifact.path);
    const xmlText = await readBoundedText(absolutePath, 300_000);
    if (!xmlText) {
      continue;
    }
    if (xmlText.toLowerCase().includes(`<uri-part>${normalized}</uri-part>`)) {
      throw new Error(`URI part is already used in repository: ${uriPart} (${artifact.path})`);
    }
  }
};

type PortalTemplate = {
  webApplicationPermissionsBlock: string;
  webApplicationDefaultAllowed: string;
  webApplicationUserProvider: string;
  webApplicationLoginMandatory: boolean;
  webApplicationLoginPanelBlock: string;
  tabPermissionsBlock: string;
  tabDefaultAllowed: string;
  tabSecure: boolean;
  tabLayoutHintBlock: string;
  tabCaseSearchActivated: string;
};

const buildDefaultPortalTemplate = (): PortalTemplate => ({
  webApplicationPermissionsBlock: "<permissions/>",
  webApplicationDefaultAllowed: "true",
  webApplicationUserProvider: "/SC Library/Users and organizations/All users.bixml",
  webApplicationLoginMandatory: false,
  webApplicationLoginPanelBlock: "",
  tabPermissionsBlock: "<permissions/>",
  tabDefaultAllowed: "true",
  tabSecure: false,
  tabLayoutHintBlock: "",
  tabCaseSearchActivated: "false",
});

const derivePortalTemplate = async (model: RepositoryModel, projectName: string): Promise<PortalTemplate> => {
  const template = buildDefaultPortalTemplate();
  const artifacts = model.artifactIndex.filter((artifact) => artifact.project === projectName);
  const webApplicationArtifact = artifacts.find((artifact) => artifact.rootElement === "webapplication");
  const tabArtifact = artifacts.find((artifact) => artifact.rootElement === "tab");

  if (webApplicationArtifact) {
    const webApplicationXml = await readBoundedText(path.resolve(model.repositoryPath, webApplicationArtifact.path), 500_000);
    if (webApplicationXml) {
      template.webApplicationPermissionsBlock =
        extractTopLevelBlock(webApplicationXml, "permissions") || template.webApplicationPermissionsBlock;
      const defaultAllowedValue = extractTopLevelValue(webApplicationXml, "default-allowed");
      if (defaultAllowedValue !== null) {
        template.webApplicationDefaultAllowed = defaultAllowedValue.trim();
      }
      const userProviderValue = extractTopLevelValue(webApplicationXml, "user-provider");
      if (userProviderValue !== null) {
        template.webApplicationUserProvider = userProviderValue.trim();
      }
      const loginMandatoryValue = extractTopLevelValue(webApplicationXml, "login-mandatory");
      if (loginMandatoryValue !== null) {
        template.webApplicationLoginMandatory = loginMandatoryValue.trim().toLowerCase() === "true";
      }
      template.webApplicationLoginPanelBlock =
        extractTopLevelBlock(webApplicationXml, "login-panel") || template.webApplicationLoginPanelBlock;
    }
  }

  if (tabArtifact) {
    const tabXml = await readBoundedText(path.resolve(model.repositoryPath, tabArtifact.path), 500_000);
    if (tabXml) {
      template.tabPermissionsBlock = extractTopLevelBlock(tabXml, "permissions") || template.tabPermissionsBlock;
      const defaultAllowedValue = extractTopLevelValue(tabXml, "default-allowed");
      if (defaultAllowedValue !== null) {
        template.tabDefaultAllowed = defaultAllowedValue.trim();
      }
      const secureValue = extractTopLevelValue(tabXml, "secure");
      if (secureValue !== null) {
        template.tabSecure = secureValue.trim().toLowerCase() === "true";
      }
      const layoutHintValue = extractTopLevelValue(tabXml, "layout-hint");
      if (layoutHintValue !== null) {
        template.tabLayoutHintBlock = `    <layout-hint>${xmlEscape(layoutHintValue)}</layout-hint>\n`;
      }
      const caseSearchActivatedValue = extractTopLevelValue(tabXml, "case-search-activated");
      if (caseSearchActivatedValue !== null) {
        template.tabCaseSearchActivated = caseSearchActivatedValue.trim();
      }
    }
  }

  return template;
};

const appendTabRefToWebApplicationContent = (
  xmlText: string,
  applicationName: string,
  tabName: string,
  tabLink: string,
  tabUriPart: string
): string | null => {
  if (xmlText.includes(`<link>${tabLink}</link>`) || xmlText.includes(`<uri-part>${tabUriPart}</uri-part>`)) {
    return null;
  }

  const tabRefBlock = `
    <tab-ref>
        <id>${createStableId(`webapp-tab:${applicationName}:${tabUriPart}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(tabLink)}</link>
        <uri-part>${xmlEscape(tabUriPart)}</uri-part>
    </tab-ref>`;

  if (/<user-provider>[\s\S]*?<\/user-provider>/i.test(xmlText)) {
    return xmlText.replace(/(\s*<user-provider>[\s\S]*?<\/user-provider>)/i, `${tabRefBlock}$1`);
  }

  if (/\s*<\/webapplication>\s*$/i.test(xmlText)) {
    return xmlText.replace(/\s*<\/webapplication>\s*$/i, `${tabRefBlock}\n</webapplication>\n`);
  }

  return null;
};

export const createCaseFormWorkflow = async (
  repoPath: string,
  projectName: string,
  formNameInput: string,
  questionLabelsInput: string[],
  options: CreateCaseFormWorkflowOptions = {}
): Promise<CreatedCaseFormWorkflowResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 3000 });
  const project = model.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }
  if (project.role !== "domain_core" && project.role !== "dsc_core" && project.role !== "specific" && project.role !== "dsc_specific") {
    throw new Error(`Project is not a supported case-workflow project: ${projectName}`);
  }

  const formName = normalizeOperationName(formNameInput);
  const questionLabels = normalizeQuestionLabels(questionLabelsInput);
  const version =
    project.versionHints[0] ||
    model.dominantVersionProfile?.version ||
    model.studioConfigs.find((config) => typeof config.version === "string")?.version ||
    null;
  const projectRoot = path.resolve(project.path);
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(project)));
  const formArtifacts = model.artifactIndex.filter(
    (artifact) =>
      artifact.project === project.name &&
      artifact.rootElement === "form" &&
      artifact.path.includes(`${project.name}${path.sep}Behavior${path.sep}_Case${path.sep}Forms`)
  );
  const eventArtifacts = model.artifactIndex.filter(
    (artifact) =>
      artifact.project === project.name &&
      artifact.rootElement === "event" &&
      artifact.path.includes(`${project.name}${path.sep}Behavior${path.sep}_Case${path.sep}Events`)
  );
  const inferredFormTemplate =
    options.templateForm
      ? formArtifacts.find((artifact) => artifact.label === options.templateForm || path.basename(artifact.path, ".bixml") === options.templateForm)
      : formArtifacts.find((artifact) => {
          const formVerb = formName.split(/\s+/)[0]?.toLowerCase();
          return artifact.label?.toLowerCase().startsWith(formVerb) || path.basename(artifact.path, ".bixml").toLowerCase().startsWith(formVerb);
        }) || formArtifacts[0];
  const inferredEventTemplate =
    options.templateEvent
      ? eventArtifacts.find((artifact) => artifact.label === options.templateEvent || path.basename(artifact.path, ".bixml") === options.templateEvent)
      : eventArtifacts.find((artifact) => {
          const formVerb = formName.split(/\s+/)[0]?.toLowerCase();
          return artifact.label?.toLowerCase().startsWith(formVerb) || path.basename(artifact.path, ".bixml").toLowerCase().startsWith(formVerb);
        }) || eventArtifacts[0];
  const template = await deriveCaseWorkflowTemplate(
    model.repositoryPath,
    projectRoot,
    inferredFormTemplate?.path || null,
    inferredEventTemplate?.path || null
  );
  if (inferredFormTemplate) {
    warnings.push(`Using form template: ${inferredFormTemplate.path}`);
  }
  if (inferredEventTemplate) {
    warnings.push(`Using event template: ${inferredEventTemplate.path}`);
  }

  const caseAttributeCatalogDir = path.join(projectRoot, "Behavior", "_Case", "Data", "Attribute groups", "Attributes");
  const requestParametersAttributePath = path.join(caseAttributeCatalogDir, "Request context.bixml");
  const requestParametersAttributeLink = `/${path
    .relative(model.repositoryPath, requestParametersAttributePath)
    .replace(/\\/g, "/")}`;
  const requestParametersAttributesetPath = path.join(
    projectRoot,
    "Behavior",
    "_Case",
    "Data",
    "Attribute sets",
    "System",
    "Request parameters.bixml"
  );
  const requestParametersAttributesetLink = `/${path
    .relative(model.repositoryPath, requestParametersAttributesetPath)
    .replace(/\\/g, "/")}`;
  const requestParametersRefId = createStableId(`case-request-parameters:${formName}`);

  const questionDefinitions: CaseFormQuestionDefinition[] = questionLabels.map((label) => {
    const questionFileName = toBixmlFileName(label);
    const filePath = path.join(projectRoot, "Behavior", "_Case", "Data", "Attribute sets", questionFileName);
    const attributeGroupFilePath = path.join(caseAttributeCatalogDir, toBixmlFileName(`${label} value`));
    const link = `/${path.relative(model.repositoryPath, filePath).replace(/\\/g, "/")}`;
    const attributeGroupLink = `/${path.relative(model.repositoryPath, attributeGroupFilePath).replace(/\\/g, "/")}`;
    return {
      label,
      filePath,
      link,
      attributeGroupFilePath,
      attributeGroupLink,
      attributesetRefId: createStableId(`case-question-ref:${formName}:${label}`),
    };
  });

  if (
    await writeFileIfMissing(
      requestParametersAttributePath,
      buildAtomicStringAttributeGroupContent("Request context", "RequestContext", version)
    )
  ) {
    createdFiles.push(requestParametersAttributePath);
  }

  if (
    await writeFileIfMissing(
      requestParametersAttributesetPath,
      buildAttributesetContent("Request parameters", "RequestParameters", [requestParametersAttributeLink], version)
    )
  ) {
    createdFiles.push(requestParametersAttributesetPath);
  }

  for (const question of questionDefinitions) {
    if (
      await writeFileIfMissing(
        question.attributeGroupFilePath,
        buildAtomicStringAttributeGroupContent(
          `${question.label} value`,
          `${toSafeIdentifier(question.label)}Value`,
          version,
          {
            attributeLabel: `${question.label} value`,
            attributeFunctionalId: `${toSafeIdentifier(question.label)}Value`,
          }
        )
      )
    ) {
      createdFiles.push(question.attributeGroupFilePath);
    } else {
      warnings.push(`Question attribute group already exists: ${question.attributeGroupFilePath}`);
    }

    if (
      await writeFileIfMissing(
        question.filePath,
        buildQuestionAttributesetContent(
          question.label,
          toSafeIdentifier(question.label),
          question.attributeGroupLink,
          version
        )
      )
    ) {
      createdFiles.push(question.filePath);
    } else {
      warnings.push(`Question data attributeset already exists: ${question.filePath}`);
    }
  }

  const eventPath = path.join(projectRoot, "Behavior", "_Case", "Events", `${formName}.bixml`);
  const formPath = path.join(projectRoot, "Behavior", "_Case", "Forms", `${formName}.bixml`);
  const eventLink = `/${path.relative(model.repositoryPath, eventPath).replace(/\\/g, "/")}`;

  if (
    await writeFileIfMissing(
      eventPath,
      buildCaseEventContent(
        formName,
        requestParametersRefId,
        requestParametersAttributesetLink,
        questionDefinitions,
        version,
        template
      )
    )
  ) {
    createdFiles.push(eventPath);
  } else {
    warnings.push(`Case event already exists: ${eventPath}`);
  }

  if (
    await writeFileIfMissing(
      formPath,
      buildCaseFormContent(
        formName,
        eventLink,
        requestParametersRefId,
        questionDefinitions,
        version,
        template,
        options.secure
      )
    )
  ) {
    createdFiles.push(formPath);
  } else {
    warnings.push(`Case form already exists: ${formPath}`);
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    formName,
    eventName: formName,
    questionLabels,
    version,
    createdFiles,
    updatedFiles,
    warnings,
  };
};

export const createWebApplicationScaffold = async (
  repoPath: string,
  projectName: string,
  applicationName: string,
  applicationUriPart: string,
  initialTabName: string,
  initialTabUriPart: string,
  options: CreateWebApplicationOptions = {}
): Promise<CreatedWebApplicationResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 4000 });
  const project = model.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }
  if (project.role !== "portal") {
    throw new Error(`Project is not a portal/web application project: ${projectName}`);
  }

  await ensureUriPartAvailable(model, applicationUriPart);
  await ensureUriPartAvailable(model, initialTabUriPart);

  const projectRoot = path.resolve(project.path);
  const version = project.versionHints[0] || model.dominantVersionProfile?.version || null;
  const template = await derivePortalTemplate(model, project.name);
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(project)));

  const tabPath = path.join(projectRoot, "Tabs", `${initialTabName}.bixml`);
  const appPath = path.join(projectRoot, "Web application", `${applicationName}.bixml`);
  const tabLink = `/${path.relative(model.repositoryPath, tabPath).replace(/\\/g, "/")}`;

  if (await writeFileIfMissing(tabPath, buildTabContent(initialTabName, initialTabUriPart, version, {}, template))) {
    createdFiles.push(tabPath);
  } else {
    warnings.push(`Initial tab already exists: ${tabPath}`);
  }

  const userProvider = options.userProvider || template.webApplicationUserProvider;
  await ensureRequiredRepoLinkRootElement(model, userProvider, "Web application user-provider", "database-user-service");
  if (
    await writeFileIfMissing(
      appPath,
      buildWebApplicationContent(
        applicationName,
        applicationUriPart,
        [{ link: tabLink, uriPart: initialTabUriPart }],
        version,
        userProvider,
        options.loginMandatory === undefined ? template.webApplicationLoginMandatory : options.loginMandatory === true,
        template
      )
    )
  ) {
    createdFiles.push(appPath);
  } else {
    warnings.push(`Web application already exists: ${appPath}`);
  }

  updatedFiles.push(...(await ensureProjectDependencies(model, project, [userProvider])));

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    applicationName,
    uriPart: applicationUriPart,
    createdFiles,
    updatedFiles,
    warnings,
  };
};

export const createPortalTab = async (
  repoPath: string,
  projectName: string,
  tabName: string,
  tabUriPart: string,
  options: CreateTabOptions = {}
): Promise<CreatedWebApplicationResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 4000 });
  const project = model.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }
  if (project.role !== "portal") {
    throw new Error(`Project is not a portal/web application project: ${projectName}`);
  }

  await ensureUriPartAvailable(model, tabUriPart);
  const projectRoot = path.resolve(project.path);
  const version = project.versionHints[0] || model.dominantVersionProfile?.version || null;
  const template = await derivePortalTemplate(model, project.name);
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(project)));
  const tabPath = path.join(projectRoot, "Tabs", `${tabName}.bixml`);
  const tabLink = `/${path.relative(model.repositoryPath, tabPath).replace(/\\/g, "/")}`;
  const validatedDatastoreListLinks: Array<{ link: string; uriPart: string }> = [];
  const validatedCaseViewLinks: Array<{ link: string; uriPart: string }> = [];
  const validatedFormTasks: Array<{ link: string; label: string; uriPart: string }> = [];

  for (const item of options.datastoreListLinks || []) {
    if (await repoLinkExists(model, item.link)) {
      validatedDatastoreListLinks.push(item);
    } else {
      warnings.push(`Skipped unresolved datastore list link: ${item.link}`);
    }
  }
  for (const item of options.caseViewLinks || options.caseListLinks || []) {
    const targetArtifact = findArtifactByRepoLink(model, item.link);
    if (targetArtifact && targetArtifact.rootElement === "case-view") {
      validatedCaseViewLinks.push(item);
    } else if (targetArtifact) {
      warnings.push(`Skipped non-case-view link for case-view-ref: ${item.link} (${targetArtifact.rootElement || "unknown"})`);
    } else {
      warnings.push(`Skipped unresolved case view link: ${item.link}`);
    }
  }
  for (const item of options.formTasks || []) {
    if (await repoLinkExists(model, item.link)) {
      validatedFormTasks.push(item);
    } else {
      warnings.push(`Skipped unresolved form task link: ${item.link}`);
    }
  }

  if (
    await writeFileIfMissing(
      tabPath,
      buildTabContent(
        tabName,
        tabUriPart,
        version,
        {
          ...options,
          datastoreListLinks: validatedDatastoreListLinks,
          caseViewLinks: validatedCaseViewLinks,
          caseListLinks: [],
          formTasks: validatedFormTasks,
        },
        template
      )
    )
  ) {
    createdFiles.push(tabPath);
  } else {
    warnings.push(`Tab already exists: ${tabPath}`);
  }

  if (options.webApplication) {
    const webApplicationArtifact = model.artifactIndex.find(
      (artifact) =>
        artifact.project === project.name &&
        artifact.rootElement === "webapplication" &&
        (artifact.label === options.webApplication || path.basename(artifact.path, ".bixml") === options.webApplication)
    );
    if (!webApplicationArtifact) {
      warnings.push(`Web application not found for tab registration: ${options.webApplication}`);
    } else {
      const webApplicationPath = path.resolve(model.repositoryPath, webApplicationArtifact.path);
      const webApplicationXml = await readBoundedText(webApplicationPath, 500_000);
      if (!webApplicationXml) {
        warnings.push(`Could not read web application file: ${webApplicationArtifact.path}`);
      } else {
        const patched = appendTabRefToWebApplicationContent(
          webApplicationXml,
          webApplicationArtifact.label || path.basename(webApplicationArtifact.path, ".bixml"),
          tabName,
          tabLink,
          tabUriPart
        );
        if (!patched) {
          warnings.push(`Web application already contains tab or could not be patched: ${webApplicationArtifact.path}`);
        } else {
          await writeFile(webApplicationPath, patched, "utf8");
          updatedFiles.push(webApplicationPath);
        }
      }
    }
  }

  updatedFiles.push(
    ...(await ensureProjectDependencies(
      model,
      project,
      [
        ...validatedDatastoreListLinks.map((item) => item.link),
        ...validatedCaseViewLinks.map((item) => item.link),
        ...validatedFormTasks.map((item) => item.link),
      ]
    ))
  );

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    applicationName: tabName,
    uriPart: tabUriPart,
    createdFiles,
    updatedFiles,
    warnings,
  };
};

export const createCaseList = async (
  repoPath: string,
  projectName: string,
  listName: string,
  uriPart: string,
  recordTypeLink: string,
  options: CreateCaseListOptions = {}
): Promise<CreatedListResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 4000 });
  const project = model.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }

  await ensureRequiredRepoLinkExists(model, recordTypeLink, "Case list record-type-link");
  if (options.createFormLink) {
    await ensureRequiredRepoLinkExists(model, options.createFormLink, "Case list create-form-link");
  }
  if (options.updateFormLink) {
    await ensureRequiredRepoLinkExists(model, options.updateFormLink, "Case list update-form-link");
  }

  await ensureUriPartAvailable(model, uriPart);
  const projectRoot = path.resolve(project.path);
  const version = project.versionHints[0] || model.dominantVersionProfile?.version || null;
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(project)));
  const listPath = path.join(projectRoot, "Lists", `${listName}.bixml`);

  if (await writeFileIfMissing(listPath, buildCaseListContent(listName, uriPart, recordTypeLink, version, options))) {
    createdFiles.push(listPath);
  } else {
    warnings.push(`Case list already exists: ${listPath}`);
  }

  updatedFiles.push(
    ...(await ensureProjectDependencies(model, project, [recordTypeLink, options.createFormLink || "", options.updateFormLink || ""]))
  );

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    listName,
    uriPart,
    listType: "case-list2",
    createdFiles,
    updatedFiles,
    warnings,
  };
};

export const createDatastoreList = async (
  repoPath: string,
  projectName: string,
  listName: string,
  uriPart: string,
  datastoreLink: string,
  options: CreateDatastoreListOptions = {}
): Promise<CreatedListResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 4000 });
  const project = model.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }

  await ensureRequiredRepoLinkRootElement(model, datastoreLink, "Datastore list datastore-link", "datastore");
  if (options.createFormLink) {
    await ensureRequiredRepoLinkExists(model, options.createFormLink, "Datastore list create-form-link");
  }
  if (options.caseContextAttributeLink) {
    await ensureRequiredRepoLinkRootElement(
      model,
      options.caseContextAttributeLink,
      "Datastore list case-context-attribute-link",
      "datastore"
    );
  }

  await ensureUriPartAvailable(model, uriPart);
  const projectRoot = path.resolve(project.path);
  const version = project.versionHints[0] || model.dominantVersionProfile?.version || null;
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(project)));
  const listPath = path.join(projectRoot, "Lists", `${listName}.bixml`);

  if (
    await writeFileIfMissing(
      listPath,
      buildDatastoreListContent(listName, uriPart, datastoreLink, version, options)
    )
  ) {
    createdFiles.push(listPath);
  } else {
    warnings.push(`Datastore list already exists: ${listPath}`);
  }

  updatedFiles.push(
    ...(await ensureProjectDependencies(
      model,
      project,
      [datastoreLink, options.createFormLink || "", options.caseContextAttributeLink || ""]
    ))
  );

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: project.name,
    listName,
    uriPart,
    listType: "datastore-list",
    createdFiles,
    updatedFiles,
    warnings,
  };
};

const toUriPart = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "generated-form";

const normalizeQuestionLabels = (questionLabels: string[]): string[] => {
  const normalized = questionLabels.map((label) => label.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one question label is required.");
  }
  return normalized;
};

const buildQuestionAttributesetContent = (
  label: string,
  functionalId: string,
  attributeGroupLink: string,
  version: string | null
): string =>
  buildAttributesetContent(label, functionalId, [attributeGroupLink], version);

type CaseWorkflowTemplate = {
  formPermissionsBlock: string;
  formLayoutHintBlock: string;
  formDefaultAllowed: string;
  formSecure: boolean;
  formQuestionSequence: Array<
    | {
        kind: "eventquestion";
        block: string;
      }
    | {
        kind: "static";
        block: string;
      }
  >;
  eventStoreType: string;
  eventInitHandlersBlock: string;
  eventStoreHandlersBlock: string;
};

const buildDefaultCaseWorkflowTemplate = (): CaseWorkflowTemplate => ({
  formPermissionsBlock: "<permissions/>",
  formLayoutHintBlock: "",
  formDefaultAllowed: "true",
  formSecure: false,
  formQuestionSequence: [],
  eventStoreType: "normal",
  eventInitHandlersBlock: `    <init-handlers>
        <id>init_handlers</id>
        <label>Init handlers</label>
        <permissions/>
        <default-allowed>true</default-allowed>
    </init-handlers>`,
  eventStoreHandlersBlock: `    <store-handlers>
        <id>store_handlers</id>
        <label>Store handlers</label>
        <permissions/>
        <default-allowed>true</default-allowed>
    </store-handlers>`,
});

const deriveCaseWorkflowTemplate = async (
  repoPath: string,
  projectRoot: string,
  formTemplateRelativePath: string | null,
  eventTemplateRelativePath: string | null
): Promise<CaseWorkflowTemplate> => {
  const template = buildDefaultCaseWorkflowTemplate();

  if (formTemplateRelativePath) {
    const formTemplatePath = path.resolve(repoPath, formTemplateRelativePath);
    const formXml = await readBoundedText(formTemplatePath, 400_000);
    if (formXml) {
      template.formPermissionsBlock = extractTopLevelBlock(formXml, "permissions") || template.formPermissionsBlock;
      const layoutHintValue = extractTopLevelValue(formXml, "layout-hint");
      if (layoutHintValue !== null) {
        template.formLayoutHintBlock = `    <layout-hint>${xmlEscape(layoutHintValue)}</layout-hint>\n`;
      }
      const secureValue = extractTopLevelValue(formXml, "secure");
      if (secureValue !== null) {
        template.formSecure = secureValue.trim().toLowerCase() === "true";
      }
      const defaultAllowedValue = extractTopLevelValue(formXml, "default-allowed");
      if (defaultAllowedValue !== null) {
        template.formDefaultAllowed = defaultAllowedValue.trim();
      }
      const questionsAndHandlersBlock = extractTopLevelBlock(formXml, "questionsAndHandlers");
      if (questionsAndHandlersBlock) {
        template.formQuestionSequence = splitTopLevelXmlChildren(extractBlockInnerXml(questionsAndHandlersBlock)).map(
          (child) =>
            child.startsWith("<eventquestion")
              ? { kind: "eventquestion", block: child }
              : { kind: "static", block: child }
        );
      }
    }
  }

  if (eventTemplateRelativePath) {
    const eventTemplatePath = path.resolve(repoPath, eventTemplateRelativePath);
    const eventXml = await readBoundedText(eventTemplatePath, 800_000);
    if (eventXml) {
      const storeType = extractTopLevelValue(eventXml, "store-type");
      if (storeType !== null) {
        template.eventStoreType = storeType.trim();
      }
      template.eventInitHandlersBlock = extractTopLevelBlock(eventXml, "init-handlers") || template.eventInitHandlersBlock;
      template.eventStoreHandlersBlock =
        extractTopLevelBlock(eventXml, "store-handlers") || template.eventStoreHandlersBlock;
    }
  }

  void projectRoot;
  return template;
};

type CaseFormQuestionDefinition = {
  label: string;
  filePath: string;
  link: string;
  attributeGroupFilePath: string;
  attributeGroupLink: string;
  attributesetRefId: string;
};

const buildCaseEventContent = (
  formName: string,
  requestParametersRefId: string,
  requestParametersLink: string,
  questionDefinitions: CaseFormQuestionDefinition[],
  version: string | null,
  template: CaseWorkflowTemplate
): string => {
  const plugins = version
    ? [
        `<?plugin nl.beinformed.bi.core.configuration_${version}?>`,
        `<?plugin nl.beinformed.bi.common.attributes_${version}?>`,
        `<?plugin nl.beinformed.bi.casemanagement_${version}?>`,
      ].join("")
    : "";

  const questionRefs = questionDefinitions
    .map(
      (question) => `        <attributeset-ref>
            <id>${question.attributesetRefId}</id>
            <permissions/>
            <default-allowed>true</default-allowed>
            <link>${xmlEscape(question.link)}</link>
        </attributeset-ref>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<event>
    <label>${xmlEscape(formName)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>${xmlEscape(toSafeIdentifier(formName))}</functional-id>
    <store-type>${xmlEscape(template.eventStoreType)}</store-type>
    <attributeset-input-role>
        <id>${createStableId(`case-event-input:${formName}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
${questionRefs}
        <attributeset-ref>
            <id>${requestParametersRefId}</id>
            <permissions/>
            <default-allowed>true</default-allowed>
            <link>${xmlEscape(requestParametersLink)}</link>
        </attributeset-ref>
    </attributeset-input-role>
${template.eventInitHandlersBlock}
${template.eventStoreHandlersBlock}
</event>
`;
};

const buildCaseFormContent = (
  formName: string,
  eventLink: string,
  requestParametersRefId: string,
  questionDefinitions: CaseFormQuestionDefinition[],
  version: string | null,
  template: CaseWorkflowTemplate,
  secureOverride?: boolean
): string => {
  const plugins = version
    ? [
        `<?plugin nl.beinformed.bi.knowledge_${version}?>`,
        `<?plugin nl.beinformed.bi.core.configuration_${version}?>`,
        `<?plugin nl.beinformed.bi.common.attributes_${version}?>`,
        `<?plugin nl.beinformed.bi.casemanagement_${version}?>`,
      ].join("")
    : "";

  const defaultQuestionBlock = (question: CaseFormQuestionDefinition, index: number): string => `        <eventquestion>
            <id>${createStableId(`case-form-question:${formName}:${question.label}`)}</id>
            <label>${xmlEscape(question.label)}</label>
            <permissions/>
            <default-allowed>true</default-allowed>
            <finishButtonLabel>${index === questionDefinitions.length - 1 ? "Submit" : "Continue"}</finishButtonLabel>
            <questionHandlers/>
            <assistant/>
            <attribute-set-type-link>${xmlEscape(`${eventLink}#${question.attributesetRefId}`)}</attribute-set-type-link>
        </eventquestion>`;

  const applyEventQuestionTemplate = (
    block: string,
    question: CaseFormQuestionDefinition,
    index: number
  ): string =>
    block
      .replace(/<id>[\s\S]*?<\/id>/i, `<id>${createStableId(`case-form-question:${formName}:${question.label}`)}</id>`)
      .replace(/<label>[\s\S]*?<\/label>/i, `<label>${xmlEscape(question.label)}</label>`)
      .replace(
        /<attribute-set-type-link>[\s\S]*?<\/attribute-set-type-link>/i,
        `<attribute-set-type-link>${xmlEscape(`${eventLink}#${question.attributesetRefId}`)}</attribute-set-type-link>`
      )
      .replace(
        /<finishButtonLabel>[\s\S]*?<\/finishButtonLabel>/i,
        `<finishButtonLabel>${index === questionDefinitions.length - 1 ? "Submit" : "Continue"}</finishButtonLabel>`
      );

  const templateQuestionBlocks = template.formQuestionSequence.filter((item) => item.kind === "eventquestion");
  const renderedSequence: string[] = [];
  let questionIndex = 0;

  if (template.formQuestionSequence.length > 0) {
    for (const item of template.formQuestionSequence) {
      if (item.kind === "static") {
        renderedSequence.push(`        ${item.block}`);
        continue;
      }
      if (questionIndex >= questionDefinitions.length) {
        continue;
      }
      renderedSequence.push(
        `        ${applyEventQuestionTemplate(item.block, questionDefinitions[questionIndex], questionIndex)}`
      );
      questionIndex += 1;
    }
  }

  while (questionIndex < questionDefinitions.length) {
    const templateBlock =
      templateQuestionBlocks[Math.min(questionIndex, Math.max(templateQuestionBlocks.length - 1, 0))];
    renderedSequence.push(
      `        ${
        templateBlock
          ? applyEventQuestionTemplate(templateBlock.block, questionDefinitions[questionIndex], questionIndex)
          : defaultQuestionBlock(questionDefinitions[questionIndex], questionIndex)
      }`
    );
    questionIndex += 1;
  }

  const questionBlocks = renderedSequence.join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<form>
    <label>${xmlEscape(formName)}</label>
    ${template.formPermissionsBlock}
    <default-allowed>${xmlEscape(template.formDefaultAllowed)}</default-allowed>
    <uri-part>${xmlEscape(toUriPart(formName))}</uri-part>
    <secure>${secureOverride === undefined ? (template.formSecure ? "true" : "false") : secureOverride ? "true" : "false"}</secure>
${template.formLayoutHintBlock}    <eventtypelink>${xmlEscape(eventLink)}</eventtypelink>
    <questionsAndHandlers>
${questionBlocks}
    </questionsAndHandlers>
    <request-parameters>
        <id>${createStableId(`case-form-request-parameters:${formName}`)}</id>
        <label>Request parameters</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <attribute-set-type-link>${xmlEscape(`${eventLink}#${requestParametersRefId}`)}</attribute-set-type-link>
    </request-parameters>
</form>
`;
};

const buildWebApplicationContent = (
  applicationName: string,
  uriPart: string,
  tabLinks: Array<{ link: string; uriPart: string }>,
  version: string | null,
  userProvider: string,
  loginMandatory: boolean,
  template: PortalTemplate
): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.webapplication_${version}?>`, `<?plugin nl.beinformed.bi.casemanagement_${version}?>`].join("")
    : "";
  const tabRefs = tabLinks
    .map(
      (tab) => `    <tab-ref>
        <id>${createStableId(`webapp-tab:${applicationName}:${tab.uriPart}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(tab.link)}</link>
        <uri-part>${xmlEscape(tab.uriPart)}</uri-part>
    </tab-ref>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<webapplication>
    <label>${xmlEscape(applicationName)}</label>
    ${template.webApplicationPermissionsBlock}
    <default-allowed>${xmlEscape(template.webApplicationDefaultAllowed)}</default-allowed>
    <uri-part>${xmlEscape(uriPart)}</uri-part>
${tabRefs}
    <user-provider>${xmlEscape(userProvider)}</user-provider>
    <login-mandatory>${loginMandatory ? "true" : "false"}</login-mandatory>
${template.webApplicationLoginPanelBlock ? `${template.webApplicationLoginPanelBlock}\n` : ""}</webapplication>
`;
};

const buildTabContent = (
  tabName: string,
  uriPart: string,
  version: string | null,
  options: CreateTabOptions = {},
  template = buildDefaultPortalTemplate()
): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.knowledge_${version}?>`, `<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.casemanagement_${version}?>`].join("")
    : "";
  const layoutHintBlock =
    options.layoutHint !== undefined && options.layoutHint
      ? `    <layout-hint>${xmlEscape(options.layoutHint)}</layout-hint>\n`
      : "";
  const datastorePanels = (options.datastoreListLinks || [])
    .map(
      (item) => `    <datastore-list-panel-ref>
        <id>${createStableId(`tab-datastore-list:${tabName}:${item.uriPart}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <uri-part-of-reference>${xmlEscape(item.uriPart)}</uri-part-of-reference>
        <link>${xmlEscape(item.link)}</link>
    </datastore-list-panel-ref>`
    )
    .join("\n");
  const caseViews = ((options.caseViewLinks && options.caseViewLinks.length > 0)
    ? options.caseViewLinks
    : options.caseListLinks || [])
    .map(
      (item) => `    <case-view-ref>
        <id>${createStableId(`tab-case-view:${tabName}:${item.uriPart}`)}</id>
        <permissions/>
        <default-allowed>true</default-allowed>
        <uri-part>${xmlEscape(item.uriPart)}</uri-part>
        <secure>false</secure>
        <link>${xmlEscape(item.link)}</link>
    </case-view-ref>`
    )
    .join("\n");
  const formRefs = (options.formTasks || [])
    .map(
      (item) => `        <form-ref>
            <id>${createStableId(`tab-task-form:${tabName}:${item.uriPart}`)}</id>
            <permissions/>
            <default-allowed>true</default-allowed>
            <uri-part>${xmlEscape(item.uriPart)}</uri-part>
            <secure>false</secure>
            <link>${xmlEscape(item.link)}</link>
            <task-label>${xmlEscape(item.label)}</task-label>
        </form-ref>`
    )
    .join("\n");
  const taskGroupBlock = formRefs
    ? `    <taskgroup>
        <id>${createStableId(`tab-taskgroup:${tabName}`)}</id>
        <label>${xmlEscape(`${tabName} tasks`)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <layout-hint/>
        <uri-part>${xmlEscape(`${toUriPart(tabName)}-tasks`)}</uri-part>
${formRefs}
    </taskgroup>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<tab>
    <label>${xmlEscape(tabName)}</label>
    ${template.tabPermissionsBlock}
    <default-allowed>${xmlEscape(template.tabDefaultAllowed)}</default-allowed>
    <uri-part>${xmlEscape(uriPart)}</uri-part>
    <secure>${options.secure === undefined ? (template.tabSecure ? "true" : "false") : options.secure ? "true" : "false"}</secure>
${layoutHintBlock}${caseViews}${caseViews && datastorePanels ? "\n" : ""}${datastorePanels}${(caseViews || datastorePanels) && taskGroupBlock ? "\n" : ""}${taskGroupBlock}
    <case-search-activated>${xmlEscape(template.tabCaseSearchActivated)}</case-search-activated>
</tab>
`;
};

const buildCaseListContent = (
  listName: string,
  uriPart: string,
  recordTypeLink: string,
  version: string | null,
  options: CreateCaseListOptions = {}
): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.knowledge_${version}?>`, `<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.common.panels_${version}?>`, `<?plugin nl.beinformed.bi.casemanagement_${version}?>`].join("")
    : "";
  const createTask = options.createFormLink
    ? `    <create-case-task>
        <id>${createStableId(`case-list-create:${listName}`)}</id>
        <label>${xmlEscape(`Create ${listName}`)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(options.createFormLink)}</link>
        <uri-part>${xmlEscape(`create-${uriPart}`)}</uri-part>
        <secure>false</secure>
        <provide-context-to-form>ID_AND_CASE</provide-context-to-form>
        <caseTypeLink>${xmlEscape(recordTypeLink)}</caseTypeLink>
    </create-case-task>`
    : "";
  const updateTask = options.updateFormLink
    ? `    <update-case-task>
        <id>${createStableId(`case-list-update:${listName}`)}</id>
        <label>${xmlEscape(`Edit ${listName}`)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(options.updateFormLink)}</link>
        <uri-part>${xmlEscape(`edit-${uriPart}`)}</uri-part>
        <secure>false</secure>
        <provide-context-to-form>ID_AND_CASE</provide-context-to-form>
        <caseTypeLink>${xmlEscape(recordTypeLink)}</caseTypeLink>
    </update-case-task>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<case-list2>
    <label>${xmlEscape(listName)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <uri-part>${xmlEscape(uriPart)}</uri-part>
    <layout-hint>translate=CaseName</layout-hint>
    <paging-enabled>true</paging-enabled>
    <page-size>25</page-size>
    <custom-page-size-enabled>true</custom-page-size-enabled>
    <custom-page-sizes>10,25,50</custom-page-sizes>
    <count-enabled>true</count-enabled>
    <result-limit>0</result-limit>
${createTask}${createTask && updateTask ? "\n" : ""}${updateTask}
    <list-attributes>
        <attribute>
            <list-attribute-id>CaseName</list-attribute-id>
            <visible>true</visible>
            <visible-in-detail>true</visible-in-detail>
            <end-user-sortable>true</end-user-sortable>
            <layout-hint/>
            <children/>
        </attribute>
    </list-attributes>
    <initial-sorting>
        <attribute-config>
            <list-attribute-id>CaseName</list-attribute-id>
            <initial-sorting/>
        </attribute-config>
    </initial-sorting>
    <secure>false</secure>
    <record-type-link>${xmlEscape(recordTypeLink)}</record-type-link>
</case-list2>
`;
};

const buildDatastoreListContent = (
  listName: string,
  uriPart: string,
  datastoreLink: string,
  version: string | null,
  options: CreateDatastoreListOptions = {}
): string => {
  const plugins = version
    ? [`<?plugin nl.beinformed.bi.knowledge_${version}?>`, `<?plugin nl.beinformed.bi.core.configuration_${version}?>`, `<?plugin nl.beinformed.bi.common.panels_${version}?>`, `<?plugin nl.beinformed.bi.casemanagement_${version}?>`].join("")
    : "";
  const createTask = options.createFormLink
    ? `    <create-data-store-task>
        <id>${createStableId(`datastore-list-create:${listName}`)}</id>
        <label>${xmlEscape(`Create ${listName}`)}</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <link>${xmlEscape(options.createFormLink)}</link>
        <uri-part>${xmlEscape(`create-${uriPart}`)}</uri-part>
        <secure>false</secure>
        <provide-context-to-form>ID_AND_CASE</provide-context-to-form>
    </create-data-store-task>`
    : "";
  const caseContextLinkBlock = options.caseContextAttributeLink
    ? `    <case-context-attribute-link>${xmlEscape(options.caseContextAttributeLink)}</case-context-attribute-link>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>${plugins}<datastore-list>
    <label>${xmlEscape(listName)}</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <uri-part>${xmlEscape(uriPart)}</uri-part>
    <layout-hint>case-row-click</layout-hint>
    <paging-enabled>true</paging-enabled>
    <page-size>25</page-size>
    <custom-page-size-enabled>true</custom-page-size-enabled>
    <custom-page-sizes>10,25,50</custom-page-sizes>
    <count-enabled>true</count-enabled>
    <result-limit>500</result-limit>
${createTask}
    <list-attributes>
        <attribute>
            <list-attribute-id>CaseName</list-attribute-id>
            <visible>true</visible>
            <visible-in-detail>true</visible-in-detail>
            <end-user-sortable>true</end-user-sortable>
            <layout-hint/>
            <children/>
        </attribute>
    </list-attributes>
    <initial-sorting>
        <attribute-config>
            <list-attribute-id>CaseName</list-attribute-id>
            <initial-sorting/>
        </attribute-config>
    </initial-sorting>
    <secure>false</secure>
    <datastore-link>${xmlEscape(datastoreLink)}</datastore-link>
${caseContextLinkBlock}    <display-one-result-in-table>true</display-one-result-in-table>
    <check-permissions>true</check-permissions>
</datastore-list>
`;
};

export const createInterfaceOperation = async (
  repoPath: string,
  interfaceProjectName: string,
  operationNameInput: string,
  options: CreateInterfaceOperationOptions = {}
): Promise<CreatedInterfaceOperationResult> => {
  const model = await buildRepositoryModel(repoPath, { includeArtifacts: true, maxArtifacts: 3000 });
  const interfaceProject = model.projects.find((project) => project.name === interfaceProjectName);
  if (!interfaceProject) {
    throw new Error(`Interface project not found: ${interfaceProjectName}`);
  }
  if (interfaceProject.role !== "interface") {
    throw new Error(`Project is not an interface-definition project: ${interfaceProjectName}`);
  }

  const operationName = normalizeOperationName(operationNameInput);
  const operationFolderName = operationName.replace(/[\\/:*?"<>|]+/g, " ").trim();
  const version = interfaceProject.versionHints[0] || model.dominantVersionProfile?.version || null;
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const warnings: string[] = [];
  updatedFiles.push(...(await ensureProjectExplicitEncoding(interfaceProject)));

  const interfaceProjectRoot = path.resolve(interfaceProject.path);
  const projectAttributeCatalogDir = path.join(interfaceProjectRoot, "Data", "Attribute groups", "Attributes");
  const requestAttributePath = path.join(projectAttributeCatalogDir, toBixmlFileName(`${operationFolderName} request value`));
  const responseAttributePath = path.join(projectAttributeCatalogDir, toBixmlFileName(`${operationFolderName} response value`));
  const requestAbsolutePath = path.join(interfaceProjectRoot, operationFolderName, "Request", "Request.bixml");
  const responseAbsolutePath = path.join(interfaceProjectRoot, operationFolderName, "Response", "Response.bixml");
  const executeAbsolutePath = path.join(interfaceProjectRoot, operationFolderName, `Execute ${operationFolderName}.bixml`);
  const requestAttributeLink = `/${path.relative(model.repositoryPath, requestAttributePath).replace(/\\/g, "/")}`;
  const responseAttributeLink = `/${path.relative(model.repositoryPath, responseAttributePath).replace(/\\/g, "/")}`;
  const requestRelative = path.relative(model.repositoryPath, requestAbsolutePath);
  const responseRelative = path.relative(model.repositoryPath, responseAbsolutePath);
  const executeRelative = path.relative(model.repositoryPath, executeAbsolutePath);
  const requestLink = `/${requestRelative.replace(/\\/g, "/")}`;
  const responseLink = `/${responseRelative.replace(/\\/g, "/")}`;
  const executeLink = `/${executeRelative.replace(/\\/g, "/")}`;

  if (
    await writeFileIfMissing(
      requestAttributePath,
      buildAtomicStringAttributeGroupContent(
        `${operationFolderName} request value`,
        `${toSafeIdentifier(operationFolderName)}RequestValue`,
        version
      )
    )
  ) {
    createdFiles.push(requestAttributePath);
  } else {
    warnings.push(`Request attribute group already exists: ${requestAttributePath}`);
  }

  if (
    await writeFileIfMissing(
      requestAbsolutePath,
      buildAttributesetContent(
        `${operationFolderName} request`,
        `${toSafeIdentifier(operationFolderName)}Request`,
        [requestAttributeLink],
        version
      )
    )
  ) {
    createdFiles.push(requestAbsolutePath);
  } else {
    warnings.push(`Request attributeset already exists: ${requestAbsolutePath}`);
  }

  if (options.withResponse !== false) {
    if (
      await writeFileIfMissing(
        responseAttributePath,
        buildAtomicStringAttributeGroupContent(
          `${operationFolderName} response value`,
          `${toSafeIdentifier(operationFolderName)}ResponseValue`,
          version
        )
      )
    ) {
      createdFiles.push(responseAttributePath);
    } else {
      warnings.push(`Response attribute group already exists: ${responseAttributePath}`);
    }

    if (
      await writeFileIfMissing(
        responseAbsolutePath,
        buildAttributesetContent(
          `${operationFolderName} response`,
          `${toSafeIdentifier(operationFolderName)}Response`,
          [responseAttributeLink],
          version
        )
      )
    ) {
      createdFiles.push(responseAbsolutePath);
    } else {
      warnings.push(`Response attributeset already exists: ${responseAbsolutePath}`);
    }
  }

  if (await writeFileIfMissing(executeAbsolutePath, buildHandlerGroupContent(operationFolderName, requestLink, version))) {
    createdFiles.push(executeAbsolutePath);
  } else {
    warnings.push(`Execute handler-group already exists: ${executeAbsolutePath}`);
  }

  const siblingCandidates = model.projects.filter(
    (project) =>
      project.family.toLowerCase() === interfaceProject.family.toLowerCase() &&
      project.name !== interfaceProject.name &&
      (project.role === "domain_core" || project.role === "dsc_core")
  );
  const domainProject = siblingCandidates[0] || null;

  if (!domainProject) {
    warnings.push(`No sibling domain project could be inferred for interface project "${interfaceProjectName}".`);
    return {
      repositoryName: model.repositoryName,
      repositoryPath: model.repositoryPath,
      interfaceProject: interfaceProject.name,
      domainProject: null,
      operationName: operationFolderName,
      version,
      createdFiles,
      updatedFiles,
      warnings,
    };
  }

  const domainProjectRoot = path.resolve(domainProject.path);
  updatedFiles.push(...(await ensureProjectExplicitEncoding(domainProject)));
  const eventAbsolutePath = path.join(domainProjectRoot, "Interfaces", operationFolderName, `${operationFolderName}.bixml`);
  const eventRelative = path.relative(model.repositoryPath, eventAbsolutePath);
  const eventLink = `/${eventRelative.replace(/\\/g, "/")}`;
  if (await writeFileIfMissing(eventAbsolutePath, buildEventContent(operationFolderName, requestLink, executeLink, version))) {
    createdFiles.push(eventAbsolutePath);
  } else {
    warnings.push(`Domain event already exists: ${eventAbsolutePath}`);
  }

  const serviceApplications = model.artifactIndex.filter(
    (artifact) => artifact.project === domainProject.name && artifact.rootElement === "service-application"
  );
  if (serviceApplications.length === 1) {
    const serviceApplicationAbsolutePath = path.resolve(model.repositoryPath, serviceApplications[0].path);
    const originalServiceApplication = await readBoundedText(serviceApplicationAbsolutePath, 1_000_000);
    if (!originalServiceApplication) {
      warnings.push(`Could not read service application file: ${serviceApplications[0].path}`);
    } else if (originalServiceApplication.includes(`<label>${operationFolderName}</label>`)) {
      warnings.push(`Service application already appears to contain an operation named "${operationFolderName}".`);
    } else {
      const patched = originalServiceApplication.replace(
        /\s*<\/service-application>\s*$/i,
        `${buildServiceOperationEntry(
          operationFolderName,
          eventLink,
          options.withResponse === false ? null : responseLink
        )}\n</service-application>\n`
      );
      await writeFile(serviceApplicationAbsolutePath, patched, "utf8");
      updatedFiles.push(serviceApplicationAbsolutePath);
    }
  } else if (serviceApplications.length === 0) {
    warnings.push(`No service-application artifact was found in sibling project "${domainProject.name}".`);
  } else {
    warnings.push(
      `Multiple service-application artifacts were found in sibling project "${domainProject.name}". No automatic update was applied.`
    );
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    interfaceProject: interfaceProject.name,
    domainProject: domainProject.name,
    operationName: operationFolderName,
    version,
    createdFiles,
    updatedFiles,
    warnings,
  };
};
