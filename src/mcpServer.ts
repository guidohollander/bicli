// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { discoverProjectPluginRoots, loadInstallationMetadata } from "./beInformedInstallation.js";
import { lintRepository } from "./lint.js";
import {
  buildRepositoryModel,
  createCaseFormWorkflow,
  createCaseList,
  createDatastoreList,
  createInterfaceOperation,
  createPortalTab,
  createTestBixmlFile,
  createWebApplicationScaffold,
  traceRepositoryArtifacts,
  validateRepositoryModel
} from "./repositoryModel.js";
import { validateBixmlFile } from "./validator.js";

const SERVER_NAME = "beinformed-repository-mcp";
const SERVER_VERSION = "0.2.0";
const REPO_ROOT = process.env.BI_REPO_ROOT || "C:\\repo";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7";
const OPENROUTER_REASONING_EFFORT = process.env.OPENROUTER_REASONING_EFFORT || "medium";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "Be Informed MCP";
const MAX_SEARCH_RESULTS = 12;
const MAX_FILE_BYTES = 1_000_000;
const MAX_COMPLEX_EVIDENCE_FILES = 8;
const REPOSITORY_INDEX_VERSION = 2;
const CACHE_DIR = path.join(process.cwd(), ".bicli-cache");

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

const TEXT_EXTENSIONS = new Set([
  ".bixml",
  ".xml",
  ".json",
  ".properties",
  ".project",
  ".txt",
  ".md",
  ".xsl",
  ".xslt",
  ".sql",
  ".groovy",
  ".java",
  ".js",
  ".ts",
  ".yaml",
  ".yml",
  ".ini",
  ".csv"
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "with"
]);

const state = {
  repositories: null,
  repositoryIndexCache: new Map(),
  repositorySearchCache: new Map(),
  repositoryModelCache: new Map(),
  bixmlFactsCache: new Map(),
  activeRepository: null
};

