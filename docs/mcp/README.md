# BeInformed Repository MCP Server Documentation

This folder contains documentation for the BeInformed Repository MCP (Model Context Protocol) server.

## What is MCP?

MCP (Model Context Protocol) is a standard protocol that connects AI assistants with external tools and data sources. The BeInformed Repository MCP server provides specialized tools for analyzing BeInformed repositories.

## Documentation Files

### [usage-guide.md](./usage-guide.md)
Complete guide on how to use the BeInformed Repository MCP server, including:
- What MCP is and how it works
- Available MCP tools and their usage
- Architecture diagrams
- Real-world examples from actual usage
- Step-by-step tool call examples

**Audience:** Developers, AI users, anyone wanting to understand MCP capabilities

### [demo-prep-servicecatalog.md](./demo-prep-servicecatalog.md)
Demo preparation guide for the servicecatalog repository, including:
- Cache warming procedures
- 15 tested demo questions with expected answers
- Performance benchmarks
- Demo script suggestions
- Troubleshooting tips

**Audience:** Demo presenters, stakeholders, technical leads

## Quick Start

### Using the MCP Server

The MCP server is configured in Windsurf's MCP config file:
```
C:\Users\guido.hollander\.codeium\windsurf\mcp_config.json
```

### Available Tools

- `mcp0_list_repositories` - List all BeInformed repositories
- `mcp0_find_repositories` - Find repositories by name/pattern
- `mcp0_describe_repository` - Get repository details
- `mcp0_prepare_repository` - Warm cache for fast queries
- `mcp0_answer_repository_question` - Ask questions about repository
- `mcp0_search_repository` - Full-text search
- `mcp0_list_repository_versions` - Detect BeInformed versions
- And more...

### Example Usage

```javascript
// List all repositories
mcp0_list_repositories()

// Warm cache for a repository
mcp0_prepare_repository({ 
  repository: "servicecatalog", 
  force: true 
})

// Ask a question
mcp0_answer_repository_question({
  repository: "servicecatalog",
  question: "What is the architecture of this application?",
  maxResults: 15
})
```

## Repository Location

All BeInformed repositories are located in:
```
C:\repo\
```

## Cache Location

MCP cache files are stored in:
```
C:\Users\guido.hollander\AppData\Local\Programs\Windsurf\.bicli-cache\
```

## Related Documentation

- [Main bicli README](../../README.md) - Project overview
- [Canon docs](../canon/) - Canonical documentation
- [Changes](../changes/) - Change logs
- [Tickets](../tickets/) - Issue tracking

## Support

For questions or issues with the MCP server, contact the BeInformed Repository MCP development team.

---

**Last Updated:** April 17, 2026  
**Version:** 1.0
