#!/usr/bin/env node
/**
 * Parse the approved agent CSV and create Test issues in Xray Cloud.
 *
 * The fourth sibling of ado-sync-csv.js, testrail-sync-csv.js and zephyr-sync-csv.js, deliberately
 * the same shape: same CSV parser, same Jira-key container match, same `{ created, errors, usage }`
 * result — so agent-docs.js can route to any of the four without caring which one it got.
 *
 * What genuinely differs is what a test *is*:
 *
 *   Azure DevOps        TestRail            Zephyr Essential       Xray
 *   ─────────────────   ─────────────────   ────────────────────   ──────────────────────────────
 *   a work item         a case in a suite   a case in a folder     a **Jira issue** of type Test
 *   steps inline XML    steps in a field    a second POST          steps in the same GraphQL call
 *   Plan → Suite        Suite → Section     Folder                 Test Repository folder path
 *   Tags = Jira:KEY     refs = KEY          a real issue link      Jira labels on the Test itself
 *
 * Because the Test is a Jira issue, one GraphQL mutation does everything: the issue, its steps and
 * its place in the repository. There is no second call to make, and the key that comes back is a
 * Jira key you can open in the same tab as the story.
 *
 * Two things this importer deliberately does not do yet, both because they would change what the
 * reviewer approved rather than just where it lands:
 *
 *  - **Preconditions stay as step 1.** In Xray a Precondition is its own issue type, linked to the
 *    test; creating one per case is a second artefact nobody approved. The CSV's preconditions row
 *    is filed as the first step, which is where it already is.
 *  - **Priority is not set.** A Jira priority is a per-project name ("High", "Major", …) and a
 *    wrong one fails the whole create. The CSV's 1/2 is left in the CSV.
 */
const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
const configStore = require("./config-store.js");
configStore.loadEnv();

const { createUsageTally } = require("./llm-usage");
const bddFormat = require("./web/bdd-format.js");
const { isFillerExpected } = require("./tms-rich-text.js");
const {
  parseCsvRows,
  csvRowsToTestCases,
  partitionManualStepsForSync,
  extractJiraKeyFromCsvFilename,
  normalizeJiraIssueKey,
  pickSuiteForJiraKey,
  titleFromCsvFilename,
  containerNameForJiraKey,
} = require("./ado-sync-csv.js");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Stored value first, then `.env`, then empty — the order every entry script uses. */
function cfgValue(key) {
  const cfg = configStore.configEnv();
  return String(cfg[key] || process.env[key] || "").trim();
}

function xrayClientOrThrow() {
  const built = configStore.xrayClientFrom();
  if (!built.ok) throw new Error(built.error);
  return built.client;
}

/** A boolean Setup value, defaulting the way the sibling importers' flags do. */
function cfgFlag(key, fallback) {
  const raw = cfgValue(key);
  if (!raw) return fallback;
  return raw === "true";
}

/** The Jira project the Test issues are created in. */
function projectKeyOrThrow() {
  const key = cfgValue("XRAY_PROJECT_KEY") || cfgValue("PROJECT_KEY");
  if (!key) throw new Error("Xray project is not set — fill in the project key on the Setup page");
  return key;
}

// ---------------------------------------------------------------------------
// Mapping the CSV onto an Xray test
// ---------------------------------------------------------------------------

/**
 * The Test Repository folder a ticket's cases are filed in, matched from the Jira key or created.
 *
 * Same rule as the Azure DevOps suite, the TestRail section and the Zephyr folder: a folder whose
 * name or path carries the key wins, and `pickSuiteForJiraKey` scores them so a leaf named exactly
 * "PROJ-123" beats one that merely mentions it. Folders are addressed by path here rather than by
 * id, so the path is what the matcher is handed as the "id".
 *
 * A miss creates `"<root>/PROJ-123 Story summary"`, which is what the Zephyr folder and the
 * TestRail section do — `createTest` takes a `folderPath` but is not documented to create one, so
 * the folder is made first rather than hoped for.
 *
 * Nothing here is fatal. Where TestRail can refuse to import without a section, this always has
 * somewhere to put a test: the configured root. A folder that cannot be read or made costs the
 * filing, not the run.
 *
 * @returns {Promise<{ folderPath: string, matched: boolean, created: boolean }>}
 */