const tools = [
  {
    name: "find_repositories",
    description: "Find repositories by partial name or path. Use this first when no repository is selected yet. Passing no repositoryHint returns the discovered repositories.",
    inputSchema: {
      type: "object",
      properties: { repositoryHint: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "activate_repository",
    description: "Activate one repository for later tool calls so subsequent calls can omit repository arguments. Use this early in a session after repository selection is clear.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_active_repository",
    description: "Get the current active repository. Use this to confirm session state before applying writes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "prepare_repository",
    description: "Warm the repository text index and repository-model caches for faster repeated questions and traces. This is the preferred warm-up tool before complex repository Q&A.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        force: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_repository",
    description: "Summarize repository structure, projects, studio configs, and top-level contents. Use this for a quick grounded overview before deeper analysis.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_path",
    description: "Describe one file or directory inside a repository, including BIXML quick facts for .bixml files. Use this for targeted inspection after search or tracing.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        relativePath: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_repository",
    description: "Search repository text and filenames. Use this when the user asks where something is defined; prefer answer_repository_question when synthesis is needed instead of raw matches.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        query: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "answer_repository_question",
    description: "Answer a repository question using retrieval plus cached repository-model summaries when relevant. Prefer this for most repository business or technical questions.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        question: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["question"],
      additionalProperties: false
    }
  },
  {
    name: "answer_complex_question",
    description: "Answer a complex repository question with the same grounded local evidence as answer_repository_question plus optional cloud augmentation. Use this only when local retrieval-only synthesis is not enough.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        question: { type: "string" },
        maxResults: { type: "number" },
        useCloud: { type: "boolean" },
        model: { type: "string" },
        reasoningEffort: { type: "string" }
      },
      required: ["question"],
      additionalProperties: false
    }
  },
  {
    name: "list_repository_versions",
    description: "Scan repositories and report sampled Be Informed plugin versions. Use this for version-discovery questions, not for general repository modeling.",
    inputSchema: {
      type: "object",
      properties: { repositoryHint: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "extract_repository_model",
    description: "Extract the typed version-aware repository model, including projects and optionally artifacts. Use this when a caller needs raw structured repository-model data rather than prose.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        includeArtifacts: { type: "boolean" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "trace_artifact_links",
    description: "Trace inbound and outbound artifact links through the repository model for one path, identifier, or label query. Use this for dependency debugging and impact analysis.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        query: { type: "string" },
        maxArtifacts: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "validate_repository_model",
    description: "Validate repository-model coherence, including missing dependencies and invalid artifact references. Use this after bounded writes or when checking repository integrity.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_interface_operation",
    description: "Create one bounded interface operation in an existing interface-definition project. This creates the request attributeset, optional response attributeset, execute handler-group, sibling domain event, and may update one unambiguous sibling service application. Use this when the target project and operation name are already known.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        operationName: { type: "string" },
        withResponse: { type: "boolean" }
      },
      required: ["project", "operationName"],
      additionalProperties: false
    }
  },
  {
    name: "create_test_bixml",
    description: "Create one minimal bounded test BIXML file in an existing project. Use this for controlled experiments or test fixtures, not for production-ready modeling.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        fileRelativePath: { type: "string" },
        rootElement: { type: "string" },
        label: { type: "string" },
        version: { type: "string" }
      },
      required: ["project", "fileRelativePath"],
      additionalProperties: false
    }
  },
  {
    name: "create_case_form_workflow",
    description: "Create one bounded _Case workflow in an existing project by generating _Case data attribute sets, one matching event, and one matching form whose questions are derived from questionLabels. Use this when the target project and form name are already known.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        formName: { type: "string" },
        questionLabels: { type: "array", items: { type: "string" } },
        secure: { type: "boolean" },
        templateForm: { type: "string" },
        templateEvent: { type: "string" }
      },
      required: ["project", "formName", "questionLabels"],
      additionalProperties: false
    }
  },
  {
    name: "create_web_application",
    description: "Create one new webapplication artifact and one initial tab artifact inside an existing portal project. Use this only when the target project and unique application/tab uri-part values are already known. This tool does not create forms, case views, or lists unless linked separately.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        applicationName: { type: "string" },
        applicationUriPart: { type: "string" },
        initialTabName: { type: "string" },
        initialTabUriPart: { type: "string" },
        userProvider: { type: "string" },
        loginMandatory: { type: "boolean" }
      },
      required: ["project", "applicationName", "applicationUriPart", "initialTabName", "initialTabUriPart"],
      additionalProperties: false
    }
  },
  {
    name: "create_portal_tab",
    description: "Create one new tab in an existing portal project and optionally patch one existing web application with a tab-ref. Use this when tab wiring is clear and the referenced lists, case views, or forms already exist.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        tabName: { type: "string" },
        tabUriPart: { type: "string" },
        secure: { type: "boolean" },
        layoutHint: { type: "string" },
        webApplication: { type: "string" },
        datastoreListLinks: { type: "array", items: { type: "object" } },
        caseViewLinks: { type: "array", items: { type: "object" } },
        caseListLinks: { type: "array", items: { type: "object" } },
        formTasks: { type: "array", items: { type: "object" } }
      },
      required: ["project", "tabName", "tabUriPart"],
      additionalProperties: false
    }
  },
  {
    name: "create_case_list",
    description: "Create one new case-list2 artifact in an existing project, with optional create/update form task links. recordTypeLink must already point to a valid case artifact.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        listName: { type: "string" },
        uriPart: { type: "string" },
        recordTypeLink: { type: "string" },
        createFormLink: { type: "string" },
        updateFormLink: { type: "string" }
      },
      required: ["project", "listName", "uriPart", "recordTypeLink"],
      additionalProperties: false
    }
  },
  {
    name: "create_datastore_list",
    description: "Create one new datastore-list artifact in an existing project, with optional create-data-store task and case-context attribute link. datastoreLink must already resolve to a valid datastore artifact.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        listName: { type: "string" },
        uriPart: { type: "string" },
        datastoreLink: { type: "string" },
        createFormLink: { type: "string" },
        caseContextAttributeLink: { type: "string" }
      },
      required: ["project", "listName", "uriPart", "datastoreLink"],
      additionalProperties: false
    }
  },
  {
    name: "inspect_installation",
    description: "Inspect a Be Informed installation and plugin roots that will drive validation. Use this before validate_bixml when installation scope is unclear.",
    inputSchema: {
      type: "object",
      properties: {
        biHome: { type: "string" },
        projectRoot: { type: "string" },
        extraPluginRoots: { type: "array", items: { type: "string" } }
      },
      required: ["biHome"],
      additionalProperties: false
    }
  },
  {
    name: "validate_bixml",
    description: "Validate one or more BIXML files against a specific Be Informed installation and optional project plugin roots. Use this for installation-aware file validation, not repository-model coherence.",
    inputSchema: {
      type: "object",
      properties: {
        biHome: { type: "string" },
        projectRoot: { type: "string" },
        extraPluginRoots: { type: "array", items: { type: "string" } },
        filePaths: { type: "array", items: { type: "string" } },
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        relativePaths: { type: "array", items: { type: "string" } }
      },
      required: ["biHome"],
      additionalProperties: false
    }
  },
  {
    name: "lint",
    description: "Lint repository modeling conventions using configured or supplied rules. Use this for style and convention checks rather than structural repository validation.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        rulesPath: { type: "string" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_modeling_patterns",
    description: "Summarize concrete modeling patterns seen in the repository, such as common child element names and layout-hint-like usage. Use this when the question is about conventions rather than one specific artifact.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        force: { type: "boolean" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_interaction_patterns",
    description: "Summarize interaction-layer patterns across webapplications, tabs, case lists, datastore lists, and panels. Use this when the question is about UI/application composition patterns.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        force: { type: "boolean" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_case_model_patterns",
    description: "Summarize repository-grounded case model patterns, including cases, case views, case lists, and validation signal. Use this for case-model design questions rather than generic search.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        force: { type: "boolean" },
        maxArtifacts: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "describe_case_workflow_pattern",
    description: "Describe the repository-grounded _Case form/event/data workflow pattern inside one project by summarizing existing forms and events. Use this before creating a new _Case workflow to understand local project shape.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        repositoryPath: { type: "string" },
        repositoryHint: { type: "string" },
        project: { type: "string" },
        force: { type: "boolean" },
        maxArtifacts: { type: "number" }
      },
      required: ["project"],
      additionalProperties: false
    }
  }
];

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function activeRepositoryPath() {
  ensureCacheDir();
  return path.join(CACHE_DIR, "active-repository.json");
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function indexCachePath(repoPath) {
  ensureCacheDir();
  return path.join(CACHE_DIR, `${safeFileName(path.basename(repoPath))}.repo-index.json`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function safeReadText(filePath, maxBytes = MAX_FILE_BYTES) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeReadHead(filePath, maxBytes = 8192) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    const bytes = Math.min(stats.size, maxBytes);
    return fs.readFileSync(filePath, "utf8").slice(0, bytes);
  } catch {
    return null;
  }
}

function walkDirectory(rootPath, visit, depth = 0, maxDepth = Infinity) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    const result = visit(fullPath, entry, depth);
    if (result === false) {
      continue;
    }
    if (entry.isDirectory() && depth < maxDepth) {
      walkDirectory(fullPath, visit, depth + 1, maxDepth);
    }
  }
}

function parseProjectFile(projectFilePath) {
  const xml = safeReadText(projectFilePath, 200_000);
  if (!xml) {
    return null;
  }
  return {
    name: xml.match(/<name>([^<]+)<\/name>/)?.[1] || path.basename(path.dirname(projectFilePath)),
    projectFilePath,
    dependencies: Array.from(xml.matchAll(/<project>([^<]+)<\/project>/g)).map((match) => match[1]),
    builders: Array.from(xml.matchAll(/<name>([^<]+)<\/name>/g))
      .map((match) => match[1])
      .filter((value) => value.includes(".")),
    natures: Array.from(xml.matchAll(/<nature>([^<]+)<\/nature>/g)).map((match) => match[1]),
    isBeInformed: xml.includes("nl.beinformed")
  };
}

function parseStudioJson(repoPath) {
  const studioDir = path.join(repoPath, "_CONTINUOUS_DELIVERY", "_STUDIO");
  if (!fs.existsSync(studioDir)) {
    return [];
  }
  const results = [];
  for (const file of fs.readdirSync(studioDir)) {
    if (!file.toLowerCase().endsWith(".json")) {
      continue;
    }
    const fullPath = path.join(studioDir, file);
    const raw = safeReadText(fullPath, 500_000);
    if (!raw) {
      continue;
    }
    try {
      results.push({ path: fullPath, data: JSON.parse(raw) });
    } catch {
      results.push({ path: fullPath, raw });
    }
  }
  return results;
}

