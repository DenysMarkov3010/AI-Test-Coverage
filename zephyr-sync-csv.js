#!/usr/bin/env node
/**
 * Parse the approved agent CSV and create test cases in Zephyr Essential 2.0.
 *
 * The third sibling of ado-sync-csv.js and testrail-sync-csv.js, deliberately the
 * same shape: same CSV parser, same Jira-key container match, same
 * `{ created, errors, usage }` result — so agent-docs.js can route to any of the
 * three without caring which one it got.
 *
 * What genuinely differs is writing the case:
 *
 *   Azure DevOps                       TestRail                     Zephyr Essential
 *   ────────────────────────────────   ──────────────────────────   ─────────────────────────────
 *   one POST, steps inline as XML      one POST, steps in a field   three calls: case, then
 *                                                                   steps (or script), then link
 *   Plan → Suite                       Suite → Section              Folder, inside the project
 *   Priority 1-4, 1 = highest          priority_id, inverted        priorityName, by name
 *   System.Tags = Jira:PROJ-123         refs = PROJ-123               a real issue link, by issue ID
 *   Preconditions stay as step 1       lifted into `custom_preconds` lifted into `precondition`
 *
 * Three calls per case is not a choice: `POST /testcases` takes no steps, and
 * the steps endpoint is keyed by the case key that call returns. The issue link
 * is a third because it needs Jira's numeric issue id, which Zephyr does not
 * resolve from a key.
 *
 * BDD has a first-class home here. A scenario goes to `/testscript` with
 * `type: "bdd"` rather than into the step grid — the same split TestRail makes
 * between its BDD field and ordinary steps. A case has a script or steps, never
 * both, so the two paths are exclusive. What is *not* the same as TestRail is
 * what that field accepts: bare keyword lines, no `Feature:` and no `Scenario:`
 * — see bddScriptText().
 *
 * The folder is matched per ticket by Jira key, the way the Azure DevOps suite
 * and the TestRail section are, so nobody edits Setup between tickets. An
 * explicit folder (the Manual Import step) skips the match entirely.
 */
const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
const configStore = require("./config-store.js");
configStore.loadEnv();

const { createUsageTally } = require("./llm-usage");
const bddFormat = require("./web/bdd-format.js");
/**
 * Zephyr's text fields are a WYSIWYG editor and store HTML, so a cell posted as
 * plain lines comes back inside one paragraph and the browser collapses the
 * newlines into spaces — which is what ran the preconditions, and a multi-line
 * expected result, together into one long line. The rules are shared with the
 * TestRail importer, which stores its fields exactly the same way.
 */
const { isFillerExpected, formatRichTextCell, formatPreconditions } = require("./tms-rich-text.js");
const { buildFolderPaths } = require("./zephyr-client.js");
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

