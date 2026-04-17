# bicli

`bicli` is a rule-based CLI validator for Be Informed `.bixml` files.

It inspects the Be Informed installation, extracts namespace and Castor mapping metadata from plugin JARs, and validates one or more `.bixml` files without launching Be Informed Studio.

`bicli` now also contains the repository-grounded MCP server. The sibling `bimcp` workspace remains only as a compatibility launcher. In this split:

- `bicli` owns validation, repository modeling, repository Q&A, and MCP tool transport
- `bimcp` forwards to `bicli mcp-server` so there is one shared engine and one warm-cache path

The current internal target representation for multi-version Be Informed modeling is documented in:

- `docs/canon/be-informed-representation.md`
- `docs/canon/repository-version-survey.md`
- `docs/canon/lint-rules-example.md`

## Status

This first version is intentionally narrower than Studio:

- It validates XML well-formedness.
- It validates Be Informed namespaces discovered from `plugin.xml`.
- It validates element and attribute usage against shipped `*-mapping.xml` files.
- It does not yet run full Be Informed project consistency checks.

## Environment

Copy `.env.example` to `.env` and adjust the values for the local machine.

Recommended Windows collaborator setup:

```env
BI_REPO_ROOT=C:\repo
BE_INFORMED_HOME=C:\bi\Be Informed AMS 23.2.9

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_MODEL=minimax/minimax-m2.7
OPENROUTER_REASONING_EFFORT=medium
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=Be Informed MCP
```

Notes:

- `BE_INFORMED_HOME` is the preferred default installation path for CLI and MCP validation flows.
- `BI_REPO_ROOT` controls repository discovery for MCP tools.
- `OPENROUTER_API_KEY` is optional. Leave it empty for local grounded answers only.
- The remaining `OPENROUTER_*` variables are the shared prefix configuration for cloud-augmented answers.

## Installation

Windows prerequisites:

- `git`
- Node.js `20+`
- npm
- a local Be Informed installation if you want CLI or MCP validation flows
- one or more local Be Informed repositories if you want repository-model or MCP features

Clone and install:

```bash
git clone https://github.com/guidohollander/bicli.git
cd bicli
npm install
npm run build
npm test
```

Optional global development commands on Windows:

```bash
npm run link:global
```

This exposes:

- `bicli`
  Requires a fresh `npm run build` after source changes.
- `bicli-dev`
  Runs directly from `src/index.ts` and always reflects current source code.

## Getting Started

Fastest path on Windows:

1. copy `.env.example` to `.env`
2. set `BI_REPO_ROOT` and `BE_INFORMED_HOME`
3. run `npm install`
4. run `npm run build`
5. run `npm test`
6. choose one path:
   - CLI: run `node dist/src/index.js validate ...`
   - MCP: run `node dist/src/index.js mcp-server`

Recommended first CLI command:

```bash
node dist/src/index.js validate "C:\\path\\to\\file.bixml"
```

Recommended first MCP sequence:

1. `find_repositories`
2. `activate_repository`
3. `prepare_repository`
4. `answer_repository_question`

## CLI

Validate one file:

```bash
node dist/src/index.js validate "C:\\path\\to\\file.bixml" --be-informed-home "C:\\bi\\Be Informed AMS 23.2.9"
```

Validate multiple files:

```bash
node dist/src/index.js validate a.bixml b.bixml c.bixml --be-informed-home "C:\\bi\\Be Informed AMS 23.2.9"
```

Validate with project-specific plugin discovery:

```bash
node dist/src/index.js validate "C:\\repo\\sample_beinformed_repo\\some-file.bixml" --project-root "C:\\repo\\sample_beinformed_repo"
```

Inspect a repository model:

```bash
node dist/src/index.js inspect-repository "C:\\repo\\sample_beinformed_repo" --max-artifacts 300
```

Trace one artifact:

```bash
node dist/src/index.js trace-artifact "C:\\repo\\sample_beinformed_repo" "Sample portal tab" --max-artifacts 800
```

Validate repository-model coherence:

```bash
node dist/src/index.js validate-repository-model "C:\\repo\\sample_beinformed_repo" --max-artifacts 1200
```

Lint repository conventions:

```bash
node dist/src/index.js lint "C:\\repo\\sample_beinformed_repo"
```

Create one bounded interface operation:

```bash
node dist/src/index.js create-interface-operation "C:\\repo\\sample_beinformed_repo" "SC Sample - Interface definitions" "getSample"
```

Create one bounded `_Case` workflow:

```bash
node dist/src/index.js create-case-form-workflow "C:\\repo\\sample_beinformed_repo" "SC Sample" "Register Sample" "Capture Sample details" "Confirm Sample data"
```

Create one bounded test BIXML file:

```bash
node dist/src/index.js create-test-bixml "C:\\repo\\sample_beinformed_repo" "SC Library" "Tests\\Example test artifact.bixml" --root-element attributegroup --label "Example test artifact"
```

## MCP

Run the embedded MCP server over stdio:

```bash
node dist/src/index.js mcp-server
```

The embedded MCP server now exposes:

- repository discovery and activation
- repository search and repository-grounded Q&A
- repository-model extraction, trace, and validation
- pattern summaries for modeling, interaction, case model, and `_Case` workflows
- bounded creation tools for interface operations, test BIXML, `_Case` workflows, web applications, tabs, case lists, and datastore lists

Recommended MCP warm-up flow:

1. `find_repositories`
2. `activate_repository`
3. `prepare_repository`
4. ask architecture/modeling questions with `answer_repository_question` or `answer_complex_question`

`prepare_repository` builds the persistent text index and warms repository-model caches so complex business and technical questions are slower cold but much faster once warm.

### Windsurf

Windsurf MCP config:

`C:\Users\<your-user>\.codeium\windsurf\mcp_config.json`

Example:

```json
{
  "mcpServers": {
    "beinformed-repository-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\bicli\\dist\\src\\index.js", "mcp-server"]
    }
  }
}
```

After updating the config:

1. restart Windsurf
2. select or activate a repository
3. call `prepare_repository`
4. ask grounded repository questions or use bounded creation tools

### PI Agentic Harness

If PI Agentic Harness accepts stdio MCP server definitions, point it at the same command:

```json
{
  "command": "node",
  "args": ["C:\\path\\to\\bicli\\dist\\src\\index.js", "mcp-server"]
}
```

Use the same `.env` file so PI sees:

- `BI_REPO_ROOT`
- `BE_INFORMED_HOME`
- optional `OPENROUTER_*` settings

### Claude Code

Claude Code supports MCP over stdio. The current documented approaches are:

1. add the server with the `claude mcp add` command
2. or check in a project-scoped `.mcp.json`

Project-scoped add command:

```bash
claude mcp add --transport stdio --scope project beinformed-repository-mcp -- node C:\path\to\bicli\dist\src\index.js mcp-server
```

Equivalent project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "beinformed-repository-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\bicli\\dist\\src\\index.js", "mcp-server"],
      "env": {
        "BI_REPO_ROOT": "C:\\repo",
        "BE_INFORMED_HOME": "C:\\bi\\Be Informed AMS 23.2.9"
      }
    }
  }
}
```

Notes:

- Claude Code project-scoped MCP config is intended for team sharing.
- The official docs describe project-scoped servers in `.mcp.json`.
- After adding the server, use `/mcp` inside Claude Code to inspect server status.
- If `node` or `claude` is not on `PATH`, use the full executable path.

### MCP Example Calls

- `find_repositories` with `repositoryHint: "mts"`
- `answer_repository_question` with `repository: "sample_beinformed_repo"` and `question: "Explain the repository architecture"`
- `trace_artifact_links` with `repository: "sample_beinformed_repo"` and `query: "Sample portal tab"`
- `describe_case_model_patterns` with `repository: "sample_beinformed_repo"`
- `create_interface_operation` with `repository: "sample_beinformed_repo"`, `project: "SC Sample - Interface definitions"`, `operationName: "getSample"`

### Example MCP Questions

- `Explain the repository architecture`
- `Where is the main case model defined?`
- `Which files define the web application structure?`
- `Describe the case workflow pattern in project SC Sample`
- `Trace the links for the sample portal tab`
- `What does the interface layer look like in this repository?`

For MCP-driven repository changes, prefer the direct bounded creation tools. The current end-to-end slices include interface-operation creation and bounded `_Case` form/event/question/data creation.

## Windows executable

Build a standalone Windows executable:

```bash
npm run build:win-exe
```

Output:

```text
release\bicli.exe
```