function summarizeDirectory(targetPath, childLimit = 20) {
  const children = [];
  let bixmlCount = 0;
  let xmlCount = 0;
  let projectFile = null;

  walkDirectory(
    targetPath,
    (fullPath, entry, depth) => {
      if (depth === 0 && children.length < childLimit) {
        children.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      }
      if (!entry.isFile()) {
        return;
      }
      if (entry.name === ".project") {
        projectFile = fullPath;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".bixml") {
        bixmlCount += 1;
      } else if (ext === ".xml") {
        xmlCount += 1;
      }
    },
    0,
    2
  );

  return {
    path: targetPath,
    project: projectFile ? parseProjectFile(projectFile) : null,
    childPreview: children,
    bixmlCount,
    xmlCount
  };
}

function getRepositoryState(repoPath) {
  try {
    const stats = fs.statSync(repoPath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function computeManifestDigest(entries) {
  const hash = createHash("sha1");
  for (const entry of entries) {
    hash.update(`${entry.relativePath}::${entry.size}::${entry.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function collectRepositoryManifest(repoPath) {
  const files = [];
  walkDirectory(repoPath, (fullPath, entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
      return false;
    }
    if (!entry.isFile()) {
      return;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!(TEXT_EXTENSIONS.has(ext) || entry.name === ".project")) {
      return;
    }
    const stats = fs.statSync(fullPath);
    files.push({
      relativePath: path.relative(repoPath, fullPath),
      size: stats.size,
      mtimeMs: stats.mtimeMs
    });
  });
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    fileCount: files.length,
    digest: computeManifestDigest(files),
    files
  };
}

function buildRepositoryFileIndex(repoPath) {
  const files = [];
  walkDirectory(repoPath, (fullPath, entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
      return false;
    }
    if (!entry.isFile()) {
      return;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!(TEXT_EXTENSIONS.has(ext) || entry.name === ".project")) {
      return;
    }
    const stats = fs.statSync(fullPath);
    files.push({
      path: fullPath,
      relativePath: path.relative(repoPath, fullPath),
      extension: ext,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      head: safeReadHead(fullPath, ext === ".bixml" ? 16_384 : 8_192)
    });
  });
  return files;
}

function collectVersionSampleFiles(repoPath) {
  const result = [];
  const perTopLevel = new Map();
  walkDirectory(repoPath, (fullPath, entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
      return false;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".bixml")) {
      return;
    }
    const relativePath = path.relative(repoPath, fullPath);
    const firstSegment = relativePath.split(path.sep)[0] || ".";
    const count = perTopLevel.get(firstSegment) || 0;
    if (count >= 2 || result.length >= 10) {
      return;
    }
    const head = safeReadHead(fullPath, 8192) || "";
    if (head.includes("<?plugin nl.beinformed")) {
      result.push(fullPath);
      perTopLevel.set(firstSegment, count + 1);
    }
  });
  return result;
}

function buildRepositoryIndex(repoPath, options = {}) {
  const manifest = collectRepositoryManifest(repoPath);
  const cacheKey = `${repoPath}::${manifest.digest}`;
  if (!options.force && state.repositoryIndexCache.has(cacheKey)) {
    return state.repositoryIndexCache.get(cacheKey);
  }

  const cachePath = indexCachePath(repoPath);
  const repoState = getRepositoryState(repoPath);
  const cached = options.force ? null : readJsonFile(cachePath);
  if (
    cached &&
    cached.indexVersion === REPOSITORY_INDEX_VERSION &&
    cached.repositoryPath === repoPath &&
    cached.manifest?.digest === manifest.digest
  ) {
    state.repositoryIndexCache.set(cacheKey, cached);
    return cached;
  }

  const index = {
    indexVersion: REPOSITORY_INDEX_VERSION,
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
    repositoryState: repoState,
    manifest,
    builtAt: new Date().toISOString(),
    files: buildRepositoryFileIndex(repoPath),
    versionSampleFiles: collectVersionSampleFiles(repoPath)
  };
  writeJsonFile(cachePath, index);
  state.repositoryIndexCache.set(cacheKey, index);
  return index;
}

function prepareRepository(repo, options = {}) {
  const startedAt = Date.now();
  const index = buildRepositoryIndex(repo.path, options);
  getCachedRepositoryModel(repo.path, { includeArtifacts: false, maxArtifacts: 300, force: options.force === true });
  return {
    repository: repo.name,
    repositoryPath: repo.path,
    prepared: true,
    forced: options.force === true,
    fileCount: index.files.length,
    versionSampleFileCount: index.versionSampleFiles.length,
    durationMs: Date.now() - startedAt,
    cachePath: indexCachePath(repo.path),
    builtAt: index.builtAt
  };
}

function discoverRepositories() {
  if (state.repositories) {
    return state.repositories;
  }
  if (!fs.existsSync(REPO_ROOT)) {
    state.repositories = [];
    return state.repositories;
  }
  const repositories = [];
  for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const repoPath = path.join(REPO_ROOT, entry.name);
    let projectCount = 0;
    let bixmlCount = 0;
    walkDirectory(
      repoPath,
      (fullPath, child, depth) => {
        if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name.toLowerCase())) {
          return false;
        }
        if (!child.isFile()) {
          return;
        }
        if (child.name === ".project") {
          projectCount += 1;
        }
        if (path.extname(child.name).toLowerCase() === ".bixml") {
          bixmlCount += 1;
        }
      },
      0,
      4
    );
    repositories.push({
      name: entry.name,
      path: repoPath,
      projectCount,
      bixmlCount,
      studioConfigs: parseStudioJson(repoPath)
    });
  }
  state.repositories = repositories.sort((left, right) => left.name.localeCompare(right.name));
  return state.repositories;
}

function resolveRepository(repositoryPath) {
  const candidates = discoverRepositories().filter(
    (repo) =>
      repo.name === repositoryPath ||
      path.resolve(repo.path).toLowerCase() === path.resolve(repositoryPath).toLowerCase()
  );
  return candidates[0] || null;
}

function findRepositories(repositoryHint) {
  const hint = String(repositoryHint || "").toLowerCase().trim();
  return discoverRepositories()
    .filter((repo) => !hint || repo.name.toLowerCase().includes(hint) || repo.path.toLowerCase().includes(hint))
    .map((repo) => ({
      name: repo.name,
      path: repo.path,
      projectCount: repo.projectCount,
      bixmlCount: repo.bixmlCount
    }))
    .slice(0, 20);
}

function getActiveRepository() {
  if (state.activeRepository) {
    return state.activeRepository;
  }
  const persisted = readJsonFile(activeRepositoryPath());
  if (persisted?.path) {
    const repo = resolveRepository(persisted.path);
    if (repo) {
      state.activeRepository = repo;
      return repo;
    }
  }
  return null;
}

function setActiveRepository(repo) {
  state.activeRepository = repo;
  writeJsonFile(activeRepositoryPath(), repo);
  return repo;
}

function resolveRepositorySelection(args = {}) {
  if (args.repositoryPath) {
    const repo = resolveRepository(args.repositoryPath);
    return { repo, candidates: repo ? [repo] : [] };
  }
  if (args.repository) {
    const repo = discoverRepositories().find((candidate) => candidate.name === args.repository) || null;
    return { repo, candidates: repo ? [repo] : [] };
  }
  if (args.repositoryHint) {
    const candidates = discoverRepositories().filter((candidate) =>
      candidate.name.toLowerCase().includes(String(args.repositoryHint).toLowerCase())
    );
    return { repo: candidates.length === 1 ? candidates[0] : null, candidates };
  }
  const active = getActiveRepository();
  return { repo: active, candidates: active ? [active] : [] };
}

function requireRepository(args) {
  const { repo, candidates } = resolveRepositorySelection(args);
  if (candidates.length > 1) {
    return {
      status: "repository-selection-required",
      repositoryHint: args.repositoryHint,
      candidates: candidates.map((candidate) => ({ name: candidate.name, path: candidate.path }))
    };
  }
  if (!repo) {
    throw new Error(
      "Repository selection is required. Pass repository, repositoryPath, or repositoryHint, or activate a repository first."
    );
  }
  return repo;
}

function limitText(text, maxLength = 1000) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .filter((term) => term && term.length > 2 && !STOP_WORDS.has(term));
}

function classifyQuestion(question) {
  const lower = String(question || "").toLowerCase();
  if (
    lower.includes("architecture") ||
    lower.includes("dependency") ||
    lower.includes("dependencies") ||
    lower.includes("layer") ||
    lower.includes("layers") ||
    lower.includes("module") ||
    lower.includes("project pattern")
  ) {
    return "architecture";
  }
  if (
    lower.includes("model") ||
    lower.includes("bixml") ||
    lower.includes("concept") ||
    lower.includes("taxonomy") ||
    lower.includes("artifact") ||
    lower.includes("case view") ||
    lower.includes("case type")
  ) {
    return "modeling";
  }
  if (
    lower.includes("setup") ||
    lower.includes("build") ||
    lower.includes("configuration") ||
    lower.includes("deploy")
  ) {
    return "setup";
  }
  return "general";
}

function extractNamedPathTargets(question, repo) {
  const lower = String(question || "").toLowerCase();
  return repo.name
    ? repo.name.toLowerCase().includes(lower) ? [repo.name] : []
    : [];
}

function scorePathTargets(relativePath, pathTargets) {
  const lowerPath = relativePath.toLowerCase();
  let boost = 0;
  for (const target of pathTargets) {
    const normalized = String(target || "").toLowerCase().trim();
    if (!normalized) {
      continue;
    }
    if (lowerPath.includes(normalized)) {
      boost += 40;
    }
  }
  return boost;
}

function makeSnippet(content, queryTerms) {
  const lower = content.toLowerCase();
  let bestIndex = 0;
  for (const term of queryTerms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) {
      bestIndex = index;
      break;
    }
  }
  const start = Math.max(0, bestIndex - 140);
  const end = Math.min(content.length, bestIndex + 340);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function searchRepository(repo, query, maxResults = MAX_SEARCH_RESULTS, options = {}) {
  const index = buildRepositoryIndex(repo.path);
  const pathTargets = options.pathTargets || [];
  const cacheKey = `${repo.path}::${index.builtAt}::${query}::${maxResults}::${pathTargets.join("|")}`;
  if (state.repositorySearchCache.has(cacheKey)) {
    return state.repositorySearchCache.get(cacheKey);
  }
  const terms = tokenize(query);
  const results = [];
  for (const file of index.files) {
    const relativePath = file.relativePath;
    const lowerPath = relativePath.toLowerCase();
    const lowerContent = String(file.head || "").toLowerCase();
    let score = scorePathTargets(relativePath, pathTargets);
    for (const term of terms) {
      if (lowerPath.includes(term)) {
        score += 8;
      }
      const matches = lowerContent.split(term).length - 1;
      if (matches > 0) {
        score += Math.min(matches, 10);
      }
    }
    if (score <= 0) {
      continue;
    }
    results.push({
      filePath: file.path,
      relativePath,
      score,
      snippet: makeSnippet(String(file.head || relativePath), terms)
    });
  }
  const sorted = results.sort((left, right) => right.score - left.score).slice(0, maxResults);
  state.repositorySearchCache.set(cacheKey, sorted);
  return sorted;
}

function getBixmlQuickFacts(filePath) {
  const text = safeReadText(filePath, 400_000);
  if (!text) {
    return null;
  }
  const rootTag = text.replace(/<\?xml[\s\S]*?\?>/, "").trimStart().match(/^<([a-zA-Z0-9:_-]+)/)?.[1] || null;
  const label = text.match(/<label>([\s\S]*?)<\/label>/)?.[1]?.trim() || null;
  const identifier = text.match(/<identifier>([\s\S]*?)<\/identifier>/)?.[1]?.trim() || null;
  const referencedConcepts = Array.from(text.matchAll(/<referenced-concept>([\s\S]*?)<\/referenced-concept>/g))
    .slice(0, 10)
    .map((match) => match[1].trim());
  return { rootTag, label, identifier, referencedConcepts };
}

function enrichRepositoryMatch(match) {
  const extension = path.extname(match.filePath).toLowerCase();
  return {
    relativePath: match.relativePath,
    score: match.score,
    snippet: limitText(match.snippet, 500),
    extension,
    bixml: extension === ".bixml" ? getBixmlQuickFacts(match.filePath) : null,
    preview: limitText(safeReadText(match.filePath, 80_000) || "", 1500)
  };
}

function deriveProjectRole(projectName) {
  const lower = String(projectName || "").toLowerCase();
  if (lower.includes("interface definition")) return "interface";
  if (lower.includes("portal")) return "portal";
  if (lower.includes("interaction layer")) return "interaction_layer";
  if (lower === "sc library") return "shared_core";
  if (lower === "sc library - specific") return "shared_specific";
  if (lower.startsWith("dsc ")) return lower.includes("specific") ? "dsc_specific" : "dsc_core";
  if (lower.startsWith("sc ")) return lower.includes("specific") ? "specific" : "domain_core";
  return "other";
}

function summarizeArchitecture(model) {
  const roleCounts = {};
  for (const project of model.projects || []) {
    const role = deriveProjectRole(project.name);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  const dependencyPatterns = [];
  for (const project of model.projects || []) {
    for (const dependency of project.dependencies || []) {
      dependencyPatterns.push(`${deriveProjectRole(project.name)}->${deriveProjectRole(dependency)}`);
    }
  }
  const counts = new Map();
  for (const pattern of dependencyPatterns) {
    counts.set(pattern, (counts.get(pattern) || 0) + 1);
  }
  return {
    projectCount: model.projects?.length || 0,
    artifactCount: model.artifactIndex?.length || 0,
    dominantVersionProfile: model.dominantVersionProfile || null,
    roleCounts,
    dependencyPatterns: Array.from(counts.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 8)
  };
}

async function getCachedRepositoryModel(repoPath, options = {}) {
  const index = buildRepositoryIndex(repoPath);
  const key = `${repoPath}::${options.includeArtifacts ? "a" : "n"}::${options.maxArtifacts || 0}::${index.manifest?.digest || "no-digest"}`;
  if (!options.force && state.repositoryModelCache.has(key)) {
    return state.repositoryModelCache.get(key);
  }
  const model = await buildRepositoryModel(repoPath, {
    includeArtifacts: options.includeArtifacts === true,
    maxArtifacts: options.maxArtifacts || 500
  });
  state.repositoryModelCache.set(key, model);
  return model;
}

async function buildEvidenceBundle(repo, question, options = {}) {
  const maxResults = options.maxResults || MAX_SEARCH_RESULTS;
  const pathTargets = extractNamedPathTargets(question, repo);
  const questionType = classifyQuestion(question);
  const lowerQuestion = String(question || "").toLowerCase();
  const useRepositoryModel = questionType === "architecture" || questionType === "modeling";
  const repositoryModel = useRepositoryModel
    ? await getCachedRepositoryModel(repo.path, {
        includeArtifacts: true,
        maxArtifacts: questionType === "architecture" ? 300 : 800
      })
    : null;
  const seededQuery =
    questionType === "architecture"
      ? `${question} architecture layer dependency project portal interface specific`
      : questionType === "modeling"
        ? `${question} bixml model concept taxonomy artifact event form case view case type`
        : question;
  const repoMatches = searchRepository(repo, seededQuery, Math.max(maxResults, MAX_COMPLEX_EVIDENCE_FILES), {
    pathTargets
  });
  return {
    repository: repo,
    question,
    questionType,
    pathTargets,
    repositoryModelSummary: repositoryModel ? summarizeArchitecture(repositoryModel) : null,
    repoMatches,
    enrichedRepoMatches: repoMatches.slice(0, MAX_COMPLEX_EVIDENCE_FILES).map(enrichRepositoryMatch)
  };
}

function synthesizeRepositoryAnswer(bundle) {
  const architecture = bundle.repositoryModelSummary;
  const strongestMatch = bundle.enrichedRepoMatches[0]?.relativePath || null;
  let synthesis = "The answer is inferred from repository retrieval results.";
  if (architecture) {
    if (bundle.questionType === "architecture") {
      synthesis =
        `The repository model shows ${architecture.projectCount} Be Informed projects and ${architecture.artifactCount} indexed artifacts. ` +
        `Dominant version: ${architecture.dominantVersionProfile?.version || "unknown"}. ` +
        `Common dependency directions are ${architecture.dependencyPatterns
          .slice(0, 4)
          .map((entry) => `${entry.pattern} (${entry.count})`)
          .join(", ") || "not yet concentrated enough to summarize"}.`;
    } else {
      synthesis =
        `The repository model shows ${architecture.artifactCount} indexed artifacts across ${architecture.projectCount} Be Informed projects. ` +
        `This question was routed through the model-aware path before text retrieval.`;
    }
    if (strongestMatch) synthesis += ` The strongest file-level evidence is ${strongestMatch}.`;
  } else if (strongestMatch) {
    synthesis = `The strongest evidence is ${strongestMatch}.`;
  }
  return {
    repository: bundle.repository.name,
    repositoryPath: bundle.repository.path,
    question: bundle.question,
    pathTargets: bundle.pathTargets,
    synthesis,
    matches: bundle.repoMatches,
    enrichedMatches: bundle.enrichedRepoMatches,
    note:
      "This answer is grounded in indexed repository files and cached repository-model summaries. Treat synthesis as inference unless it quotes direct file content."
  };
}

async function answerRepositoryQuestion(repo, question, maxResults = 6) {
  return synthesizeRepositoryAnswer(await buildEvidenceBundle(repo, question, { maxResults }));
}

function buildCloudPrompt(bundle) {
  return [
    `Repository: ${bundle.repository.name}`,
    `Question: ${bundle.question}`,
    "",
    "Repository evidence:",
    JSON.stringify(bundle.enrichedRepoMatches, null, 2),
    "",
    "Repository model summary:",
    JSON.stringify(bundle.repositoryModelSummary, null, 2)
  ].join("\n");
}

function extractOpenRouterText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const texts = [];
  for (const choice of choices) {
    if (typeof choice?.message?.content === "string") {
      texts.push(choice.message.content.trim());
    }
  }
  return texts.join("\n\n").trim() || null;
}

async function callOpenRouterForGroundedAnswer(bundle, options = {}) {
  if (!OPENROUTER_API_KEY) {
    return {
      usedCloud: false,
      note: "OPENROUTER_API_KEY is not configured. Falling back to retrieval-only mode."
    };
  }

  const response = await fetch(OPENROUTER_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      ...(OPENROUTER_SITE_URL ? { "HTTP-Referer": OPENROUTER_SITE_URL } : {}),
      ...(OPENROUTER_APP_NAME ? { "X-OpenRouter-Title": OPENROUTER_APP_NAME } : {})
    },
    body: JSON.stringify({
      model: options.model || OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You answer Be Informed repository questions. Use only the supplied repository evidence. Distinguish direct evidence from inference and cite file paths explicitly."
        },
        { role: "user", content: buildCloudPrompt(bundle) }
      ],
      reasoning: { effort: options.reasoningEffort || OPENROUTER_REASONING_EFFORT }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error ${response.status}: ${limitText(await response.text(), 500)}`);
  }

  const payload = JSON.parse(await response.text());
  return {
    usedCloud: true,
    provider: "openrouter",
    model: options.model || OPENROUTER_MODEL,
    reasoningEffort: options.reasoningEffort || OPENROUTER_REASONING_EFFORT,
    answer: extractOpenRouterText(payload),
    responseId: payload.id || null
  };
}

async function answerComplexQuestion(repo, question, options = {}) {
  const bundle = await buildEvidenceBundle(repo, question, { maxResults: options.maxResults || 8 });
  const local = synthesizeRepositoryAnswer(bundle);
  if (options.useCloud === false) {
    return { mode: "retrieval-only", local };
  }
  try {
    const cloud = await callOpenRouterForGroundedAnswer(bundle, options);
    return cloud.usedCloud ? { mode: "cloud-augmented", local, cloud } : { mode: "retrieval-only", local, cloud };
  } catch (error) {
    return {
      mode: "retrieval-only",
      local,
      cloud: { usedCloud: false, note: error instanceof Error ? error.message : String(error) }
    };
  }
}

function summarizeRepository(repo) {
  const projects = [];
  walkDirectory(
    repo.path,
    (fullPath, entry) => {
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        return false;
      }
      if (entry.isFile() && entry.name === ".project") {
        const parsed = parseProjectFile(fullPath);
        if (parsed) {
          projects.push(parsed);
        }
      }
    },
    0,
    4
  );
  return {
    name: repo.name,
    path: repo.path,
    projectCount: projects.length,
    bixmlCount: repo.bixmlCount,
    topLevelEntries: fs.readdirSync(repo.path).slice(0, 40),
    projects: projects.slice(0, 60),
    studioConfigs: parseStudioJson(repo.path).slice(0, 10)
  };
}

async function getPatternModel(repoPath, options = {}) {
  return getCachedRepositoryModel(repoPath, {
    includeArtifacts: true,
    maxArtifacts: options.maxArtifacts || 2500,
    force: options.force === true
  });
}

async function describeModelingPatterns(repoPath, options = {}) {
  const model = await getPatternModel(repoPath, options);
  const fieldNames = new Map();
  const layoutHints = new Map();

  for (const artifact of model.artifactIndex) {
    for (const childName of artifact.childElementNames || []) {
      fieldNames.set(childName, (fieldNames.get(childName) || 0) + 1);
    }
  }

  for (const form of model.forms) {
    layoutHints.set("form", (layoutHints.get("form") || 0) + 1);
    for (const questionLink of form.questionAttributeSetLinks) {
      if (questionLink.includes("layout-hint")) {
        layoutHints.set(questionLink, (layoutHints.get(questionLink) || 0) + 1);
      }
    }
  }

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    dominantVersion: model.dominantVersionProfile?.version || null,
    topChildElementNames: Array.from(fieldNames.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 40),
    layoutHintSamples: Array.from(layoutHints.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 20),
    artifactCount: model.artifactIndex.length
  };
}

async function describeInteractionPatterns(repoPath, options = {}) {
  const model = await getPatternModel(repoPath, options);
  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    webApplicationCount: model.webApplications.length,
    tabCount: model.tabs.length,
    caseListCount: model.caseLists.length,
    datastoreListCount: model.datastoreLists.length,
    panelCount: model.panels.length,
    webApplications: model.webApplications.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      uriPart: item.uriPart,
      tabCount: item.tabLinks.length,
      loginMandatory: item.loginMandatory
    })),
    tabs: model.tabs.slice(0, 30).map((item) => ({
      label: item.label,
      project: item.project,
      caseViewCount: item.caseViewLinks.length,
      caseListCount: item.caseListLinks.length,
      datastoreListCount: item.datastoreListPanelLinks.length,
      formTaskCount: item.formTaskLinks.length
    })),
    caseLists: model.caseLists.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      recordTypeLink: item.recordTypeLink,
      createCaseTaskCount: item.createCaseTaskCaseTypeLinks.length,
      generalPanelTaskCount: item.generalPanelTaskFormLinks.length
    })),
    datastoreLists: model.datastoreLists.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      datastoreLink: item.datastoreLink,
      hasCaseContextAttribute: Boolean(item.caseContextAttributeLink),
      createTaskCount: item.createDataStoreTaskFormLinks.length
    }))
  };
}

