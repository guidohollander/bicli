export type MappingField = {
  name: string;
  attributeNames: string[];
  childNames: string[];
};

export type MappingClass = {
  name: string;
  xmlNames: string[];
  extendsName?: string;
  fields: MappingField[];
};

export type InstallationMetadata = {
  classes: MappingClass[];
  knownElementNames: Set<string>;
  knownAttributeNames: Set<string>;
  knownNamespaces: Set<string>;
};

export type ProjectRole =
  | "shared_core"
  | "shared_specific"
  | "domain_core"
  | "interface"
  | "specific"
  | "dsc_core"
  | "dsc_specific"
  | "interaction_layer"
  | "portal"
  | "delivery"
  | "development"
  | "frontend"
  | "other";

export type ArtifactKind =
  | "knowledge"
  | "taxonomy"
  | "data"
  | "behavior"
  | "ui"
  | "application"
  | "integration"
  | "configuration"
  | "unknown";

export type VersionProfile = {
  id: string;
  version: string;
  baseFamily: string;
  fileCount: number;
  sampleFiles: string[];
};

export type StudioConfig = {
  path: string;
  version: string | null;
  type: string | null;
  port: number | string | null;
  webApps: string[];
  camelContext: string | null;
  excludeProjects: string[];
};

export type ProjectNode = {
  name: string;
  path: string;
  role: ProjectRole;
  family: string;
  dependencies: string[];
  builders: string[];
  natures: string[];
  isBeInformed: boolean;
  versionHints: string[];
  explicitEncoding: string | null;
  hasProjectEncodingPreference: boolean;
  hasDotProjectEncodingPreference: boolean;
};

export type ArtifactLink = {
  source: string;
  target: string;
  type: string;
  confidence: "high" | "medium" | "low";
  resolvedPath?: string;
};

export type ArtifactNode = {
  path: string;
  project: string | null;
  rootElement: string | null;
  artifactKind: ArtifactKind;
  label: string | null;
  identifier: string | null;
  versionHints: string[];
  links: ArtifactLink[];
  childElementNames?: string[];
};

export type CaseTypeNode = {
  path: string;
  project: string | null;
  label: string | null;
  functionalId: string | null;
  stateCount: number;
  stateIds: string[];
  stateLinks: string[];
  documentTypeCount: number;
  recordTypeLinks: string[];
};

export type CaseViewNode = {
  path: string;
  project: string | null;
  label: string | null;
  caseTypeLink: string | null;
  casePropertiesPanelCount: number;
  caseRelatedDatastoreListPanelRefCount: number;
  eventListPanelRefCount: number;
  taskGroupCount: number;
  relatedCaseViewCount: number;
  caseRelatedDatastoreListPanelLinks: string[];
  eventListPanelLinks: string[];
  groupingPanelLinks: string[];
  recordListPanelLinks: string[];
};

export type CaseListNode = {
  path: string;
  project: string | null;
  label: string | null;
  recordTypeLink: string | null;
  createCaseTaskCaseTypeLinks: string[];
  createCaseTaskFormLinks: string[];
  generalPanelTaskFormLinks: string[];
};

export type DatastoreListNode = {
  path: string;
  project: string | null;
  label: string | null;
  datastoreLink: string | null;
  caseContextAttributeLink: string | null;
  createDataStoreTaskFormLinks: string[];
};

export type TabNode = {
  path: string;
  project: string | null;
  label: string | null;
  caseViewLinks: string[];
  caseListLinks: string[];
  datastoreListPanelLinks: string[];
  formTaskLinks: string[];
};

export type WebApplicationNode = {
  path: string;
  project: string | null;
  label: string | null;
  uriPart: string | null;
  tabLinks: string[];
  userProviderLink: string | null;
  loginMandatory: boolean | null;
  loginPanelUriPart: string | null;
  loginEventLinks: string[];
};

export type PanelNode = {
  path: string;
  project: string | null;
  label: string | null;
  rootElement: string;
  uriPart: string | null;
  caseRelatedDatastoreListPanelLinks: string[];
  eventListPanelLinks: string[];
  groupingPanelLinks: string[];
  recordListPanelLinks: string[];
  formLinks: string[];
};

export type EventNewCaseHandlerNode = {
  caseTypeLink: string | null;
  stateTypeLink: string | null;
};

export type EventNode = {
  path: string;
  project: string | null;
  label: string | null;
  newCaseTypeLinks: string[];
  newCaseStateLinks: string[];
  newCaseHandlers: EventNewCaseHandlerNode[];
  inputAttributeSetRefs: string[];
};

export type FormNode = {
  path: string;
  project: string | null;
  label: string | null;
  eventTypeLink: string | null;
  requestParameterAttributeSetLink: string | null;
  questionAttributeSetLinks: string[];
};

