# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

For local defaults, copy `.env.example` to `.env`.

## Before Opening a PR

Run:

```bash
npm run build
npm test
```

## Public Documentation Rule

This repository is public. Keep examples generic.

Do:

- use placeholder repository names like `sample_beinformed_repo`
- use placeholder project names like `SC Sample`
- use placeholder paths like `C:\Users\<your-user>\...`

Do not:

- mention real customer repositories
- mention real customer names
- include local user profile paths
- include transcripts or analysis derived from non-public repositories

## MCP Changes

When changing MCP behavior:

1. keep tool descriptions explicit and bounded
2. prefer precise direct tools over ambiguous meta-tools
3. update README examples when the MCP surface changes
4. add or update tests in `tests/mcpServer.test.ts`