async function describeCaseModelPatterns(repoPath, options = {}) {
  const model = await getPatternModel(repoPath, options);
  const validation = validateRepositoryModel(model);
  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    caseTypeCount: model.caseTypes.length,
    caseViewCount: model.caseViews.length,
    caseListCount: model.caseLists.length,
    caseTypes: model.caseTypes.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      functionalId: item.functionalId,
      stateCount: item.stateCount,
      documentTypeCount: item.documentTypeCount
    })),
    caseViews: model.caseViews.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      caseTypeLink: item.caseTypeLink,
      taskGroupCount: item.taskGroupCount,
      relatedCaseViewCount: item.relatedCaseViewCount
    })),
    caseLists: model.caseLists.slice(0, 20).map((item) => ({
      label: item.label,
      project: item.project,
      recordTypeLink: item.recordTypeLink
    })),
    validation: {
      ok: validation.ok,
      issueCount: validation.issueCount,
      issueTypes: Array.from(new Set(validation.issues.map((issue) => issue.type))).sort()
    }
  };
}

async function describeCaseWorkflowPattern(repoPath, projectName, options = {}) {
  const model = await getPatternModel(repoPath, options);
  const events = model.events.filter((item) => item.project === projectName);
  const forms = model.forms.filter((item) => item.project === projectName);
  const caseEvents = events.filter((item) => (item.path.includes(`${path.sep}_Case${path.sep}`) || item.label?.includes("Case")));
  const caseForms = forms.filter((item) => (item.path.includes(`${path.sep}_Case${path.sep}`) || item.label?.includes("Case")));

  return {
    repositoryName: model.repositoryName,
    repositoryPath: model.repositoryPath,
    project: projectName,
    eventCount: events.length,
    formCount: forms.length,
    caseEventCount: caseEvents.length,
    caseFormCount: caseForms.length,
    sampleEvents: caseEvents.slice(0, 12).map((item) => ({
      label: item.label,
      path: path.relative(model.repositoryPath, item.path),
      inputAttributeSetRefs: item.inputAttributeSetRefs.slice(0, 8),
      newCaseTypeLinks: item.newCaseTypeLinks.slice(0, 4)
    })),
    sampleForms: caseForms.slice(0, 12).map((item) => ({
      label: item.label,
      path: path.relative(model.repositoryPath, item.path),
      eventTypeLink: item.eventTypeLink,
      requestParameterAttributeSetLink: item.requestParameterAttributeSetLink,
      questionAttributeSetLinks: item.questionAttributeSetLinks.slice(0, 8)
    })),
    note:
      "This summary is repository-grounded and reflects current _Case-style forms and events found in the selected project."
  };
}

