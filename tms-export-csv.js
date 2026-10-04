#!/usr/bin/env node
/**
 * Existing test cases from Zephyr Essential or Xray → one agent CSV, the input of the Update flow.
 *
 * The Update flow reads a CSV from `Updated test cases` and does not care where it came from; for
 * Azure DevOps that CSV is an export, for these two it had to be made by hand. This writes it from
 * the TMS directly.
 *
 * Which cases, is the QA engineer's call: the Jira key on the Update page is the ticket carrying the
 * *new* requirements, and the cases being updated can sit anywhere — under an older story, in a
 * regression folder. So the Web UI exports what was ticked in the "Add context from …" tree
 * (exportPickedCases), across as many folders as were ticked. The CLI can also find a folder by a
 * Jira key (exportCasesForJiraKey), which only works for cases this project filed itself.
 *
 * Two kinds of case come through, and both have to land in the same CSV shape:
 *
 *   - **new** ones, filed by this project's importers — every field below is where the importer
 *     put it, so the table is simply the importer read backwards;
 *   - **old** ones, written by hand before this tool existed — no labels, free-form preconditions,
 *     and shapes the importers never produce: an Xray Precondition *issue* linked to the test, an
 *     Xray Generic test holding one block of free text, a Zephyr step that calls another case.
 *
 *   | In the TMS                                  | In the CSV                                      |
 *   |---------------------------------------------|-------------------------------------------------|
 *
 *   | Zephyr `precondition`                       | step 1 "Preconditions: …" with expected "—"     |
 *   | Xray step 1 "Preconditions: …" (new)        | the same row, "—" restored                      |
 *   | Xray linked Precondition issues (old)       | the same preconditions row, one line each       |
 *   | Zephyr BDD script / Xray Cucumber           | Gherkin lines as steps (`#` comments → preconds)|
 *   | Xray Generic test (old)                     | one step holding its text                       |
 *   | Zephyr step calling another case (old)      | a step "Call test case PROJ-T9"                  |
 *   | rich-text step cells                        | plain lines, `<ul>` back to "- " lines          |
 *   | test data (Zephyr `testData`, Xray `data`)  | appended to Step Action — the CSV has no column |
 *   | priority name                               | 1-4                                             |
 *   | labels: Jira key + Area Path (new)          | Area Path = the first label that is not a key   |
 *
 * The ID column carries the TMS key (`PROJ-T12`, `PROJ-456`), not the Jira key: nothing reads it in
 * the Update flow today, and it is what an in-place update would need to find the case again.
 *
 * A checklist is a case whose steps have no expected result at all. Its preconditions row, if it
 * has one, keeps an empty expected rather than "—": the Update flow files a block as a checklist
 * only when every Step Expected is empty, and one dash would turn it into a test case.
 *
 * Read-only by construction: nothing here writes to any TMS.
 *
 * CLI (cases this project filed — the folder named after the key, or one named outright):
 *   node tms-export-csv.js --jira-key PROJ-123 [--folder <id or path>] [--out <dir>]
 *   npm run tms:export-csv -- --jira-key PROJ-123
 */
const fs = require("fs");
const path = require("path");
const configStore = require("./config-store.js");
const bddFormat = require("./web/bdd-format.js");
const { htmlToCell } = require("./tms-rich-text.js");
const { pickSuiteForJiraKey, normalizeJiraIssueKey, titleFromCsvFilename } = require("./ado-sync-csv.js");
const { JiraClient, contextIssueKeyFor } = require("./jira-client.js");

/** Providers this can read from. Azure DevOps has its own export (ado-export-tag-csv.js). */
const EXPORTABLE_PROVIDERS = new Set(["zephyr", "xray"]);

const HEADER = ["ID", "Work Item Type", "Title", "Test Step", "Step Action", "Step Expected", "Priority", "Area Path", "Assigned To", "State"];

/** Zephyr steps are one call per case; this many run at once. */
const ZEPHYR_STEP_CONCURRENCY = 5;

