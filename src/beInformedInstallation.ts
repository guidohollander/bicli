import AdmZip from "adm-zip";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

import type { InstallationMetadata, MappingClass, MappingField } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false
});
const metadataCache = new Map<string, Promise<InstallationMetadata>>();

type XmlNode = Record<string, unknown>;
type JarFileInfo = {
  path: string;
  mtimeMs: number;
  size: number;
};
type InstallationMetadataCacheFile = {
  jarFiles: JarFileInfo[];
  metadata: {
    classes: MappingClass[];
    knownElementNames: string[];
    knownAttributeNames: string[];
    knownNamespaces: string[];
  };
};

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const isJarFile = (filePath: string): boolean => filePath.toLowerCase().endsWith(".jar");

const collectJarFiles = async (rootPath: string): Promise<JarFileInfo[]> => {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const jarFiles: JarFileInfo[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      jarFiles.push(...(await collectJarFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isJarFile(entryPath)) {
      const fileStat = await stat(entryPath);
      jarFiles.push({
        path: entryPath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size
      });
    }
  }

  return jarFiles;
};

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    await access(directoryPath);
    return true;
  } catch {
    return false;
  }
};

export const discoverProjectPluginRoots = async (projectRoot: string): Promise<string[]> => {
  const candidateDirectories = [
    path.join(projectRoot, ".metadata", "additionalPlugins", "eclipse", "plugins"),
    path.join(projectRoot, "_CONTINUOUS_DELIVERY", "_STUDIO", "PLUGINS"),
    path.join(projectRoot, "_CONTINUOUS_DELIVERY", "_GENERAL", "CUSTOM_PLUGINS", "default")
  ];
  const discoveredDirectories: string[] = [];

  for (const candidateDirectory of candidateDirectories) {
    if (await directoryExists(candidateDirectory)) {
      discoveredDirectories.push(candidateDirectory);
    }
  }

  return discoveredDirectories;
};

const getText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  return undefined;
};

const deriveDefaultChildName = (fieldName: string): string => fieldName.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
const deriveClassXmlName = (className: string): string => {
  const simpleName = className.split(".").at(-1) ?? className;

  return simpleName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
};

const parseField = (fieldNode: XmlNode): MappingField => {
  const bindXmlNode = typeof fieldNode["bind-xml"] === "object" && fieldNode["bind-xml"] !== null
    ? (fieldNode["bind-xml"] as XmlNode)
    : undefined;
  const bindName = getText(bindXmlNode?.["@_name"]);
  const nodeType = getText(bindXmlNode?.["@_node"]);
  const autoNaming = getText(bindXmlNode?.["@_auto-naming"]);
  const fieldName = getText(fieldNode["@_name"]) ?? "unknown";

  const explicitName = bindName ?? deriveDefaultChildName(fieldName);
  const childNames = nodeType === "attribute" ? [] : [explicitName];

  if (autoNaming === "deriveByClass") {
    return {
      name: fieldName,
      attributeNames: [],
      childNames
    };
  }

  return {
    name: fieldName,
    attributeNames: nodeType === "attribute" ? [explicitName] : [],
    childNames
  };
};

const parseMappingXml = (xmlText: string): MappingClass[] => {
  const document = parser.parse(xmlText) as XmlNode;
  const mappingRoot = document.mapping as XmlNode | undefined;

  if (!mappingRoot) {
    return [];
  }

  return asArray(mappingRoot.class as XmlNode[] | XmlNode | undefined).map((classNode) => {
    const mapToNode = typeof classNode["map-to"] === "object" && classNode["map-to"] !== null
      ? (classNode["map-to"] as XmlNode)
      : undefined;
    const xmlName = getText(mapToNode?.["@_xml"]);
    const fields = asArray(classNode.field as XmlNode[] | XmlNode | undefined).map(parseField);

    return {
      name: getText(classNode["@_name"]) ?? "unknown",
      xmlNames: [xmlName ?? deriveClassXmlName(getText(classNode["@_name"]) ?? "unknown")],
      extendsName: getText(classNode["@_extends"]),
      fields
    };
  });
};

const parsePluginXmlNamespaces = (xmlText: string): string[] => {
  const document = parser.parse(xmlText) as XmlNode;
  const pluginRoot = document.plugin as XmlNode | undefined;

  if (!pluginRoot) {
    return [];
  }

  return asArray(pluginRoot.extension as XmlNode[] | XmlNode | undefined)
    .filter((extensionNode) => getText(extensionNode["@_point"]) === "nl.beinformed.bi.core.configuration.namespace")
    .flatMap((extensionNode) => asArray(extensionNode.uri as XmlNode[] | XmlNode | undefined))
    .map((uriNode) => getText(uriNode["@_uri"]))
    .filter((uri): uri is string => Boolean(uri));
};

const loadJarEntries = (jarPath: string): { classes: MappingClass[]; namespaces: string[] } => {
  const zip = new AdmZip(jarPath);
  const classes: MappingClass[] = [];
  const namespaces: string[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith("mapping.xml")) {
      classes.push(...parseMappingXml(entry.getData().toString("utf8")));
    }

    if (entry.entryName === "plugin.xml") {
      namespaces.push(...parsePluginXmlNamespaces(entry.getData().toString("utf8")));
    }
  }

  return { classes, namespaces };
};

