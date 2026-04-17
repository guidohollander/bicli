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

## Usage

```bash
npm run build
node dist/src/index.js validate "C:\\path\\to\\file.bixml" --bi-home "C:\\bi\\Be Informed AMS 23.2.9"
```

Multiple files are supported:

```bash
node dist/src/index.js validate a.bixml b.bixml c.bixml --bi-home "C:\\bi\\Be Informed AMS 23.2.9"
```

For project-specific custom plugins, include the repo root:

```bash
node dist/src/index.js validate "C:\\repo\\gd_mts\\some-file.bixml" --bi-home "C:\\bi\\Be Informed AMS 23.2.9" --project-root "C:\\repo\\gd_mts"
```

## Global development command

Install globally linked commands on Windows:

```bash
npm run link:global
```

This exposes:

- `bicli`
  Requires a fresh `npm run build` after source changes.
- `bicli-dev`
  Runs directly from `src/index.ts` and always reflects current source code.

Recommended development usage:

```bash
bicli-dev validate "C:\\repo\\gd_mts\\some-file.bixml" --bi-home "C:\\bi\\Be Informed AMS 23.2.9" --project-root "C:\\repo\\gd_mts"
```

Repository modeling usage:

```bash
bicli-dev inspect-repository "C:\\repo\\gd_mts" --max-artifacts 300
```

Run the embedded MCP server over stdio:

```bash
bicli-dev mcp-server
```

Recommended MCP warm-up flow in Windsurf or other MCP clients:

1. `activate_repository`
2. `prepare_repository`
3. ask architecture/modeling questions with `answer_repository_question` or `answer_complex_question`

`prepare_repository` builds the persistent text index and warms repository-model caches so complex business and technical questions are slower cold but much faster once warm.

The embedded MCP server now exposes:

- repository discovery and activation
- repository search and repository-grounded Q&A
- repository-model extraction, trace, and validation
- pattern summaries for modeling, interaction, case model, and `_Case` workflows
- bounded creation tools for interface operations, test BIXML, `_Case` workflows, web applications, tabs, case lists, and datastore lists

```bash
bicli-dev trace-artifact "C:\\repo\\gd_mts" "Cash register portal" --max-artifacts 800
```

These commands emit JSON and are intended to support:

- version-aware repository modeling
- project-role and dependency analysis
- artifact tracing for debugging and maintenance
- future repository-level consistency validation

Bounded write workflow for a real artifact slice:

```bash
bicli-dev create-interface-operation "C:\\repo\\gd_mts" "SC Foo - Interface definitions" "getFoo"
```

This creates a request attributeset, optional response attributeset, execute handler-group, sibling domain event, and updates a unique sibling service-application when that target is unambiguous. Re-running the command is idempotent for already-created artifacts.

```bash
bicli-dev create-case-form-workflow "C:\\repo\\gd_mts" "SC Foo" "Register Foo" "Capture Foo details" "Confirm Foo data"
```

This creates a bounded `_Case` workflow inside one existing project:

- data attribute-set files under `Behavior/_Case/Data/Attribute sets`
- a matching event under `Behavior/_Case/Events`
- a matching form under `Behavior/_Case/Forms`

The generated form uses `eventtypelink`, each event question points to `event#<attributeset-ref-id>`, and the event input role points to the generated data attribute sets.

When the project already contains `_Case` forms and events, `bicli` now uses those as local templates to inherit project-specific shape such as:

- form permissions
- form `secure`
- form `layout-hint`
- event `store-type`
- top-level `init-handlers` and `store-handlers` blocks

You can also provide explicit templates:

```bash
bicli-dev create-case-form-workflow "C:\\repo\\gd_mts" "SC Foo" "Register Foo v2" "Capture Foo v2 details" "Confirm Foo v2 data" --template-form "Register Foo" --template-event "Register Foo"
```

Repository-model validation:

```bash
bicli-dev validate-repository-model "C:\\repo\\gd_mts" --max-artifacts 1200
```

Repository linting for modeling conventions:

```bash
bicli-dev lint "C:\\repo\\gd_mts"
```

With project-scoped markdown rules:

```bash
bicli-dev lint "C:\\repo\\gd_mts" --rules "C:\\dev\\js\\bicli\\docs\\canon\\lint-rules-example.md"
```

The first lint slice is intentionally convention-focused, not Studio-correctness-focused. It currently supports:

- duplicate inline attribute detection
- strict inline-attribute prohibition for selected project roles such as `interface`

Bounded write operation for a test file in an existing project:

```bash
bicli-dev create-test-bixml "C:\\repo\\gd_mts" "SC Library" "Tests\\Example test artifact.bixml" --root-element attributegroup --label "Example test artifact"
```

This creates a minimal skeleton file for controlled experiments. It is intended to be safe and bounded, not to guarantee a deployable model by itself.

For MCP-driven repository changes, prefer the direct bounded creation tools over generic intent interpretation. The current end-to-end slices include interface-operation creation and bounded `_Case` form/event/question/data creation.

## Windows executable

Build a standalone Windows executable:

```bash
npm run build:win-exe
```

Output:

```text
release\bicli.exe
```