async function resolveFolderForJiraKey(client, { projectId, jiraKey, rootPath, createMissing, title }) {
  const root = String(rootPath || "/").trim() || "/";
  const atRoot = { folderPath: root, matched: false, created: false };
  if (!jiraKey) return atRoot;
  if (!projectId) {
    console.warn(
      `   Xray: could not resolve the Jira project id — the folder tree cannot be read, filing under ${root}`
    );
    return atRoot;
  }

  let folders = [];
  try {
    folders = await client.listFolders(projectId);
  } catch (e) {
    console.warn(`   Xray: could not read the folder tree (${e.message}) — filing under ${root}`);
    return atRoot;
  }

  const flat = folders.map((f) => ({ suiteId: f.path, suiteName: f.name, path: f.path }));
  const picked = pickSuiteForJiraKey(flat, jiraKey);
  if (picked) {
    console.log(`   Xray: "${jiraKey}" → folder ${picked.path}`);
    return { folderPath: String(picked.suiteId), matched: true, created: false };
  }

  if (!createMissing) {
    console.log(`   Xray: no folder carries "${jiraKey}" — filing under ${root}`);
    return atRoot;
  }

  const wanted = `${root === "/" ? "" : root.replace(/\/+$/, "")}/${containerNameForJiraKey(jiraKey, title)}`;
  try {
    const made = await client.createFolder(projectId, wanted);
    console.log(`   Xray: no folder carries "${jiraKey}" — created ${made.path}`);
    (made.warnings || []).forEach((w) => console.warn(`   Xray: ${w}`));
    return { folderPath: made.path, matched: false, created: true };
  } catch (e) {
    console.warn(`   Xray: could not create ${wanted} (${e.message}) — filing under ${root}`);
    return atRoot;
  }
}

/**
 * Manual steps as Xray step objects.
 *
 * `result` is the CSV's Step Expected, minus the agent's "—" filler — a checklist item has nothing to
 * assert, and repeating the dash on every row is noise. `data` stays empty: the CSV has no column
 * for test data, and inventing one from the action would be a guess.
 *
 * @param {Array<{ action: string, expected: string }>} steps
 */
function buildStepItems(steps) {
  return steps
    .map((s) => ({
      action: String(s.action || "").trim(),
      data: "",
      result: isFillerExpected(s.expected) ? "" : String(s.expected || "").trim(),
    }))
    .filter((s) => s.action);
}

/**
 * A scenario as the Gherkin body Xray's Cucumber editor holds.
 *
 * No `Feature:` and no `Scenario:` line: in Xray the *test* is the scenario — the issue summary is
 * its name and this field is the body. The same split TestRail and Zephyr make, with the same
 * reasoning and a third syntax.
 *
 * Preconditions ride along as Gherkin **comments** at the top. TestRail and Zephyr each have a
 * precondition field to lift them into; a Cucumber test has none — in Xray a Precondition is its
 * own issue type — and the alternative that was here before was to drop them, which loses what a
 * tester needs before the scenario can start. A `#` line is valid Gherkin, shows in the editor,
 * and invents no step the reviewer did not approve.
 *
 * @param {Array<{ action: string, expected: string }>} steps preconditions already split off
 * @param {string} [preconditions] the text of the preconditions row, if the case had one
 */
function bddScenarioText(steps, preconditions) {
  const body = bddFormat.stepsToGherkinLines(steps).join("\n");
  const pre = String(preconditions || "").trim();
  if (!pre) return body;
  const commented = pre
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `# ${line}`);
  return ["# Preconditions:", ...commented, body].filter(Boolean).join("\n");
}

