# CAP-0002 Be Informed Representation

## Purpose

Define a reusable internal representation for Be Informed repositories so `bicli` can evolve from syntax validation into tooling that can:

- validate
- debug
- create
- maintain
- explain

Be Informed models across multiple platform versions.

This representation is derived from:

- Be Informed installation metadata and plugin jars
- repository structure under `C:\repo`
- representative non-frontend repositories
- repository-grounded analysis through the local `bimcp` server

## Scope

This canon explicitly excludes frontend-only repositories such as:

- `*-frontend`
- `FRONTEND`

The focus is Be Informed project structure, BIXML artifact types, project dependencies, and version-sensitive modeling patterns.

## Version Profiles

The repositories under `C:\repo` indicate a small number of meaningful Be Informed version families with substantial overlap:

### `23.2.2.1`

- older 23.2.x style present in subsets such as older Camel or message-broker related modules
- useful as a compatibility profile, not as the dominant baseline

### `23.2.5.202412131027`

- transitional 23.2.x profile
- visible in some repositories beside `23.2.6`
- should be treated as mostly compatible with `23.2.6`, but not identical

### `23.2.6.202501081215`

- dominant baseline across most non-frontend repositories
- best primary profile for current repository-derived reasoning

### `23.2.9.202510140827`

- later 23.2.x profile
- often visible in interaction-layer, portal, and selected newer artifacts
- should be represented as a refinement of the `23.2.6` baseline, not a separate universe

### `24.2.2.1`

- early 24.2.x compatibility marker
- appears in some repositories but not as the dominant profile

### `24.2.6.202511211123`

- dominant 24.2.x profile in `bes_bbf`
- structurally similar to 23.2.x, but should be modeled as a new baseline profile because plugin and artifact details differ

## Representation Layers

The internal representation should have four layers.

### 1. Platform Profile

This is installation-derived and version-sensitive.

Fields:

- `versionProfile`
- `knownNamespaces`
- `knownElementNames`
- `knownAttributeNames`
- `mappingClasses`
- `pluginRoots`
- `customPluginRoots`

Primary source:

- Be Informed installation jars
- project plugin roots

Use:

- structural validation
- plugin-aware generation constraints
- version-specific compatibility checks

### 2. Repository Architecture Graph

This is repository-derived and solution-specific.

Nodes:

- repository
- project
- studio configuration
- deployment/config package

Project roles:

- `shared_core`
- `shared_specific`
- `domain_core`
- `interface`
- `specific`
- `dsc_core`
- `dsc_specific`
- `interaction_layer`
- `portal`
- `delivery`
- `development`

Edges:

- `project_depends_on_project`
- `studio_config_exposes_webapp`
- `studio_config_uses_camel_context`

Use:

- architecture explanation
- dependency tracing
- impact analysis
- generation target selection

## Common Project Pattern

Across the dominant 23.2.x repositories, the recurring pattern is:

1. `SC Library`
   Shared base concepts, taxonomies, knowledge-model types, shared data definitions, icons, and utility artifacts.
2. `SC <Domain> - Interface definitions`
   Contract layer for request/response shapes, service entry points, integration handlers, and reusable interface-facing data structures.
3. `SC <Domain>`
   Reusable domain capability.
4. `SC <Domain> - Specific`
   Solution-specific or tenant-specific extension and composition.
5. `DSC <Domain>`
   Domain solution component, usually with the same triplet:
   core, interface definitions, specific.
6. `Interaction layer`
   Cross-domain composition into case views, panels, workflows, and user-facing orchestration.
7. `Portal`
   Application entry point composed from domains and interaction-layer artifacts.

This same pattern remains visible in `24.2.6`, though with smaller repositories it may be less expansive.

## Artifact Taxonomy

The internal model should classify BIXML artifacts by function, not just XML root tag.

### Knowledge and Taxonomy

- knowledge-model-type
- concept-type
- relation-type
- taxonomy

Purpose:

- define the semantic metamodel
- define concept classes and relations

### Data Definition

- object
- attribute group
- attribute set
- taxonomy-backed attribute structures
- datastore and datastore codemap structures

Purpose:

- define the data shape used by behavior, UI, and integration

Observed generation convention for new work:

