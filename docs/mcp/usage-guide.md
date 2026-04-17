# MCP Usage Guide

This guide describes how to use the embedded `beinformed-repository-mcp` server in a public-safe way.

## Purpose

The MCP server exposes repository-grounded Be Informed tools for:

- repository discovery
- repository activation
- repository search
- repository-grounded question answering
- repository-model extraction and validation
- bounded creation tools

## Typical Flow

1. find a repository
2. activate it
3. warm the caches
4. ask questions or call bounded write tools

Example sequence:

```json
{ "name": "find_repositories", "arguments": { "repositoryHint": "sample" } }
```

```json
{ "name": "activate_repository", "arguments": { "repository": "sample_beinformed_repo" } }
```

```json
{ "name": "prepare_repository", "arguments": { "repository": "sample_beinformed_repo" } }
```

```json
{
  "name": "answer_repository_question",
  "arguments": {
    "repository": "sample_beinformed_repo",
    "question": "Explain the repository architecture"
  }
}
```

## Example Questions

- `Where is the main case model defined?`
- `Explain the repository architecture`
- `Which files define the web application structure?`
- `Trace the links for the portal home tab`
- `Describe the case workflow pattern in project SC Sample`

## Notes

- `prepare_repository` is the preferred warm-up tool before complex Q&A.
- Use direct bounded creation tools when the desired artifact type is already clear.
- Use `.env` for shared local defaults like `BI_REPO_ROOT` and `BE_INFORMED_HOME`.
- Keep project-specific repository names, customer names, and local user paths out of checked-in examples.