const toSerializableMetadata = (metadata: InstallationMetadata): InstallationMetadataCacheFile["metadata"] => ({
  classes: metadata.classes,
  knownElementNames: [...metadata.knownElementNames].sort(),
  knownAttributeNames: [...metadata.knownAttributeNames].sort(),
  knownNamespaces: [...metadata.knownNamespaces].sort()
});

const fromSerializableMetadata = (
  metadata: InstallationMetadataCacheFile["metadata"]
): InstallationMetadata => ({
  classes: metadata.classes,
  knownElementNames: new Set(metadata.knownElementNames),
  knownAttributeNames: new Set(metadata.knownAttributeNames),
  knownNamespaces: new Set(metadata.knownNamespaces)
});

const getInstallationCachePath = (biHome: string, extraPluginRoots: string[]): string => {
  const cacheKey = createHash("sha1")
    .update(
      JSON.stringify({
        biHome: path.resolve(biHome),
        extraPluginRoots: extraPluginRoots.map((pluginRoot) => path.resolve(pluginRoot)).sort()
      })
    )
    .digest("hex");

  return path.join(os.tmpdir(), "bicli-cache", `${cacheKey}.json`);
};

const jarFileListsMatch = (left: JarFileInfo[], right: JarFileInfo[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftJar, index) => {
    const rightJar = right[index];

    return leftJar.path === rightJar?.path
      && leftJar.mtimeMs === rightJar.mtimeMs
      && leftJar.size === rightJar.size;
  });
};

const readCachedMetadata = async (
  cacheFilePath: string,
  jarFiles: JarFileInfo[]
): Promise<InstallationMetadata | undefined> => {
  try {
    const cacheText = await readFile(cacheFilePath, "utf8");
    const cacheData = JSON.parse(cacheText) as InstallationMetadataCacheFile;

    if (!jarFileListsMatch(cacheData.jarFiles, jarFiles)) {
      return undefined;
    }

    return fromSerializableMetadata(cacheData.metadata);
  } catch {
    return undefined;
  }
};

const writeCachedMetadata = async (
  cacheFilePath: string,
  jarFiles: JarFileInfo[],
  metadata: InstallationMetadata
): Promise<void> => {
  const cacheDirectory = path.dirname(cacheFilePath);
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    cacheFilePath,
    JSON.stringify(
      {
        jarFiles,
        metadata: toSerializableMetadata(metadata)
      } satisfies InstallationMetadataCacheFile,
      null,
      2
    ),
    "utf8"
  );
};

export const loadInstallationMetadata = async (
  biHome: string,
  extraPluginRoots: string[] = []
): Promise<InstallationMetadata> => {
  const cacheKey = JSON.stringify({
    biHome,
    extraPluginRoots: [...extraPluginRoots].sort()
  });
  const cachedMetadata = metadataCache.get(cacheKey);

  if (cachedMetadata) {
    return cachedMetadata;
  }

  const metadataPromise = (async () => {
  const biHomeStat = await stat(biHome);

  if (!biHomeStat.isDirectory()) {
    throw new Error(`Be Informed home is not a directory: ${biHome}`);
  }

  const pluginRoots = [path.join(biHome, "plugins"), path.join(biHome, "dropins"), ...extraPluginRoots];
  const jarFiles = (
    await Promise.all(pluginRoots.map(async (pluginRoot) => (await directoryExists(pluginRoot) ? collectJarFiles(pluginRoot) : [])))
  ).flat().sort((left, right) => left.path.localeCompare(right.path));
  const cacheFilePath = getInstallationCachePath(biHome, extraPluginRoots);
  const cachedMetadata = await readCachedMetadata(cacheFilePath, jarFiles);

  if (cachedMetadata) {
    return cachedMetadata;
  }

  const classes: MappingClass[] = [];
  const knownNamespaces = new Set<string>();
  const knownElementNames = new Set<string>();
  const knownAttributeNames = new Set<string>();

  for (const jarFile of jarFiles) {
    const jarData = loadJarEntries(jarFile.path);
    classes.push(...jarData.classes);

    for (const namespace of jarData.namespaces) {
      knownNamespaces.add(namespace);
    }
  }

  for (const mappingClass of classes) {
    for (const xmlName of mappingClass.xmlNames) {
      knownElementNames.add(xmlName);
    }

    for (const field of mappingClass.fields) {
      for (const childName of field.childNames) {
        knownElementNames.add(childName);
      }

      for (const attributeName of field.attributeNames) {
        knownAttributeNames.add(attributeName);
      }
    }
  }

  const metadata = {
    classes,
    knownElementNames,
    knownAttributeNames,
    knownNamespaces
  };

  await writeCachedMetadata(cacheFilePath, jarFiles, metadata);

  return metadata;
  })();

  metadataCache.set(cacheKey, metadataPromise);

  return metadataPromise;
};