function describePath(repo, relativePath) {
  const resolvedPath = relativePath ? path.resolve(repo.path, relativePath) : repo.path;
  if (!resolvedPath.startsWith(path.resolve(repo.path))) {
    throw new Error("Path escapes repository root");
  }
  const stats = fs.statSync(resolvedPath);
  if (stats.isDirectory()) {
    return {
      type: "directory",
      relativePath: path.relative(repo.path, resolvedPath) || ".",
      ...summarizeDirectory(resolvedPath)
    };
  }
  return {
    type: "file",
    relativePath: path.relative(repo.path, resolvedPath),
    extension: path.extname(resolvedPath).toLowerCase(),
    size: stats.size,
    bixml: path.extname(resolvedPath).toLowerCase() === ".bixml" ? getBixmlQuickFacts(resolvedPath) : null,
    preview: limitText(safeReadText(resolvedPath, 100_000) || "", 2000)
  };
}

function collectVersionHints(filePath) {
  const text = safeReadHead(filePath, 8192) || "";
  return Array.from(text.matchAll(/<\?plugin\s+nl\.beinformed\.[^_]+_([0-9.]+)\?>/g)).map((match) => match[1]);
}

function listRepositoryVersions(repositoryHint) {
  return findRepositories(repositoryHint).map((repo) => {
    const versions = new Set();
    for (const samplePath of collectVersionSampleFiles(repo.path)) {
      for (const version of collectVersionHints(samplePath)) {
        versions.add(version);
      }
    }
    return { name: repo.name, path: repo.path, versions: Array.from(versions).sort() };
  });
}

