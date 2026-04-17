# BeInformed Repository MCP Server - Usage Guide

## What is MCP (Model Context Protocol)?

MCP is a standard protocol that connects AI assistants (like Cascade) with external tools and data sources. Think of it as a bridge that allows the AI to access specialized functions beyond its built-in capabilities.

## The BeInformed Repository MCP Server

The `beinformed-repository-mcp` server provides specialized tools for analyzing BeInformed repositories, including:
- Repository discovery and listing
- Version detection from BIXML files
- Repository structure analysis
- Content search and question answering

## How We Used It in This Conversation

### 1. Listing All Repositories

**User Request:** "list all mts repos in c:\repos"

**MCP Tool Used:** `mcp0_list_repositories`

**What Happened:**
```javascript
// Cascade called this MCP function
mcp0_list_repositories()

// MCP server scanned C:\repo and returned:
{
  "repositoryRoot": "C:\\repo",
  "repositories": [
    {
      "name": "aia_mts",
      "path": "C:\\repo\\aia_mts",
      "projectCount": 203,
      "bixmlCount": 1430
    },
    {
      "name": "gd_mts",
      "path": "C:\\repo\\gd_mts",
      "projectCount": 239,
      "bixmlCount": 1706
    },
    // ... more repositories
  ]
}
```

**Result:** Found 9 MTS repositories with their statistics

---

### 2. Finding Specific Repositories

**User Request:** "find all repositories about mts"

**MCP Tool Used:** `mcp0_find_repositories`

**What Happened:**
```javascript
// Cascade called with a hint
mcp0_find_repositories({
  repositoryHint: "mts"
})

// MCP server filtered repositories matching "mts":
{
  "candidates": [
    { "name": "aia_mts", "projectCount": 203, "bixmlCount": 1430 },
    { "name": "gd_mts", "projectCount": 239, "bixmlCount": 1706 },
    { "name": "gd_mts-pfix", "projectCount": 235, "bixmlCount": 1703 },
    { "name": "png_mts", "projectCount": 236, "bixmlCount": 1639 },
    { "name": "skn_mts", "projectCount": 219, "bixmlCount": 1602 },
    { "name": "vct_mts", "projectCount": 236, "bixmlCount": 1637 }
  ]
}
```

**Result:** Filtered list of only MTS-related repositories

---

### 3. Detecting BeInformed Versions

**User Request:** "tell me in what version of beinformed they were built"

**MCP Tool Used:** `mcp0_list_repository_versions`

**What Happened:**
```javascript
// Cascade called with repository hint
mcp0_list_repository_versions({
  repositoryHint: "mts"
})

// MCP server scanned BIXML files and extracted version from XML headers:
// <?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>

// Returned version analysis:
{
  "repositories": [
    {
      "repository": "aia_mts",
      "dominantVersion": "23.2.6.202501081215",
      "versions": [
        { "version": "23.2.6.202501081215", "fileCount": 8 },
        { "version": "23.2.5.202412131027", "fileCount": 2 },
        { "version": "23.2.2.2", "fileCount": 1 }
      ]
    },
    {
      "repository": "gd_mts",
      "dominantVersion": "23.2.6.202501081215",
      "versions": [
        { "version": "23.2.6.202501081215", "fileCount": 10 }
      ]
    }
    // ... more repositories
  ]
}
```

**Result:** Complete version breakdown showing:
- Most repositories use BeInformed 23.2.6 (January 2025)
- Some have mixed versions
- One repository (skn_mts) still on 23.2.5

---

### 4. Answering Repository Questions

**User Request:** "focus on gd_mts. What tax types are supported?"

**MCP Tool Used:** `mcp0_answer_repository_question`

