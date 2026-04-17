import { readFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { InstallationMetadata, ValidationIssue, ValidationResult } from "./types.js";

type XmlNode = {
  "@_xmlns"?: string;
  [attributeName: `@_${string}`]: string | undefined;
  [key: string]: unknown;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false
});

const isAttributeName = (name: string): boolean => name.startsWith("@_");
const isProcessingInstruction = (name: string): boolean => name.startsWith("?");

const splitQualifiedName = (qualifiedName: string): { prefix?: string; localName: string } => {
  const [prefix, localName] = qualifiedName.includes(":")
    ? qualifiedName.split(":", 2)
    : [undefined, qualifiedName];

  return {
    prefix,
    localName: localName ?? qualifiedName
  };
};

const getNamespaceUri = (attributes: Record<string, string>, prefix?: string): string | undefined => {
  const key = prefix ? `xmlns:${prefix}` : "xmlns";
  return attributes[key];
};

const toPath = (segments: string[]): string => segments.join("/");

const validateNode = (
  nodeName: string,
  nodeValue: unknown,
  pathSegments: string[],
  metadata: InstallationMetadata,
  issues: ValidationIssue[],
  inheritedNamespaces: Record<string, string>
): void => {
  const { prefix, localName } = splitQualifiedName(nodeName);

  if (!metadata.knownElementNames.has(localName)) {
    issues.push({
      message: `Unknown element "${nodeName}"`,
      path: toPath(pathSegments)
    });
  }

  if (typeof nodeValue !== "object" || nodeValue === null || Array.isArray(nodeValue)) {
    if (prefix !== undefined && !inheritedNamespaces[prefix]) {
      issues.push({
        message: `Missing namespace declaration for prefix "${prefix}"`,
        path: toPath(pathSegments)
      });
    }

    return;
  }

  const xmlNode = nodeValue as XmlNode;
  const attributes = Object.fromEntries(
    Object.entries(xmlNode)
      .filter(([name, value]) => isAttributeName(name) && typeof value === "string")
      .map(([name, value]) => [name.slice(2), value])
  ) as Record<string, string>;
  const namespaces = { ...inheritedNamespaces };

  for (const [attributeName, attributeValue] of Object.entries(attributes)) {
    if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) {
      const namespacePrefix = attributeName === "xmlns" ? "" : attributeName.slice("xmlns:".length);
      namespaces[namespacePrefix] = attributeValue;

      if (!metadata.knownNamespaces.has(attributeValue)) {
        issues.push({
          message: `Unknown Be Informed namespace URI "${attributeValue}"`,
          path: toPath(pathSegments)
        });
      }

      continue;
    }

    const { localName } = splitQualifiedName(attributeName);

    if (attributeName.startsWith("xml:")) {
      continue;
    }

    if (!metadata.knownAttributeNames.has(localName)) {
      issues.push({
        message: `Unknown attribute "${attributeName}"`,
        path: toPath(pathSegments)
      });
    }
  }

  if (prefix !== undefined) {
    const namespaceUri = getNamespaceUri(attributes, prefix) ?? namespaces[prefix];

    if (!namespaceUri) {
      issues.push({
        message: `Missing namespace declaration for prefix "${prefix}"`,
        path: toPath(pathSegments)
      });
    }
  }

  for (const [childName, childValue] of Object.entries(xmlNode)) {
    if (isAttributeName(childName) || childName === "#text" || isProcessingInstruction(childName)) {
      continue;
    }

    const childNodes = Array.isArray(childValue) ? childValue : [childValue];

    for (const childNode of childNodes) {
      validateNode(childName, childNode, [...pathSegments, childName], metadata, issues, namespaces);
    }
  }
};

export const validateBixmlFile = async (
  filePath: string,
  metadata: InstallationMetadata
): Promise<ValidationResult> => {
  const xmlText = await readFile(filePath, "utf8");
  const syntaxResult = XMLValidator.validate(xmlText, { allowBooleanAttributes: true });

  if (syntaxResult !== true) {
    return {
      filePath,
      ok: false,
      issues: [
        {
          message: `Malformed XML: ${syntaxResult.err.msg}`,
          path: path.basename(filePath)
        }
      ]
    };
  }

  const parsed = parser.parse(xmlText) as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  for (const [nodeName, nodeValue] of Object.entries(parsed)) {
    if (!isProcessingInstruction(nodeName)) {
      validateNode(nodeName, nodeValue, [nodeName], metadata, issues, {});
    }
  }

  return {
    filePath,
    ok: issues.length === 0,
    issues
  };
};
