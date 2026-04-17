import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRepositoryModel,
  createCaseFormWorkflow,
  createCaseList,
  createInterfaceOperation,
  createDatastoreList,
  createPortalTab,
  createTestBixmlFile,
  createWebApplicationScaffold,
  deriveModuleFamily,
  deriveProjectRole,
  extractBeInformedVersionsFromText,
  traceRepositoryArtifacts,
  validateRepositoryModel
} from "../src/repositoryModel.js";
import { lintRepository } from "../src/lint.js";
import { applyLintRefactor } from "../src/refactor.js";

const tempRoots: string[] = [];

const createProject = async (
  repoRoot: string,
  projectName: string,
  dependencies: string[] = []
): Promise<string> => {
  const projectDir = path.join(repoRoot, projectName);
  await mkdir(projectDir, { recursive: true });
  const dependencyXml = dependencies.map((dependency) => `<project>${dependency}</project>`).join("");

  await writeFile(
    path.join(projectDir, ".project"),
    `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>${projectName}</name>
  <projects>${dependencyXml}</projects>
  <buildSpec>
    <buildCommand>
      <name>nl.beinformed.bi.studio.tool.BIBuilder</name>
    </buildCommand>
  </buildSpec>
  <natures>
    <nature>nl.beinformed.bi.studio.tool.BINature</nature>
  </natures>
</projectDescription>`,
    "utf8"
  );

  await mkdir(path.join(projectDir, ".settings"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".settings", "org.eclipse.core.resources.prefs"),
    "eclipse.preferences.version=1\nencoding/.project=UTF-8\nencoding/<project>=UTF-8\n",
    "utf8"
  );

  return projectDir;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true })));
});