**What Happened:**
```javascript
// Cascade asked a complex question
mcp0_answer_repository_question({
  repository: "gd_mts",
  question: "What tax types are supported in this repository? List all tax types, tax type configurations, and domain-specific tax implementations.",
  maxResults: 20
})

// MCP server:
// 1. Analyzed the question
// 2. Searched through 1,706 BIXML files
// 3. Found relevant files and snippets
// 4. Ranked results by relevance

// Returned matches with context:
{
  "repository": "gd_mts",
  "matches": [
    {
      "filePath": "C:\\repo\\gd_mts\\SC Tax Types\\Behavior\\Data\\Datastores\\Load tax types.bixml",
      "score": 172,
      "snippet": "formed.bi.common.attributes_23.2.6.202501081215?><?plugin nl.beinformed.bi.casemanagement_23.2.6.202501081215?><datastore> <label>Load tax types</label>..."
    },
    // ... 19 more relevant files
  ]
}
```

**Result:** Identified 9 tax types including:
- Corporate Income Tax (CIT)
- Personal Income Tax (PIT)
- Goods and Services Tax (GST)
- Pay As You Earn (PAYE)
- Property Tax (PRT)
- Withholding Tax (WHT)
- Annual Stamp Tax (AST)
- Interim Stabilization Levy (ISL)
- Property Valuation

---

### 5. Searching Repository Content

**MCP Tool Used:** `mcp0_search_repository`

**What Happened:**
```javascript
// Cascade searched for specific patterns
mcp0_search_repository({
  repository: "gd_mts",
  query: "DSC tax type domain specific configuration",
  maxResults: 30
})

// MCP server performed full-text search across all files
// Returned ranked results with snippets showing context
```

**Result:** Found all domain-specific tax type implementations (DSC modules)

---

## How MCP Works Behind the Scenes

### Architecture

```
┌─────────────────┐
│   Windsurf IDE  │
│   (User)        │
└────────┬────────┘
         │
         │ User asks question
         │
┌────────▼────────┐
│   Cascade AI    │
│   (Assistant)   │
└────────┬────────┘
         │
         │ Calls MCP tool
         │ (e.g., mcp0_list_repositories)
         │
┌────────▼────────────────────┐
│  MCP Server                 │
│  (beinformed-repository-mcp)│
│                             │
│  - Scans C:\repo            │
│  - Reads BIXML files        │
│  - Extracts versions        │
│  - Searches content         │
│  - Analyzes structure       │
└────────┬────────────────────┘
         │
         │ Returns structured data
         │
┌────────▼────────┐
│   Cascade AI    │
│   Interprets    │
│   & Formats     │
└────────┬────────┘
         │
         │ Presents results
         │
┌────────▼────────┐
│   User sees     │
│   formatted     │
│   answer        │
└─────────────────┘
```

### Configuration

The MCP server is configured in:
```
C:\Users\guido.hollander\.codeium\windsurf\mcp_config.json
```

This file tells Windsurf:
- Which MCP servers are available
- How to connect to them
- What tools they provide

### Available MCP Tools

From the `beinformed-repository-mcp` server:

1. **mcp0_list_repositories**
   - Lists all BeInformed repositories
   - Returns: name, path, project count, BIXML count

2. **mcp0_find_repositories**
   - Filters repositories by hint/pattern
   - Returns: matching repositories only

3. **mcp0_describe_repository**
   - Detailed repository summary
   - Returns: structure, projects, configuration

4. **mcp0_describe_path**
   - Explains a specific file or directory
   - Returns: purpose, content summary

5. **mcp0_list_repository_versions**
   - Scans BIXML files for BeInformed versions
   - Returns: version breakdown per repository

6. **mcp0_answer_repository_question**
   - Natural language question answering
   - Returns: relevant files and snippets

7. **mcp0_search_repository**
   - Full-text search across repository
   - Returns: ranked search results

8. **mcp0_answer_complex_question**
   - Advanced question answering with AI augmentation
   - Returns: synthesized answer with evidence

---

## Key Advantages of Using MCP

### 1. **Specialized Knowledge**
- The MCP server understands BeInformed repository structure
- Knows how to parse BIXML files
- Can extract version information from XML headers