function cfgFlag(key, fallback) {
  const raw = cfgValue(key).toLowerCase();
  if (!raw) return fallback;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

function zephyrClientOrThrow() {
  const built = configStore.zephyrClientFrom();
  if (!built.ok) throw new Error(built.error);
  return built.client;
}

/** The project every read and write is scoped by. A key, not an id — see ZEPHYR.md §3. */
function projectKeyOrThrow() {
  const key = cfgValue("ZEPHYR_PROJECT_KEY");
  if (!key) throw new Error("Zephyr project is not set — pick one on the Setup page");
  return key;
}

// ---------------------------------------------------------------------------
// Mapping the CSV onto a Zephyr case
// ---------------------------------------------------------------------------

/**
 * Split off the preconditions row.
 *
 * Agent CSVs put preconditions in step 1 with expected "—", which is an Azure
 * DevOps convention: it has no field for them. Zephyr has a real `precondition`
 * field, so the row moves there instead of pretending to be a step.
 *
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} steps
 */
function splitPreconditionsFromSteps(steps) {
  const { preconditions, steps: rest } = bddFormat.splitPreconditionsRow(steps);
  return { preconditions, steps: rest };
}

/**
 * The CSV's 1-4 priority onto whatever this project calls its priorities.
 *
 * Zephyr takes a name, and a project is free to rename or reorder them, so the
 * list is read once and matched by position: CSV 1 is the most urgent, and so
 * is the first priority Zephyr returns. A name that matches outright wins over
 * the position, which covers the stock High / Normal / Low unchanged.
 *
 * @param {Array<{ id: number, name: string, default?: boolean }>} priorities
 * @returns {(csvPriority: unknown) => string|undefined}
 */
function buildPriorityResolver(priorities) {
  const rows = (priorities || []).filter((p) => p && p.name);
  if (!rows.length) return () => undefined;

  const byName = new Map(rows.map((p) => [String(p.name).toLowerCase(), String(p.name)]));
  // The stock scale, for the common case where the CSV says 1-4 and the project
  // never touched its priorities.
  const CSV_TO_STOCK = { 1: "high", 2: "normal", 3: "normal", 4: "low" };

  return (csvPriority) => {
    const raw = String(csvPriority == null ? "" : csvPriority).trim();
    if (!raw) return undefined;
    if (byName.has(raw.toLowerCase())) return byName.get(raw.toLowerCase());

    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return undefined;
    const stock = CSV_TO_STOCK[Math.min(4, Math.max(1, n))];
    if (stock && byName.has(stock)) return byName.get(stock);
    // Renamed priorities: fall back to position, clamped to what exists.
    return String(rows[Math.min(rows.length - 1, Math.max(0, n - 1))].name);
  };
}

/**
 * The folder generated cases are filed in, matched from the Jira key.
 *
 * Same rule as the Azure DevOps suite and the TestRail section: a folder whose
 * name or path carries the key wins, and `pickSuiteForJiraKey` scores them so a
 * leaf named exactly "PROJ-123" beats one that merely mentions it. The rows are
 * reshaped to the `{ suiteId, suiteName, path }` triple that matcher takes.
 *
 * @param {import("./zephyr-client").ZephyrEssentialClient} client
 * @param {{ projectKey: string, jiraKey: string, createMissing: boolean, title?: string }} args
 * @returns {Promise<{ folderId: number, name: string, created: boolean }>}
 */
async function resolveFolderForJiraKey(client, { projectKey, jiraKey, createMissing, title }) {
  if (!jiraKey) {
    throw new Error(
      "No Jira key to match a folder with — name the CSV approved-testcases-PROJ-123.csv, or pass --jira-key"
    );
  }

  const folders = buildFolderPaths(await client.listFolders(projectKey, "TEST_CASE"));
  const flat = folders.map((f) => ({ suiteId: f.id, suiteName: f.name, path: f.path }));

  const picked = pickSuiteForJiraKey(flat, jiraKey);
  if (picked) {
    console.log(`   Zephyr: "${jiraKey}" → folder ${picked.suiteId} — ${picked.path}`);
    return { folderId: Number(picked.suiteId), name: picked.suiteName, created: false };
  }

  if (!createMissing) {
    throw new Error(
      `No folder carries "${jiraKey}" (${flat.length} folder(s) searched) and ZEPHYR_CREATE_MISSING_FOLDER is off — create the folder in Zephyr, or switch that on`
    );
  }

  // "PROJ-123 Story summary", the same shape the TestRail section gets. The key leads because it is
  // what the next run matches on; the summary is there so the folder tree reads as something other
  // than a column of keys. It comes from the CSV's file name, so it costs no Jira call.
  const name = containerNameForJiraKey(jiraKey, title);
  const made = await client.createFolder({ name, projectKey });
  const id = Number(made && made.id);
  if (!Number.isFinite(id)) {
    throw new Error(`Zephyr accepted the folder "${name}" but returned no id`);
  }
  console.log(`   Zephyr: "${jiraKey}" → no folder matched, created folder ${id} — ${name}`);
  return { folderId: id, name, created: true };
}

/**
 * The `POST /testcases` body for one parsed CSV case.
 *
 * @param {object} args
 * @param {object} args.tc parsed case from csvRowsToTestCases()
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} args.steps
 * @param {string} args.projectKey
 * @param {number|undefined} args.folderId
 * @param {string|undefined} args.priorityName
 * @param {string} args.statusName
 * @param {string} args.jiraKey
 */
function buildCasePayload({ tc, steps, projectKey, folderId, priorityName, statusName, jiraKey }) {
  const preconditions = formatPreconditions(splitPreconditionsFromSteps(steps).preconditions);

  /** @type {Record<string, unknown>} */
  const payload = { projectKey, name: String(tc.title || "Test case").trim() };
  if (Number.isFinite(Number(folderId))) payload.folderId = Number(folderId);
  if (priorityName) payload.priorityName = priorityName;
  if (statusName) payload.statusName = statusName;
  if (preconditions) payload.precondition = preconditions;
  // The Area Path column has no second axis to land on here, so it rides as a
  // label — the one place Zephyr can hold it without inventing a custom field.
  const areaPath = String(tc.areaPath || "").trim();
  const labels = [jiraKey, areaPath].filter(Boolean);
  if (labels.length) payload.labels = labels;
  return payload;
}

/**
 * A scenario as Zephyr's BDD script: the keyword lines and nothing else.
 *
 * No `Feature:` and no `Scenario:` header. Zephyr's validator rejects both with a flat
 * `Invalid Gherkin script`, because in its model the *case* is the scenario — the case name is
 * the scenario name, and this field holds only the body. That was measured against a live
 * instance: bare `Given / When / Then` lines are accepted, and every shape carrying a header is
 * refused, with or without indentation, trailing newline or CRLF.
 *
 * It is the opposite of the sibling importer: TestRail's BDD field takes a whole `.feature`
 * document. Same design, two products, two different ideas of what a scenario is.
 *
 * This is also the one field here that is NOT HTML: it is parsed by Zephyr's Gherkin validator
 * and rendered in a code editor, so the lines are sent plain. Running them through the rich-text
 * formatter would post `<br>` into a scenario and fail validation.
 *
 * @param {Array<{ action: string, expected: string }>} steps preconditions already split off
 */
function bddScriptText(steps) {
  return bddFormat.stepsToGherkinLines(steps).join("\n");
}

/**
 * Manual steps as Zephyr's inline step objects.
 *
 * `expectedResult` is the CSV's Step Expected. A standard case fills both; a
 * checklist leaves it empty; a BDD one never reaches here, because a scenario
 * goes to the script endpoint.
 *
 * Both cells are rich text, so both go through the same formatter the
 * preconditions use: a bulleted expected result becomes a `<ul>`, any other
 * multi-line cell becomes `<br>`-joined lines, and a single line stays plain
 * escaped text. Posted raw, every one of those renders as one run-on line.
 *
 * @param {Array<{ action: string, expected: string }>} steps
 */
function buildStepItems(steps) {
  return steps
    .map((s) => ({
      description: formatRichTextCell(s.action),
      // "—" is the agent's filler for "nothing to assert" — a checklist item, or a
      // step whose result is the next step. Zephyr has an empty cell for that,
      // and repeating the dash on every row is noise the reviewer has to read
      // past. Same call TestRail's separated steps make.
      expectedResult: isFillerExpected(s.expected) ? "" : formatRichTextCell(s.expected),
    }))
    .filter((s) => s.description);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Create the CSV's approved test cases in Zephyr Essential.
 *
 * @param {string} csvFilePath
 * @param {{ jiraIssueKey?: string, folderId?: number|string }} [opts]
 * @returns {Promise<{ created: Array<{ id: unknown, title: string }>, errors: string[], usage: object }>}
 */
async function syncApprovedCsvToZephyr(csvFilePath, opts = {}) {
  const jiraKey =
    extractJiraKeyFromCsvFilename(csvFilePath) || normalizeJiraIssueKey(opts.jiraIssueKey || "");
  const text = fs.readFileSync(csvFilePath, "utf8");
  const testCases = csvRowsToTestCases(parseCsvRows(text));
  if (testCases.length === 0) {
    return { created: [], errors: ["No test cases parsed from CSV"], usage: createUsageTally() };
  }

  const client = zephyrClientOrThrow();
  const projectKey = projectKeyOrThrow();

  // An explicit folder (the Manual Import step) skips the match entirely; the
  // approval run never passes one, which is the whole point of the key match.
  const folder = opts.folderId
    ? { folderId: Number(opts.folderId), name: `folder ${opts.folderId}`, created: false }
    : await resolveFolderForJiraKey(client, {
        projectKey,
        jiraKey,
        createMissing: cfgFlag("ZEPHYR_CREATE_MISSING_FOLDER", true),
        title: titleFromCsvFilename(csvFilePath, jiraKey),
      });

  const statusName = cfgValue("ZEPHYR_DEFAULT_STATUS");
  const priorities = await client.listPriorities(projectKey).catch((e) => {
    console.warn(`   Zephyr: could not read priorities (${e.message}) — cases keep the project default`);
    return [];
  });
  const resolvePriority = buildPriorityResolver(priorities);

  // One lookup for the whole run: every case links to the same ticket, and the
  // link endpoint takes Jira's numeric id rather than the key.
  const issueId = cfgFlag("ZEPHYR_LINK_ISSUES", true) ? await resolveJiraIssueId(jiraKey) : 0;

  const bddCount = testCases.filter((tc) => bddFormat.isBddTestCase(tc)).length;
  if (bddCount) {
    console.log(
      `   Zephyr: ${bddCount}/${testCases.length} case(s) are Gherkin scenarios → written as a BDD test script`
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

    try {
      const payload = buildCasePayload({
        tc,
        steps: manualSteps,
        projectKey,
        folderId: folder.folderId,
        priorityName: resolvePriority(tc.priority),
        statusName,
        jiraKey,
      });
      const made = await client.createTestCase(payload);
      const key = made && made.key;
      if (!key) {
        errors.push(`${tc.title}: Zephyr accepted the case but returned no key`);
        continue;
      }
      // Counted as created here, not at the end of the block. The case exists from this line on,
      // and the two calls below add to it — a case with no steps is a case with a problem, not a
      // case that was never made, and reporting "0 created" for nine real cases sends anyone
      // looking in the wrong place.
      created.push({ id: key, title: tc.title });

      // Preconditions already moved to their own field, so only the rest is a step.
      const { steps: bodySteps } = splitPreconditionsFromSteps(manualSteps);

      try {
        if (bddFormat.looksLikeGherkinSteps(manualSteps)) {
          await client.setTestScript(key, bddScriptText(bodySteps), "bdd");
        } else {
          const items = buildStepItems(bodySteps);
          if (items.length) await client.setTestSteps(key, items);
        }
      } catch (e) {
        errors.push(`${tc.title}: created ${key}, but its steps did not — ${e.message}`);
      }

      if (issueId) {
        try {
          await client.linkIssue(key, issueId);
        } catch (e) {
          // The case exists and is the point; a missing link is worth saying, not failing over.
          errors.push(`${tc.title}: created ${key}, but the Jira link failed — ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`${tc.title}: ${e.message}`);
    }
  }

  // Always an empty tally: this import makes no LLM calls. It is returned anyway
  // so the caller in agent-docs.js can fold it in without asking which provider
  // it got.
  return { created, errors, usage: createUsageTally() };
}

/**
 * Jira's numeric id for an issue key, or 0 when it cannot be had.
 *
 * Zephyr's link endpoint takes the id, and nothing else in this import needs
 * Jira at all — so a failure here costs the links and not the run.
 *
 * @param {string} jiraKey
 * @returns {Promise<number>}
 */
async function resolveJiraIssueId(jiraKey) {
  if (!jiraKey) return 0;
  const base = cfgValue("JIRA_BASE_URL");
  const email = cfgValue("JIRA_EMAIL");
  const token = cfgValue("JIRA_API_TOKEN");
  if (!base || !email || !token) {
    console.warn("   Zephyr: Jira credentials are not set — cases are created without an issue link");
    return 0;
  }
  try {
    const { JiraClient } = require("./jira-client.js");
    const issue = await new JiraClient(base, email, token).getIssue(jiraKey);
    const id = Number(issue && issue.id);
    return Number.isFinite(id) ? id : 0;
  } catch (e) {
    console.warn(`   Zephyr: could not resolve ${jiraKey} in Jira (${e.message}) — no issue links`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI args: [options] <path-to-approved.csv>
 * Options: --folder-id / -f, --jira-key / -j, --help
 */
function parseZephyrSyncCliArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let folderId = NaN;
  let jiraKey = process.env.ZEPHYR_SYNC_JIRA_KEY || "";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--folder-id" || a === "-f") folderId = parseInt(args[++i], 10);
    else if (a === "--jira-key" || a === "-j") jiraKey = String(args[++i] || "");
    else positional.push(a);
  }
  return { csvPath: positional[0] || "", folderId, jiraKey, help };
}

async function main() {
  const { csvPath, folderId, jiraKey, help } = parseZephyrSyncCliArgs(process.argv);
  if (help || !csvPath) {
    console.log(
      [
        "Usage: npm run zephyr:sync-csv -- [options] <path-to-approved.csv>",
        "",
        "  -f, --folder-id <id>   file into this folder instead of matching the Jira key",
        "  -j, --jira-key <KEY>   when the file name does not carry it",
        "",
        "Project and token come from the Setup page (see ZEPHYR.md).",
      ].join("\n")
    );
    process.exit(help ? 0 : 1);
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.error(`❌ No such file: ${abs}`);
    process.exit(1);
  }

  const r = await syncApprovedCsvToZephyr(abs, {
    jiraIssueKey: jiraKey,
    folderId: Number.isFinite(folderId) ? folderId : undefined,
  });
  r.created.forEach((c) => console.log(`   ✅ Zephyr ${c.id}: ${c.title}`));
  r.errors.forEach((e) => console.warn(`   ⚠️  ${e}`));
  console.log(`\n${r.created.length} case(s) created, ${r.errors.length} problem(s).`);
  if (!r.created.length) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  syncApprovedCsvToZephyr,
  parseZephyrSyncCliArgs,
  splitPreconditionsFromSteps,
  formatPreconditions,
  buildPriorityResolver,
  buildCasePayload,
  buildStepItems,
  bddScriptText,
  resolveFolderForJiraKey,
};