/** The labels a created Test carries: the ticket it covers, and its area. */
function buildLabels(tc, jiraKey) {
  // Jira labels cannot contain spaces — an Area Path of "Customer Portal" would be rejected and
  // take the whole create with it, so spaces and path separators become underscores and the rest
  // is dropped. `Project\Social Features` stays readable as `Project_Social_Features`.
  const clean = (v) =>
    String(v || "")
      .trim()
      .replace(/[\s\\/]+/g, "_")
      .replace(/[^\w.\-]/g, "");
  return [clean(jiraKey), clean(tc.areaPath)].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Create the CSV's approved test cases in Xray.
 *
 * @param {string} csvFilePath
 * @param {{ jiraIssueKey?: string, folderPath?: string }} [opts]
 * @returns {Promise<{ created: Array<{ id: unknown, title: string }>, errors: string[], usage: object }>}
 */
async function syncApprovedCsvToXray(csvFilePath, opts = {}) {
  const jiraKey =
    extractJiraKeyFromCsvFilename(csvFilePath) || normalizeJiraIssueKey(opts.jiraIssueKey || "");
  const text = fs.readFileSync(csvFilePath, "utf8");
  const testCases = csvRowsToTestCases(parseCsvRows(text));
  if (testCases.length === 0) {
    return { created: [], errors: ["No test cases parsed from CSV"], usage: createUsageTally() };
  }

  const client = xrayClientOrThrow();
  const projectKey = projectKeyOrThrow();
  // Xray addresses folders by the **numeric Jira project id**, and no Xray query turns a key into
  // one — so it is read from Jira with the credentials the card names. Without it the per-ticket
  // folder match cannot run, so a run that loses it says so out loud rather than silently filing
  // everything at the root.
  const resolved = await configStore.resolveXrayProjectId(projectKey, {});
  const projectId = resolved.id;
  if (!projectId) {
    console.log(`   ⚠ no folder matching: ${resolved.error}`);
    console.log(`   → every test goes to ${cfgValue("XRAY_FOLDER_PATH") || "/"}`);
  }

  // An explicit folder (the Manual Import step) skips the match entirely; the approval run never
  // passes one, which is the whole point of the key match.
  const folder = opts.folderPath
    ? { folderPath: String(opts.folderPath), matched: false, created: false }
    : await resolveFolderForJiraKey(client, {
        projectId,
        jiraKey,
        rootPath: cfgValue("XRAY_FOLDER_PATH") || "/",
        createMissing: cfgFlag("XRAY_CREATE_MISSING_FOLDER", true),
        title: titleFromCsvFilename(csvFilePath, jiraKey),
      });

  // One lookup for the whole run: every test links to the same ticket, and the link type is an
  // instance-wide name rather than a per-issue choice.
  const link = cfgFlag("XRAY_LINK_ISSUES", true) ? await resolveIssueLink(jiraKey) : null;

  const bddCount = testCases.filter((tc) => bddFormat.isBddTestCase(tc)).length;
  if (bddCount) {
    console.log(
      `   Xray: ${bddCount}/${testCases.length} case(s) are Gherkin scenarios → created as Cucumber tests`
    );
  }

  const created = [];
  const errors = [];

  for (const tc of testCases) {
    const manualSteps = partitionManualStepsForSync(tc.steps);
    if (!manualSteps.length) {
      errors.push(`Skipped (no steps): ${tc.title}`);
      continue;
    }

    const title = String(tc.title || "Test case").trim();
    const labels = buildLabels(tc, jiraKey);
    try {
      const isBdd = bddFormat.looksLikeGherkinSteps(manualSteps);
      // Preconditions are not Gherkin — they are what a run needs before the scenario can start —
      // so they are peeled off here exactly as the other importers peel them off, and kept.
      const split = bddFormat.splitPreconditionsRow(manualSteps);
      const made = isBdd
        ? await client.createCucumberTest({
            projectKey,
            summary: title,
            gherkin: bddScenarioText(split.steps, split.preconditions),
            folderPath: folder.folderPath,
            labels,
          })
        : await client.createManualTest({
            projectKey,
            summary: title,
            steps: buildStepItems(manualSteps),
            folderPath: folder.folderPath,
            labels,
          });
      created.push({ id: made.key, title });
      (made.warnings || []).forEach((w) => errors.push(`${title}: Xray warning — ${w}`));

      if (link) {
        try {
          await link.link(made.key);
        } catch (e) {
          // The test exists and is the point; a missing link is worth saying, not failing over.
          // Same call the Zephyr importer makes about its own issue link.
          errors.push(`${title}: created ${made.key}, but the Jira link failed — ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`${title}: ${e.message}`);
    }
  }

  // Always an empty tally: this import makes no LLM calls. It is returned anyway so the caller in
  // agent-docs.js can fold it in without asking which provider it got.
  return { created, errors, usage: createUsageTally() };
}

/**
 * A closure that links one created Test back to the story, or null when it cannot be had.
 *
 * The Zephyr sibling posts a link through Zephyr's own endpoint; here both ends are ordinary Jira
 * issues, so the link is an ordinary Jira link and the Xray API is not involved at all. It runs on
 * the credentials the card already names for the project-id lookup — the Xray card's own Jira
 * fields when it has them, the main Jira card otherwise — so a separate Jira site is linked
 * correctly rather than against the wrong instance.
 *
 * The link **type** is resolved once and per instance: "Test" and "Tests" are what Xray's own
 * conventions use, "Relates" exists everywhere, and `XRAY_LINK_TYPE` overrides all of it. A type
 * this instance does not have would fail every single create, so a name that matches nothing falls
 * back rather than throwing.
 *
 * @param {string} jiraKey the story the tests cover
 * @returns {Promise<{ link: (testKey: string) => Promise<void>, type: string } | null>}
 */
async function resolveIssueLink(jiraKey) {
  if (!jiraKey) return null;
  const { base, email, token, source, missing } = configStore.xrayJiraCreds(configStore.configEnv());
  if (missing.length) {
    console.warn(
      `   Xray: no Jira credentials for issue links (${missing.join(", ")} on ${source === "xray" ? "the Xray card" : "the Jira card"}) — tests carry the key as a label only`
    );
    return null;
  }

  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const call = async (endpoint, init = {}) => {
    const res = await fetch(`${base}${endpoint}`, {
      ...init,
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
    // POST /issueLink answers 201 with an empty body, so nothing is parsed unless there is a body.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  let type = "";
  try {
    const wanted = cfgValue("XRAY_LINK_TYPE");
    const body = await call("/rest/api/3/issueLinkType");
    const names = ((body && body.issueLinkTypes) || []).map((t) => String(t.name || ""));
    const match = (want) => names.find((n) => n.toLowerCase() === String(want).toLowerCase());
    type = (wanted && match(wanted)) || match("Test") || match("Tests") || match("Relates") || names[0] || "";
    if (wanted && !match(wanted)) {
      console.warn(`   Xray: this Jira has no "${wanted}" link type — using "${type}" instead`);
    }
  } catch (e) {
    console.warn(`   Xray: could not read Jira link types (${e.message}) — tests carry the key as a label only`);
    return null;
  }
  if (!type) return null;

  // Xray can live on a different Jira site than the story (a trial beside the real one). A link
  // to a key that site does not have fails on every test, so it is checked once and skipped.
  try {
    await call(`/rest/api/3/issue/${encodeURIComponent(jiraKey)}?fields=summary`);
  } catch (e) {
    // A 404 is the expected answer when Xray sits on another site — say that plainly, not as a fault.
    if (/\b404\b/.test(e.message)) {
      console.log(
        `   ℹ️  Xray: ${jiraKey} lives on another Jira site than ${base} — no issue link, the key is on each test as a label`
      );
    } else {
      console.warn(`   Xray: could not check ${jiraKey} on ${base} (${e.message.slice(0, 80)}) — no issue link`);
    }
    return null;
  }

  console.log(`   Xray: tests are linked to ${jiraKey} as "${type}"`);
  return {
    type,
    link: async (testKey) => {
      // The Test is the inward end: it tests the story, the story does not test it. With a
      // symmetric type like "Relates" the direction makes no visible difference either way.
      await call("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({
          type: { name: type },
          inwardIssue: { key: testKey },
          outwardIssue: { key: jiraKey },
        }),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseXraySyncCliArgs(argv) {
  const args = { csv: "", jiraKey: "", folderPath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--jira-key" || a === "-j") args.jiraKey = String(argv[++i] || "");
    else if (a === "--folder" || a === "-f") args.folderPath = String(argv[++i] || "");
    else if (!a.startsWith("-")) args.csv = a;
  }
  return args;
}

async function main() {
  const args = parseXraySyncCliArgs(process.argv.slice(2));
  if (!args.csv) {
    console.error("Usage: node xray-sync-csv.js <approved.csv> [--jira-key PROJ-123] [--folder /Path]");
    process.exit(1);
  }
  const csvPath = path.resolve(args.csv);
  console.log(`📂 CSV: ${csvPath}`);
  const r = await syncApprovedCsvToXray(csvPath, {
    jiraIssueKey: args.jiraKey,
    folderPath: args.folderPath,
  });
  r.created.forEach((c) => console.log(`   ✅ Xray test ${c.id}: ${c.title}`));
  r.errors.forEach((e) => console.warn(`   ⚠️  ${e}`));
  console.log(`\n${r.created.length} test(s) created, ${r.errors.length} problem(s).`);
  if (!r.created.length) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  syncApprovedCsvToXray,
  resolveIssueLink,
  parseXraySyncCliArgs,
  resolveFolderForJiraKey,
  buildStepItems,
  buildLabels,
  bddScenarioText,
};