describe("repository model extraction", () => {
  it("derives stable project roles and version hints", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-repo-model-"));
    tempRoots.push(repoRoot);

    const libraryDir = await createProject(repoRoot, "SC Library");
    const interfaceDir = await createProject(repoRoot, "SC Tax - Interface definitions", ["SC Library"]);
    const specificDir = await createProject(repoRoot, "SC Tax - Specific", ["SC Tax", "SC Tax - Interface definitions"]);
    const domainDir = await createProject(repoRoot, "SC Tax", ["SC Library", "SC Tax - Interface definitions"]);

    await writeFile(
      path.join(domainDir, "Tax model.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.knowledge_23.2.6.202501081215?>
<knowledge-model>
  <label>Tax model</label>
  <identifier>TaxModel</identifier>
  <referenced-concept>SharedTaxonomy</referenced-concept>
</knowledge-model>`,
      "utf8"
    );
    await writeFile(
      path.join(interfaceDir, "Request.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.knowledge_23.2.6.202501081215?>
<serviceapplication>
  <label>Request</label>
</serviceapplication>`,
      "utf8"
    );
    await writeFile(
      path.join(specificDir, "Specific form.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.knowledge_23.2.9.202510140827?>
<form>
  <label>Specific form</label>
</form>`,
      "utf8"
    );
    await mkdir(path.join(repoRoot, "_CONTINUOUS_DELIVERY", "_STUDIO"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "_CONTINUOUS_DELIVERY", "_STUDIO", "sample.json"),
      JSON.stringify({ version: "23.2.9", port: 1234, camelContext: "/Portal/Camel/CamelContext.xml" }, null, 2),
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });

    expect(model.repositoryName).toBe(path.basename(repoRoot));
    expect(model.dominantVersionProfile?.version).toBe("23.2.6.202501081215");
    expect(model.versionProfiles.map((profile) => profile.version)).toContain("23.2.9.202510140827");
    expect(model.projects.find((project) => project.name === "SC Library")?.role).toBe("shared_core");
    expect(model.projects.find((project) => project.name === "SC Tax - Interface definitions")?.role).toBe("interface");
    expect(model.projects.find((project) => project.name === "SC Tax - Specific")?.role).toBe("specific");
    expect(model.projects.find((project) => project.name === "SC Tax")?.versionHints).toEqual(["23.2.6.202501081215"]);
    expect(model.artifactIndex.find((artifact) => artifact.identifier === "TaxModel")?.artifactKind).toBe("knowledge");
    expect(model.studioConfigs[0]?.version).toBe("23.2.9");
    expect(model.studioConfigs[0]?.camelContext).toContain("CamelContext.xml");

    const trace = await traceRepositoryArtifacts(repoRoot, "TaxModel", { maxArtifacts: 20 });
    expect(trace.matches).toHaveLength(1);
    expect(trace.matches[0]?.path).toContain("Tax model.bixml");
    expect(trace.outboundLinks[0]?.target).toBe("SharedTaxonomy");

    expect(deriveProjectRole("MTS Interaction layer")).toBe("interaction_layer");
    expect(deriveModuleFamily("SC Tax - Interface definitions")).toBe("SC Tax");
    expect(extractBeInformedVersionsFromText("<?plugin nl.beinformed.bi.knowledge_24.2.6.202511211123?>")).toEqual([
      "24.2.6.202511211123"
    ]);

    void libraryDir;
  });

  it("validates repository coherence and can create a test bixml file in an existing project", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-repo-write-"));
    tempRoots.push(repoRoot);

    const libraryDir = await createProject(repoRoot, "SC Library");
    const domainDir = await createProject(repoRoot, "SC Tax", ["SC Library", "SC Missing dependency"]);

    await writeFile(
      path.join(domainDir, "Tax model.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.knowledge_23.2.6.202501081215?>
<knowledge-model>
  <label>Tax model</label>
  <identifier>TaxModel</identifier>
  <referenced-concept>UnknownTarget</referenced-concept>
</knowledge-model>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.type === "missing_project_dependency")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "unresolved_artifact_link")).toBe(true);

    const created = await createTestBixmlFile(repoRoot, "SC Tax", path.join("Tests", "Sample test artifact.bixml"), {
      rootElement: "attributegroup",
      label: "Sample test artifact"
    });

    expect(created.project).toBe("SC Tax");
    expect(created.version).toBe("23.2.6.202501081215");
    expect(created.relativePath).toContain(path.join("SC Tax", "Tests", "Sample test artifact.bixml"));

    const createdContent = await readFile(created.filePath, "utf8");
    expect(createdContent).toContain("<?plugin nl.beinformed.bi.knowledge_23.2.6.202501081215?>");
    expect(createdContent).toContain("<attributegroup>");
    expect(createdContent).toContain("<label>Sample test artifact</label>");

    void libraryDir;
  });

  it("treats empty attribute containers as repository validation errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-empty-attributeset-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await writeFile(
      path.join(projectDir, "Empty attributeset.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Empty attributeset</label>
  <functional-id>EmptyAttributeset</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.type === "empty_attribute_container")).toBe(true);
  });

  it("does not treat memo-only attributesets as empty", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-memo-attributeset-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await writeFile(
      path.join(projectDir, "Memo attributeset.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Memo attributeset</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <memoattribute>
    <id>MemoField</id>
    <label>Memo field</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>MemoField</functional-id>
    <mandatory>false</mandatory>
    <key>false</key>
    <master>false</master>
    <readonly>false</readonly>
    <assistant/>
    <layout-hint/>
    <columns>50</columns>
    <rows>5</rows>
    <maxlength>2000</maxlength>
    <formatted>false</formatted>
  </memoattribute>
  <functional-id>MemoAttributeset</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.issues.some((issue) => issue.type === "empty_attribute_container")).toBe(false);
  });

  it("treats broken new-case-handler case-type links as repository validation errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-broken-new-case-link-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await mkdir(path.join(projectDir, "Behavior", "_Case", "Events"), { recursive: true });
    await writeFile(
      path.join(projectDir, "Behavior", "_Case", "Events", "Create example.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<event>
  <label>Create example</label>
  <store-handlers>
    <new-case-handler>
      <case-type-link>/SC Example/Missing case.bixml</case-type-link>
    </new-case-handler>
  </store-handlers>
</event>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.issues.some((issue) => issue.type === "invalid_event_new_case_target")).toBe(true);
  });

  it("treats broken new-case-handler state-type links as repository validation errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-broken-event-state-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await writeFile(
      path.join(projectDir, "Example case.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case>
  <label>Example case</label>
  <functional-id>ExampleCase</functional-id>
</case>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Example event.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><event>
  <label>Example event</label>
  <store-handlers>
    <new-case-handler>
      <case-type-link>/SC Example/Example case.bixml</case-type-link>
      <state-type-link>/SC Example/Missing state.bixml</state-type-link>
    </new-case-handler>
  </store-handlers>
</event>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.issues.some((issue) => issue.type === "invalid_event_state_target")).toBe(true);
  });

  it("treats new-case-handler state links not exposed by the case type as repository validation errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-event-state-availability-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await writeFile(
      path.join(projectDir, "Initial state.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><state>
  <label>Initial</label>
  <functional-id>Initial</functional-id>
</state>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Example case.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case>
  <label>Example case</label>
  <functional-id>ExampleCase</functional-id>
</case>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Example event.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><event>
  <label>Example event</label>
  <store-handlers>
    <new-case-handler>
      <case-type-link>/SC Example/Example case.bixml</case-type-link>
      <state-type-link>/SC Example/Initial state.bixml</state-type-link>
    </new-case-handler>
  </store-handlers>
</event>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.issues.some((issue) => issue.type === "invalid_event_state_target")).toBe(true);
  });

  it("treats form request parameters that do not target an event input attributeset as repository validation errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-form-request-params-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await writeFile(
      path.join(projectDir, "Example event.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><event>
  <label>Example event</label>
  <attributeset-input-role>
    <id>role1</id>
    <attributeset>
      <id>good1234</id>
      <label>Good</label>
      <functional-id>Good</functional-id>
    </attributeset>
  </attributeset-input-role>
</event>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Example form.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><form>
  <label>Example form</label>
  <eventtypelink>/SC Example/Example event.bixml</eventtypelink>
  <questionsAndHandlers>
    <eventquestion>
      <attribute-set-type-link>/SC Example/Example event.bixml#good1234</attribute-set-type-link>
    </eventquestion>
  </questionsAndHandlers>
  <request-parameters>
    <attribute-set-type-link>/SC Example/Example event.bixml#bad99999</attribute-set-type-link>
  </request-parameters>
</form>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 20 });
    const validation = validateRepositoryModel(model);

    expect(validation.issues.some((issue) => issue.type === "invalid_form_request_parameters_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_form_question_target")).toBe(false);
  });

  it("treats missing explicit Eclipse project encoding as a repository validation warning", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-missing-encoding-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Example");
    await rm(path.join(projectDir, ".settings", "org.eclipse.core.resources.prefs"), { force: true });

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: false, maxArtifacts: 0 });
    const validation = validateRepositoryModel(model);

    expect(validation.ok).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "missing_project_encoding")).toBe(true);
  });

  it("creates an interface operation and patches the sibling service application when the target is unambiguous", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-interface-op-"));
    tempRoots.push(repoRoot);

    await createProject(repoRoot, "SC Library");
    const interfaceDir = await createProject(repoRoot, "SC Foo - Interface definitions", ["SC Library"]);
    const domainDir = await createProject(repoRoot, "SC Foo", ["SC Library", "SC Foo - Interface definitions"]);

    await mkdir(path.join(domainDir, "Library"), { recursive: true });
    await writeFile(
      path.join(domainDir, "Library", "Case service Foo.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.serviceapplication_23.2.6.202501081215?><service-application>
    <label>Case service Foo</label>
    <permissions/>
    <default-allowed>true</default-allowed>
</service-application>
`,
      "utf8"
    );
    await writeFile(
      path.join(interfaceDir, "Existing.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?><attributeset>
    <label>Existing</label>
    <functional-id>Existing</functional-id>
    <repeatable>false</repeatable>
    <repeat-number/>
    <optional>false</optional>
</attributeset>
`,
      "utf8"
    );

    const result = await createInterfaceOperation(repoRoot, "SC Foo - Interface definitions", "getFoo");

    expect(result.interfaceProject).toBe("SC Foo - Interface definitions");
    expect(result.domainProject).toBe("SC Foo");
    expect(
      result.createdFiles.some((filePath) =>
        filePath.endsWith(path.join("Data", "Attribute groups", "Attributes", "getFoo request value.bixml"))
      )
    ).toBe(true);
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("getFoo", "Request", "Request.bixml")))).toBe(true);
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("getFoo", "Response", "Response.bixml")))).toBe(true);
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("Interfaces", "getFoo", "getFoo.bixml")))).toBe(true);
    expect(result.updatedFiles.some((filePath) => filePath.endsWith(path.join("Library", "Case service Foo.bixml")))).toBe(true);

    const requestFile = await readFile(path.join(interfaceDir, "getFoo", "Request", "Request.bixml"), "utf8");
    const eventFile = await readFile(path.join(domainDir, "Interfaces", "getFoo", "getFoo.bixml"), "utf8");
    const serviceApplication = await readFile(path.join(domainDir, "Library", "Case service Foo.bixml"), "utf8");

    expect(requestFile).toContain("nl.beinformed.bi.common.attributes_23.2.6.202501081215");
    expect(requestFile).toContain("<attributegroup-ref>");
    expect(requestFile).not.toContain("<stringattribute>");
    expect(requestFile).toContain("/SC Foo - Interface definitions/Data/Attribute groups/Attributes/getFoo request value.bixml");
    expect(eventFile).toContain("/SC Foo - Interface definitions/getFoo/Request/Request.bixml");
    expect(serviceApplication).toContain("<label>getFoo</label>");
    expect(serviceApplication).toContain("/SC Foo/Interfaces/getFoo/getFoo.bixml");
  });

  it("treats repeated interface-operation creation as idempotent and does not duplicate service operations", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-interface-op-repeat-"));
    tempRoots.push(repoRoot);

    await createProject(repoRoot, "SC Library");
    await createProject(repoRoot, "SC Foo - Interface definitions", ["SC Library"]);
    const domainDir = await createProject(repoRoot, "SC Foo", ["SC Library", "SC Foo - Interface definitions"]);

    await mkdir(path.join(domainDir, "Library"), { recursive: true });
    await writeFile(
      path.join(domainDir, "Library", "Case service Foo.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.serviceapplication_23.2.6.202501081215?><service-application>
    <label>Case service Foo</label>
    <permissions/>
    <default-allowed>true</default-allowed>
</service-application>
`,
      "utf8"
    );

    const first = await createInterfaceOperation(repoRoot, "SC Foo - Interface definitions", "getFoo");
    const second = await createInterfaceOperation(repoRoot, "SC Foo - Interface definitions", "getFoo");
    const serviceApplication = await readFile(path.join(domainDir, "Library", "Case service Foo.bixml"), "utf8");

    expect(first.createdFiles.length).toBeGreaterThan(0);
    expect(second.createdFiles).toHaveLength(0);
    expect(second.updatedFiles).toHaveLength(0);
    expect(second.warnings.some((warning) => warning.includes("already exists"))).toBe(true);
    expect(serviceApplication.match(/<label>getFoo<\/label>/g)?.length || 0).toBe(1);
  });

  it("creates a bounded case form workflow with form, event, event questions, and data", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-case-form-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Customer", ["SC Library"]);
    await createProject(repoRoot, "SC Library");

    await mkdir(path.join(projectDir, "Behavior", "_Case", "Forms"), { recursive: true });
    await mkdir(path.join(projectDir, "Behavior", "_Case", "Events"), { recursive: true });
    await writeFile(
      path.join(projectDir, "Behavior", "_Case", "Forms", "Register existing customer.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.knowledge_23.2.6.202501081215?><?plugin nl.beinformed.bi.core.configuration_23.2.6.202501081215?><?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?><?plugin nl.beinformed.bi.casemanagement_23.2.6.202501081215?><form>
    <label>Register existing customer</label>
    <permissions><permission><type>read</type><default-allowed>false</default-allowed><constraints/></permission></permissions>
    <default-allowed>true</default-allowed>
    <uri-part>register-existing-customer</uri-part>
    <secure>true</secure>
    <layout-hint>disable-merged-objects</layout-hint>
    <eventtypelink>/SC Customer/Behavior/_Case/Events/Register existing customer.bixml</eventtypelink>
    <questionsAndHandlers/>
    <request-parameters><id>abcd1234</id><label>Request parameters</label><permissions/><default-allowed>true</default-allowed><attribute-set-type-link>/SC Customer/Behavior/_Case/Events/Register existing customer.bixml#abcd1234</attribute-set-type-link></request-parameters>
</form>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Behavior", "_Case", "Events", "Register existing customer.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.core.configuration_23.2.6.202501081215?><?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?><?plugin nl.beinformed.bi.casemanagement_23.2.6.202501081215?><event>
    <label>Register existing customer</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>RegisterExistingCustomer</functional-id>
    <store-type>noEventLogging</store-type>
    <attributeset-input-role><id>_input_role</id><permissions/><default-allowed>true</default-allowed></attributeset-input-role>
    <init-handlers><id>init_handlers</id><label>Init handlers</label><permissions/><default-allowed>true</default-allowed></init-handlers>
    <store-handlers><id>store_handlers</id><label>Store handlers</label><permissions/><default-allowed>true</default-allowed></store-handlers>
</event>`,
      "utf8"
    );

    const result = await createCaseFormWorkflow(
      repoRoot,
      "SC Customer",
      "Register customer",
      ["Capture customer details", "Confirm customer data"]
    );

    expect(result.project).toBe("SC Customer");
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("Behavior", "_Case", "Forms", "Register customer.bixml")))).toBe(true);
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("Behavior", "_Case", "Events", "Register customer.bixml")))).toBe(true);
    expect(
      result.createdFiles.some((filePath) =>
        filePath.endsWith(path.join("Behavior", "_Case", "Data", "Attribute groups", "Attributes", "Capture customer details value.bixml"))
      )
    ).toBe(true);
    expect(result.createdFiles.some((filePath) => filePath.endsWith(path.join("Behavior", "_Case", "Data", "Attribute sets", "Capture customer details.bixml")))).toBe(true);

    const formFile = await readFile(path.join(projectDir, "Behavior", "_Case", "Forms", "Register customer.bixml"), "utf8");
    const eventFile = await readFile(path.join(projectDir, "Behavior", "_Case", "Events", "Register customer.bixml"), "utf8");
    const questionFile = await readFile(
      path.join(projectDir, "Behavior", "_Case", "Data", "Attribute sets", "Capture customer details.bixml"),
      "utf8"
    );

    expect(formFile).toContain("<eventtypelink>/SC Customer/Behavior/_Case/Events/Register customer.bixml</eventtypelink>");
    expect(formFile).toContain("<eventquestion>");
    expect(formFile).toContain("<attribute-set-type-link>/SC Customer/Behavior/_Case/Events/Register customer.bixml#");
    expect(formFile).toContain("<secure>true</secure>");
    expect(formFile).toContain("<layout-hint>disable-merged-objects</layout-hint>");
    expect(eventFile).toContain("<attributeset-input-role>");
    expect(eventFile).toContain("/SC Customer/Behavior/_Case/Data/Attribute sets/Capture customer details.bixml");
    expect(eventFile).toContain("/SC Customer/Behavior/_Case/Data/Attribute sets/System/Request parameters.bixml");
    expect(eventFile).not.toContain("<attributeset>");
    expect(eventFile).toContain("<store-type>noEventLogging</store-type>");
    expect(questionFile).toContain("<attributeset>");
    expect(questionFile).toContain("<attributegroup-ref>");
    expect(questionFile).not.toContain("<stringattribute>");
    expect(questionFile).toContain(
      "/SC Customer/Behavior/_Case/Data/Attribute groups/Attributes/Capture customer details value.bixml"
    );
    expect(result.warnings.some((warning) => warning.includes("Using form template"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Using event template"))).toBe(true);
  });

  it("records case types, case views, case lists, and tabs and validates their linkage", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-case-model-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Case");
    const portalDir = await createProject(repoRoot, "Case Portal");
    await writeFile(
      path.join(projectDir, "Case type.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case>
    <label>Case type</label>
    <functional-id>CaseType</functional-id>
    <state><id>s1</id><label>Initial</label><permissions/><default-allowed>true</default-allowed><functional-id>Initial</functional-id></state>
</case>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Case view.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-view>
    <label>Case view</label>
    <case-type>/SC Case/Case type.bixml</case-type>
    <case-related-datastore-list-panel-ref>
      <case-related-datastore-list-panel-link>/SC Case/Overview panel.bixml</case-related-datastore-list-panel-link>
    </case-related-datastore-list-panel-ref>
    <event-list-panel-ref>
      <event-list-panel-link>/SC Case/History panel.bixml</event-list-panel-link>
    </event-list-panel-ref>
    <grouping-panel-ref>
      <grouping-panel-link>/SC Case/Details grouping panel.bixml</grouping-panel-link>
    </grouping-panel-ref>
    <record-list-panel-ref>
      <record-list-panel-link>/SC Case/Review panel.bixml</record-list-panel-link>
    </record-list-panel-ref>
</case-view>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Broken case view.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-view>
    <label>Broken case view</label>
    <case-type>/SC Case/Missing case type.bixml</case-type>
    <event-list-panel-ref>
      <event-list-panel-link>/SC Case/Case list.bixml</event-list-panel-link>
    </event-list-panel-ref>
</case-view>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Overview panel.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-related-datastore-list><label>Overview</label></case-related-datastore-list>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "History panel.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><event-list-panel><label>History</label></event-list-panel>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Review panel.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><record-list-panel><label>Review</label></record-list-panel>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Details grouping panel.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><grouping-panel>
    <label>Details</label>
    <panel-elements>
      <case-related-datastore-list-panel-ref>
        <case-related-datastore-list-panel-link>/SC Case/Overview panel.bixml</case-related-datastore-list-panel-link>
      </case-related-datastore-list-panel-ref>
      <record-list-panel-ref>
        <record-list-panel-link>/SC Case/Broken case view.bixml</record-list-panel-link>
      </record-list-panel-ref>
    </panel-elements>
</grouping-panel>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Case list.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-list2>
    <label>Case list</label>
    <record-type-link>/SC Case/Case type.bixml</record-type-link>
    <create-case-task>
      <label>Create case</label>
      <link>/SC Case/Case form.bixml</link>
      <caseTypeLink>/SC Case/Case type.bixml</caseTypeLink>
    </create-case-task>
</case-list2>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Broken case list.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-list2>
    <label>Broken case list</label>
    <record-type-link>/SC Case/Broken case view.bixml</record-type-link>
</case-list2>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Datastore list.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><datastore-list>
    <label>Datastore list</label>
    <datastore-link>/SC Case/Datastore.bixml</datastore-link>
</datastore-list>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Broken datastore list.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><datastore-list>
    <label>Broken datastore list</label>
    <datastore-link>/SC Case/Case view.bixml</datastore-link>
</datastore-list>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Datastore.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><datastore>
    <label>Datastore</label>
    <attributeset>
      <label>Datastore</label>
      <functional-id>Datastore</functional-id>
      <repeatable>false</repeatable>
      <repeat-number/>
      <optional>false</optional>
      <stringattribute><label>Name</label><functional-id>Name</functional-id><permissions/><default-allowed>true</default-allowed><id>Name</id><size>50</size><maxlength>255</maxlength><minlength>0</minlength></stringattribute>
    </attributeset>
</datastore>`,
      "utf8"
    );
    await writeFile(path.join(projectDir, "Case form.bixml"), `<?xml version="1.0" encoding="UTF-8"?><form><label>Case form</label></form>`, "utf8");
    const libraryDir = await createProject(repoRoot, "SC Library");
    await mkdir(path.join(libraryDir, "Users and organizations"), { recursive: true });
    await writeFile(
      path.join(libraryDir, "Users and organizations", "All users.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><database-user-service><label>All users</label></database-user-service>`,
      "utf8"
    );
    await writeFile(
      path.join(libraryDir, "Users and organizations", "Wrong users.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><user-provider><label>Wrong users</label></user-provider>`,
      "utf8"
    );
    await writeFile(
      path.join(portalDir, "Case tab.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><tab>
    <label>Case tab</label>
    <case-view-ref>
      <link>/SC Case/Case view.bixml</link>
    </case-view-ref>
    <case-list-ref>
      <link>/SC Case/Case list.bixml</link>
    </case-list-ref>
    <datastore-list-panel-ref>
      <datastore-list-panel-link>/SC Case/Datastore list.bixml</datastore-list-panel-link>
    </datastore-list-panel-ref>
</tab>`,
      "utf8"
    );
    await writeFile(
      path.join(portalDir, "Broken tab.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><tab>
    <label>Broken tab</label>
    <case-view-ref>
      <link>/SC Case/Case list.bixml</link>
    </case-view-ref>
    <case-list-ref>
      <link>/SC Case/Case view.bixml</link>
    </case-list-ref>
    <datastore-list-panel-ref>
      <datastore-list-panel-link>/SC Case/Case view.bixml</datastore-list-panel-link>
    </datastore-list-panel-ref>
</tab>`,
      "utf8"
    );
    await writeFile(
      path.join(portalDir, "Case app.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><webapplication>
    <label>Case app</label>
    <uri-part>case-app</uri-part>
    <tab-ref>
      <link>/Case Portal/Case tab.bixml</link>
      <uri-part>case-tab</uri-part>
    </tab-ref>
    <user-provider>/SC Library/Users and organizations/All users.bixml</user-provider>
</webapplication>`,
      "utf8"
    );
    await writeFile(
      path.join(portalDir, "Broken app.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><webapplication>
    <label>Broken app</label>
    <uri-part>broken-app</uri-part>
    <tab-ref>
      <link>/SC Case/Case view.bixml</link>
      <uri-part>broken-tab</uri-part>
    </tab-ref>
    <user-provider>/SC Library/Users and organizations/Wrong users.bixml</user-provider>
    <login-panel>
      <label>Login</label>
      <uri-part>login</uri-part>
    </login-panel>
</webapplication>`,
      "utf8"
    );

    const model = await buildRepositoryModel(repoRoot, { includeArtifacts: true, maxArtifacts: 100 });
    expect(model.caseTypes).toHaveLength(1);
    expect(model.caseViews).toHaveLength(2);
    expect(model.caseLists).toHaveLength(2);
    expect(model.datastoreLists).toHaveLength(2);
    expect(model.tabs).toHaveLength(2);
    expect(model.webApplications).toHaveLength(2);
    expect(model.panels).toHaveLength(4);
    expect(model.caseTypes[0]?.functionalId).toBe("CaseType");
    expect(model.caseViews.find((node) => node.label === "Case view")?.caseTypeLink).toBe("/SC Case/Case type.bixml");
    expect(model.caseViews.find((node) => node.label === "Case view")?.eventListPanelLinks).toEqual(["/SC Case/History panel.bixml"]);
    expect(model.caseLists.find((node) => node.label === "Case list")?.recordTypeLink).toBe("/SC Case/Case type.bixml");
    expect(model.tabs.find((node) => node.label === "Case tab")?.caseViewLinks).toEqual(["/SC Case/Case view.bixml"]);
    expect(model.tabs.find((node) => node.label === "Case tab")?.datastoreListPanelLinks).toEqual(["/SC Case/Datastore list.bixml"]);
    expect(model.datastoreLists.find((node) => node.label === "Datastore list")?.datastoreLink).toBe("/SC Case/Datastore.bixml");
    expect(model.webApplications.find((node) => node.label === "Case app")?.tabLinks).toEqual(["/Case Portal/Case tab.bixml"]);
    expect(model.panels.find((node) => node.label === "Details")?.recordListPanelLinks).toEqual(["/SC Case/Broken case view.bixml"]);

    const validation = validateRepositoryModel(model);
    expect(validation.issues.some((issue) => issue.type === "invalid_case_view_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_case_list_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_tab_case_view_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_tab_case_list_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_tab_datastore_list_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_datastore_list_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_web_application_tab_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_web_application_user_provider_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "reserved_web_application_login_uri")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_case_view_panel_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "invalid_panel_reference_target")).toBe(true);
    expect(validation.issues.some((issue) => issue.type === "missing_reference_project_dependency")).toBe(true);
  });

  it("reports duplicated inline attributes as lint warnings from markdown rules", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-lint-duplicate-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Foo");
    const rulesPath = path.join(repoRoot, "lint-rules.md");
    await writeFile(
      path.join(projectDir, "First.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>First</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a1</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <functional-id>First</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Second.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Second</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a2</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <functional-id>Second</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );
    await writeFile(
      rulesPath,
      `# Lint rules

\`\`\`yaml
id: prefer-shared-attributes
kind: duplicate_inline_attribute
severity: warning
minOccurrences: 2
targetFolder: Behavior/_Case/Data/Attribute groups/Attributes
message: Inline attribute '{functionalId}' appears {count} times in project '{project}'. Consider extracting it to {targetFolder}.
\`\`\`
`,
      "utf8"
    );

    const result = await lintRepository(repoRoot, { rulesPath });
    const finding = result.findings.find((item) => item.ruleId === "prefer-shared-attributes");

    expect(result.ok).toBe(true);
    expect(finding).toBeTruthy();
    expect(finding?.occurrences).toBe(2);
    expect(finding?.functionalId).toBe("CustomerName");
    expect(finding?.remediation?.action).toBe("extract_attribute_group");
    expect(finding?.remediation?.targetFolder).toBe("Behavior/_Case/Data/Attribute groups/Attributes");
    expect(finding?.remediation?.suggestedArtifactFileName).toBe("Customer name.bixml");
  });

  it("reports inline attributes in interface projects as lint errors", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-lint-interface-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Foo - Interface definitions");
    await writeFile(
      path.join(projectDir, "Bad request.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Bad request</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a1</id>
    <label>Request value</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>RequestValue</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <functional-id>BadRequest</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );

    const result = await lintRepository(repoRoot);
    const finding = result.findings.find((item) => item.ruleId === "no-inline-interface-attributes");

    expect(result.ok).toBe(false);
    expect(finding).toBeTruthy();
    expect(result.findings.some((finding) => finding.severity === "error")).toBe(true);
    expect(finding?.remediation?.action).toBe("replace_inline_attribute_with_ref");
  });

  it("can apply lint refactors by extracting a shared attribute group and replacing inline attributes", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-refactor-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Foo");
    await writeFile(
      path.join(projectDir, "First.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>First</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a1</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <functional-id>First</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Second.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Second</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a2</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <functional-id>Second</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );

    const lintResult = await lintRepository(repoRoot);
    const refactorResult = await applyLintRefactor(repoRoot, { lintResult });
    const sharedAttribute = await readFile(
      path.join(projectDir, "Data", "Attribute groups", "Attributes", "Customer name.bixml"),
      "utf8"
    );
    const firstFile = await readFile(path.join(projectDir, "First.bixml"), "utf8");
    const secondFile = await readFile(path.join(projectDir, "Second.bixml"), "utf8");

    expect(refactorResult.changes.some((change) => change.status === "created")).toBe(true);
    expect(sharedAttribute).toContain("<attributegroup>");
    expect(sharedAttribute).toContain("<functional-id>CustomerName</functional-id>");
    expect(firstFile).toContain("<attributegroup-ref>");
    expect(firstFile).not.toContain("<stringattribute>");
    expect(secondFile).toContain("<attributegroup-ref>");
    expect(secondFile).not.toContain("<stringattribute>");
  });

  it("uses an immutable pre-change snapshot when extracting multiple shared attributes from the same source file", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-refactor-snapshot-"));
    tempRoots.push(repoRoot);

    const projectDir = await createProject(repoRoot, "SC Foo");
    await writeFile(
      path.join(projectDir, "Composite.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Composite</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>a1</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <memoattribute>
    <id>a2</id>
    <label>Quality check notes</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>QualityCheckNotes</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
  </memoattribute>
  <functional-id>Composite</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );
    await writeFile(
      path.join(projectDir, "Mirror.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<?plugin nl.beinformed.bi.common.attributes_23.2.6.202501081215?>
<attributeset>
  <label>Mirror</label>
  <permissions/>
  <default-allowed>true</default-allowed>
  <stringattribute>
    <id>b1</id>
    <label>Customer name</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>CustomerName</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
    <size>50</size>
    <maxlength>255</maxlength>
  </stringattribute>
  <memoattribute>
    <id>b2</id>
    <label>Quality check notes</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <functional-id>QualityCheckNotes</functional-id>
    <mandatory>false</mandatory>
    <readonly>false</readonly>
  </memoattribute>
  <functional-id>Mirror</functional-id>
  <repeatable>false</repeatable>
  <repeat-number/>
  <optional>false</optional>
</attributeset>`,
      "utf8"
    );

    const lintResult = await lintRepository(repoRoot);
    await applyLintRefactor(repoRoot, { lintResult });

    const customerGroup = await readFile(
      path.join(projectDir, "Data", "Attribute groups", "Attributes", "Customer name.bixml"),
      "utf8"
    );
    const qualityGroup = await readFile(
      path.join(projectDir, "Data", "Attribute groups", "Attributes", "Quality check notes.bixml"),
      "utf8"
    );

    expect(customerGroup).toContain("<functional-id>CustomerName</functional-id>");
    expect(customerGroup).not.toContain("<functional-id>QualityCheckNotes</functional-id>");
    expect(qualityGroup).toContain("<functional-id>QualityCheckNotes</functional-id>");
    expect(qualityGroup).not.toContain("<functional-id>CustomerName</functional-id>");
  });

  it("creates a web application scaffold, lists, and a portal tab that patches the web application", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bicli-portal-"));
    tempRoots.push(repoRoot);

    const portalDir = await createProject(repoRoot, "Example Portal");
    const domainDir = await createProject(repoRoot, "SC Foo", ["SC Library"]);
    const libraryDir = await createProject(repoRoot, "SC Library");
    await mkdir(path.join(libraryDir, "Users and organizations"), { recursive: true });
    await writeFile(
      path.join(libraryDir, "Users and organizations", "All users.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><database-user-service><label>All users</label></database-user-service>`,
      "utf8"
    );
    await mkdir(path.join(domainDir, "Case definition"), { recursive: true });
    await mkdir(path.join(domainDir, "Behavior", "_Case", "Forms"), { recursive: true });
    await mkdir(path.join(domainDir, "Behavior", "Forms"), { recursive: true });
    await mkdir(path.join(domainDir, "Behavior"), { recursive: true });
    await mkdir(path.join(domainDir, "Lists", "Datastores"), { recursive: true });
    await writeFile(
      path.join(domainDir, "Case definition", "Foo.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><recordtype><label>Foo</label></recordtype>`,
      "utf8"
    );
    await writeFile(
      path.join(domainDir, "Behavior", "_Case", "Forms", "Create Foo.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><form><label>Create Foo</label></form>`,
      "utf8"
    );
    await writeFile(
      path.join(domainDir, "Behavior", "_Case", "Forms", "Edit Foo.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><form><label>Edit Foo</label></form>`,
      "utf8"
    );
    await writeFile(
      path.join(domainDir, "Behavior", "Forms", "Create datastore row.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><form><label>Create datastore row</label></form>`,
      "utf8"
    );
    await writeFile(
      path.join(domainDir, "Behavior", "Foo view.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><case-view><label>Foo view</label></case-view>`,
      "utf8"
    );
    await writeFile(
      path.join(domainDir, "Lists", "Datastores", "Foo datastore.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><datastore><label>Foo datastore</label><attributeset><label>Foo datastore</label><stringattribute><label>CaseRef</label><functional-id>CaseRef</functional-id><permissions/><default-allowed>true</default-allowed><id>CaseRef</id><size>50</size><maxlength>255</maxlength><minlength>0</minlength></stringattribute><functional-id>FooDatastore</functional-id><repeatable>false</repeatable><repeat-number/><optional>false</optional></attributeset></datastore>`,
      "utf8"
    );

    await writeFile(
      path.join(portalDir, "Seed web app.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.webapplication_23.2.6.202501081215?><?plugin nl.beinformed.bi.casemanagement_23.2.6.202501081215?><webapplication>
    <label>Seed web app</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <uri-part>seed-web-app</uri-part>
    <user-provider>/SC Library/Users and organizations/All users.bixml</user-provider>
    <login-mandatory>false</login-mandatory>
    <login-panel>
        <id>seed_login_panel</id>
        <label>Login</label>
        <permissions/>
        <default-allowed>true</default-allowed>
        <uri-part>login</uri-part>
        <secure>false</secure>
        <event-handlers/>
    </login-panel>
</webapplication>`,
      "utf8"
    );
    await mkdir(path.join(portalDir, "Tabs"), { recursive: true });
    await writeFile(
      path.join(portalDir, "Tabs", "Seed tab.bixml"),
      `<?xml version="1.0" encoding="UTF-8"?><?plugin nl.beinformed.bi.core.configuration_23.2.6.202501081215?><?plugin nl.beinformed.bi.casemanagement_23.2.6.202501081215?><tab>
    <label>Seed tab</label>
    <permissions/>
    <default-allowed>true</default-allowed>
    <uri-part>seed-tab</uri-part>
    <secure>true</secure>
    <layout-hint>no-follow</layout-hint>
    <case-search-activated>false</case-search-activated>
</tab>`,
      "utf8"
    );

    const webApplication = await createWebApplicationScaffold(
      repoRoot,
      "Example Portal",
      "Foo Portal",
      "foo-portal",
      "Home",
      "home"
    );
    const caseList = await createCaseList(
      repoRoot,
      "SC Foo",
      "Foo cases",
      "foo-cases",
      "/SC Foo/Case definition/Foo.bixml",
      {
        createFormLink: "/SC Foo/Behavior/_Case/Forms/Create Foo.bixml",
        updateFormLink: "/SC Foo/Behavior/_Case/Forms/Edit Foo.bixml"
      }
    );
    const datastoreList = await createDatastoreList(
      repoRoot,
      "SC Foo",
      "Foo datastore",
      "foo-datastore",
      "/SC Foo/Lists/Datastores/Foo datastore.bixml",
      {
        createFormLink: "/SC Foo/Behavior/Forms/Create datastore row.bixml",
        caseContextAttributeLink: "/SC Foo/Lists/Datastores/Foo datastore.bixml#CaseRef"
      }
    );
    const tab = await createPortalTab(repoRoot, "Example Portal", "Operations", "operations", {
      webApplication: "Foo Portal",
      datastoreListLinks: [{ link: "/SC Foo/Lists/Foo datastore.bixml", uriPart: "foo-datastore" }],
      caseViewLinks: [{ link: "/SC Foo/Behavior/Foo view.bixml", uriPart: "foo-view" }],
      formTasks: [{ link: "/SC Foo/Behavior/_Case/Forms/Create Foo.bixml", label: "Create Foo", uriPart: "create-foo" }]
    });

    expect(webApplication.createdFiles.some((filePath) => filePath.endsWith(path.join("Web application", "Foo Portal.bixml")))).toBe(true);
    expect(caseList.listType).toBe("case-list2");
    expect(datastoreList.listType).toBe("datastore-list");
    expect(tab.createdFiles.some((filePath) => filePath.endsWith(path.join("Tabs", "Operations.bixml")))).toBe(true);
    expect(tab.updatedFiles.some((filePath) => filePath.endsWith(path.join("Web application", "Foo Portal.bixml")))).toBe(true);

    const webApplicationFile = await readFile(path.join(portalDir, "Web application", "Foo Portal.bixml"), "utf8");
    const homeTabFile = await readFile(path.join(portalDir, "Tabs", "Home.bixml"), "utf8");
    const operationsTabFile = await readFile(path.join(portalDir, "Tabs", "Operations.bixml"), "utf8");
    const caseListFile = await readFile(path.join(domainDir, "Lists", "Foo cases.bixml"), "utf8");
    const datastoreListFile = await readFile(path.join(domainDir, "Lists", "Foo datastore.bixml"), "utf8");

    expect(webApplicationFile).toContain("<uri-part>foo-portal</uri-part>");
    expect(webApplicationFile).toContain("<link>/Example Portal/Tabs/Operations.bixml</link>");
    expect(webApplicationFile).toContain("<login-panel>");
    expect(homeTabFile).not.toContain("<layout-hint>no-follow</layout-hint>");
    expect(homeTabFile).toContain("<secure>true</secure>");
    expect(operationsTabFile).toContain("<datastore-list-panel-ref>");
    expect(operationsTabFile).toContain("<case-view-ref>");
    expect(operationsTabFile).toContain("<taskgroup>");
    expect(operationsTabFile).toContain("<layout-hint/>");
    expect(operationsTabFile).toContain("<link>/SC Foo/Behavior/_Case/Forms/Create Foo.bixml</link>");
    expect(caseListFile).toContain("<case-list2>");
    expect(caseListFile).toContain("<create-case-task>");
    expect(caseListFile).toContain("<update-case-task>");
    expect(datastoreListFile).toContain("<datastore-list>");
    expect(datastoreListFile).toContain("<create-data-store-task>");
    expect(datastoreListFile).toContain("<case-context-attribute-link>/SC Foo/Lists/Datastores/Foo datastore.bixml#CaseRef</case-context-attribute-link>");

    const portalProjectFile = await readFile(path.join(portalDir, ".project"), "utf8");
    expect(portalProjectFile).toContain("<project>SC Foo</project>");
    expect(portalProjectFile).toContain("<project>SC Library</project>");
  });
});