- prefer project-scoped reusable atomic attributes as standalone `<attributegroup>` artifacts
- store those atomic attributes in a dedicated per-project folder
  - for generic/interface projects, a practical default is `Data/Attribute groups/Attributes`
  - for case workflows, a practical default is `Behavior/_Case/Data/Attribute groups/Attributes`
- compose higher-level `<attributeset>` and `<attributegroup>` artifacts from those atomic files through `<attributegroup-ref>`
- avoid inline/local attributes in generated events, forms, and attributesets when a reusable project-scoped attribute artifact can be referenced instead
- allow exceptions only for clearly transient or tooling-specific fields where reusable domain modeling would be artificial

### Behavior

- handler group
- event
- activity
- action
- validation condition
- process-related artifacts

Purpose:

- define execution logic and domain behavior

### UI and Application Composition

- form
- panel
- datastore-list
- case-list2
- case-view
- tab
- web-application
- service-application

Purpose:

- define interaction surfaces and application entry points

## Case Model Layer

Case modeling needs to be represented explicitly, not inferred ad hoc from arbitrary artifacts.

Core nodes:

- `CaseTypeNode`
- `CaseViewNode`
- `CaseListNode`
- `TabNode`
- `WebApplicationNode`
- `PanelNode`
- `RecordTypeNode`

Minimum extracted fields:

- `CaseTypeNode`
  - `path`
  - `project`
  - `label`
  - `functionalId`
  - `stateCount`
  - `documentTypeCount`
  - `recordTypeLinks`
- `CaseViewNode`
  - `path`
  - `project`
  - `label`
  - `caseTypeLink`
  - `casePropertiesPanelCount`
  - `caseRelatedDatastoreListPanelRefCount`
  - `eventListPanelRefCount`
  - `taskGroupCount`
  - `relatedCaseViewCount`
- `CaseListNode`
  - `path`
  - `project`
  - `label`
  - `recordTypeLink`
  - `createCaseTaskCaseTypeLinks`
  - `createCaseTaskFormLinks`
  - `generalPanelTaskFormLinks`
- `TabNode`
  - `path`
  - `project`
  - `label`
  - `caseViewLinks`
  - `caseListLinks`
  - `datastoreListPanelLinks`
  - `formTaskLinks`
- `WebApplicationNode`
  - `path`
  - `project`
  - `label`
  - `uriPart`
  - `tabLinks`
  - `userProviderLink`
  - `loginMandatory`
  - `loginEventLinks`
- `PanelNode`
  - `path`
  - `project`
  - `label`
  - `rootElement`
  - `uriPart`
  - `caseRelatedDatastoreListPanelLinks`
  - `eventListPanelLinks`
  - `groupingPanelLinks`
  - `recordListPanelLinks`
  - `formLinks`

Observed repository rules:

- case types are rooted as `<case>`
- case views are rooted as `<case-view>`
- a case view points to its case type through `<case-type>`
- tabs point to case views through `<case-view-ref>`
- tabs can also point to case lists through `<case-list-ref>`
- tabs can point to datastore lists through `<datastore-list-panel-ref>`
- tabs do not point to case lists through `<case-view-ref>`
- case lists point to case types through `<record-type-link>`
- datastore lists point to datastores through `<datastore-link>`
- datastore lists can point to datastore attributes through `<case-context-attribute-link>`
- `case-list2/create-case-task/caseTypeLink` points to a case type
- web applications point to tabs through `<tab-ref>`
- web applications point to a user provider through `<user-provider>`
- case views point to panels through:
  - `<case-related-datastore-list-panel-ref>`
  - `<event-list-panel-ref>`
  - `<grouping-panel-ref>`
  - `<record-list-panel-ref>`
- panel artifacts are represented explicitly by root element:
  - `case-related-datastore-list`
  - `event-list-panel`
  - `grouping-panel`
  - `record-list-panel`
- case types reference child record types through `<record-type-ref>`
- cross-project case references require matching Eclipse `.project` dependencies
- case views often expose:
  - `case-properties-panel`
  - `case-related-datastore-list-panel-ref`
  - `event-list-panel-ref`
  - `taskgroup`
  - richer interaction-layer variants such as `grouping-panel` and `record-list-panel`

Validation rules that should be enforced from this representation:

- every `case-view` should resolve its `case-type` to a `<case>` artifact
- every `case-view-ref` in a `tab` should resolve to a `<case-view>` artifact
- every `case-list-ref` in a `tab` should resolve to a `<case-list2>` artifact
- every `datastore-list-panel-ref` in a `tab` should resolve to a `<datastore-list>` artifact
- every `datastore-list` `datastore-link` should resolve to a `<datastore>` artifact
- every `datastore-list` `case-context-attribute-link` should resolve into a `<datastore>` artifact
- every `case-list2` `record-type-link` should resolve to a case type or another valid record type, depending on pattern
- every `case-list2/create-case-task/caseTypeLink` should resolve to a `<case>` artifact
- every `tab-ref` in a `webapplication` should resolve to a `<tab>` artifact
- every `user-provider` in a `webapplication` should resolve to a `<database-user-service>` artifact
- every case-view panel reference should resolve to the matching panel artifact type
- every nested panel reference inside a panel should resolve to the matching panel artifact type
- cross-project references should be backed by `.project` dependencies
- every Be Informed Eclipse project should declare explicit UTF-8 resource encoding in `.settings/org.eclipse.core.resources.prefs`
  - `encoding/<project>=UTF-8`
  - `encoding/.project=UTF-8`

### Integration

- execute-handler-group artifacts
- request and response attribute structures
- camel route related artifacts
- router configuration
- message types

Purpose:

- define service contracts and cross-system flow

## BIXML Composition Model

The CLI should represent model interaction primarily as typed links between artifacts.

Key link types:

- `project_depends_on_project`
- `artifact_links_to_artifact`
- `artifact_uses_attribute_set`
- `artifact_uses_attribute_group`
- `artifact_uses_datastore`
- `artifact_executes_handler_group`
- `artifact_uses_event`
- `artifact_uses_case_view`
- `artifact_uses_panel`
- `artifact_uses_form`
- `artifact_uses_taxonomy`
- `artifact_uses_knowledge_model`
- `artifact_exposes_service_contract`

The most important practical insight is that Be Informed solutions are not flat files. They are layered graphs:

- project graph
- artifact graph
- data-shape graph
- UI composition graph
- integration graph

## What Is Stable Across Versions

Stable:

- shared/domain/interface/specific layering
- strong use of project dependency graphs
- BIXML as the unit of composition
- repeated artifact categories for data, behavior, UI, and integration
- library plus portal/application composition pattern

Less stable:

- plugin versions and exact namespaces
- exact XML element and attribute availability
- some integration and platform-specific root elements
- selected interaction-layer and service-application details

## Operational Use In `bicli`

### Validate

Use:

- platform profile for syntax and element validity
- repository architecture graph for missing project dependencies
- artifact graph for unresolved links
- version profile for compatibility warnings

### Debug

Use:

- dependency graph to locate the owning project
- artifact graph to trace broken links
- artifact taxonomy to distinguish data-shape issues from behavior issues from UI issues

### Create

Use:

- project role inference to choose the correct target project
- artifact taxonomy to scaffold the right BIXML kind
- family pattern to create matching `core/interface/specific` artifacts where needed
- version profile to emit version-compatible structures

### Maintain

Use:

- impact analysis on project and artifact graphs
- drift detection between version profiles
- consistency checks between interface definitions, specific projects, interaction layer, and portal composition

## Recommended Data Model For Implementation

`bicli` should evolve toward these internal entities:

### `VersionProfile`

- `id`
- `version`
- `baseFamily`
- `knownNamespaces`
- `knownElements`
- `knownAttributes`
- `mappingClasses`

### `RepositoryModel`

- `repositoryName`
- `repositoryPath`
- `dominantVersionProfile`
- `studioConfigs`
- `projects`
- `artifactIndex`

### `ProjectNode`

- `name`
- `path`
- `role`
- `family`
- `dependencies`
- `versionHints`

### `ArtifactNode`

- `path`
- `project`
- `rootElement`
- `artifactKind`
- `label`
- `identifier`
- `pluginVersions`
- `links`

### `ArtifactLink`

- `source`
- `target`
- `type`
- `confidence`

## Immediate Follow-Up Work

The next useful implementation steps for `bicli` are:

1. Persist project-role inference in code, not only in MCP output.
2. Parse BIXML links into a first-class artifact graph.
3. Add repository-level validation for unresolved links and missing project dependencies.
4. Add generation helpers that select target projects by role and family.
5. Add version-profile selection so validation and creation are explicitly version-aware.