### 2. **Efficient Scanning**
- Can quickly scan thousands of files
- Indexes content for fast searching
- Caches results for performance

### 3. **Structured Data**
- Returns JSON data that Cascade can process
- Provides scores and rankings
- Includes file paths and snippets

### 4. **Context-Aware**
- Understands BeInformed-specific concepts
- Knows about projects, datastores, tax types
- Can answer domain-specific questions

---

## Example: Version Detection Deep Dive

### How the MCP Server Detects Versions

**Step 1:** User asks about versions
```
User: "tell me in what version of beinformed they were built"
```

**Step 2:** Cascade calls MCP tool
```javascript
mcp0_list_repository_versions({ repositoryHint: "mts" })
```

**Step 3:** MCP server executes
```
1. Find all repositories matching "mts"
2. For each repository:
   a. Sample 10 random BIXML files
   b. Read first line of each file
   c. Parse XML plugin declarations
   d. Extract version numbers using regex:
      <?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
                                            ^^^^^^^^^^^^^^^^^^^^
   e. Count occurrences of each version
   f. Determine dominant version
3. Return structured results
```

**Step 4:** MCP returns data
```json
{
  "repository": "gd_mts",
  "dominantVersion": "23.2.6.202501081215",
  "versionCount": 1,
  "versions": [
    {
      "version": "23.2.6.202501081215",
      "fileCount": 10,
      "sampleFiles": [
        "SC License application parameters\\Behaviour\\License fee category\\License fee category case list.bixml",
        "SC Batch Processing\\0000 Definition\\0200 Taxonomies\\Mode.bixml"
      ]
    }
  ]
}
```

**Step 5:** Cascade formats for user
```markdown
## GD_MTS - BeInformed Version

**Primary Version:** 23.2.6.202501081215 (January 8, 2025)
- All 10 sampled files use this version
- Repository: 239 projects, 1,706 BIXML files
```

---

## Why This is Powerful

### Without MCP:
```
User: "What BeInformed version is gd_mts using?"

Cascade would need to:
1. List files manually
2. Read each file
3. Parse XML
4. Extract versions
5. Count and analyze

Result: Slow, error-prone, limited by token budget
```

### With MCP:
```
User: "What BeInformed version is gd_mts using?"

Cascade calls: mcp0_list_repository_versions({ repository: "gd_mts" })

MCP server: Does all the work efficiently
Returns: Structured, analyzed data

Result: Fast, accurate, comprehensive
```

---

## Practical Benefits Demonstrated

### 1. **Repository Discovery**
- Found all 9 MTS repositories instantly
- Got statistics (projects, BIXML count) for each
- No manual directory traversal needed

### 2. **Version Management**
- Identified version inconsistencies across repositories
- Found that skn_mts needs upgrade from 23.2.5 to 23.2.6
- Detected mixed versions in aia_mts

### 3. **Content Analysis**
- Discovered all 9 tax types in gd_mts
- Found domain-specific implementations (DSC modules)
- Identified configuration files and interfaces

### 4. **Knowledge Extraction**
- Answered "What tax types are supported?" without manual file inspection
- Provided file paths and context for each finding
- Ranked results by relevance

---

## Summary

**MCP = Superpower for Repository Analysis**

The BeInformed Repository MCP server transforms Cascade from a general-purpose AI into a specialized BeInformed repository expert. It can:

✅ Scan thousands of files in seconds  
✅ Extract structured information from BIXML  
✅ Answer complex questions about repository content  
✅ Detect versions, configurations, and patterns  
✅ Provide ranked, relevant results  

**In this conversation, MCP enabled:**
- Instant discovery of 9 MTS repositories
- Version analysis across all repositories
- Tax type identification in gd_mts
- All without manual file inspection or scripting

**The key insight:** MCP servers extend AI capabilities by providing specialized tools that understand domain-specific data structures and can perform complex analysis efficiently.
