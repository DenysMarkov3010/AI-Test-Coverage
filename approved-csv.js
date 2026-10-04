/**
 * The approved CSV: the one artefact every downstream step reads.
 *
 * Approval happens in the review panel now — each checklist item and each test case carries an
 * APPROVED mark, and only marked rows reach this writer. What comes out is the Azure
 * DevOps CSV shape (ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority,
 * Area Path, Assigned To, State), which is also what TestRail and Zephyr importers parse.
 *
 * It lives here rather than in agent-docs.js because both flows produce it: Create writes one
 * file per ticket, Update writes one file for the whole CSV's blocks, and the import steps read
 * one back off the ticket. Three call sites, one definition of the format.
 *
 * Three groups of functions:
 *   build   — the writers, one per shape (checklist, test cases, an Update run's mixed blocks)
 *   attach  — put the file on the Jira sub-task, with a comment linking it
 *   fetch   — take the newest CSV back off the ticket, which is how an import step finds it
 */
const fs = require("fs");
const path = require("path");

const bddFormat = require("./web/bdd-format.js");
const { guardLlmResult } = require("./placeholder-guard");

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function normalizeExpectedResultText(expectedRaw) {
  const raw = String(expectedRaw || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  // A Gherkin "Then … / And …" block is already one fact per line. Bulleting it
  // would put "- " in front of every keyword, and the sentence split below would
  // break "Then the file is saved. The banner closes." into lines that no longer
  // start with a keyword — which is exactly what the Update flow reads back to
  // recognise a BDD case.
  if (bddFormat.isGherkinExpectedCell(raw)) {
    return bddFormat.splitCellLines(raw).join("\n");
  }
  const bulletLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (bulletLines.length > 1 && bulletLines.every((l) => /^[-•]\s+/.test(l))) {
    return bulletLines.map((l) => l.replace(/^•\s+/, "- ")).join("\n");
  }
  let parts = [];
  if (raw.includes("\n")) {
    parts = bulletLines;
  } else {
    parts = raw.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  }
  if (parts.length <= 1) return raw;
  return parts
    .map((p) => p.replace(/^[-•]\s+/, "").trim())
    .filter(Boolean)
    .map((p) => `- ${p}`)
    .join("\n");
}

function normalizeExpectedInTestCases(testCases) {
  if (!Array.isArray(testCases)) return [];
  return testCases.map((tc) => ({
    ...tc,
    steps: Array.isArray(tc.steps)
      ? tc.steps.map((s) => ({
          ...s,
          expected: normalizeExpectedResultText(s.expected),
        }))
      : [],
  }));
}

/**
 * Escape a CSV field (quote if contains comma, newline, or double quote).
 */
function escapeCSV(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Build a safe CSV filename from issue title (summary) and key, e.g. "Search field improvements (PROJ-99).csv"
 */
function approvedChecklistCsvFilename(issueKey, summary) {
  const raw = (summary || issueKey || "Checklist").trim();
  const safe = raw
    .replace(/[\s\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const base = safe || issueKey;
  return `${base} (${issueKey}).csv`;
}

/**
 * One CSV file with multiple Test Case blocks — one Azure DevOps work item per checklist.
 * @param {Object} issueData
 * @param {Array<{ partLabel?: string, approvedItems: Array<{ number: number, item: { category, description } }> }>} groups
 * @param {string} outputPath
 */
function generateApprovedMultiChecklistCSV(issueData, groups, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const baseTitle = (issueData.summary || issueData.key || "Checklist").trim();
  const assignedTo = issueData.assignee || "";
  const rows = [];

  groups.forEach((group, gi) => {
    const partLabel = String(group.partLabel || "").trim();
    let title = baseTitle;
    if (partLabel) title = `${baseTitle} (${partLabel})`;
    else if (groups.length > 1) title = `${baseTitle} (checklist ${gi + 1})`;

    rows.push(
      [
        escapeCSV(issueData.key),
        "Test Case",
        escapeCSV(title),
        "",
        "",
        "",
        escapeCSV(priority),
        escapeCSV(areaPath),
        escapeCSV(assignedTo),
        escapeCSV(state),
      ].join(",")
    );

    (group.approvedItems || []).forEach(({ item }, index) => {
      const stepNum = String(index + 1);
      const stepAction = (item.description || "").trim();
      rows.push(
        [
          "",
          "",
          "",
          escapeCSV(stepNum),
          escapeCSV(stepAction),
          "",
          "",
          "",
          "",
          "",
        ].join(",")
      );
    });
  });

  writeGuardedCsv(outputPath, [header, ...rows].join("\r\n"), "checklist CSV");
  return outputPath;
}

/**
 * Write a CSV, stripping redaction placeholders one last time. The generation parsers already
 * guard fresh LLM output, but approved content can be re-read from a Jira comment or a JSON
 * attachment produced before this guard existed — this is the final net before Azure DevOps.
 */
function writeGuardedCsv(outputPath, csv, contextLabel) {
  fs.writeFileSync(outputPath, guardLlmResult(csv, `${contextLabel} ${path.basename(outputPath)}`), "utf8");
}

/**
 * Generate CSV file with approved checklist items.
 * Format matches Azure DevOps / test checklist CSV: ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path, Assigned To, State
 * @param {Object} issueData - { key, summary, assignee, ... }
 * @param {Array<{ number: number, item: { category, description } }>} approvedItems - list of approved checklist items
 * @param {string} outputPath - path for the CSV file (e.g. approved-checklist-PROJ-95.csv)
 * @returns {string} path to written file
 */
function generateApprovedChecklistCSV(issueData, approvedItems, outputPath) {
  return generateApprovedMultiChecklistCSV(issueData, [{ partLabel: "", approvedItems }], outputPath);
}

/**
 * Generate CSV with approved test cases (Azure DevOps format).
 * Each test case: one header row (ID, Title) then step rows (Test Step, Step Action, Step Expected).
 */
/**
 * The case's steps with its preconditions guaranteed to be step 1.
 *
 * Preconditions reach here two ways. A standard case already carries them as step 1 with an
 * expected of "—", which is the Azure DevOps convention the whole CSV format follows. A BDD
 * scenario carries them in a `preconditions` field of their own, because they are setup rather
 * than Gherkin — `Given` is the scenario's business context, not the environment it needs.
 *
 * The CSV has no column for that field, so writing it out unchanged silently drops it. Folding
 * it into step 1 here is what every provider then sees:
 *
 *   Azure DevOps       has no Preconditions field at all — step 1 is where they belong
 *   TestRail           lifts the row back out into its real `preconds` field on import
 *   Zephyr Essential   has `precondition` on a test case, to be lifted the same way
 *
 * Doing it in the writer rather than in each importer means the CSV — the one artefact all
 * three read, and the one attached to Jira as the audit trail — is never the lossy step.
 *
 * @param {{ steps?: Array, preconditions?: string }} tc
 * @returns {Array<{ stepNumber: number, action: string, expected: string }>}
 */
function stepsWithPreconditions(tc) {
  const steps = (tc.steps || []).slice().sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
  const text = String(tc.preconditions || "").trim();
  // Already folded in — by normalizeBddTestCases, or because it is a standard case. Prepending
  // again would give the work item two Preconditions rows.
  if (!text || (steps.length && bddFormat.isPreconditionsStep(steps[0]))) return steps;
  const row = bddFormat.preconditionsStep(text);
  if (!row) return steps;
  return [row, ...steps].map((s, i) => ({ ...s, stepNumber: i + 1 }));
}

function generateApprovedTestCasesCSV(issueData, approvedTestCases, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const assignedTo = issueData.assignee || "";
  const rows = [];

  approvedTestCases.forEach((tc) => {
    const title = (tc.title || "Test case").trim();
    const tcPriority = tc.priority != null ? String(tc.priority) : priority;
    const tcAreaPath = (tc.areaPath || areaPath).trim() || areaPath;
    rows.push([
      escapeCSV(issueData.key),
      "Test Case",
      escapeCSV(title),
      "",
      "",
      "",
      escapeCSV(tcPriority),
      escapeCSV(tcAreaPath),
      escapeCSV(assignedTo),
      escapeCSV(state),
    ].join(","));
    const steps = stepsWithPreconditions(tc);
    steps.forEach((step, stepIdx) => {
      const stepNum = String(step.stepNumber != null ? step.stepNumber : stepIdx + 1);
      const action = (step.action || "").trim();
      const expected = normalizeExpectedResultText(step.expected);
      rows.push([
        "",
        "",
        "",
        escapeCSV(stepNum),
        escapeCSV(action),
        escapeCSV(expected),
        "",
        "",
        "",
        "",
      ].join(","));
    });
  });

  const csv = [header, ...rows].join("\r\n");
  writeGuardedCsv(outputPath, csv, "test cases CSV");
  return outputPath;
}

function approvedTestCasesCsvFilename(issueKey, summary) {
  const safe = (summary || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const base = safe || issueKey;
  return `${base} (${issueKey}).csv`;
}

/**
 * One CSV for approved sections from Update test design (test cases + checklist blocks in order).
 * @param {Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', partLabel: string, approvedItems: { number: number, item: object }[] }>} sections
 */
function generateApprovedUpdatedDesignCsv(issueData, sections, outputPath) {
  const header = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Priority,Area Path,Assigned To,State";
  const priority = process.env.CSV_PRIORITY || "2";
  const areaPath = process.env.CSV_AREA_PATH || "";
  const state = process.env.CSV_STATE || "Ready";
  const assignedTo = issueData.assignee || "";
  const baseTitle = (issueData.summary || issueData.key || "Export").trim();
  const rows = [];

  const checklistSectionCount = sections.filter((s) => s.type === "checklist").length;
  let checklistIndex = 0;

  for (const sec of sections) {
    if (sec.type === "testcases") {
      for (const tc of sec.testCases || []) {
        const title = (tc.title || "Test case").trim();
        const tcPriority = tc.priority != null ? String(tc.priority) : priority;
        const tcAreaPath = (tc.areaPath || areaPath).trim() || areaPath;
        rows.push(
          [
            escapeCSV(issueData.key),
            "Test Case",
            escapeCSV(title),
            "",
            "",
            "",
            escapeCSV(tcPriority),
            escapeCSV(tcAreaPath),
            escapeCSV(assignedTo),
            escapeCSV(state),
          ].join(",")
        );
        const steps = stepsWithPreconditions(tc);
        steps.forEach((step, stepIdx) => {
          const stepNum = String(step.stepNumber != null ? step.stepNumber : stepIdx + 1);
          const action = (step.action || "").trim();
          const expected = normalizeExpectedResultText(step.expected);
          rows.push(
            [
              "",
              "",
              "",
              escapeCSV(stepNum),
              escapeCSV(action),
              escapeCSV(expected),
              "",
              "",
              "",
              "",
            ].join(",")
          );
        });
      }
    } else {
      checklistIndex += 1;
      const partLabel = String(sec.partLabel || "").trim();
      let title = baseTitle;
      if (partLabel) title = `${baseTitle} (${partLabel})`;
      else if (checklistSectionCount > 1) title = `${baseTitle} (checklist ${checklistIndex})`;

      rows.push(
        [
          escapeCSV(issueData.key),
          "Test Case",
          escapeCSV(title),
          "",
          "",
          "",
          escapeCSV(priority),
          escapeCSV(areaPath),
          escapeCSV(assignedTo),
          escapeCSV(state),
        ].join(",")
      );
      (sec.approvedItems || []).forEach(({ item }, index) => {
        const stepNum = String(index + 1);
        const stepAction = (item.description || "").trim();
        rows.push(
          [
            "",
            "",
            "",
            escapeCSV(stepNum),
            escapeCSV(stepAction),
            "",
            "",
            "",
            "",
            "",
          ].join(",")
        );
      });
    }
  }

  writeGuardedCsv(outputPath, [header, ...rows].join("\r\n"), "grouped checklist CSV");
  return outputPath;
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/**
 * Whether the approved CSV belongs on the story's "Test design" QA sub-task.
 *
 * Only the Azure DevOps flow works that way: a parent key is typed in, and the CSV (and every
 * comment around it) goes to the parent's Test design sub-task. TestRail, Zephyr and Xray keep
 * it simple — the CSV goes to whichever ticket was typed in, sub-task or not.
 */
function usesTestDesignSubtask() {
  return require("./config-store.js").activeProvider() === "ado";
}

/**
 * The Test design sub-task of `contextIssueKey`, or null when there is none — and always null
 * when the active TMS is not Azure DevOps, so every caller falls back to the typed-in key.
 *
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} contextIssueKey the story (parent of the typed-in key, or the key itself)
 * @param {string} projectKey
 * @returns {Promise<string|null>}
 */
async function testDesignSubtaskKeyFor(jiraClient, contextIssueKey, projectKey) {
  if (!usesTestDesignSubtask()) return null;
  return jiraClient.getTestDesignSubtaskKey(contextIssueKey, projectKey);
}

/**
 * Put the approved CSV on the ticket, and link it from a comment.
 *
 * This is what "Submit to Jira" now means. The reviewer already approved the content in the
 * panel, so the ticket does not need the content again — it needs the artefact, findable by
 * anyone reading the sub-task, and the comment is what makes an attachment visible in the
 * activity stream instead of buried in the Attachments panel.
 *
 * The attachment is the hand-off: the import steps read the newest CSV back off this ticket.
 *
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} issueKey the ticket to attach to (resolved by the caller — see testDesignSubtaskKeyFor)
 * @param {string} csvPath
 * @param {string} [commentTitle]
 * @returns {Promise<{ fileName: string, url: string|null }>}
 */
async function attachApprovedCsv(jiraClient, issueKey, csvPath, commentTitle = "Approved test design (CSV)") {
  const fallbackName = path.basename(csvPath);
  const attachments = await jiraClient.addAttachment(issueKey, csvPath);
  console.log(`✅ CSV attached to ${issueKey}`);

  const att = attachments && attachments[0];
  const fileName = (att && att.filename) || fallbackName;
  const url =
    att && (att.content || att.id)
      ? att.content ||
        `${String(jiraClient.baseUrl || "").replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(fileName)}`
      : null;

  if (url) {
    // A failed comment must not undo a successful attach: the file is the artefact, the comment
    // is the pointer to it.
    try {
      await jiraClient.addCommentWithFileLink(issueKey, commentTitle, url, fileName);
      console.log(`✅ Comment linking ${fileName} added to ${issueKey}`);
    } catch (e) {
      console.warn(`⚠️  CSV is attached, but the comment linking it failed: ${e.message}`);
    }
  }
  return { fileName, url };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Our own CSV, not any spreadsheet someone dropped on the ticket. */
function isCsvAttachment(att) {
  return !!att && /\.csv$/i.test(String(att.filename || ""));
}

/**
 * The newest approved CSV on a ticket, written to disk so an importer can read it.
 *
 * This replaced reading an "APPROVED: 1,2,3" comment. Approval is a decision the reviewer
 * already made in the panel, and Submit recorded it by attaching this file — so an import step
 * has nothing left to interpret: it takes the latest CSV and imports it. Newest wins, because a
 * second Submit for the same ticket is a correction of the first.
 *
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} issueKey the Test design sub-task (resolved by the caller)
 * @param {string} outDir where to write the downloaded copy
 * @returns {Promise<{ csvPath: string, fileName: string, created: string }>}
 */
async function fetchLatestApprovedCsv(jiraClient, issueKey, outDir) {
  const all = await jiraClient.getAttachments(issueKey);
  const csvs = (all || []).filter(isCsvAttachment);
  if (!csvs.length) {
    throw new Error(
      `No CSV attached to ${issueKey} — approve the test design in the review panel and press "Submit to Jira" first`
    );
  }
  // `created` is an ISO string from Jira; ties keep Jira's own order, which is creation order.
  const newest = csvs.slice().sort((a, b) => Date.parse(b.created || 0) - Date.parse(a.created || 0))[0];
  const text = await jiraClient.getAttachmentContent(newest.content);

  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, newest.filename);
  fs.writeFileSync(csvPath, text, "utf8");
  console.log(`📄 Approved CSV from ${issueKey}: ${newest.filename} (attached ${newest.created})`);
  return { csvPath, fileName: newest.filename, created: newest.created };
}

module.exports = {
  normalizeExpectedResultText,
  normalizeExpectedInTestCases,
  escapeCSV,
  writeGuardedCsv,
  stepsWithPreconditions,
  approvedChecklistCsvFilename,
  approvedTestCasesCsvFilename,
  generateApprovedChecklistCSV,
  generateApprovedMultiChecklistCSV,
  generateApprovedTestCasesCSV,
  generateApprovedUpdatedDesignCsv,
  usesTestDesignSubtask,
  testDesignSubtaskKeyFor,
  attachApprovedCsv,
  fetchLatestApprovedCsv,
};