function summarizeInstallation(args) {
  const biHome = path.resolve(args.biHome);
  const projectPluginRoots = args.projectRoot ? discoverProjectPluginRoots(args.projectRoot) : [];
  const extraPluginRoots = Array.isArray(args.extraPluginRoots) ? args.extraPluginRoots.map((value) => path.resolve(value)) : [];
  const pluginRoots = [path.join(biHome, "plugins"), path.join(biHome, "dropins"), ...projectPluginRoots, ...extraPluginRoots]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => fs.existsSync(candidate));
  return { biHome, projectRoot: args.projectRoot || null, pluginRoots };
}

async function validateBixmlWithCore(args) {
  const repo = args.repository || args.repositoryPath || args.repositoryHint ? requireRepository(args) : null;
  const filePaths = Array.isArray(args.filePaths) ? args.filePaths : [];
  const relativePaths = Array.isArray(args.relativePaths) ? args.relativePaths : [];
  const resolvedFilePaths = [
    ...filePaths.map((filePath) => path.resolve(filePath)),
    ...relativePaths.map((relativePath) => path.resolve(repo.path, relativePath))
  ];
  const extraPluginRoots = [
    ...(args.projectRoot ? discoverProjectPluginRoots(args.projectRoot) : []),
    ...((Array.isArray(args.extraPluginRoots) ? args.extraPluginRoots : []).map((value) => path.resolve(value)))
  ];
  const metadata = await loadInstallationMetadata(args.biHome, extraPluginRoots);
  const results = [];
  for (const filePath of resolvedFilePaths) {
    results.push(await validateBixmlFile(filePath, metadata));
  }
  return { biHome: path.resolve(args.biHome), files: results, ok: results.every((result) => result.ok) };
}

