# Demo Preparation

This file contains a generic public-safe checklist for preparing one sample Be Informed repository for an MCP demo.

## Goal

Prepare one sample repository for a live MCP walkthrough without checking in customer-specific data.

## Checklist

1. confirm `.env` contains:
   - `BI_REPO_ROOT`
   - `BE_INFORMED_HOME`
   - optional `OPENROUTER_*`
2. build the project:
   - `npm install`
   - `npm run build`
   - `npm test`
3. start the MCP server:
   - `node dist/src/index.js mcp-server`
4. warm the sample repository:
   - `find_repositories`
   - `activate_repository`
   - `prepare_repository`
5. run public-safe example questions:
   - `Explain the repository architecture`
   - `Describe the case model patterns`
   - `Trace the sample portal tab`

## Public-Safe Rule

Do not commit:

- real repository names
- customer names
- local user profile paths
- customer-specific question/answer transcripts
