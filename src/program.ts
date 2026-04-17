import { Command } from "commander";
import path from "node:path";

import { discoverProjectPluginRoots, loadInstallationMetadata } from "./beInformedInstallation.js";
import { lintRepository } from "./lint.js";
import { startMcpServer } from "./mcpServer.js";
import { applyLintRefactor } from "./refactor.js";
import {
  buildRepositoryModel,
  createCaseFormWorkflow,
  createCaseList,
  createInterfaceOperation,
  createDatastoreList,
  createPortalTab,
  createTestBixmlFile,
  createWebApplicationScaffold,
  traceRepositoryArtifacts,
  validateRepositoryModel
} from "./repositoryModel.js";
import { validateBixmlFile } from "./validator.js";

const collectValues = (value: string, previous: string[] = []): string[] => [...previous, value];

const parseLinkUriPairs = (values: string[]): Array<{ link: string; uriPart: string }> =>
  values.map((value) => {
    const [link, uriPart] = value.split("|");
    if (!link || !uriPart) {
      throw new Error(`Expected <link>|<uri-part> pair, received: ${value}`);
    }
    return { link, uriPart };
  });

const parseFormTasks = (values: string[]): Array<{ link: string; label: string; uriPart: string }> =>
  values.map((value) => {
    const [link, label, uriPart] = value.split("|");
    if (!link || !label || !uriPart) {
      throw new Error(`Expected <link>|<label>|<uri-part> form task, received: ${value}`);
    }
    return { link, label, uriPart };
  });