export type RepositoryModel = {
  repositoryName: string;
  repositoryPath: string;
  dominantVersionProfile: VersionProfile | null;
  versionProfiles: VersionProfile[];
  studioConfigs: StudioConfig[];
  projects: ProjectNode[];
  artifactIndex: ArtifactNode[];
  caseTypes: CaseTypeNode[];
  caseViews: CaseViewNode[];
  caseLists: CaseListNode[];
  datastoreLists: DatastoreListNode[];
  tabs: TabNode[];
  webApplications: WebApplicationNode[];
  panels: PanelNode[];
  events: EventNode[];
  forms: FormNode[];
};

export type ValidationIssue = {
  message: string;
  path: string;
};

export type ValidationResult = {
  filePath: string;
  ok: boolean;
  issues: ValidationIssue[];
};

export type ArtifactTrace = {
  repositoryName: string;
  repositoryPath: string;
  query: string;
  matches: ArtifactNode[];
  inboundLinks: ArtifactLink[];
  outboundLinks: ArtifactLink[];
};

export type RepositoryValidationIssue = {
  type:
    | "missing_project_dependency"
    | "artifact_without_project"
    | "unresolved_artifact_link"
    | "mixed_version_project"
    | "missing_project_encoding"
    | "empty_attribute_container"
    | "invalid_case_view_target"
    | "invalid_tab_case_view_target"
    | "invalid_case_list_target"
    | "invalid_tab_case_list_target"
    | "invalid_tab_datastore_list_target"
    | "invalid_datastore_list_target"
    | "invalid_datastore_list_case_context_target"
    | "invalid_web_application_tab_target"
    | "invalid_web_application_user_provider_target"
    | "reserved_web_application_login_uri"
    | "invalid_case_view_panel_target"
    | "invalid_panel_reference_target"
    | "invalid_event_new_case_target"
    | "invalid_event_state_target"
    | "invalid_form_event_target"
    | "invalid_form_request_parameters_target"
    | "invalid_form_question_target"
    | "missing_reference_project_dependency";
  severity: "error" | "warning";
  message: string;
  project?: string;
  artifactPath?: string;
  target?: string;
};

export type RepositoryValidationResult = {
  repositoryName: string;
  repositoryPath: string;
  ok: boolean;
  issueCount: number;
  issues: RepositoryValidationIssue[];
};

export type LintSeverity = "error" | "warning" | "info" | "hint";

export type LintRuleKind = "duplicate_inline_attribute" | "inline_attribute_presence";

export type LintRule = {
  id: string;
  kind: LintRuleKind;
  severity: LintSeverity;
  minOccurrences?: number;
  projectRoles?: ProjectRole[];
  message?: string;
  targetFolder?: string;
};

export type LintFinding = {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  project?: string;
  artifactPath?: string;
  functionalId?: string;
  occurrences?: number;
  paths?: string[];
  remediation?: {
    action: "extract_attribute_group" | "replace_inline_attribute_with_ref";
    targetFolder: string;
    suggestedArtifactFileName: string;
    suggestedArtifactLabel: string;
    sourcePaths: string[];
  };
};

export type LintResult = {
  repositoryName: string;
  repositoryPath: string;
  ok: boolean;
  ruleCount: number;
  findingCount: number;
  findings: LintFinding[];
  loadedRules: LintRule[];
};

export type CreatedTestBixmlFile = {
  repositoryName: string;
  repositoryPath: string;
  project: string;
  projectPath: string;
  filePath: string;
  relativePath: string;
  rootElement: string;
  label: string;
  version: string | null;
};

export type CreatedInterfaceOperationResult = {
  repositoryName: string;
  repositoryPath: string;
  interfaceProject: string;
  domainProject: string | null;
  operationName: string;
  version: string | null;
  createdFiles: string[];
  updatedFiles: string[];
  warnings: string[];
};

export type CreatedCaseFormWorkflowResult = {
  repositoryName: string;
  repositoryPath: string;
  project: string;
  formName: string;
  eventName: string;
  questionLabels: string[];
  version: string | null;
  createdFiles: string[];
  updatedFiles: string[];
  warnings: string[];
};

export type CreatedWebApplicationResult = {
  repositoryName: string;
  repositoryPath: string;
  project: string;
  applicationName: string;
  uriPart: string;
  createdFiles: string[];
  updatedFiles: string[];
  warnings: string[];
};

export type CreatedListResult = {
  repositoryName: string;
  repositoryPath: string;
  project: string;
  listName: string;
  uriPart: string;
  listType: "case-list2" | "datastore-list";
  createdFiles: string[];
  updatedFiles: string[];
  warnings: string[];
};