function extractMutationPaths(result) {
  const values = new Set<string>();
  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      if (value.includes("\\") || value.includes("/") || value.toLowerCase().endsWith(".bixml")) {
        values.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(result);
  return Array.from(values).slice(0, 40);
}

async function formatBoundedMutationResult(toolName, repo, result) {
  const validation = validateRepositoryModel(
    await getCachedRepositoryModel(repo.path, {
      includeArtifacts: true,
      maxArtifacts: 1200,
      force: true
    })
  );

  return {
    tool: toolName,
    mode: "bounded-write",
    repository: repo.name,
    repositoryPath: repo.path,
    summary: {
      mutatedPathCount: extractMutationPaths(result).length,
      repositoryValidationOk: validation.ok,
      repositoryIssueCount: validation.issueCount
    },
    mutatedPaths: extractMutationPaths(result),
    result,
    repositoryValidation: validation
  };
}

function formatTextResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

async function handleToolCall(name, args) {
  switch (name) {
    case "find_repositories":
      return formatTextResult({ repositoryRoot: REPO_ROOT, candidates: findRepositories(args.repositoryHint) });
    case "activate_repository": {
      const repo = requireRepository(args);
      if (repo.status) {
        return formatTextResult(repo);
      }
      return formatTextResult({ activeRepository: setActiveRepository(repo) });
    }
    case "get_active_repository":
      return formatTextResult({ activeRepository: getActiveRepository() });
    case "prepare_repository": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(prepareRepository(repo, { force: args.force === true }));
    }
    case "describe_repository": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(summarizeRepository(repo));
    }
    case "describe_path": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(describePath(repo, args.relativePath));
    }
    case "search_repository": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult({
        repository: repo.name,
        repositoryPath: repo.path,
        query: args.query,
        matches: searchRepository(repo, args.query, args.maxResults || MAX_SEARCH_RESULTS)
      });
    }
    case "answer_repository_question": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(await answerRepositoryQuestion(repo, args.question, args.maxResults || 6));
    }
    case "answer_complex_question": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await answerComplexQuestion(repo, args.question, {
          maxResults: args.maxResults || 8,
          useCloud: args.useCloud !== false,
          model: args.model,
          reasoningEffort: args.reasoningEffort
        })
      );
    }
    case "list_repository_versions":
      return formatTextResult({ repositoryRoot: REPO_ROOT, repositories: listRepositoryVersions(args.repositoryHint) });
    case "extract_repository_model": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await getCachedRepositoryModel(repo.path, {
          includeArtifacts: args.includeArtifacts === true,
          maxArtifacts: args.maxArtifacts || 500,
          force: args.force === true
        })
      );
    }
    case "trace_artifact_links": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await traceRepositoryArtifacts(repo.path, args.query, {
          includeArtifacts: true,
          maxArtifacts: args.maxArtifacts || 1500
        })
      );
    }
    case "validate_repository_model": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        validateRepositoryModel(
          await getCachedRepositoryModel(repo.path, {
            includeArtifacts: true,
            maxArtifacts: args.maxArtifacts || 1200,
            force: args.force === true
          })
        )
      );
    }
    case "create_interface_operation": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_interface_operation",
          repo,
          await createInterfaceOperation(repo.path, args.project, args.operationName, {
            withResponse: args.withResponse !== false
          })
        )
      );
    }
    case "create_test_bixml": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_test_bixml",
          repo,
          await createTestBixmlFile(repo.path, args.project, args.fileRelativePath, {
            rootElement: args.rootElement,
            label: args.label,
            version: args.version
          })
        )
      );
    }
    case "create_case_form_workflow": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_case_form_workflow",
          repo,
          await createCaseFormWorkflow(repo.path, args.project, args.formName, args.questionLabels || [], {
            secure: args.secure === true,
            templateForm: args.templateForm,
            templateEvent: args.templateEvent
          })
        )
      );
    }
    case "create_web_application": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_web_application",
          repo,
          await createWebApplicationScaffold(
            repo.path,
            args.project,
            args.applicationName,
            args.applicationUriPart,
            args.initialTabName,
            args.initialTabUriPart,
            {
              userProvider: args.userProvider,
              loginMandatory: args.loginMandatory === true
            }
          )
        )
      );
    }
    case "create_portal_tab": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_portal_tab",
          repo,
          await createPortalTab(repo.path, args.project, args.tabName, args.tabUriPart, {
            secure: args.secure === true,
            layoutHint: args.layoutHint,
            webApplication: args.webApplication,
            datastoreListLinks: Array.isArray(args.datastoreListLinks) ? args.datastoreListLinks : [],
            caseViewLinks: Array.isArray(args.caseViewLinks) ? args.caseViewLinks : [],
            caseListLinks: Array.isArray(args.caseListLinks) ? args.caseListLinks : [],
            formTasks: Array.isArray(args.formTasks) ? args.formTasks : []
          })
        )
      );
    }
    case "create_case_list": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_case_list",
          repo,
          await createCaseList(repo.path, args.project, args.listName, args.uriPart, args.recordTypeLink, {
            createFormLink: args.createFormLink,
            updateFormLink: args.updateFormLink
          })
        )
      );
    }
    case "create_datastore_list": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await formatBoundedMutationResult(
          "create_datastore_list",
          repo,
          await createDatastoreList(repo.path, args.project, args.listName, args.uriPart, args.datastoreLink, {
            createFormLink: args.createFormLink,
            caseContextAttributeLink: args.caseContextAttributeLink
          })
        )
      );
    }
    case "inspect_installation":
      return formatTextResult(summarizeInstallation(args));
    case "validate_bixml":
      return formatTextResult(await validateBixmlWithCore(args));
    case "lint": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await lintRepository(repo.path, {
          project: args.project,
          rulesPath: args.rulesPath,
          maxArtifacts: args.maxArtifacts || 3000
        })
      );
    }
    case "describe_modeling_patterns": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await describeModelingPatterns(repo.path, {
          maxArtifacts: args.maxArtifacts || 2500,
          force: args.force === true
        })
      );
    }
    case "describe_interaction_patterns": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await describeInteractionPatterns(repo.path, {
          maxArtifacts: args.maxArtifacts || 2500,
          force: args.force === true
        })
      );
    }
    case "describe_case_model_patterns": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await describeCaseModelPatterns(repo.path, {
          maxArtifacts: args.maxArtifacts || 2500,
          force: args.force === true
        })
      );
    }
    case "describe_case_workflow_pattern": {
      const repo = requireRepository(args);
      if (repo.status) return formatTextResult(repo);
      return formatTextResult(
        await describeCaseWorkflowPattern(repo.path, args.project, {
          maxArtifacts: args.maxArtifacts || 2500,
          force: args.force === true
        })
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  try {
    switch (method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        sendResponse(id, { tools });
        return;
      case "tools/call":
        sendResponse(id, await handleToolCall(params.name, params.arguments || {}));
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    sendError(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export const processMcpMessage = async (message) => {
  const responses = [];
  const captureSend = (payload) => {
    responses.push(payload);
  };

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk) => {
    try {
      captureSend(typeof chunk === "string" ? JSON.parse(chunk.trim()) : chunk);
    } catch {}
    return true;
  }) as typeof process.stdout.write;

  try {
    await handleRequest(message);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  return responses;
};

export const startMcpServer = async (): Promise<void> => {
  ensureCacheDir();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let lineBreak = buffer.search(/\r?\n/);
    while (lineBreak >= 0) {
      const rawLine = buffer.slice(0, lineBreak);
      const separatorLength = buffer[lineBreak] === "\r" && buffer[lineBreak + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(lineBreak + separatorLength);
      const line = rawLine.trim();
      if (line) {
        try {
          void handleRequest(JSON.parse(line));
        } catch (error) {
          sendError(null, -32700, error instanceof Error ? error.message : String(error));
        }
      }
      lineBreak = buffer.search(/\r?\n/);
    }
  });
};

export const mcpInternals = {
  discoverRepositories,
  buildRepositoryIndex,
  prepareRepository,
  searchRepository,
  answerRepositoryQuestion,
  answerComplexQuestion,
  synthesizeRepositoryAnswer,
  summarizeRepository,
  listRepositoryVersions,
  getCachedRepositoryModel
};