export const createProgram = (): Command => {
  const program = new Command();

  program.name("bicli").description("Validate Be Informed BIXML syntax using vendor-derived rules");

  program
    .command("mcp-server")
    .description("Run the Be Informed MCP server over stdio")
    .action(async () => {
      await startMcpServer();
    });

  program
    .command("validate")
    .argument("<files...>", "One or more .bixml files")
    .requiredOption("--bi-home <path>", "Path to the Be Informed installation")
    .option("--project-root <path>", "Optional project root used to discover custom plugin jars")
    .action(async (files: string[], options: { biHome: string; projectRoot?: string }) => {
      const extraPluginRoots = options.projectRoot
        ? await discoverProjectPluginRoots(options.projectRoot)
        : [];
      const metadata = await loadInstallationMetadata(options.biHome, extraPluginRoots);
      let hasFailure = false;

      for (const inputFile of files) {
        const absoluteFile = path.resolve(inputFile);
        const result = await validateBixmlFile(absoluteFile, metadata);

        if (result.ok) {
          console.log(`PASS ${absoluteFile}`);
          continue;
        }

        hasFailure = true;
        console.log(`FAIL ${absoluteFile}`);

        for (const issue of result.issues) {
          console.log(`  ${issue.path}: ${issue.message}`);
        }
      }

      process.exitCode = hasFailure ? 1 : 0;
    });

  program
    .command("lint")
    .argument("<repo-root>", "Repository root")
    .option("--project <name>", "Optional project name filter")
    .option("--rules <path>", "Markdown file with fenced yaml lint-rule blocks")
    .option("--max-artifacts <count>", "Maximum number of BIXML artifacts to index", (value) => Number.parseInt(value, 10), 3000)
    .action(async (repoRoot: string, options: { project?: string; rules?: string; maxArtifacts: number }) => {
      const result = await lintRepository(repoRoot, {
        project: options.project,
        rulesPath: options.rules,
        maxArtifacts: Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : 3000,
      });

      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    });

  program
    .command("refactor")
    .argument("<repo-root>", "Repository root")
    .option("--input <path>", "Path to a lint JSON result file")
    .option("--from-stdin", "Read lint JSON from stdin")
    .action(async (repoRoot: string, options: { input?: string; fromStdin?: boolean }) => {
      const result = await applyLintRefactor(repoRoot, {
        lintJson: options.input,
      });

      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command("inspect-repository")
    .argument("<repo-root>", "Repository root")
    .option("--no-artifacts", "Skip BIXML artifact extraction")
    .option("--max-artifacts <count>", "Maximum number of BIXML artifacts to index", (value) => Number.parseInt(value, 10), 500)
    .action(async (repoRoot: string, options: { artifacts: boolean; maxArtifacts: number }) => {
      const model = await buildRepositoryModel(repoRoot, {
        includeArtifacts: options.artifacts,
        maxArtifacts: Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : 500
      });

      console.log(JSON.stringify(model, null, 2));
    });

  program
    .command("trace-artifact")
    .argument("<repo-root>", "Repository root")
    .argument("<query>", "Artifact path, identifier, or label fragment")
    .option("--max-artifacts <count>", "Maximum number of BIXML artifacts to index", (value) => Number.parseInt(value, 10), 1500)
    .action(async (repoRoot: string, query: string, options: { maxArtifacts: number }) => {
      const trace = await traceRepositoryArtifacts(repoRoot, query, {
        includeArtifacts: true,
        maxArtifacts: Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : 1500
      });

      console.log(JSON.stringify(trace, null, 2));
    });

  program
    .command("validate-repository-model")
    .argument("<repo-root>", "Repository root")
    .option("--max-artifacts <count>", "Maximum number of BIXML artifacts to index", (value) => Number.parseInt(value, 10), 1200)
    .action(async (repoRoot: string, options: { maxArtifacts: number }) => {
      const model = await buildRepositoryModel(repoRoot, {
        includeArtifacts: true,
        maxArtifacts: Number.isFinite(options.maxArtifacts) ? options.maxArtifacts : 1200
      });
      const validation = validateRepositoryModel(model);

      console.log(JSON.stringify(validation, null, 2));
      process.exitCode = validation.ok ? 0 : 1;
    });

  program
    .command("create-test-bixml")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing Be Informed project name")
    .argument("<file-relative-path>", "Path relative to the project root")
    .option("--root-element <name>", "Root element for the test skeleton", "knowledge-model-type")
    .option("--label <text>", "Label to emit in the test file")
    .option("--version <value>", "Override the inferred Be Informed version")
    .action(
      async (
        repoRoot: string,
        project: string,
        fileRelativePath: string,
        options: { rootElement: string; label?: string; version?: string }
      ) => {
        const created = await createTestBixmlFile(repoRoot, project, fileRelativePath, {
          rootElement: options.rootElement,
          label: options.label,
          version: options.version
        });

        console.log(JSON.stringify(created, null, 2));
      }
    );

  program
    .command("create-interface-operation")
    .argument("<repo-root>", "Repository root")
    .argument("<interface-project>", "Existing interface-definition project name")
    .argument("<operation-name>", "Operation name")
    .option("--no-response", "Do not create a response attributeset")
    .action(
      async (
        repoRoot: string,
        interfaceProject: string,
        operationName: string,
        options: { response: boolean }
      ) => {
        const result = await createInterfaceOperation(repoRoot, interfaceProject, operationName, {
          withResponse: options.response
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("create-case-form-workflow")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing project that owns the case workflow")
    .argument("<form-name>", "Case form and event name")
    .argument("<question-labels...>", "One or more event question labels")
    .option("--secure", "Mark the generated form as secure")
    .option("--template-form <name>", "Existing case form label or file name to use as a template")
    .option("--template-event <name>", "Existing case event label or file name to use as a template")
    .action(
      async (
        repoRoot: string,
        project: string,
        formName: string,
        questionLabels: string[],
        options: { secure?: boolean; templateForm?: string; templateEvent?: string }
      ) => {
        const result = await createCaseFormWorkflow(repoRoot, project, formName, questionLabels, {
          secure: options.secure === true,
          templateForm: options.templateForm,
          templateEvent: options.templateEvent
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("create-web-application")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing portal project name")
    .argument("<application-name>", "Web application label and file name")
    .argument("<application-uri-part>", "Unique web application URI part")
    .argument("<initial-tab-name>", "Initial tab label and file name")
    .argument("<initial-tab-uri-part>", "Unique initial tab URI part")
    .option("--user-provider <link>", "Override the user-provider link")
    .option("--login-mandatory", "Mark the web application as login-mandatory")
    .action(
      async (
        repoRoot: string,
        project: string,
        applicationName: string,
        applicationUriPart: string,
        initialTabName: string,
        initialTabUriPart: string,
        options: { userProvider?: string; loginMandatory?: boolean }
      ) => {
        const result = await createWebApplicationScaffold(
          repoRoot,
          project,
          applicationName,
          applicationUriPart,
          initialTabName,
          initialTabUriPart,
          {
            userProvider: options.userProvider,
            loginMandatory: options.loginMandatory === true
          }
        );

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("create-portal-tab")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing portal project name")
    .argument("<tab-name>", "Tab label and file name")
    .argument("<tab-uri-part>", "Unique tab URI part")
    .option("--secure", "Mark the tab as secure")
    .option("--layout-hint <value>", "Override the tab layout hint")
    .option("--web-application <name>", "Existing web application label or file name to patch with a tab-ref")
    .option(
      "--datastore-list <link|uri-part>",
      "Add a datastore-list-panel-ref",
      collectValues,
      []
    )
    .option("--case-view <link|uri-part>", "Add a case-view-ref", collectValues, [])
    .option("--case-list <link|uri-part>", "Add a case-list-panel-ref", collectValues, [])
    .option("--form-task <link|label|uri-part>", "Add a form-ref task inside the tab taskgroup", collectValues, [])
    .action(
      async (
        repoRoot: string,
        project: string,
        tabName: string,
        tabUriPart: string,
        options: {
          secure?: boolean;
          layoutHint?: string;
          webApplication?: string;
          datastoreList: string[];
          caseView: string[];
          caseList: string[];
          formTask: string[];
        }
      ) => {
        const result = await createPortalTab(repoRoot, project, tabName, tabUriPart, {
          secure: options.secure === true,
          layoutHint: options.layoutHint,
          webApplication: options.webApplication,
          datastoreListLinks: parseLinkUriPairs(options.datastoreList || []),
          caseViewLinks: parseLinkUriPairs(options.caseView || []),
          caseListLinks: parseLinkUriPairs(options.caseList || []),
          formTasks: parseFormTasks(options.formTask || [])
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("create-case-list")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing Be Informed project name")
    .argument("<list-name>", "Case list label and file name")
    .argument("<uri-part>", "Unique list URI part")
    .argument("<record-type-link>", "Case record-type-link")
    .option("--create-form-link <link>", "Optional form link for create-case-task")
    .option("--update-form-link <link>", "Optional form link for update-case-task")
    .action(
      async (
        repoRoot: string,
        project: string,
        listName: string,
        uriPart: string,
        recordTypeLink: string,
        options: { createFormLink?: string; updateFormLink?: string }
      ) => {
        const result = await createCaseList(repoRoot, project, listName, uriPart, recordTypeLink, {
          createFormLink: options.createFormLink,
          updateFormLink: options.updateFormLink
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("create-datastore-list")
    .argument("<repo-root>", "Repository root")
    .argument("<project>", "Existing Be Informed project name")
    .argument("<list-name>", "Datastore list label and file name")
    .argument("<uri-part>", "Unique list URI part")
    .argument("<datastore-link>", "Datastore-link target")
    .option("--create-form-link <link>", "Optional form link for create-data-store-task")
    .option("--case-context-attribute-link <link>", "Optional case-context-attribute-link target")
    .action(
      async (
        repoRoot: string,
        project: string,
        listName: string,
        uriPart: string,
        datastoreLink: string,
        options: { createFormLink?: string; caseContextAttributeLink?: string }
      ) => {
        const result = await createDatastoreList(repoRoot, project, listName, uriPart, datastoreLink, {
          createFormLink: options.createFormLink,
          caseContextAttributeLink: options.caseContextAttributeLink
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  return program;
};

export const main = async (argv: string[]): Promise<void> => {
  await createProgram().parseAsync(argv);
};