const PRECONDITIONS_RE = /^preconditions?\s*:\s*/i;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const FILENAME_FORBIDDEN = /[<>:"/\\|?*\x00-\x1f]/g;

/** A priority name → the CSV's 1-4. Stock names first, the importer's own map read backwards. */
const PRIORITY_BY_NAME = {
  blocker: "1",
  highest: "1",
  critical: "1",
  high: "1",
  major: "2",
  medium: "2",
  normal: "2",
  minor: "3",
  low: "4",
  lowest: "4",
  trivial: "4",
};

const message = (e) => String((e && e.message) || e).slice(0, 300);

function cfgValue(key) {
  return String(configStore.configEnv()[key] || process.env[key] || "").trim();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// One case → CSV rows
// ---------------------------------------------------------------------------

/** "High" → "1". An unknown name falls back to its position in the project's list, then to 2. */
function csvPriority(name, orderedNames = []) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return "2";
  if (PRIORITY_BY_NAME[n]) return PRIORITY_BY_NAME[n];
  const at = orderedNames.findIndex((p) => String(p).toLowerCase() === n);
  return at >= 0 ? String(Math.min(4, at + 1)) : "2";
}

/** The importers stamp the Jira key and the Area Path as labels; the Area Path is the other one. */
function areaPathFromLabels(labels) {
  return (labels || []).map((l) => String(l || "").trim()).find((l) => l && !JIRA_KEY_RE.test(l)) || "";
}

/**
 * Xray Precondition issues linked to an old test → preconditions text, one line per issue: its
 * summary, then its definition on the same line. A definition over several lines is folded with
 * "; ", because each line of the preconditions row is read as one precondition.
 *
 * @param {Array<{ summary: string, definition: string }>} preconditions
 */
function linkedPreconditionsText(preconditions) {
  return (preconditions || [])
    .map((p) => {
      const summary = String(p.summary || "").trim();
      const definition = htmlToCell(p.definition).split("\n").filter(Boolean).join("; ");
      if (summary && definition && definition !== summary) return `${summary}: ${definition}`;
      return summary || definition;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The Xray importer puts preconditions at the top of a Cucumber scenario as `#` comments, under a
 * "# Preconditions:" line. They come off here, back into the preconditions they were.
 */
function splitGherkinComments(text) {
  const pre = [];
  const body = [];
  for (const raw of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      const comment = line.replace(/^#+\s*/, "");
      if (comment && !/^preconditions?\s*:?\s*$/i.test(comment)) pre.push(comment);
      continue;
    }
    body.push(raw);
  }
  return { preconditions: pre.join("\n"), body: body.join("\n") };
}

/**
 * A normalized case → the agent CSV step rows the Update flow parses.
 *
 * @param {{ preconditions?: string, steps?: Array<{ action: string, data?: string, expected?: string }>, gherkin?: string }} tc
 * @returns {{ steps: Array<{ stepNumber: number, action: string, expected: string }>, kind: "bdd"|"checklist"|"testcase" }}
 */
function toAgentSteps(tc) {
  if (String(tc.gherkin || "").trim()) {
    const { preconditions, body } = splitGherkinComments(tc.gherkin);
    const pre = [tc.preconditions, preconditions].filter(Boolean).join("\n");
    return { steps: bddFormat.gherkinTextToSteps(body, { preconditions: pre }), kind: "bdd" };
  }

  let pre = String(tc.preconditions || "").trim();
  let steps = (tc.steps || [])
    .map((s) => {
      const action = String(s.action || "").trim();
      const data = String(s.data || "").trim();
      return {
        action: data ? `${action}\nTest data: ${data}` : action,
        expected: String(s.expected || "").trim(),
      };
    })
    .filter((s) => s.action || s.expected);

  // Xray keeps the preconditions as step 1, the way the CSV had them.
  if (steps.length && PRECONDITIONS_RE.test(steps[0].action)) {
    const lifted = steps[0].action.replace(PRECONDITIONS_RE, "").trim();
    pre = [pre, lifted].filter(Boolean).join("\n");
    steps = steps.slice(1);
  }

  const isChecklist = steps.length > 0 && steps.every((s) => !s.expected);
  const preRow = bddFormat.preconditionsStep(pre);
  if (preRow && isChecklist) preRow.expected = "";
  const all = preRow ? [preRow, ...steps] : steps;
  return {
    steps: all.map((s, i) => ({ stepNumber: i + 1, action: s.action, expected: s.expected })),
    kind: isChecklist ? "checklist" : "testcase",
  };
}

function escapeCsvField(val) {
  const s = String(val ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rowToCsv = (cells) => cells.map(escapeCsvField).join(",");

/**
 * Normalized cases → the CSV text, plus what was in it.
 *
 * @param {Array<{ id: string, title: string, priority: string, areaPath: string, state?: string,
 *   preconditions?: string, steps?: Array, gherkin?: string }>} cases
 */
function casesToAgentCsv(cases) {
  const lines = [rowToCsv(HEADER)];
  const stats = { cases: 0, testCases: 0, bdd: 0, checklists: 0, skippedEmpty: [] };
  for (const tc of cases) {
    const { steps, kind } = toAgentSteps(tc);
    // The Update flow drops a block with no steps anyway; saying so here is kinder than silence.
    if (!steps.length) {
      stats.skippedEmpty.push(tc.id);
      continue;
    }
    stats.cases += 1;
    if (kind === "bdd") stats.bdd += 1;
    else if (kind === "checklist") stats.checklists += 1;
    else stats.testCases += 1;

    lines.push(rowToCsv([tc.id, "Test Case", tc.title, "", "", "", tc.priority || "2", tc.areaPath || "", "", tc.state || ""]));
    for (const s of steps) {
      lines.push(rowToCsv(["", "", "", String(s.stepNumber), s.action, s.expected, "", "", "", ""]));
    }
  }
  return { csv: lines.join("\r\n") + "\r\n", stats };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const zephyr = {
  title: "Zephyr Essential",

  async folders() {
    const res = await configStore.listZephyrFolders();
    if (!res.ok) throw new Error(res.error);
    return res.folders;
  },

  /** @param {string|number} folderId @param {string[]|null} [caseIds] only these; null = all */
  async cases(folderId, caseIds = null) {
    const built = configStore.zephyrClientFrom({});
    if (!built.ok) throw new Error(built.error);
    const client = built.client;
    const projectKey = cfgValue("ZEPHYR_PROJECT_KEY");
    if (!projectKey) throw new Error("Zephyr project is not set — pick one on the Setup page");

    const wanted = caseIds ? new Set(caseIds.map(String)) : null;
    // Filtered before the steps are read: that is one call per case, and only ticked ones pay it.
    const rows = (await client.listTestCases(projectKey, folderId)).filter(
      (c) => c && c.key && (!wanted || wanted.has(String(c.key)))
    );
    // A case may carry its priority by id only; the project's list turns that into a name.
    const priorities = await client.listPriorities(projectKey).catch(() => []);
    const priorityNameById = new Map((priorities || []).map((p) => [String(p.id), String(p.name || "")]));
    const orderedNames = (priorities || []).map((p) => String(p.name || ""));

    return mapLimit(rows, ZEPHYR_STEP_CONCURRENCY, async (c) => {
      const pr = c.priority || {};
      const priorityName = c.priorityName || pr.name || priorityNameById.get(String(pr.id != null ? pr.id : c.priorityId)) || "";
      const tc = {
        id: String(c.key),
        title: String(c.name || c.key),
        priority: csvPriority(priorityName, orderedNames),
        areaPath: areaPathFromLabels(c.labels),
        state: String((c.status && c.status.name) || c.statusName || ""),
        preconditions: htmlToCell(c.precondition),
        steps: [],
        gherkin: "",
      };
      const steps = await client.getTestSteps(c.key);
      tc.steps = (steps || [])
        .map((s) => {
          // A hand-written case can call another case as one of its steps; there is no inline text
          // to read, so the call itself becomes the step rather than vanishing.
          const called = s && s.testCase && (s.testCase.testCaseKey || s.testCase.key);
          if (called && !(s.inline && s.inline.description)) {
            return { action: `Call test case ${called}`, data: "", expected: "" };
          }
          const inline = (s && s.inline) || {};
          return { action: htmlToCell(inline.description), data: htmlToCell(inline.testData), expected: htmlToCell(inline.expectedResult) };
        })
        .filter((s) => s.action || s.expected);
      if (!tc.steps.length) {
        // A BDD case has a script instead of steps, and 404s the other way round.
        const script = await client.getTestScript(c.key).catch(() => null);
        tc.gherkin = script && script.text ? String(script.text) : "";
      }
      return tc;
    });
  },
};

const xray = {
  title: "Xray",

  async folders() {
    const res = await configStore.listXrayFolders();
    if (!res.ok) throw new Error(res.detail || res.error);
    return res.folders;
  },

  /** @param {string} folderPath @param {string[]|null} [caseIds] only these; null = all */
  async cases(folderPath, caseIds = null) {
    const built = configStore.xrayClientFrom({});
    if (!built.ok) throw new Error(built.error);
    const projectKey = cfgValue("XRAY_PROJECT_KEY") || cfgValue("PROJECT_KEY");
    const resolved = await configStore.resolveXrayProjectId(projectKey);
    if (!resolved.id) throw new Error(resolved.error || `No numeric project id for "${projectKey}"`);

    const wanted = caseIds ? new Set(caseIds.map(String)) : null;
    const tests = (await built.client.listTestsInFolder(resolved.id, folderPath || "/")).filter(
      (t) => !wanted || wanted.has(String(t.key))
    );
    return tests.map((t) => {
      const steps = t.steps.map((s) => ({ action: htmlToCell(s.action), data: htmlToCell(s.data), expected: htmlToCell(s.result) }));
      // A Generic test is one block of free text; as a single step it is still something to update.
      if (!steps.length && !t.gherkin && t.unstructured.trim()) {
        steps.push({ action: htmlToCell(t.unstructured), data: "", expected: "" });
      }
      return {
        id: t.key,
        title: t.summary || t.key,
        priority: csvPriority(t.priority),
        areaPath: areaPathFromLabels(t.labels),
        state: "",
        preconditions: linkedPreconditionsText(t.preconditions),
        steps,
        gherkin: t.gherkin || "",
      };
    });
  },
};

const PROVIDERS = { zephyr, xray };

// ---------------------------------------------------------------------------
// Folder for a Jira key
// ---------------------------------------------------------------------------

/**
 * The story key behind a Test design sub-task, since that is the key the importer named the folder
 * after. Returns "" when Jira is not configured or the ticket has no such parent — the caller has
 * already tried the key as typed.
 */
async function parentStoryKey(jiraKey) {
  const baseUrl = cfgValue("JIRA_BASE_URL") || cfgValue("BASE_URL");
  const email = cfgValue("JIRA_EMAIL") || cfgValue("LOGIN_EMAIL");
  const token = cfgValue("JIRA_API_TOKEN");
  if (!baseUrl || !email || !token) return "";
  try {
    const client = new JiraClient(baseUrl, email, token);
    const issue = await client.getIssueWithExpand(jiraKey);
    const ctx = contextIssueKeyFor(issue, jiraKey);
    return ctx && ctx !== jiraKey ? ctx : "";
  } catch {
    return "";
  }
}

/**
 * @returns {Promise<{ folder: { suiteId: string|number, suiteName: string, path: string }, matchedKey: string }>}
 */
async function resolveFolder(provider, { jiraKey, folder }) {
  const folders = await PROVIDERS[provider].folders();
  const title = PROVIDERS[provider].title;

  if (folder != null && String(folder).trim() !== "") {
    const wanted = String(folder).trim();
    const hit = folders.find((f) => String(f.suiteId) === wanted || f.path === wanted);
    if (!hit) throw new Error(`${title} has no folder "${wanted}"`);
    return { folder: hit, matchedKey: jiraKey };
  }

  if (!jiraKey) throw new Error("A Jira key is needed to find the folder");
  const flat = folders.filter((f) => f.path !== "/");
  let picked = pickSuiteForJiraKey(flat, jiraKey);
  let matchedKey = jiraKey;
  if (!picked) {
    const parent = await parentStoryKey(jiraKey);
    if (parent) {
      picked = pickSuiteForJiraKey(flat, parent);
      matchedKey = parent;
    }
  }
  if (!picked) {
    throw new Error(
      `No ${title} folder carries "${jiraKey}" (${flat.length} folder(s) searched) — the import files each ticket in a folder named "<KEY> <summary>"; pick the CSV with Browse instead`
    );
  }
  return { folder: picked, matchedKey };
}

/** `PROJ-123 Order address edit` → `Order address edit (PROJ-123).csv`, the approval step's own shape. */
function csvFileNameFor(folderName, jiraKey) {
  const summary = titleFromCsvFilename(`${folderName}.csv`, jiraKey);
  const base = summary && summary !== jiraKey ? `${summary} (${jiraKey})` : jiraKey;
  return `${base.replace(FILENAME_FORBIDDEN, "_").replace(/\s+/g, " ").trim().slice(0, 180)}.csv`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Read one ticket's cases out of the TMS In use and build the CSV. Never throws.
 *
 * @param {{ jiraKey?: string, folder?: string|number, provider?: string }} input
 * @returns {Promise<{ ok: true, provider: string, providerTitle: string, jiraKey: string,
 *   folder: { id: string, name: string, path: string }, fileName: string, csv: string,
 *   stats: object } | { ok: false, error: string }>}
 */
async function exportCasesForJiraKey(input = {}) {
  try {
    const provider = input.provider || configStore.activeProvider();
    if (!EXPORTABLE_PROVIDERS.has(provider)) {
      return { ok: false, error: `Loading test cases is available for Zephyr Essential and Xray; "${provider}" is In use` };
    }
    const jiraKey = input.jiraKey ? normalizeJiraIssueKey(input.jiraKey) : "";
    const { folder, matchedKey } = await resolveFolder(provider, { jiraKey, folder: input.folder });
    const cases = await PROVIDERS[provider].cases(folder.suiteId);
    const { csv, stats } = casesToAgentCsv(cases);
    if (!stats.cases) {
      return { ok: false, error: `${PROVIDERS[provider].title} folder "${folder.path}" holds no test case with steps` };
    }
    return {
      ok: true,
      provider,
      providerTitle: PROVIDERS[provider].title,
      jiraKey: matchedKey,
      source: `"${folder.path}"`,
      fileName: csvFileNameFor(folder.suiteName, matchedKey || jiraKey),
      csv,
      stats,
    };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Last segment of a folder path: `Regression / Checkout` and `/Regression/Checkout` → `Checkout`. */
function folderLeaf(p) {
  const parts = String(p || "").split(/\s*\/\s*/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "root";
}

/** `Xray - Checkout, Refunds.csv` — which folders the cases came from, readable in the file list. */
function csvFileNameForPicks(providerTitle, folderPaths) {
  const leaves = [...new Set(folderPaths.map(folderLeaf))];
  const shown = leaves.slice(0, 3).join(", ") + (leaves.length > 3 ? ` +${leaves.length - 3}` : "");
  const base = `${providerTitle} - ${shown}`;
  return `${base.replace(FILENAME_FORBIDDEN, "_").replace(/\s+/g, " ").trim().slice(0, 180)}.csv`;
}

/**
 * The cases ticked in the "Add context from …" tree → the CSV. Never throws.
 *
 * Folders are exported in the order they were ticked from and each keeps its own case order, so
 * the CSV reads the way the tree did. A folder whose ticked cases all fail to load stops the whole
 * export: a CSV missing half of what was picked would be updated as if it were complete.
 *
 * @param {{ provider?: string, picks: Array<{ containerId: string, containerPath?: string, caseIds: string[] }> }} input
 */
async function exportPickedCases(input = {}) {
  try {
    const provider = input.provider || configStore.activeProvider();
    if (!EXPORTABLE_PROVIDERS.has(provider)) {
      return { ok: false, error: `Using picked cases as the CSV is available for Zephyr Essential and Xray; "${provider}" is In use` };
    }
    const picks = (input.picks || []).filter((p) => p && p.containerId != null && Array.isArray(p.caseIds) && p.caseIds.length);
    if (!picks.length) return { ok: false, error: "Tick at least one test case first" };

    const all = [];
    const missing = [];
    for (const pick of picks) {
      const cases = await PROVIDERS[provider].cases(pick.containerId, pick.caseIds);
      const found = new Set(cases.map((c) => String(c.id)));
      for (const id of pick.caseIds) if (!found.has(String(id))) missing.push(String(id));
      all.push(...cases);
    }
    if (missing.length) {
      return { ok: false, error: `${PROVIDERS[provider].title} did not return ${missing.join(", ")} — reload the tree and pick again` };
    }

    const { csv, stats } = casesToAgentCsv(all);
    if (!stats.cases) return { ok: false, error: "None of the picked cases has steps to update" };
    const paths = picks.map((p) => p.containerPath || String(p.containerId));
    return {
      ok: true,
      provider,
      providerTitle: PROVIDERS[provider].title,
      source: paths.length === 1 ? `"${paths[0]}"` : `${paths.length} folders`,
      fileName: csvFileNameForPicks(PROVIDERS[provider].title, paths),
      csv,
      stats,
    };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Write `content` as the only CSV in `dir` — the Update flow reads the newest one, and the
 * Browse button keeps just one there for the same reason.
 *
 * @returns {{ filePath: string, removed: number }}
 */
function writeAsOnlyCsv(dir, fileName, content) {
  const resolvedDir = path.resolve(dir);
  const filePath = path.resolve(resolvedDir, fileName);
  const rel = path.relative(resolvedDir, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid file name");
  fs.mkdirSync(resolvedDir, { recursive: true });
  let removed = 0;
  for (const entry of fs.readdirSync(resolvedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.csv$/i.test(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(resolvedDir, entry.name));
      removed += 1;
    } catch (_) {
      /* a locked file is left; the new one is still the newest */
    }
  }
  fs.writeFileSync(filePath, content, "utf8");
  return { filePath, removed };
}

/** One line for a log or the page: `12 case(s) from Xray "/Checkout" — 9 test case(s), 3 BDD`. */
function describeExport(res) {
  const s = res.stats;
  const parts = [
    s.testCases && `${s.testCases} test case(s)`,
    s.bdd && `${s.bdd} BDD`,
    s.checklists && `${s.checklists} checklist(s)`,
  ].filter(Boolean);
  const skipped = s.skippedEmpty.length ? `; skipped without steps: ${s.skippedEmpty.join(", ")}` : "";
  return `${s.cases} case(s) from ${res.providerTitle} ${res.source} — ${parts.join(", ")}${skipped}`;
}

function parseCliArgs(argv) {
  const out = { jiraKey: "", folder: "", out: path.join(__dirname, "Updated test cases") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--jira-key" || a === "-k") out.jiraKey = argv[++i] || "";
    else if (a === "--folder" || a === "-f") out.folder = argv[++i] || "";
    else if (a === "--out" || a === "-o") out.out = argv[++i] || out.out;
  }
  if (!out.jiraKey) out.jiraKey = process.env.JIRA_ISSUE_KEY || "";
  return out;
}

async function main() {
  configStore.loadEnv();
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.jiraKey && !args.folder) {
    console.error("Usage: node tms-export-csv.js --jira-key PROJ-123 [--folder <id or path>] [--out <dir>]");
    process.exit(1);
  }
  const res = await exportCasesForJiraKey({ jiraKey: args.jiraKey, folder: args.folder });
  if (!res.ok) {
    console.error(`❌ ${res.error}`);
    process.exit(1);
  }
  const { filePath, removed } = writeAsOnlyCsv(args.out, res.fileName, res.csv);
  if (removed) console.log(`Removed ${removed} previous CSV file(s) in ${path.dirname(filePath)}`);
  console.log(`✅ ${describeExport(res)}`);
  console.log(`   → ${filePath}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(message(e));
    process.exit(1);
  });
}

module.exports = {
  EXPORTABLE_PROVIDERS,
  exportPickedCases,
  exportCasesForJiraKey,
  linkedPreconditionsText,
  csvFileNameForPicks,
  writeAsOnlyCsv,
  describeExport,
  casesToAgentCsv,
  toAgentSteps,
  csvPriority,
  areaPathFromLabels,
  splitGherkinComments,
  csvFileNameFor,
};
