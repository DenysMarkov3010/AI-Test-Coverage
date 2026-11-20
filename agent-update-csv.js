const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

const { JiraClient, contextIssueKeyFor } = require("./jira-client");
const { mergePreconditionStepsForTestCase } = require("./merge-precondition-steps");
const { analyzeFigmaUrl, isFigmaUrl } = require("./figma-client");
const { analyzePrototypeUrl, isHttpUrl } = require("./prototype-client");
const { analyzeAttachments, attachmentPathsFromEnv } = require("./attachment-analyzer");
const { loadIssueComments } = require("./issue-comments");
const { appendTicketDataFiles } = require("./ticket-data-files");
const { collectConfluencePages, confluencePagesToText, parseConfluenceLinks } = require("./confluence-pages");
const pc = require("./prompt-context");
const areaBriefLib = require("./area-brief");
const updatePlan = require("./update-plan");
const {
  areaPathForPrompt,
  buildFigmaContextBlock,
  buildPrototypeContextBlock,
  buildAttachmentsContextBlock,
  buildIssueCommentsBlock,
  buildConfluenceContextBlock,
  buildAdoContextBlock,
  NO_REDACTION_PLACEHOLDERS_BLOCK,
  DEFECT_SOURCE_BLOCK,
  PRIORITY_RULES,
  BDD_STYLE_BLOCK,
  BDD_STEPS_CONTRACT,
  bddExamplesBlock,
  BDD_PRECONDITIONS_CONTRACT,
  buildUserGuidanceBlock,
  checklistExamplesBlock,
  regenerateChecklistItemPrompt,
  regenerateTestCasePrompt,
  regenerateBddTestCasePrompt,
} = require("./prompts-docs");
const bddFormat = require("./web/bdd-format.js");
const { guardLlmResult } = require("./placeholder-guard");
const adoContextStore = require("./ado-context-store.js");
const tmsContext = require("./tms-context.js");
const { createUsageTally, logUsage } = require("./llm-usage");
const { callModel, missingLlmKeyMessage } = require("./llm-client");
// The approved CSV is the same artefact the Create flow produces — one writer, one attach.
const {
  generateApprovedUpdatedDesignCsv,
  usesTestDesignSubtask,
  testDesignSubtaskKeyFor,
  attachApprovedCsv,
} = require("./approved-csv.js");

// Same default as agent-docs.js: the Setup page's "Checklist output folder".
const CHECKLIST_OUTPUT_DIR =
  process.env.CHECKLIST_OUTPUT_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || "", "OneDrive", "Desktop", "Checklists and Test cases");

/** Token spend for this process, accumulated by callLLM and reported at the end of the run. */
const runUsage = createUsageTally();

/**
 * Which slice of the pipeline to run — same contract as agent-docs.js.
 *   full       - generate AND post every block (the original behaviour; still the default)
 *   generate   - generate all blocks into PIPELINE_IO_FILE, post nothing
 *   regenerate - redo one block, or one row inside a block, from the stored context
 *   submit     - post the (edited) blocks from PIPELINE_IO_FILE
 */
const PIPELINE_STAGE = (process.env.PIPELINE_STAGE || "full").toLowerCase().trim();
const PIPELINE_IO_FILE = process.env.PIPELINE_IO_FILE || "";

function pipelineIoPath() {
  if (!PIPELINE_IO_FILE) {
    throw new Error(`PIPELINE_IO_FILE is required when PIPELINE_STAGE=${PIPELINE_STAGE}`);
  }
  return PIPELINE_IO_FILE;
}

function readPipelineIo() {
  return JSON.parse(fs.readFileSync(pipelineIoPath(), "utf8"));
}

function writePipelineIo(data) {
  fs.writeFileSync(pipelineIoPath(), JSON.stringify(data, null, 2), "utf8");
}

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "PROJ";
const UPDATED_TEST_CASES_FOLDER =
  process.env.UPDATED_TEST_CASES_FOLDER || path.join(__dirname, "Updated test cases");
const UPDATED_FLOW_MODE = (process.env.UPDATED_FLOW_MODE || "auto").toLowerCase().trim();
const UPDATED_FLOW_INPUT_FILE = (process.env.UPDATED_FLOW_INPUT_FILE || "").trim();

if (!JIRA_BASE_URL) {
  console.error("❌ Error: JIRA_BASE_URL or BASE_URL is not set");
  process.exit(1);
}
if (!JIRA_EMAIL) {
  console.error("❌ Error: JIRA_EMAIL or LOGIN_EMAIL is not set");
  process.exit(1);
}
if (!JIRA_API_TOKEN) {
  console.error("❌ Error: JIRA_API_TOKEN is not set");
  process.exit(1);
}
// The key of whichever provider Setup → AI model points at (OpenRouter or the Claude API).
if (missingLlmKeyMessage()) {
  console.error(`❌ Error: ${missingLlmKeyMessage()}`);
  process.exit(1);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < normalized.length) {
    const c = normalized[i];
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  pushField();
  if (row.length > 1 || (row[0] && row[0].length > 0)) pushRow();
  return rows;
}

function rowsToTestCases(rows) {
  const COL = {
    TYPE: 1,
    TITLE: 2,
    STEP: 3,
    ACTION: 4,
    EXPECTED: 5,
    PRIORITY: 6,
    AREA: 7,
  };
  const out = [];
  let current = null;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 10) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const wit = (line[COL.TYPE] || "").trim().toLowerCase();
    if (title && wit === "test case") {
      current = {
        title,
        priority: parseInt((line[COL.PRIORITY] || "2").trim(), 10) || 2,
        areaPath: (line[COL.AREA] || "").trim(),
        steps: [],
      };
      out.push(current);
    }
    const stepNumRaw = (line[COL.STEP] || "").trim();
    const action = (line[COL.ACTION] || "").trim();
    const expected = (line[COL.EXPECTED] || "").trim();
    if (current && stepNumRaw && (action || expected)) {
      const stepNumber = parseInt(stepNumRaw, 10);
      current.steps.push({
        stepNumber: Number.isFinite(stepNumber) ? stepNumber : current.steps.length + 1,
        action,
        expected,
      });
    }
  }
  for (const tc of out) {
    // Never on a scenario. The merge folds every row after "Preconditions:" into
    // it until it recognises a UI action ("Click", "Open", "Navigate to", …), and
    // no Gherkin line ever matches that list — so a whole scenario would collapse
    // into the preconditions cell. The auto parser skips the merge for the same
    // reason; this is the explicit UPDATED_FLOW_MODE=testcases path.
    if (tc.steps && tc.steps.length > 1 && !bddFormat.isBddTestCase(tc)) {
      tc.steps = mergePreconditionStepsForTestCase(tc.steps);
    }
  }
  return out;
}

function rowsToChecklist(rows) {
  const COL = { TITLE: 2, ACTION: 4 };
  const items = [];
  let n = 1;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 6) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const action = (line[COL.ACTION] || "").trim();
    if (title && action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  return items;
}

/** True when row looks like an Azure DevOps parent row (ID / Work Item Type / Title). */
function isCsvWorkItemParentRow(line) {
  const TYPE = 1;
  const TITLE = 2;
  const copy = [...line];
  while (copy.length < 10) copy.push("");
  const title = (copy[TITLE] || "").trim();
  const wit = (copy[TYPE] || "").trim().toLowerCase();
  if (!title || !wit) return false;
  if (wit === "test case") return true;
  if (wit.includes("checklist")) return true;
  return false;
}

/**
 * Split CSV into separate checklist blocks (same file can contain multiple checklists).
 * A new block starts at each row with Work Item Type + Title (e.g. Test Case).
 * If the file has no such parent rows, returns a single segment from legacy flat parsing.
 * @returns {Array<{ workItemTitle: string | null, workItemType: string | null, items: object[] }>}
 */
function rowsToChecklistSegments(rows) {
  if (!rows || rows.length < 2) return [];
  let anyParent = false;
  for (let r = 1; r < rows.length; r++) {
    if (isCsvWorkItemParentRow(rows[r])) {
      anyParent = true;
      break;
    }
  }
  if (!anyParent) {
    const flat = rowsToChecklist(rows);
    return flat.length ? [{ workItemTitle: null, workItemType: null, items: flat }] : [];
  }

  const COL = { TITLE: 2, ACTION: 4 };
  const segments = [];
  let current = null;
  let n = 1;

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const lineCopy = [...line];
    while (lineCopy.length < 10) lineCopy.push("");

    if (isCsvWorkItemParentRow(line)) {
      if (current && current.items.length) segments.push(current);
      current = {
        workItemTitle: (lineCopy[COL.TITLE] || "").trim(),
        workItemType: (lineCopy[1] || "").trim(),
        items: [],
      };
      n = 1;
      continue;
    }

    if (!current) {
      current = { workItemTitle: null, workItemType: null, items: [] };
      n = 1;
    }

    const title = (lineCopy[COL.TITLE] || "").trim();
    const action = (lineCopy[COL.ACTION] || "").trim();
    if (title && action) {
      current.items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      current.items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  if (current && current.items.length) segments.push(current);
  return segments;
}

const COL_WIT = 1;
const COL_TITLE = 2;
const COL_STEP = 3;
const COL_ACTION = 4;
const COL_EXPECTED = 5;
const COL_PRIORITY = 6;
const COL_AREA = 7;

function padCsvLine(line) {
  const copy = [...(line || [])];
  while (copy.length < 10) copy.push("");
  return copy;
}

/** Child rows under a parent work item → checklist-shaped items (same rules as rowsToChecklistSegments). */
function childRowsToChecklistItems(childRows) {
  const items = [];
  let n = 1;
  for (const row of childRows) {
    const lineCopy = padCsvLine(row);
    const title = (lineCopy[COL_TITLE] || "").trim();
    const action = (lineCopy[COL_ACTION] || "").trim();
    if (title && action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: `${title}: ${action}`.slice(0, 600),
        category: "Functional",
      });
      n++;
    } else if (action) {
      items.push({
        id: `CL-${String(n).padStart(3, "0")}`,
        description: action.slice(0, 600),
        category: "Functional",
      });
      n++;
    }
  }
  return items;
}

/**
 * True when this row starts a new work-item block (Test Case or checklist work item).
 * Used only for UPDATED_FLOW_MODE=auto ordered parsing.
 */
function isAutoBlockParentRow(line) {
  const ln = padCsvLine(line);
  const title = (ln[COL_TITLE] || "").trim();
  const wit = (ln[COL_WIT] || "").trim().toLowerCase();
  if (!title || !wit) return false;
  if (wit === "test case") return true;
  if (wit.includes("checklist")) return true;
  return false;
}

/**
 * For auto mode: walk CSV top-to-bottom and classify each parent block.
 * - Work Item Type contains "checklist" → checklist segment (child rows only).
 * - Work Item Type is "test case":
 *   - If the steps are Gherkin → test case with format "bdd" (checked first: a
 *     scenario that never reaches a Then has no Step Expected at all, and the
 *     next rule would file it as a checklist).
 *   - If every step has empty Step Expected → checklist segment (ADO-style checklist rows).
 *   - Otherwise → test case (steps merged like rowsToTestCases).
 * - No parent rows in file → single legacy checklist segment from rowsToChecklist (if any).
 *
 * The BDD check is per test case, not per file: a CSV may well hold standard
 * cases next to scenarios, and each block then gets the prompt that matches it.
 */
function parseUpdatedCsvBlocksForAuto(rows) {
  if (!rows || rows.length < 2) return [];

  let hasParent = false;
  for (let r = 1; r < rows.length; r++) {
    if (isAutoBlockParentRow(rows[r])) {
      hasParent = true;
      break;
    }
  }

  if (!hasParent) {
    const flat = rowsToChecklist(rows);
    return flat.length
      ? [{ type: "checklist", segment: { workItemTitle: null, workItemType: null, items: flat } }]
      : [];
  }

  const blocks = [];
  let r = 1;
  while (r < rows.length) {
    const parentLine = padCsvLine(rows[r]);
    const title = (parentLine[COL_TITLE] || "").trim();
    const witLower = (parentLine[COL_WIT] || "").trim().toLowerCase();
    if (!title || !(witLower === "test case" || witLower.includes("checklist"))) {
      r++;
      continue;
    }

    const isChecklistWit = witLower.includes("checklist");
    const blockTitle = title;
    const blockWitRaw = (parentLine[COL_WIT] || "").trim();
    const priority = parseInt((parentLine[COL_PRIORITY] || "2").trim(), 10) || 2;
    const areaPath = (parentLine[COL_AREA] || "").trim();
    r++;

    const childRows = [];
    while (r < rows.length) {
      if (isAutoBlockParentRow(rows[r])) break;
      childRows.push(rows[r]);
      r++;
    }

    if (isChecklistWit) {
      const items = childRowsToChecklistItems(childRows);
      if (items.length) {
        blocks.push({
          type: "checklist",
          segment: { workItemTitle: blockTitle, workItemType: blockWitRaw, items },
        });
      }
      continue;
    }

    const steps = [];
    for (const cl of childRows) {
      const ln = padCsvLine(cl);
      const stepNumRaw = (ln[COL_STEP] || "").trim();
      const action = (ln[COL_ACTION] || "").trim();
      const expected = (ln[COL_EXPECTED] || "").trim();
      if (stepNumRaw && (action || expected)) {
        const stepNumber = parseInt(stepNumRaw, 10);
        steps.push({
          stepNumber: Number.isFinite(stepNumber) ? stepNumber : steps.length + 1,
          action,
          expected,
        });
      }
    }

    if (!steps.length) continue;

    if (bddFormat.looksLikeGherkinSteps(steps)) {
      blocks.push({
        type: "testcase",
        format: "bdd",
        // No precondition merge: "Preconditions:" never opens a scenario, and the
        // Given lines are deliberately one row each.
        case: { title: blockTitle, priority, areaPath, steps },
      });
      continue;
    }

    const allExpectedEmpty = steps.every((s) => !String(s.expected || "").trim());
    if (allExpectedEmpty) {
      const items = childRowsToChecklistItems(childRows);
      if (items.length) {
        blocks.push({
          type: "checklist",
          segment: { workItemTitle: blockTitle, workItemType: blockWitRaw, items },
        });
      }
    } else {
      const merged = steps.length > 1 ? mergePreconditionStepsForTestCase(steps) : steps;
      blocks.push({
        type: "testcase",
        format: "standard",
        case: {
          title: blockTitle,
          priority,
          areaPath,
          steps: merged,
        },
      });
    }
  }

  return blocks;
}

/**
 * LLMs (especially via OpenRouter free tiers) frequently produce JSON that JSON.parse rejects:
 *   - trailing commas before `}` / `]`
 *   - literal newlines / tabs / CR inside string values
 *   - leading/trailing prose around the actual JSON
 * This helper applies the safe repairs that don't change semantics. If the parse still fails
 * (typically because of unescaped `"` inside a value — only the LLM can know where the string
 * really ends), we dump the full raw response to disk so the user can inspect / re-prompt /
 * report it, and throw a clear error pointing at that file.
 */
function escapeControlCharsInsideJsonStrings(s) {
  let out = "";
  let inStr = false;
  let escapeNext = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function extractFirstJsonObject(s) {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function dumpBadLlmResponse(contextLabel, rawResponse, parseError) {
  const ts = Date.now();
  const safeLabel = String(contextLabel || "llm")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "-");
  const fileName = `bad-llm-response-${safeLabel}-${ts}.txt`;
  const filePath = path.join(__dirname, fileName);
  const header =
    `# bad-llm-response\n` +
    `# context: ${contextLabel}\n` +
    `# timestamp: ${new Date(ts).toISOString()}\n` +
    `# parse error: ${parseError && parseError.message ? parseError.message : String(parseError)}\n` +
    `# raw LLM response follows below this line\n` +
    `# =====================================================\n`;
  try {
    fs.writeFileSync(filePath, header + String(rawResponse || ""), "utf8");
    return filePath;
  } catch {
    return null;
  }
}

function parseLlmJsonWithRepairs(rawResponse, contextLabel) {
  let txt = String(rawResponse || "");
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  txt = txt.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(txt);
  } catch (_) {
    /* fall through to repairs */
  }

  let body = extractFirstJsonObject(txt) || txt;
  body = body.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(body);
  } catch (_) {
    /* fall through */
  }

  const repaired = escapeControlCharsInsideJsonStrings(body);
  try {
    return JSON.parse(repaired);
  } catch (finalErr) {
    const savedPath = dumpBadLlmResponse(contextLabel, rawResponse, finalErr);
    const where = savedPath ? `\n   Raw LLM response saved to: ${savedPath}` : "";
    const hint =
      "\n   Hint: most often the LLM left unescaped \" inside a string value." +
      "\n   Try re-running, or remove curly/smart quotes (\u201C \u201D \u2018 \u2019) from the source CSV.";
    const err = new Error(
      `LLM did not return valid JSON for ${contextLabel}: ${finalErr.message}${where}${hint}`
    );
    err.cause = finalErr;
    err.rawResponsePath = savedPath || null;
    throw err;
  }
}

/**
 * Parse an LLM JSON response, then strip redaction-style placeholders ([PERSON_NAME] & co.)
 * before anything downstream — Jira comment, CSV, Azure DevOps — can pick them up.
 */
function parseLlmJsonStrict(rawResponse, contextLabel) {
  return guardLlmResult(parseLlmJsonWithRepairs(rawResponse, contextLabel), contextLabel);
}

/**
 * Thin wrapper over the shared LLM client (OpenRouter or the Claude API, per Setup → AI model).
 * Same contract as the Create flow's callLLM; the
 * truncation remedy also mentions splitting the CSV, because in this flow an oversized answer is
 * usually one oversized source block.
 */
async function callLLM(prompt, maxTokens = 6000) {
  return callModel(prompt, {
    maxTokens,
    apiKey: OPENROUTER_API_KEY,
    usageTally: runUsage,
    labels: {
      truncationRemedy:
        "The answer is incomplete. Raise CHECKLIST_MAX_TOKENS / TEST_CASES_MAX_TOKENS, " +
        "or split the source CSV into smaller blocks.",
    },
    hooks: {
      onModelSwitch: (model, reason) =>
        console.warn(`LLM model "${model}" failed (${reason}). Trying next fallback model.`),
    },
  });
}

/**
 * Test cases picked from the TMS in the Web UI, as reference context — plus, during a Regenerate,
 * the cases of the suites / sections / folders the reviewer's guidance names (see
 * runUpdateRegenerateStage, which fills `guidanceContextFiles` before any prompt is built), and
 * the ones the Helping Prompt names (`helpingContextFiles`: fetched by run() at generation, read
 * back from the session by a Regenerate).
 *
 * Memoized: an update run builds one prompt per CSV segment, and every one of them would
 * otherwise re-read the same files off disk. A Regenerate is its own process, so it always reads
 * the selection as it is now.
 * Never throws — missing picked context means "less context", not a failed run.
 * @returns {Array<{ filename: string, content: string }>}
 */
/**
 * The area brief of this run (area-brief.js): one study pass over the ticket's context and the
 * picked test management cases, made once before the first block and put into every block's
 * prompt — so twenty blocks start from the same understanding of the area instead of each forming
 * its own from the same raw material. Set by run(); a Regenerate reads it back from the session,
 * with `edited` when the reviewer corrected it in the panel.
 */
let areaBrief = { text: "", edited: false };

let adoPickedContextCache = null;
let guidanceContextFiles = [];
let helpingContextFiles = [];
function loadAdoPickedContext() {
  if (adoPickedContextCache) return [...helpingContextFiles, ...adoPickedContextCache, ...guidanceContextFiles];
  try {
    adoPickedContextCache = adoContextStore.loadContextFiles(__dirname);
  } catch (err) {
    console.warn(`\u26a0\ufe0f  Could not read picked test management context: ${err.message}`);
    adoPickedContextCache = [];
  }
  if (adoPickedContextCache.length > 0) {
    const total = adoPickedContextCache.length;
    console.log(`\ud83d\udccc Using ${total} test management context source(s) picked in the Web UI`);
  }
  return [...helpingContextFiles, ...adoPickedContextCache, ...guidanceContextFiles];
}

/**
 * The Helping Prompt typed on the Update page (HELPING_PROMPT), and the TMS suites / sections /
 * folders it names \u2014 the same lookup a Regenerate's guidance uses (tms-context.js), done once per
 * run. See buildHelpingPromptBlock in prompts-docs.js for how the model is told to use it.
 * Never throws: an unreadable TMS means less context, not a failed run.
 * @returns {Promise<{ text: string, files: Array<{ filename: string, content: string }> }>}
 */
async function resolveHelpingPromptContext() {
  const text = String(process.env.HELPING_PROMPT || "").trim();
  if (!text) return { text: "", files: [] };
  console.log(`\ud83e\udded Helping prompt: ${text}`);
  try {
    const guided = await tmsContext.resolveGuidanceContext(text, {
      projectDir: __dirname,
      log: (line) => console.log(String(line).replace(/\bGuidance\b/g, "Helping prompt")),
    });
    const files = guided.files.map((f) => ({
      ...f,
      filename: String(f.filename).replace("named in the reviewer guidance", "named in the Helping Prompt"),
    }));
    return { text, files };
  } catch (err) {
    console.warn(`\u26a0\ufe0f  Could not read the test cases the helping prompt names (continuing without them): ${err.message}`);
    return { text, files: [] };
  }
}

/**
 * The ticket, the source priority and the behaviour-change rule — the same universal blocks the
 * Create prompts use (prompt-context.js). `issueData.ticket` is missing in sessions written before
 * it existed; the summary alone still shows then.
 */
function updateTicketSection(issueData) {
  const d = issueData || {};
  return `${pc.buildTicketSection({
    issueKey: d.key,
    issueDescription: d.description,
    issueLabels: d.labels || [],
    ticket: d.ticket || { summary: d.summary || "" },
  })}
${pc.SOURCE_PRIORITY_BLOCK}${pc.buildAreaBriefBlock(areaBrief.text, { edited: areaBrief.edited, kind: "update" })}
${pc.BEHAVIOUR_CHANGE_BLOCK}
${DEFECT_SOURCE_BLOCK}`;
}

/**
 * The Update flow is maintenance, and the prompts used to say "update and improve". "Improve" is
 * a licence to reword steps the ticket never touched, so the reviewer got a diff where the two
 * real changes were buried under twenty cosmetic ones. These rules are the same for all three
 * formats; only the nouns change.
 *
 * @param {"testcase"|"bdd"|"checklist"} kind
 * @param {boolean} hasOutline - whether the OTHER … / ALREADY ADDED lists are in the prompt
 * @param {boolean} [planned] - whether a FILE PLAN is in the prompt (update-plan.js): new cases are
 *   then written in their own step, so a case's own call must not add any
 */
function maintenanceRules(kind, hasOutline, planned = false) {
  const isChecklist = kind === "checklist";
  const isBdd = kind === "bdd";
  const unit = isChecklist ? "checklist" : isBdd ? "scenario" : "test case";
  const part = isChecklist ? "item" : isBdd ? "line" : "step";
  const parts = `${part}s`;
  const NEW = isChecklist ? "item" : isBdd ? "scenario" : "test case";
  const untouched = isChecklist
    ? `An item the ticket does not affect is returned character for character, with "changeType": "unchanged".`
    : isBdd
      ? `A line the ticket does not affect is returned character for character, in the same place. A scenario none of whose lines changed is "changeType": "unchanged".`
      : `A step the ticket does not affect is returned character for character — same wording, same test data, same position — with "changeType": "unchanged".`;
  const addInside = isChecklist
    ? ""
    : isBdd
      ? `
4. Add a line only where the changed behaviour needs another Given / When / Then inside this scenario's own behaviour. A different rule, actor or outcome — the negative, boundary or role check a new rule implies — is not more lines here: it is a new scenario, under rule 5.`
      : `
4. Add a step only where the changed behaviour needs a new check inside this test case's own flow — including the negative, boundary or role check a new rule implies (a new limit → at the limit and just past it; a new state → the transition that is no longer allowed; a new permission → the role that lacks it).`;
  const fitsNone = isChecklist ? "no item of this segment verifies" : `fits no flow of the ${unit} above`;
  const others = isChecklist
    ? "does not belong to a segment listed under OTHER PARTS OF THIS FILE"
    : `is not what any ${unit} listed under OTHER PARTS OF THIS FILE is about — that one gets the change when its own turn comes`;
  const addNew = planned
    ? isChecklist
      ? `Add a new item only for the changes the FILE PLAN names for this checklist, and only where no existing item already verifies them.`
      : `Do not add a new ${NEW} here. New ${NEW}s for this ticket are written in a separate step from the FILE PLAN, so one added here would be a duplicate. Only REVIEWER GUIDANCE that explicitly asks for a new ${NEW} overrides this.`
    : hasOutline
    ? `Add a new ${NEW} only for behaviour the ticket brings that (a) ${fitsNone}, (b) ${others}, and (c) is not listed under ALREADY ADDED IN THIS RUN. This file is updated one group at a time, so anything that fails (b) or (c) would be added twice. When in doubt, do not add.`
    : `Add a new ${NEW} only for behaviour the ticket brings that ${fitsNone}. One ${NEW} per new behaviour — never two that check the same thing.`;
  const n = isChecklist ? 4 : 5;
  const aPart = isChecklist ? "an item" : `a ${part}`;
  return `HOW TO UPDATE — this is maintenance, not a rewrite. The ${unit} above is reviewed and in use; every ${part} you alter is ${aPart} someone has to re-read and re-approve.
1. Find what the ticket changes ("was → becomes") and which ${parts} exercise that behaviour. Start "reasoning" with it: what changes, and which ${parts} it touches.
2. Change only those ${parts}. ${untouched} Do not rephrase, tidy, reorder, merge, split or "improve" what the ticket leaves alone — not even to fix style.
3. If the ticket does not affect this ${unit} at all, return it exactly as it is, everything "unchanged", and say so in "reasoning". That is a valid and expected answer: one ticket usually touches a few ${isChecklist ? "items" : `${unit}s`} of a file, not all of them.${addInside}
${n}. ${addNew}
${n + 1}. Remove ${aPart}${isChecklist ? "" : ` or the whole ${unit}`} only when the ticket makes it obsolete — the behaviour it checks no longer exists. List it in "removed" with the reason; do not keep it in the output.
${n + 2}. Write changed and new ${parts} in the existing ${unit}'s own style — its wording, ${isChecklist ? "granularity and level of detail" : isBdd ? "line granularity" : "step granularity and Preconditions layout"} — so they read as part of it. Names of people and record numbers are the exception: in what you write, generalise them as GENERIC TEST DATA says, even where the existing ${unit} spells them out.${
    isChecklist || isBdd
      ? ""
      : ` If you change the Preconditions step itself, list one precondition per line, each starting with "- ".`
  }
${n + 3}. REVIEWER GUIDANCE or a HELPING PROMPT above may ask for more than this ("rewrite the steps in more detail", "add negative cases for …"). Then do what it asks, on top of these rules, and still mark every change.`;
}

/**
 * What else is in the CSV and what earlier groups of this run already added.
 *
 * Every group is updated in its own call and sees only its own rows. Without this, a ticket that
 * adds one behaviour gets a new case for it from every group that finds it relevant — the same
 * case, three times, in three blocks. The outline is set per block by run() and stored with the
 * block, so a Regenerate sees it too.
 *
 * @param {{ otherTitles?: string[], alreadyAdded?: string[] }|null} outline
 */
function buildOutlineBlock(outline) {
  const clip = (list, max) => {
    const arr = (Array.isArray(list) ? list : []).map((t) => String(t || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    const shown = arr.slice(0, max).map((t) => `- ${t.length > 200 ? `${t.slice(0, 199)}…` : t}`);
    if (arr.length > max) shown.push(`- … and ${arr.length - max} more`);
    return shown;
  };
  const others = clip(outline && outline.otherTitles, 150);
  const added = clip(outline && outline.alreadyAdded, 60);
  if (!others.length && !added.length) return "";
  let out = "";
  if (others.length) {
    out += `

OTHER PARTS OF THIS FILE (titles only — each is updated in its own call; do NOT output them and do not add coverage that belongs to them):
${others.join("\n")}`;
  }
  if (added.length) {
    out += `

ALREADY ADDED IN THIS RUN (new coverage earlier groups of this file created for this ticket — do NOT add it again):
${added.join("\n")}`;
  }
  return out;
}

/** Whether the prompt will carry an outline — decides how the "add a new case" rule is worded. */
/** The FILE PLAN note for this case's prompt, "" when the run has no plan. */
function planNoteOf(outline, kind) {
  const p = outline && outline.plan;
  return p ? updatePlan.buildPlanNote(p.case, p.changes, kind) : "";
}

function hasOutline(outline) {
  return Boolean(
    outline && ((Array.isArray(outline.otherTitles) && outline.otherTitles.length) || (Array.isArray(outline.alreadyAdded) && outline.alreadyAdded.length))
  );
}

const UPDATE_JSON_RULES = `- Return ONLY valid JSON (no markdown/code fences, no prose before or after).
- The response MUST be parseable by JSON.parse on the first try. In particular:
  * Inside every string value, escape every " as \\" (backslash + quote). Never leave a bare " inside a string.
  * Use straight ASCII double quotes only. Never use smart/curly quotes (\u201C \u201D \u2018 \u2019) as string delimiters or anywhere else - if the source text contains them, replace them with straight " when copying into JSON.
  * Never put a literal newline, tab, or carriage return inside a JSON string - use \\n, \\t, \\r.
  * No trailing commas before } or ].`;

function buildUpdatedTestCasesPrompt(issueData, existingCases, segmentMeta, figmaContext = "", userGuidance = "", prototypeContext = "", attachmentsContext = "", commentsContext = "", confluenceContext = "", helpingPrompt = "", outline = null) {
  const areaPath = areaPathForPrompt();
  const sm = segmentMeta || {};
  const segmentNote =
    sm.total > 1
      ? `This is test case group ${sm.index} of ${sm.total} in the same CSV file${
          sm.caseTitle ? ` ("${sm.caseTitle}")` : ""
        }. Work on the case(s) below only — the other groups are updated in their own calls, so do not merge them in or re-create them.\n\n`
      : "";
  const figmaBlock =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext) +
    buildConfluenceContextBlock(confluenceContext);
  const adoBlock = buildAdoContextBlock(loadAdoPickedContext());
  return `You are a senior QA engineer maintaining an existing test suite.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
Task: bring the existing test case(s) below in line with the ticket — change what the ticket changes, and leave the rest exactly as it is.

${segmentNote}${updateTicketSection(issueData)}

<existing_test_cases>
${JSON.stringify(existingCases, null, 2)}
</existing_test_cases>${buildOutlineBlock(outline)}${planNoteOf(outline, "testcase")}
${figmaBlock}${adoBlock}

${maintenanceRules("testcase", hasOutline(outline), Boolean(outline && outline.plan))}

Output rules:
${UPDATE_JSON_RULES}
- ${pc.languageRule()} Text you leave unchanged stays in the language it is written in.
- In changed and new steps keep Step Expected specific: exact UI labels, limits, counters, states and messages from the sources — never a summary. Several expected facts go on their own "- " bullet lines.
- Keep "priority" and "areaPath" of an existing case as they are${areaPath.value ? ` (a new case uses areaPath "${areaPath.value}")` : ""}.
- Mark what you changed, so the reviewer can see it without diffing by eye:
  * every test case carries "changeType": "added" (did not exist in the CSV), "changed" (existed, and at least one of its steps or its title is different now) or "unchanged" (returned exactly as it was);
  * every step carries its own "changeType" by the same rule — "unchanged" means the text is identical to the CSV;
  * "changeReason" is one short sentence naming the requirement behind the change ("limit raised from 5 to 10 in the description"), required whenever changeType is "added" or "changed" (leave it "" for "unchanged");
  * anything you dropped from the CSV goes in "removed" with the reason — do NOT keep it in "testCases".
- Use this JSON schema:
{
  "reasoning": "string: first what the ticket changes (was → becomes) and which steps it touches — or that it does not affect this case; then anything the reviewer should know",
  "testCases": [
    {
      "title": "string",
      "priority": 1,
      "areaPath": "${areaPath.jsonExample}",
      "changeType": "added" | "changed" | "unchanged",
      "changeReason": "string",
      "steps": [
        {
          "stepNumber": 1,
          "action": "string",
          "expected": "string",
          "changeType": "added" | "changed" | "unchanged",
          "changeReason": "string"
        }
      ]
    }
  ],
  "removed": [
    { "item": "string: what was dropped", "why": "string: why it is no longer needed" }
  ],
  "changeSummary": {
    "added": [
      {
        "item": "string",
        "why": "string"
      }
    ],
    "changed": [
      {
        "item": "string",
        "why": "string"
      }
    ]
  }
}
${NO_REDACTION_PLACEHOLDERS_BLOCK}`;
}

/**
 * The BDD twin of buildUpdatedTestCasesPrompt, used when the CSV block was
 * recognised as Gherkin.
 *
 * The existing scenario is handed over as plain Gherkin lines, not as
 * action/expected rows — showing the model the CSV encoding invites it to
 * "improve" that encoding instead of the scenario. Change annotations stay at
 * scenario level: the review panel edits a BDD scenario as one block of text, so
 * a per-line changeType would have nowhere to render.
 */
function buildUpdatedBddTestCasesPrompt(issueData, existingScenarios, segmentMeta, figmaContext = "", userGuidance = "", prototypeContext = "", attachmentsContext = "", commentsContext = "", confluenceContext = "", helpingPrompt = "", outline = null) {
  const areaPath = areaPathForPrompt();
  const sm = segmentMeta || {};
  const segmentNote =
    sm.total > 1
      ? `This is scenario group ${sm.index} of ${sm.total} in the same CSV file${
          sm.caseTitle ? ` ("${sm.caseTitle}")` : ""
        }. Work on the scenario(s) below only — the other groups are updated in their own calls, so do not merge them in or re-create them.\n\n`
      : "";
  const figmaBlock =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext) +
    buildConfluenceContextBlock(confluenceContext);
  const adoBlock = buildAdoContextBlock(loadAdoPickedContext());
  return `You are a senior QA automation engineer specialising in Behaviour-Driven Development, maintaining an existing set of scenarios.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
Task: bring the existing BDD scenario(s) below in line with the ticket — change what the ticket changes, leave the rest exactly as it is, and STAY IN GHERKIN.

${segmentNote}${updateTicketSection(issueData)}

<existing_scenarios>
${JSON.stringify(existingScenarios, null, 2)}
</existing_scenarios>
They came from a CSV where each scenario is stored as Gherkin; "steps" is one Gherkin line per entry.${buildOutlineBlock(outline)}${planNoteOf(outline, "bdd")}
${figmaBlock}${adoBlock}

${maintenanceRules("bdd", hasOutline(outline), Boolean(outline && outline.plan))}
${BDD_STYLE_BLOCK}
The style rules above govern the lines you change or add. Lines the ticket does not affect stay as they are, even where they break a style rule.
${bddExamplesBlock()}
Output rules:
- The output MUST stay Gherkin. Do not convert these scenarios into step/expected test cases.
${UPDATE_JSON_RULES}
- ${pc.languageRule()} Text you leave unchanged stays in the language it is written in.
${BDD_STEPS_CONTRACT}
${BDD_PRECONDITIONS_CONTRACT}
- Keep "preconditions" of an existing scenario as they are unless the ticket changes the setup it needs.
- Keep "priority" and "areaPath" of an existing scenario as they are.
- Mark what you changed, so the reviewer can see it without diffing by eye:
  * every scenario carries "changeType": "added" (did not exist in the CSV), "changed" (existed, and its title, preconditions or at least one line is different now) or "unchanged" (returned exactly as it was);
  * "changeReason" is one short sentence naming the requirement behind the change and which lines it touched, required whenever changeType is "added" or "changed" (leave it "" for "unchanged");
  * anything you dropped from the CSV goes in "removed" with the reason — do NOT keep it in "testCases".
- Use this JSON schema:
{
  "reasoning": "string: first what the ticket changes (was → becomes) and which lines it touches — or that it does not affect this scenario; then anything the reviewer should know",
  "feature": "string: the Feature name these scenarios belong to, no \\"Feature:\\" prefix",
  "testCases": [
    {
      "title": "string: the Scenario name, no \\"Scenario:\\" prefix",
      "priority": 1,
      "areaPath": "${areaPath.jsonExample}",
      "changeType": "added" | "changed" | "unchanged",
      "changeReason": "string",
      "preconditions": "string: environment/setup, one per line; \\"\\" when none",
      "steps": ["Given ...", "And ...", "When ...", "Then ...", "And ..."]
    }
  ],
  "removed": [
    { "item": "string: what was dropped", "why": "string: why it is no longer needed" }
  ],
  "changeSummary": {
    "added": [
      {
        "item": "string",
        "why": "string"
      }
    ],
    "changed": [
      {
        "item": "string",
        "why": "string"
      }
    ]
  }
}
${NO_REDACTION_PLACEHOLDERS_BLOCK}`;
}

function buildUpdatedChecklistPrompt(issueData, existingItems, segmentMeta, figmaContext = "", userGuidance = "", prototypeContext = "", attachmentsContext = "", commentsContext = "", confluenceContext = "", helpingPrompt = "", outline = null) {
  const sm = segmentMeta || {};
  const segmentNote =
    sm.total > 1
      ? `This is checklist segment ${sm.index} of ${sm.total} in the same CSV file${
          sm.workItemTitle ? ` (source title: "${sm.workItemTitle}")` : ""
        }. Work on the items listed below only — the other segments are updated in their own calls, so do not merge them in or re-create them.\n\n`
      : "";
  const figmaBlock =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext) +
    buildConfluenceContextBlock(confluenceContext);
  const adoBlock = buildAdoContextBlock(loadAdoPickedContext());
  return `You are a QA engineer maintaining an existing test checklist.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
Task: bring the existing checklist below in line with the ticket — change what the ticket changes, and leave the rest exactly as it is.

${segmentNote}${updateTicketSection(issueData)}

<existing_checklist>
${JSON.stringify(existingItems, null, 2)}
</existing_checklist>${buildOutlineBlock(outline)}${planNoteOf(outline, "checklist")}
${figmaBlock}${adoBlock}

${maintenanceRules("checklist", hasOutline(outline), Boolean(outline && outline.plan))}

Rules:
- Use categories Functional, Negative, Boundary, Integration only. Do NOT output Regression. An item you leave unchanged keeps its category; a new item gets the category that fits it — there is no quota per category.

${pc.CHECKLIST_PRECONDITIONS_BLOCK}
- If the existing checklist already opens with a Preconditions item, keep it first (update it only when the setup changed).
${checklistExamplesBlock()}
The format examples above set the style of the items you change or add; they are not a reason to reword the items the ticket leaves alone.

Output rules:
${UPDATE_JSON_RULES}
- ${pc.languageRule()} Text you leave unchanged stays in the language it is written in.

Mark what you changed, so the reviewer can see it without diffing by eye:
- every item carries "changeType": "added" (not in the CSV before), "changed" (existed but its text is different now) or "unchanged" (returned exactly as it was);
- "changeReason" is one short sentence naming the requirement behind the change, required whenever changeType is "added" or "changed" (leave it "" for "unchanged");
- anything you dropped from the CSV goes in "removed" with the reason — do NOT keep it in "checklistItems".

Schema:
{
  "reasoning": "string: first what the ticket changes (was → becomes) and which items it touches — or that it does not affect this checklist; then anything the reviewer should know",
  "checklistItems": [
    {
      "id": "CL-001",
      "description": "string",
      "category": "Functional" | "Negative" | "Boundary" | "Integration",
      "changeType": "added" | "changed" | "unchanged",
      "changeReason": "string"
    }
  ],
  "removed": [
    { "item": "string: what was dropped", "why": "string: why it is no longer needed" }
  ],
  "changeSummary": {
    "added": [
      {
        "item": "string",
        "why": "string"
      }
    ],
    "changed": [
      {
        "item": "string",
        "why": "string"
      }
    ]
  }
}
${NO_REDACTION_PLACEHOLDERS_BLOCK}`;
}

function normalizeChangeSummary(changeSummary) {
  const toList = (arr) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      if (x && typeof x === "object") {
        const item = String(x.item || "").trim();
        const why = String(x.why || "").trim();
        if (item) out.push({ item, why });
      } else if (typeof x === "string") {
        const item = x.trim();
        if (item) out.push({ item, why: "" });
      }
      if (out.length >= 7) break;
    }
    return out;
  };
  const added = toList(changeSummary?.added);
  const changed = toList(changeSummary?.changed);
  return { added, changed };
}

function normalizeExpectedResultText(expectedRaw) {
  const raw = String(expectedRaw || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  // A Gherkin "Then … / And …" block is already one fact per line. Bulleting it
  // would bury the keywords, and the sentence split below would produce lines
  // that no longer start with one — which is exactly what this flow reads back
  // to tell a BDD block from a standard one.
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

function renderChangeSummaryLines(changeSummary) {
  const lines = [];
  if (changeSummary.added.length) {
    lines.push("Added:");
    changeSummary.added.forEach((x, idx) => {
      lines.push(`${idx + 1}. ${x.item}${x.why ? ` — Why: ${x.why}` : ""}`);
    });
  }
  if (changeSummary.changed.length) {
    lines.push("Changed:");
    changeSummary.changed.forEach((x, idx) => {
      lines.push(`${idx + 1}. ${x.item}${x.why ? ` — Why: ${x.why}` : ""}`);
    });
  }
  return lines;
}

/**
 * What these posted comments say about approving, now that no comment is read back.
 *
 * Only a direct CLI run reaches them: a web-UI run approves row by row in the review panel, and
 * Submit attaches the approved CSV instead of posting the design. So the posts are the generated
 * design for reference, and they say where approving actually happens — replying "APPROVED (1)"
 * to one of them is read by nothing.
 */
const APPROVE_IN_PANEL_NOTE =
  "Generated design, for reference. Approving happens in the review panel of the web UI (npm run web): " +
  "mark each row APPROVED there and press Submit to Jira, which attaches the approved rows as a CSV.";

/**
 * @param {{ blockIndex: number, totalBlocks: number } | null} placement - global post order in this run (1..N).
 * @param {{ index: number, total: number, caseTitle?: string | null } | null} tcSegmentMeta - among test-case groups in CSV (when nGroups>1).
 */
function buildUpdatedFlowApprovalAdfParagraphs(placement, tcSegmentMeta) {
  const pi =
    placement && placement.blockIndex >= 1 && placement.totalBlocks >= 1 ? placement : null;
  const out = [
    JiraClient.buildAdfParagraph(
      APPROVE_IN_PANEL_NOTE + (pi && pi.totalBlocks > 1 ? ` This post is block ${pi.blockIndex} of ${pi.totalBlocks} in this update.` : "")
    ),
  ];

  if (tcSegmentMeta && tcSegmentMeta.total > 1) {
    const title = (tcSegmentMeta.caseTitle || "").trim();
    out.push(
      JiraClient.buildAdfParagraph(
        `Among test case groups in this CSV file: segment ${tcSegmentMeta.index}/${tcSegmentMeta.total}${
          title ? ` — ${title}` : ""
        }.`
      )
    );
  }
  return out;
}

/**
 * @param {{ blockIndex: number, totalBlocks: number } | null} placement
 * @param {{ index: number, total: number, workItemTitle?: string | null } | null} checklistSegmentMeta
 */
function formatChecklistBlockApprovalSection(placement, checklistSegmentMeta) {
  const pi =
    placement && placement.blockIndex >= 1 && placement.totalBlocks >= 1 ? placement : null;
  const lines = [
    APPROVE_IN_PANEL_NOTE + (pi && pi.totalBlocks > 1 ? ` This post is block ${pi.blockIndex} of ${pi.totalBlocks} in this update.` : ""),
  ];
  const sm = checklistSegmentMeta || {};
  if (sm.total > 1 && sm.index) {
    lines.push(
      `Among checklist segments in this CSV export: Part ${sm.index}/${sm.total}${
        sm.workItemTitle ? ` — ${sm.workItemTitle}` : ""
      }.`
    );
  }
  return lines.join("\n\n");
}

function updatedFlowSummaryApprovalFooter() {
  return `\n\n${APPROVE_IN_PANEL_NOTE}`;
}

function buildTestCasesCommentAdf(testCasesResult, placement, tcSegmentMeta) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const changeSummary = normalizeChangeSummary(testCasesResult.changeSummary);
  // A Gherkin scenario squeezed into a 3-column table is unreadable; the
  // approval numbering is untouched, so "APPROVED (2): 1,3" still works.
  const isBdd = testCasesResult.format === "bdd" || bddFormat.anyBddTestCase(testCases);
  const content = [
    JiraClient.buildAdfHeading(
      isBdd
        ? "🤖 AI-Generated BDD Scenarios — Gherkin (Updated CSV flow)"
        : "🤖 AI-Generated Test Cases (Updated CSV flow)",
      3
    ),
    ...buildUpdatedFlowApprovalAdfParagraphs(placement || null, tcSegmentMeta || null),
  ];
  if (isBdd) {
    const feature = String(testCasesResult.feature || "").trim();
    if (feature) content.push(JiraClient.buildAdfHeading(`Feature: ${feature}`, 4));
  }
  if (reasoning) {
    content.push(JiraClient.buildAdfHeading("Reasoning", 4));
    content.push(JiraClient.buildAdfParagraph(reasoning));
  }
  if (changeSummary.added.length || changeSummary.changed.length) {
    content.push(JiraClient.buildAdfHeading("What was added / changed", 4));
    const lines = renderChangeSummaryLines(changeSummary);
    lines.forEach((line) => content.push(JiraClient.buildAdfParagraph(line)));
  }
  testCases.forEach((tc, idx) => {
    content.push(JiraClient.buildAdfParagraph(`${idx + 1}. ${(tc.title || "").trim()}`));
    if (isBdd) {
      // Not part of the scenario, but the reviewer approves from this comment.
      const { preconditions } = bddFormat.splitPreconditionsRow(tc.steps);
      if (preconditions) {
        content.push(JiraClient.buildAdfParagraph(`Preconditions: ${preconditions.replace(/\n/g, " ")}`));
      }
      content.push(JiraClient.buildAdfCodeBlock(bddFormat.testCaseToScenarioText(tc), "gherkin"));
      return;
    }
    const steps = (tc.steps || []).slice().sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
    const tableRows = [
      ["Test Step", "Step Action", "Step Expected"],
      ...steps.map((s) => [
        String(s.stepNumber != null ? s.stepNumber : ""),
        (s.action || "").trim(),
        normalizeExpectedResultText(s.expected),
      ]),
    ];
    const table = JiraClient.buildAdfTable(tableRows);
    if (table) content.push(table);
  });
  return { type: "doc", version: 1, content };
}

function formatChecklistComment(checklistResult, segmentMeta, placement) {
  const sm = segmentMeta || {};
  const partHeader =
    sm.total > 1
      ? `Part ${sm.index}/${sm.total}${
          sm.workItemTitle ? ` — ${sm.workItemTitle}` : ""
        }\n\n`
      : "";
  const items = checklistResult.checklistItems || [];
  const reasoning = checklistResult.reasoning || "";
  const changeSummary = normalizeChangeSummary(checklistResult.changeSummary);
  const itemsList = items
    .map((item, idx) => `${idx + 1}. [${item.category}] ${item.description}`)
    .join("\n");
  const changeLines = renderChangeSummaryLines(changeSummary);
  const approvalBlock = formatChecklistBlockApprovalSection(
    placement || null,
    sm.total > 1 && sm.index ? sm : null
  );
  return `${partHeader}🤖 AI-Generated Test Checklist (Updated CSV flow)

Approval instructions (Update test design only — this post):

${approvalBlock}

---
Proposed test scenarios:
${itemsList}

---
${reasoning ? `Reasoning:\n${reasoning}\n---\n` : ""}
${changeLines.length ? `What was added / changed (detailed):\n${changeLines.join("\n")}\n---\n` : ""}
📌 Generated automatically from Jira requirements + uploaded CSV`;
}

/**
 * Generation and posting are split so the web UI can put a review step between them: this flow
 * emits every block for editing first, and only PIPELINE_STAGE=submit writes to Jira.
 * A block is one parent row from the CSV — one test case group or one checklist segment — and its
 * position in the CSV becomes the APPROVED (n) index, so the order must survive the round trip.
 */
const CHANGE_TYPES = ["added", "changed", "unchanged"];

/**
 * Make the change annotations safe to render.
 *
 * The model is asked for `changeType` / `changeReason` on every row and a block-level `removed`
 * list, but it is still a model: fields go missing, come back with invented values, or carry a
 * reason on an "unchanged" row. Normalising here means the panel can render without defensive
 * checks, and an older session (generated before these fields existed) still displays.
 */
function normalizeChangeAnnotations(parsed) {
  const type = (v) => (CHANGE_TYPES.includes(v) ? v : "unchanged");
  const reason = (v, t) => (t === "unchanged" ? "" : String(v || "").trim());

  const rows = Array.isArray(parsed.testCases)
    ? parsed.testCases
    : Array.isArray(parsed.checklistItems)
    ? parsed.checklistItems
    : [];
  for (const row of rows) {
    row.changeType = type(row.changeType);
    row.changeReason = reason(row.changeReason, row.changeType);
    if (Array.isArray(row.steps)) {
      for (const step of row.steps) {
        step.changeType = type(step.changeType);
        step.changeReason = reason(step.changeReason, step.changeType);
      }
    }
  }

  parsed.removed = (Array.isArray(parsed.removed) ? parsed.removed : [])
    .map((r) => ({ item: String((r && r.item) || "").trim(), why: String((r && r.why) || "").trim() }))
    .filter((r) => r.item);

  return parsed;
}

/* ── Change annotations checked against the CSV ──────────────────────────────────────────────── */

/** Text as the comparison sees it: no bullets, no blank lines, single spaces, "—" same as empty. */
function canonText(v) {
  return String(v || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*[-•]\s+/, "").replace(/\s+/g, " ").trim())
    .filter((l) => l && l !== "—" && l !== "-" && l !== "–")
    .join("\n");
}

const canonStep = (st) => `${canonText(st && st.action)}\u0001${canonText(normalizeExpectedResultText(st && st.expected))}`;

/**
 * Make "changeType" say what actually happened to the text.
 *
 * The annotations are the model's own account of its edit, and the review panel colours rows by
 * them — so a step quietly reworded but reported "unchanged" is exactly the change a reviewer
 * never looks at. The source rows are right here, so the claim is checked instead of trusted:
 *   - text identical to the CSV   → "unchanged", whatever the model said;
 *   - reported "unchanged" but the text differs → "changed", with a reason that says so.
 * Nothing is rewritten or restored; only the labels are corrected. Returns how many were corrected.
 *
 * @param {Object} parsed - normalised payload (testCases | checklistItems)
 * @param {Object} block - the update block; `block.source` is what the CSV held
 */
function reconcileChangeAnnotations(parsed, block) {
  const UNREPORTED = "Differs from the CSV — the model reported it as unchanged, so check this edit";
  let corrected = 0;
  const set = (row, type, reason) => {
    if (row.changeType === type) return;
    row.changeType = type;
    row.changeReason = type === "unchanged" ? "" : row.changeReason || reason;
    corrected += 1;
  };
  if (!parsed || !block || !block.source) return 0;

  if (block.type !== "testcase") {
    const before = new Set((block.source.items || []).map((it) => canonText(it.description)));
    for (const it of parsed.checklistItems || []) {
      const same = before.has(canonText(it.description));
      if (same) set(it, "unchanged", "");
      else if (it.changeType === "unchanged") set(it, "changed", UNREPORTED);
    }
    return corrected;
  }

  const cases = parsed.testCases || [];
  const src = block.source;
  // One CSV case per block: it is the returned case with the same title, else the first one the
  // model did not mark as added.
  const existing =
    cases.find((tc) => canonText(tc.title) === canonText(src.title)) || cases.find((tc) => tc.changeType !== "added");
  if (!existing) return 0;

  if (blockIsBdd(block)) {
    const was = blockSourceAsScenario(src);
    const now = blockSourceAsScenario(existing);
    const same =
      canonText(was.title) === canonText(now.title) &&
      canonText(was.preconditions) === canonText(now.preconditions) &&
      was.steps.map(canonText).join("\n") === now.steps.map(canonText).join("\n");
    if (same) set(existing, "unchanged", "");
    else if (existing.changeType !== "changed") set(existing, "changed", UNREPORTED);
    return corrected;
  }

  const before = new Set((src.steps || []).map(canonStep));
  const steps = existing.steps || [];
  for (const st of steps) {
    const same = before.has(canonStep(st));
    if (same) set(st, "unchanged", "");
    else if (st.changeType === "unchanged") set(st, "changed", UNREPORTED);
  }
  const identical =
    canonText(existing.title) === canonText(src.title) &&
    steps.length === (src.steps || []).length &&
    steps.every((st, i) => canonStep(st) === canonStep(src.steps[i]));
  if (identical) set(existing, "unchanged", "");
  else if (existing.changeType !== "changed") {
    const dropped = (src.steps || []).length - steps.filter((st) => st.changeType === "unchanged").length;
    set(
      existing,
      "changed",
      steps.some((st) => st.changeType !== "unchanged")
        ? "Steps were added or edited — see the marked steps"
        : dropped > 0
          ? "Steps were removed or reordered compared to the CSV"
          : "Title differs from the CSV"
    );
  }
  return corrected;
}

/** Titles (test cases) or descriptions (checklist items) a block's answer marked as added. */
function addedTitlesOf(block, parsed) {
  const rows = block.type === "testcase" ? parsed.testCases || [] : parsed.checklistItems || [];
  return rows
    .filter((r) => r && r.changeType === "added")
    .map((r) => String(block.type === "testcase" ? r.title : r.description || "").trim())
    .filter(Boolean);
}

/** What a block is called in another block's outline. */
function blockOutlineTitle(block) {
  const src = (block && block.source) || {};
  if (block.type === "testcase") return String(src.title || "").trim();
  const title = String(src.workItemTitle || "").trim();
  return title ? `Checklist: ${title}` : "";
}

/** Normalise the annotations, then correct them against the CSV; logs when the model misreported. */
function finishUpdatedPayload(parsed, block) {
  const out = normalizeChangeAnnotations(parsed);
  const corrected = reconcileChangeAnnotations(out, block);
  if (corrected) {
    console.log(`   🔎 ${corrected} change mark(s) corrected against the CSV (the text, not the model's label, decides)`);
  }
  return out;
}

/** True when this CSV block was written as Gherkin — set by the parser, re-checked for old sessions. */
function blockIsBdd(block) {
  if (!block || block.type !== "testcase") return false;
  if (block.format) return block.format === "bdd";
  return bddFormat.isBddTestCase(block.source);
}

/**
 * The existing scenario as the BDD prompt wants to see it: Gherkin lines, not
 * the CSV's action/expected rows, and the preconditions in their own field
 * rather than hidden in a row the model would try to turn into a `Given`.
 */
function blockSourceAsScenario(source) {
  const { preconditions, steps } = bddFormat.splitPreconditionsRow(source && source.steps);
  return {
    title: (source && source.title) || "",
    priority: source && source.priority,
    areaPath: source && source.areaPath,
    // Bullets stripped: the prompt asks for one item per line without them, and
    // showing the model the "- " it is told not to produce invites it back.
    preconditions: bddFormat.splitCellLines(preconditions).join("\n"),
    steps: bddFormat.stepsToGherkinLines(steps),
  };
}

async function generateUpdatedTestCaseBlock(issueData, block, design, testDesignKey) {
  const isBdd = blockIsBdd(block);
  if (isBdd) {
    console.log(
      `   🥒 Block ${block.typeIndex + 1}/${block.typeTotal} is a BDD scenario — updating in Gherkin${
        block.source && block.source.title ? ` — ${block.source.title}` : ""
      }`
    );
  }
  const prompt = isBdd
    ? buildUpdatedBddTestCasesPrompt(
        issueData,
        [blockSourceAsScenario(block.source)],
        block.meta,
        design.figmaContext,
        "",
        design.prototypeContext,
        design.attachmentsContext,
        design.commentsContext,
        design.confluenceContext,
        design.helpingPrompt,
        block.outline,
      )
    : buildUpdatedTestCasesPrompt(issueData, [block.source], block.meta, design.figmaContext, "", design.prototypeContext, design.attachmentsContext, design.commentsContext, design.confluenceContext, design.helpingPrompt, block.outline);
  const response = await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "16000", 10));
  const ctxLabel = `${isBdd ? "bdd" : "testcases"}-${testDesignKey}${block.typeTotal > 1 ? `-seg${block.typeIndex + 1}` : ""}`;
  const parsed = parseLlmJsonStrict(response, ctxLabel);
  if (!parsed.testCases || !Array.isArray(parsed.testCases)) {
    throw new Error("LLM response missing testCases array");
  }
  if (isBdd) {
    parsed.testCases = bddFormat.normalizeBddTestCases(parsed.testCases);
    parsed.format = "bdd";
    parsed.feature = String(parsed.feature || "").trim();
  } else {
    parsed.testCases = normalizeExpectedInTestCases(parsed.testCases);
  }
  return finishUpdatedPayload(parsed, block);
}

async function postUpdatedTestCaseBlock(jiraClient, testDesignKey, block, parsed) {
  const segmentMeta = block.meta;
  const tcSeg =
    segmentMeta && segmentMeta.total > 1
      ? {
          index: segmentMeta.index,
          total: segmentMeta.total,
          caseTitle: segmentMeta.caseTitle || null,
        }
      : null;
  const adfBody = buildTestCasesCommentAdf(parsed, block.placement || null, tcSeg);
  await jiraClient.addCommentAdf(testDesignKey, adfBody);
  const isBdd = parsed.format === "bdd" || bddFormat.anyBddTestCase(parsed.testCases);
  const jsonPayload = JSON.stringify(
    {
      testCases: parsed.testCases,
      reasoning: parsed.reasoning || "",
      ...(isBdd ? { format: "bdd", feature: parsed.feature || "" } : {}),
    },
    null,
    2
  );
  const jsonFileName =
    block.typeTotal === 1
      ? `generated-testcases-${testDesignKey}.json`
      : `generated-testcases-${testDesignKey}-seg${block.typeIndex + 1}.json`;
  const tmpPath = path.join(__dirname, jsonFileName);
  try {
    fs.writeFileSync(tmpPath, jsonPayload, "utf8");
    await jiraClient.addAttachment(testDesignKey, tmpPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
  console.log(
    `   ✅ Posted test case group ${block.typeIndex + 1}/${block.typeTotal}${
      block.source && block.source.title ? ` — ${block.source.title}` : ""
    }`
  );
}

async function generateUpdatedChecklistBlock(issueData, block, design, testDesignKey) {
  const seg = block.source;
  console.log(
    `   Segment ${block.typeIndex + 1}/${block.typeTotal}: ${seg.items.length} item(s)${
      seg.workItemTitle ? ` — ${seg.workItemTitle}` : ""
    }`
  );
  const prompt = buildUpdatedChecklistPrompt(
    issueData,
    seg.items,
    block.meta,
    design.figmaContext,
    "",
    design.prototypeContext,
    design.attachmentsContext,
    design.commentsContext,
    design.confluenceContext,
    design.helpingPrompt,
    block.outline,
  );
  const response = await callLLM(prompt, parseInt(process.env.CHECKLIST_MAX_TOKENS || "16000", 10));
  const ctxLabel = `checklist-${testDesignKey}${block.typeTotal > 1 ? `-seg${block.typeIndex + 1}` : ""}`;
  const parsed = parseLlmJsonStrict(response, ctxLabel);
  if (!parsed.checklistItems || !Array.isArray(parsed.checklistItems)) {
    throw new Error("LLM response missing checklistItems array");
  }
  return finishUpdatedPayload(parsed, block);
}

async function postUpdatedChecklistBlock(jiraClient, testDesignKey, block, parsed) {
  await jiraClient.addComment(
    testDesignKey,
    formatChecklistComment(parsed, block.meta, block.placement || null)
  );
}

/* ── Two-pass update: the file plan and its execution (update-plan.js) ───────────────────────── */

/** The context blocks every update prompt appends after the cases. */
function designBlocksOf(design) {
  const d = design || {};
  return (
    buildFigmaContextBlock(d.figmaContext) +
    buildPrototypeContextBlock(d.prototypeContext) +
    buildAttachmentsContextBlock(d.attachmentsContext) +
    buildIssueCommentsBlock(d.commentsContext) +
    buildConfluenceContextBlock(d.confluenceContext)
  );
}

/**
 * Pass 1: decide, for the whole file at once, what the ticket changes and which cases that
 * touches. null when planning is off or failed — the caller then updates every case the old way.
 */
async function planUpdate(issueData, blocks, design) {
  try {
    console.log(`🗺️  Planning the update across ${blocks.length} case(s) of the file...`);
    const prompt = updatePlan.buildPlanPrompt({
      ticketSection: updateTicketSection(issueData),
      guidanceBlock: buildUserGuidanceBlock("", design.helpingPrompt),
      blocks,
      contextBlocks: designBlocksOf(design),
    });
    const parsed = parseLlmJsonStrict(await callLLM(prompt, updatePlan.planMaxTokens()), "update-plan");
    const plan = updatePlan.normalizePlan(parsed, blocks);
    if (!plan || !plan.changes.length) throw new Error("the plan named no changes");
    const count = (v) => plan.cases.filter((c) => c.verdict === v).length;
    console.log(
      `🗺️  Plan: ${plan.changes.length} change(s) in the ticket — ${count("update")} case(s) to update, ${count("check")} to check, ${count("keep")} left as they are, ${plan.newCases.length} new.`
    );
    for (const c of plan.changes) console.log(`   ${c.id}: ${c.text}`);
    return plan;
  } catch (err) {
    console.warn(`⚠️  Planning failed (updating every case on its own, as before): ${err.message}`);
    return null;
  }
}

/** A case the plan left alone: its CSV rows as an "unchanged" payload, without a model call. */
function keptPayload(block, why) {
  const reasoning = why ? `Not affected by the ticket: ${why}.` : "Not affected by the ticket.";
  if (block.type !== "testcase") {
    return {
      checklistItems: (block.source.items || []).map((it) => ({ ...it, changeType: "unchanged", changeReason: "" })),
      removed: [],
      reasoning,
    };
  }
  const mark = (tc) => ({
    ...tc,
    changeType: "unchanged",
    changeReason: "",
    steps: (tc.steps || []).map((s) => ({ ...s, changeType: "unchanged", changeReason: "" })),
  });
  if (blockIsBdd(block)) {
    return {
      testCases: bddFormat.normalizeBddTestCases([blockSourceAsScenario(block.source)]).map(mark),
      removed: [],
      reasoning,
      format: "bdd",
      feature: "",
    };
  }
  return { testCases: [mark({ ...block.source })], removed: [], reasoning };
}

/**
 * Write the new cases the plan asked for — one call for all of them. `block.newCtx` carries what
 * the prompt needs (the specs, the ticket's changes, the file's titles, a style sample), so a
 * Regenerate of this block can run from the stored session alone.
 */
async function generateNewCases(issueData, block, design, userGuidance = "") {
  const ctx = block.newCtx || {};
  const isBdd = ctx.format === "bdd";
  const prompt = updatePlan.buildNewCasesPrompt({
    ticketSection: updateTicketSection(issueData),
    guidanceBlock: buildUserGuidanceBlock(userGuidance, design.helpingPrompt),
    specs: ctx.specs || [],
    changes: ctx.changes || [],
    existingTitles: ctx.existingTitles || [],
    styleSample: ctx.styleSample || null,
    format: isBdd ? "bdd" : "standard",
    contextBlocks: designBlocksOf(design) + buildAdoContextBlock(loadAdoPickedContext()),
    areaPathExample: areaPathForPrompt().jsonExample,
    blocks: {
      priorityRules: PRIORITY_RULES,
      noRedaction: NO_REDACTION_PLACEHOLDERS_BLOCK,
      bddStyle: BDD_STYLE_BLOCK,
      bddSteps: BDD_STEPS_CONTRACT,
      bddPreconditions: BDD_PRECONDITIONS_CONTRACT,
    },
  });
  const parsed = parseLlmJsonStrict(
    await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "16000", 10)),
    "update-new-cases"
  );
  if (!Array.isArray(parsed.testCases)) throw new Error("LLM response missing testCases array");
  const known = new Set((ctx.changes || []).map((c) => c.id));
  // The prompt asks for one case per entry, in order — so when the counts match, what a case
  // covers is the plan's own statement, not the model's restatement of it.
  const specs = ctx.specs || [];
  const inOrder = parsed.testCases.length === specs.length;
  const coversOf = (i) =>
    inOrder
      ? specs[i].covers
      : (Array.isArray(parsed.testCases[i] && parsed.testCases[i].covers) ? parsed.testCases[i].covers : [])
          .map((id) => String(id || "").trim())
          .filter((id) => known.has(id));
  const cases = (isBdd ? bddFormat.normalizeBddTestCases(parsed.testCases) : normalizeExpectedInTestCases(parsed.testCases)).map(
    (tc, i) => ({
      ...tc,
      covers: coversOf(i),
      changeType: "added",
      changeReason: String((parsed.testCases[i] && parsed.testCases[i].changeReason) || "").trim() || "New behaviour in the ticket",
      steps: (tc.steps || []).map((s) => ({ ...s, changeType: "added", changeReason: "" })),
    })
  );
  const payload = { testCases: cases, removed: [], reasoning: String(parsed.reasoning || "").trim() };
  if (isBdd) {
    payload.format = "bdd";
    payload.feature = String(issueData.summary || "").trim();
  }
  return payload;
}

/**
 * Pass 2: carry the plan out. Kept cases come straight from the CSV; cases to update or check go
 * through the ordinary update prompt with the plan's note; a change whose planned cases all came
 * back unchanged is handed to the new-case step instead of being lost; new cases are written last,
 * in one call, as a block of their own after the file's cases.
 */
async function executePlannedUpdate(issueData, blocks, plan, design, testDesignKey) {
  const generated = [];
  const otherTitles = (block) => blocks.filter((b) => b !== block).map(blockOutlineTitle).filter(Boolean);
  for (const [i, block] of blocks.entries()) {
    const casePlan = plan.cases[i];
    // Kept on the block: the review panel groups and labels by it, and a later Regenerate reads it.
    block.plan = { verdict: casePlan.verdict, why: casePlan.why, changes: casePlan.changes };
    block.outline = { otherTitles: otherTitles(block), alreadyAdded: [], plan: { case: casePlan, changes: plan.changes } };
    if (casePlan.verdict === "keep") {
      generated.push({ ...block, payload: keptPayload(block, casePlan.why) });
      continue;
    }
    const payload = await generateUpdatedBlock(issueData, block, design, testDesignKey);
    if (block.type === "testcase") {
      // New cases have their own step; one slipped in here would be written twice.
      const stray = (payload.testCases || []).filter((tc) => tc.changeType === "added");
      if (stray.length && (payload.testCases || []).length > stray.length) {
        payload.testCases = payload.testCases.filter((tc) => tc.changeType !== "added");
        console.log(`   ℹ️  Dropped ${stray.length} new case(s) written inside case ${i + 1} — new cases are written in their own step.`);
      }
    }
    generated.push({ ...block, payload });
  }

  const tcBlocks = blocks.filter((b) => b.type === "testcase");
  if (!tcBlocks.length) return generated; // checklists take their additions inside the segment

  // A change the plan gave to a case that then came back untouched has landed nowhere.
  const rowsChanged = (b) =>
    (b.type === "testcase" ? b.payload.testCases || [] : b.payload.checklistItems || []).some((r) => r.changeType !== "unchanged") ||
    (b.payload.removed || []).length > 0;
  const specs = plan.newCases.map((s) => ({ ...s }));
  const skipped = new Set(plan.notCovered.map((x) => x.change));
  for (const change of plan.changes) {
    if (skipped.has(change.id)) continue;
    const inCase = generated.some((b, i) => plan.cases[i].changes.includes(change.id) && rowsChanged(b));
    const inNew = specs.some((s) => s.covers.includes(change.id));
    if (!inCase && !inNew) {
      specs.push({
        title: change.text.length > 110 ? `${change.text.slice(0, 109)}…` : change.text,
        covers: [change.id],
        why: "the case planned for it came back unchanged",
      });
    }
  }
  if (!specs.length) return generated;

  const format = tcBlocks.some((b) => !blockIsBdd(b)) ? "standard" : "bdd";
  const sample = tcBlocks.find((b) => blockIsBdd(b) === (format === "bdd")) || tcBlocks[0];
  const newBlock = {
    type: "testcase",
    format,
    source: null,
    meta: null,
    isNew: true,
    typeIndex: tcBlocks.length,
    typeTotal: tcBlocks.length + 1,
    placement: { blockIndex: blocks.length + 1, totalBlocks: blocks.length + 1 },
    plan: { verdict: "new", why: "", changes: [...new Set(specs.flatMap((s) => s.covers))] },
    newCtx: {
      specs,
      changes: plan.changes,
      existingTitles: blocks.map(blockOutlineTitle).filter(Boolean),
      styleSample: format === "bdd" ? blockSourceAsScenario(sample.source) : sample.source,
      format,
    },
  };
  console.log(`🆕 Writing ${specs.length} new ${format === "bdd" ? "scenario" : "test case"}(s) the plan asked for...`);
  try {
    const payload = await generateNewCases(issueData, newBlock, design);
    if (payload.testCases.length) generated.push({ ...newBlock, payload });
  } catch (err) {
    console.warn(`⚠️  Writing the new cases failed (the updated cases are still there): ${err.message}`);
  }
  return generated;
}

/** @param {{figmaContext: string, prototypeContext: string, attachmentsContext?: string, commentsContext?: string, confluenceContext?: string}} design all optional, all may be "" */
async function generateUpdatedBlock(issueData, block, design, testDesignKey) {
  return block.type === "testcase"
    ? generateUpdatedTestCaseBlock(issueData, block, design, testDesignKey)
    : generateUpdatedChecklistBlock(issueData, block, design, testDesignKey);
}

async function postUpdatedBlock(jiraClient, testDesignKey, block, parsed) {
  return block.type === "testcase"
    ? postUpdatedTestCaseBlock(jiraClient, testDesignKey, block, parsed)
    : postUpdatedChecklistBlock(jiraClient, testDesignKey, block, parsed);
}

/** Base name may omit .csv; tries name then name + ".csv". */
function resolveCsvPathInUpdatedFolder(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) {
    if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isFile()) return nameOrPath;
    if (!/\.csv$/i.test(nameOrPath)) {
      const withCsv = `${nameOrPath}.csv`;
      if (fs.existsSync(withCsv) && fs.statSync(withCsv).isFile()) return withCsv;
    }
    return null;
  }
  const p = path.join(UPDATED_TEST_CASES_FOLDER, nameOrPath);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (!/\.csv$/i.test(nameOrPath)) {
    const pCsv = path.join(UPDATED_TEST_CASES_FOLDER, `${nameOrPath}.csv`);
    if (fs.existsSync(pCsv) && fs.statSync(pCsv).isFile()) return pCsv;
  }
  return null;
}

function readInputCsvFile() {
  if (!fs.existsSync(UPDATED_TEST_CASES_FOLDER)) {
    throw new Error(`Updated CSV folder not found: ${UPDATED_TEST_CASES_FOLDER}`);
  }
  if (UPDATED_FLOW_INPUT_FILE) {
    const resolved = resolveCsvPathInUpdatedFolder(UPDATED_FLOW_INPUT_FILE);
    if (!resolved) {
      throw new Error(
        `UPDATED_FLOW_INPUT_FILE not found: ${path.join(UPDATED_TEST_CASES_FOLDER, UPDATED_FLOW_INPUT_FILE)} (also tried .csv)`
      );
    }
    return resolved;
  }
  const files = fs
    .readdirSync(UPDATED_TEST_CASES_FOLDER, { withFileTypes: true })
    .filter((f) => f.isFile() && path.extname(f.name).toLowerCase() === ".csv")
    .map((f) => path.join(UPDATED_TEST_CASES_FOLDER, f.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No CSV files found in ${UPDATED_TEST_CASES_FOLDER}`);
  return files[0];
}

function runExistingApprovalFlow(issueKey) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["agent-docs.js"], {
      cwd: __dirname,
      env: { ...process.env, JIRA_ISSUE_KEY: issueKey, CHECK_APPROVAL: "true" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent-docs.js CHECK_APPROVAL flow exited with code ${code}`));
    });
  });
}

/**
 * The first Jira-style key among the sources — the issue key itself, usually, then whatever a
 * summary happens to carry.
 *
 * The pattern used to be `PROJ-\d+`: one project's prefix, in code, which meant any other project's
 * updated CSV came out with no key in its name at all — and the importers read the container name,
 * the tags and the issue link back out of that file name. The shape is generic now, the way
 * extractJiraKeyFromCsvFilename() in ado-sync-csv.js has always been.
 */
function extractIssueKeyFromSources(...sources) {
  for (const s of sources) {
    // Not `\b` on the left: an underscore is a word character, so `\bABC-1` misses "prefix_ABC-1".
    const m = String(s || "").match(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/i);
    if (m) return m[1].toUpperCase();
  }
  return "";
}

function buildUpdatedOutputNameFromParent(parentSummary, sourceKey, fallbackKey) {
  const baseRaw = String(parentSummary || "").trim() || String(fallbackKey || "updated-cases");
  const safe = String(baseRaw)
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const keyPart = sourceKey || String(fallbackKey || "").trim();
  const withKey = keyPart ? `${safe} (${keyPart})` : safe;
  return `${withKey} (updated by AI).csv`;
}

function readReportJsonIfExists() {
  const reportPath = path.join(__dirname, "report.yaml");
  if (!fs.existsSync(reportPath)) return null;
  try {
    const text = fs.readFileSync(reportPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Flatten the CSV into one ordered list of blocks, whatever the mode.
 *
 * The three modes used to each have their own loop and their own copy of the posting call. They
 * only ever differed in how the blocks are picked, so that is all this does — the order it returns
 * is the order they get posted in, and therefore the APPROVED (n) numbering.
 *
 * @returns {{ blocks: Array, tcCount: number, clCount: number }}
 */
function collectUpdateBlocks(rows, mode) {
  const out = [];

  if (mode === "auto") {
    console.log(`🧭 Updated CSV mode: auto (per-block: test case vs checklist, CSV order)`);
    const parsedBlocks = parseUpdatedCsvBlocksForAuto(rows);
    if (!parsedBlocks.length) throw new Error("No test case or checklist content found in CSV");
    const tcCount = parsedBlocks.filter((b) => b.type === "testcase").length;
    const clCount = parsedBlocks.filter((b) => b.type === "checklist").length;
    if (tcCount > 1) console.log(`🧪 Test case blocks in CSV: ${tcCount} (sequential LLM runs)`);
    if (clCount > 1) console.log(`📋 Checklist blocks in CSV: ${clCount} (sequential LLM runs)`);
    const bddCount = parsedBlocks.filter((b) => b.format === "bdd").length;
    if (bddCount) {
      console.log(
        `🥒 BDD (Gherkin) blocks detected in CSV: ${bddCount}/${tcCount} — those are updated in Gherkin, the rest in the standard format`
      );
    }
    let tcIdx = 0;
    let clIdx = 0;
    parsedBlocks.forEach((block, i) => {
      const placement = { blockIndex: i + 1, totalBlocks: parsedBlocks.length };
      if (block.type === "testcase") {
        out.push({
          type: "testcase",
          // Decided per block by the CSV parser, so a file that mixes standard
          // cases and scenarios updates each one in its own format.
          format: block.format || "standard",
          source: block.case,
          meta:
            tcCount > 1
              ? { index: tcIdx + 1, total: tcCount, caseTitle: (block.case.title || "").trim() || null }
              : null,
          typeIndex: tcIdx,
          typeTotal: tcCount,
          placement,
        });
        tcIdx += 1;
      } else {
        const seg = block.segment;
        out.push({
          type: "checklist",
          source: seg,
          meta:
            clCount > 1
              ? {
                  index: clIdx + 1,
                  total: clCount,
                  workItemTitle: seg.workItemTitle || null,
                  workItemType: seg.workItemType || null,
                }
              : null,
          typeIndex: clIdx,
          typeTotal: clCount,
          placement,
        });
        clIdx += 1;
      }
    });
    return { blocks: out, tcCount, clCount };
  }

  console.log(`🧭 Updated CSV mode: ${mode}`);

  if (mode === "testcases") {
    const existingCases = rowsToTestCases(rows);
    const withSteps = existingCases.filter((c) => (c.steps || []).length > 0);
    const caseGroups = withSteps.length ? withSteps : existingCases;
    if (!caseGroups.length) {
      throw new Error("No test cases found in CSV (expected Test Case rows with steps)");
    }
    const nGroups = caseGroups.length;
    if (nGroups > 1) {
      console.log(`🧪 Test case groups in CSV: ${nGroups} (updating sequentially, not merged)`);
    }
    caseGroups.forEach((oneCase, i) => {
      out.push({
        type: "testcase",
        // The explicit "testcases" mode skips the auto classifier, so the format
        // is read straight off the rows — a Gherkin CSV still updates as Gherkin.
        format: bddFormat.isBddTestCase(oneCase) ? "bdd" : "standard",
        source: oneCase,
        meta:
          nGroups > 1
            ? { index: i + 1, total: nGroups, caseTitle: (oneCase.title || "").trim() || null }
            : null,
        typeIndex: i,
        typeTotal: nGroups,
        placement: { blockIndex: i + 1, totalBlocks: nGroups },
      });
    });
    const bddGroups = out.filter((b) => b.format === "bdd").length;
    if (bddGroups) {
      console.log(`🥒 BDD (Gherkin) blocks detected in CSV: ${bddGroups}/${nGroups}`);
    }
    return { blocks: out, tcCount: nGroups, clCount: 0 };
  }

  const checklistSegments = rowsToChecklistSegments(rows);
  if (!checklistSegments.length) throw new Error("No checklist content found in CSV");
  const nSeg = checklistSegments.length;
  if (nSeg > 1) {
    console.log(`📋 Checklist segments in CSV: ${nSeg} (updating sequentially, not merged)`);
  }
  checklistSegments.forEach((seg, i) => {
    out.push({
      type: "checklist",
      source: seg,
      meta:
        nSeg > 1
          ? {
              index: i + 1,
              total: nSeg,
              workItemTitle: seg.workItemTitle || null,
              workItemType: seg.workItemType || null,
            }
          : null,
      typeIndex: i,
      typeTotal: nSeg,
      placement: { blockIndex: i + 1, totalBlocks: nSeg },
    });
  });
  return { blocks: out, tcCount: 0, clCount: nSeg };
}

/** The closing summary comment. Wording preserved per mode and per block mix. */
function buildUpdatedFlowSummary(mode, tcCount, clCount, base) {
  const footer = updatedFlowSummaryApprovalFooter();
  if (mode === "auto") {
    if (tcCount && clCount) {
      return `Updated CSV flow: source file "${base}" — posted **${tcCount}** test case block(s) and **${clCount}** checklist(s) **in CSV order** (comments may alternate: ADF tables vs checklist text).${footer}`;
    }
    if (tcCount > 1) {
      return `Updated CSV flow: source file "${base}" — ${tcCount} test case group(s) from the CSV were analyzed and posted above **in order** (not merged into one run).${footer}`;
    }
    if (clCount > 1) {
      return `Updated CSV flow: source file "${base}" — ${clCount} separate checklist(s) from the CSV were analyzed and posted above **in order** (not merged).${footer}`;
    }
    if (tcCount === 1) {
      return `Updated CSV flow: source file "${base}" analyzed, test cases posted for approval.${footer}`;
    }
    return `Updated CSV flow: source file "${base}" analyzed, checklist posted for approval.${footer}`;
  }
  if (mode === "testcases") {
    return tcCount > 1
      ? `Updated CSV flow: source file "${base}" — ${tcCount} test case group(s) from the CSV were analyzed and posted above **in order** (not merged into one run).${footer}`
      : `Updated CSV flow: source file "${base}" analyzed, test cases posted for approval.${footer}`;
  }
  return clCount > 1
    ? `Updated CSV flow: source file "${base}" — ${clCount} separate checklist(s) from the CSV were analyzed and posted above **in order** (not merged).${footer}`
    : `Updated CSV flow: source file "${base}" analyzed, checklist posted for approval.${footer}`;
}

/** A row the reviewer marked APPROVED in the panel. Anything else never reaches the CSV. */
function isApprovedRow(row) {
  return !!(row && row.approved);
}

/**
 * Rebuild the rows of a block that is going into the CSV.
 *
 * The reviewer edits a scenario as free Gherkin text, so the steps are derived from that text
 * here rather than trusted as they came back from the browser.
 */
function normalizeBlockPayload(block) {
  const payload = block.payload || {};
  if (block.type !== "testcase") return;
  payload.testCases = blockIsBdd(block)
    ? bddFormat.normalizeBddTestCases(payload.testCases)
    : normalizeExpectedInTestCases(payload.testCases);
}

/**
 * The reviewed blocks as CSV sections, APPROVED rows only.
 *
 * Approval is per row now, so a block contributes a section only if something inside it was
 * approved. A block where nothing was — because the reviewer deleted its rows, or read them and
 * approved none — is simply absent from the CSV; that is a decision about one CSV segment, not a
 * reason to refuse the whole update. Only a run with nothing approved anywhere has no answer.
 *
 * The section order is the block order, which is the order of the source CSV.
 *
 * @returns {{ sections: Array, approvedCount: number, reviewedCount: number, skipped: number }}
 */
function approvedSectionsFromBlocks(blocks) {
  const sections = [];
  let approvedCount = 0;
  let reviewedCount = 0;
  let skipped = 0;

  for (const block of blocks) {
    const payload = block.payload || {};
    const isTestCases = block.type === "testcase";
    const reviewed = (isTestCases ? payload.testCases : payload.checklistItems) || [];
    const approved = reviewed.filter(isApprovedRow);
    reviewedCount += reviewed.length;
    if (!approved.length) {
      skipped += 1;
      continue;
    }
    approvedCount += approved.length;

    if (isTestCases) {
      // Normalize the approved cases only — the rest are not going anywhere.
      payload.testCases = approved;
      normalizeBlockPayload(block);
      sections.push({ type: "testcases", testCases: payload.testCases });
    } else {
      sections.push({
        type: "checklist",
        // Titles the block's Test Case row when the update has more than one checklist.
        partLabel: (block.meta && block.meta.workItemTitle) || "",
        approvedItems: approved.map((item, i) => ({ number: i + 1, item })),
      });
    }
  }
  return { sections, approvedCount, reviewedCount, skipped };
}

const UPDATE_CHECKLIST_CATEGORIES = ["Functional", "Negative", "Boundary", "Integration"];

/**
 * PIPELINE_STAGE=regenerate — redo part of one already generated block, reusing the context stored
 * in the review session. Touches no Jira API: the ticket is only read during "generate" and only
 * written during "submit", so iterating here costs nothing but tokens.
 *
 * Input (PIPELINE_IO_FILE): { blockIndex, kind, index, userGuidance, promptContext, block }
 *   kind "block"    - regenerate the whole block from its original CSV rows
 *   kind "item"     - regenerate the checklist item at `index` inside the block
 *   kind "testcase" - regenerate the test case at `index` inside the block
 */
async function runUpdateRegenerateStage() {
  const input = readPipelineIo();
  const kind = String(input.kind || "block");
  const userGuidance = String(input.userGuidance || "").trim();
  const ctx = input.promptContext || {};
  const issueData = ctx.issueData || {};
  const figmaContext = ctx.figmaContext || "";
  const prototypeContext = ctx.prototypeContext || "";
  const attachmentsContext = ctx.attachmentsContext || "";
  const commentsContext = ctx.commentsContext || "";
  const confluenceContext = ctx.confluenceContext || "";
  // The Helping Prompt of the generation step, and the cases it named — stored with the session,
  // so every Regenerate keeps following it without asking the TMS again.
  const helpingPrompt = ctx.helpingPrompt || "";
  helpingContextFiles = Array.isArray(ctx.helpingPromptTestCases) ? ctx.helpingPromptTestCases : [];
  areaBrief = { text: String(ctx.areaBrief || ""), edited: Boolean(ctx.areaBriefEdited) };
  const block = input.block;
  if (!block) throw new Error("regenerate: no block supplied");
  if (helpingPrompt) console.log(`🧭 Helping prompt (from generation): ${helpingPrompt}`);
  if (userGuidance) console.log(`🗣️  Reviewer guidance: ${userGuidance}`);

  // Suites / sections / folders the guidance names, pulled from the TMS In use for this call only.
  // They ride along with the picked context through loadAdoPickedContext().
  const guided = await tmsContext.resolveGuidanceContext(userGuidance, { projectDir: __dirname });
  guidanceContextFiles = guided.files;
  const referenceTestCases = loadAdoPickedContext();
  const guidanceContext = guided.provider
    ? {
        providerTitle: guided.providerTitle,
        matched: guided.matched,
        unmatchedQuotes: guided.unmatchedQuotes,
        notes: guided.notes,
      }
    : null;
  // Every answer says which suites the guidance pulled in, so the panel can tell the reviewer.
  const respond = (result) => writePipelineIo({ ...result, guidanceContext });

  const label = `block ${block.placement ? block.placement.blockIndex : "?"}`;

  const isBddBlock = blockIsBdd(block);

  if (kind === "block") {
    console.log(
      `🤖 Regenerating the whole ${
        block.type === "testcase" ? (isBddBlock ? "BDD scenario block" : "test case block") : "checklist block"
      } (${label})...`
    );
    // The block of new cases has no CSV rows behind it: it is rewritten from the plan's list.
    if (block.isNew) {
      const payload = await generateNewCases(
        issueData,
        block,
        { figmaContext, prototypeContext, attachmentsContext, commentsContext, confluenceContext, helpingPrompt },
        userGuidance
      );
      if (!payload.testCases.length) throw new Error("regenerate: LLM returned no test cases");
      respond({ ok: true, kind, payload, usage: { ...runUsage } });
      return;
    }
    const prompt =
      block.type !== "testcase"
        ? buildUpdatedChecklistPrompt(
            issueData,
            block.source.items,
            block.meta,
            figmaContext,
            userGuidance,
            prototypeContext,
            attachmentsContext,
            commentsContext,
            confluenceContext,
            helpingPrompt,
            block.outline
          )
        : isBddBlock
        ? buildUpdatedBddTestCasesPrompt(
            issueData,
            [blockSourceAsScenario(block.source)],
            block.meta,
            figmaContext,
            userGuidance,
            prototypeContext,
            attachmentsContext,
            commentsContext,
            confluenceContext,
            helpingPrompt,
            block.outline
          )
        : buildUpdatedTestCasesPrompt(
            issueData,
            [block.source],
            block.meta,
            figmaContext,
            userGuidance,
            prototypeContext,
            attachmentsContext,
            commentsContext,
            confluenceContext,
            helpingPrompt,
            block.outline
          );
    const maxTokens = parseInt(
      (block.type === "testcase" ? process.env.TEST_CASES_MAX_TOKENS : process.env.CHECKLIST_MAX_TOKENS) || "16000",
      10
    );
    const parsed = parseLlmJsonStrict(await callLLM(prompt, maxTokens), `${kind}-${label}`);
    if (block.type === "testcase") {
      if (!Array.isArray(parsed.testCases) || !parsed.testCases.length) {
        throw new Error("regenerate: LLM returned no test cases");
      }
      if (isBddBlock) {
        parsed.testCases = bddFormat.normalizeBddTestCases(parsed.testCases);
        parsed.format = "bdd";
        parsed.feature = String(parsed.feature || (block.payload && block.payload.feature) || "").trim();
      } else {
        parsed.testCases = normalizeExpectedInTestCases(parsed.testCases);
      }
    } else if (!Array.isArray(parsed.checklistItems) || !parsed.checklistItems.length) {
      throw new Error("regenerate: LLM returned no checklist items");
    }
    respond({ ok: true, kind, payload: finishUpdatedPayload(parsed, block), usage: { ...runUsage } });
    return;
  }

  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`regenerate: index must be a non-negative integer, got ${input.index}`);
  }

  if (kind === "item") {
    const items = (block.payload && block.payload.checklistItems) || [];
    const item = items[index];
    if (!item) throw new Error(`regenerate: no checklist item at index ${index} in ${label}`);
    console.log(`🤖 Regenerating checklist item ${index + 1} of ${items.length} (${label})...`);
    const prompt = regenerateChecklistItemPrompt({
      issueKey: issueData.key,
      issueDescription: issueData.description,
      issueLabels: issueData.labels || [],
      ticket: issueData.ticket || null,
      figmaContext,
      prototypeContext,
      attachmentsContext,
      commentsContext,
      confluenceContext,
      areaBrief: areaBrief.text,
      areaBriefEdited: areaBrief.edited,
      item,
      siblingItems: items.filter((_, i) => i !== index),
      referenceTestCases,
      userGuidance,
      helpingPrompt,
    });
    const parsed = parseLlmJsonStrict(await callLLM(prompt, 2500), `item ${index + 1} of ${label}`);
    const description = String(parsed.description || "").trim();
    if (!description) throw new Error("regenerate: LLM returned an empty item description");
    const category = UPDATE_CHECKLIST_CATEGORIES.includes(parsed.category) ? parsed.category : item.category;
    respond({
      ok: true,
      kind,
      index,
      item: { ...item, description, category },
      reasoning: parsed.reasoning || "",
      usage: { ...runUsage },
    });
    return;
  }

  if (kind === "testcase") {
    const cases = (block.payload && block.payload.testCases) || [];
    const testCase = cases[index];
    if (!testCase) throw new Error(`regenerate: no test case at index ${index} in ${label}`);
    // A row inside a BDD block stays BDD; a row that is plainly Gherkin does too,
    // which covers sessions generated before the format was recorded.
    const isBdd = isBddBlock || bddFormat.isBddTestCase(testCase);
    console.log(
      `🤖 Regenerating ${isBdd ? "scenario" : "test case"} ${index + 1} of ${cases.length} (${label})...`
    );
    const siblingTitles = cases.filter((_, i) => i !== index).map((c) => c.title || "");
    const prompt = isBdd
      ? regenerateBddTestCasePrompt({
          issueKey: issueData.key,
          issueDescription: issueData.description,
          issueLabels: issueData.labels || [],
          ticket: issueData.ticket || null,
          figmaContext,
          prototypeContext,
          attachmentsContext,
          commentsContext,
          confluenceContext,
          areaBrief: areaBrief.text,
          areaBriefEdited: areaBrief.edited,
          feature: (block.payload && block.payload.feature) || "",
          testCase: {
            title: testCase.title || "",
            priority: testCase.priority,
            areaPath: testCase.areaPath,
            steps: bddFormat.stepsToGherkinLines(testCase.steps),
          },
          siblingTitles,
          referenceTestCases,
          userGuidance,
          helpingPrompt,
        })
      : regenerateTestCasePrompt({
          issueKey: issueData.key,
          issueDescription: issueData.description,
          issueLabels: issueData.labels || [],
          ticket: issueData.ticket || null,
          figmaContext,
          prototypeContext,
          attachmentsContext,
          commentsContext,
          confluenceContext,
          areaBrief: areaBrief.text,
          areaBriefEdited: areaBrief.edited,
          testCase,
          siblingTitles,
          referenceTestCases,
          userGuidance,
          helpingPrompt,
        });
    const parsed = parseLlmJsonStrict(
      await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "16000", 10)),
      `test case ${index + 1} of ${label}`
    );
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) {
      throw new Error("regenerate: LLM returned a test case with no steps");
    }
    const rebuilt = {
      title: String(parsed.title || testCase.title || "").trim(),
      priority: parsed.priority != null ? parsed.priority : testCase.priority,
      areaPath: parsed.areaPath || testCase.areaPath,
      steps: parsed.steps,
    };
    const [normalized] = isBdd
      ? bddFormat.normalizeBddTestCases([rebuilt])
      : normalizeExpectedInTestCases([
          {
            ...rebuilt,
            steps: parsed.steps.map((step, i) => ({
              stepNumber: i + 1,
              action: String(step.action || "").trim(),
              expected: String(step.expected || "").trim(),
            })),
          },
        ]);
    respond({ ok: true, kind, index, testCase: normalized, reasoning: parsed.reasoning || "", usage: { ...runUsage } });
    return;
  }

  throw new Error(`regenerate: unknown kind "${kind}" (expected block | item | testcase)`);
}

async function run() {
  const issueKey = String(process.env.JIRA_ISSUE_KEY || "").trim();
  if (!issueKey) {
    throw new Error("JIRA_ISSUE_KEY is required (e.g. PROJ-12345)");
  }
  const checkApproval = process.env.CHECK_APPROVAL === "true";
  if (checkApproval) {
    console.log("📥 CHECK_APPROVAL=true: importing the approved CSV attached to this ticket (no comment is read)...");
    const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
    const issue = await jiraClient.getIssueWithExpand(issueKey);
    const contextIssueKey = contextIssueKeyFor(issue, issueKey);
    let parentIssue = issue;
    if (contextIssueKey !== issueKey) {
      try {
        parentIssue = await jiraClient.getIssueWithExpand(contextIssueKey);
      } catch {
        parentIssue = issue;
      }
    }
    const parentData = jiraClient.extractIssueData(parentIssue);
    const sourceKey = extractIssueKeyFromSources(parentData.key, parentData.summary, contextIssueKey);
    await runExistingApprovalFlow(issueKey);
    const report = readReportJsonIfExists();
    const generatedPath = report?.approvalCsv?.csvPath ? String(report.approvalCsv.csvPath) : "";
    if (generatedPath && fs.existsSync(generatedPath)) {
      const dir = path.dirname(generatedPath);
      const targetName = buildUpdatedOutputNameFromParent(
        parentData.summary,
        sourceKey,
        parentData.key || contextIssueKey
      );
      const targetPath = path.join(dir, targetName);
      if (path.resolve(generatedPath) !== path.resolve(targetPath)) {
        // Keep historical file if name already exists.
        const finalPath = fs.existsSync(targetPath)
          ? path.join(
              dir,
              `${path.basename(targetName, ".csv")} (${Date.now()}).csv`
            )
          : targetPath;
        fs.copyFileSync(generatedPath, finalPath);
        console.log(`✅ Renamed approved CSV copy for updated flow: ${finalPath}`);
      }
    } else {
      console.log("ℹ️  Import finished, but the CSV path was not reported back in report.yaml.");
    }
    return;
  }

  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = contextIssueKeyFor(issue, issueKey);
  const contextIssue =
    contextIssueKey !== issueKey ? await jiraClient.getIssueWithExpand(contextIssueKey) : issue;
  const issueData = jiraClient.extractIssueData(contextIssue);
  issueData.ticket = pc.ticketFactsFromIssue(contextIssue);
  // CSV / JSON files attached to the story are part of its requirement (ticket-data-files.js).
  // Not on submit: that stage only writes the reviewed rows, it builds no prompt.
  if (PIPELINE_STAGE !== "submit") await appendTicketDataFiles(jiraClient, issueData);

  // Azure DevOps posts to the story's Test design sub-task; every other TMS posts to the
  // typed-in key, so the sub-task is only required for Azure DevOps.
  const testDesignKey =
    (await testDesignSubtaskKeyFor(jiraClient, contextIssueKey, PROJECT_KEY)) ||
    (usesTestDesignSubtask() ? null : issueKey);
  if (!testDesignKey) {
    throw new Error("No QA Sub-task with title 'Test design' found for this issue.");
  }

  let figmaContext = "";
  const figmaUrl = (process.env.FIGMA_URL || "").trim();
  if (figmaUrl) {
    if (!isFigmaUrl(figmaUrl)) {
      console.warn(`⚠️  FIGMA_URL is set but does not look like a Figma link — skipping design analysis. Value: ${figmaUrl}`);
    } else {
      try {
        const figma = await analyzeFigmaUrl(figmaUrl);
        if (figma.error) console.warn(`⚠️  Figma: ${figma.error}`);
        if (figma.summary) {
          figmaContext = figma.summary;
          const visionNote = figma.stats?.visionFrames
            ? `, vision: ${figma.stats.visionFrames} frame(s) via ${figma.stats.visionModel}`
            : ", vision: skipped";
          console.log(
            `🎨 Figma analyzed: ${figma.stats?.scopeKind} "${figma.stats?.scopeName || "(unnamed)"}" — ${figma.stats?.framesAnalyzed || 0} frame(s)${visionNote}.`,
          );
        }
      } catch (err) {
        console.warn(`⚠️  Figma analysis crashed (continuing without design context): ${err.message}`);
      }
    }
  }

  // The live prototype, set by the Web UI when Setup's "Read prototype" is on. Same handling as
  // Figma: a broken link or an unreachable build costs a warning, never the run.
  let prototypeContext = "";
  const prototypeUrl = (process.env.PROTOTYPE_URL || "").trim();
  if (prototypeUrl) {
    if (!isHttpUrl(prototypeUrl)) {
      console.warn(`⚠️  PROTOTYPE_URL is not an http(s) link — skipping the prototype crawl. Value: ${prototypeUrl}`);
    } else {
      try {
        const proto = await analyzePrototypeUrl(prototypeUrl);
        if (proto.error) console.warn(`⚠️  Prototype: ${proto.error}`);
        if (proto.summary) {
          prototypeContext = proto.summary;
          const visionNote = proto.stats?.visionScreens
            ? `, vision: ${proto.stats.visionScreens} screen(s) via ${proto.stats.visionModel}`
            : ", vision: skipped";
          console.log(
            `🧭 Prototype analyzed: ${proto.stats?.screens || 0} screen(s) crawled${proto.stats?.truncated ? " (page budget reached)" : ""}${visionNote}.`,
          );
        }
      } catch (err) {
        console.warn(`⚠️  Prototype crawl crashed (continuing without it): ${err.message}`);
      }
    }
  }
  // Images / PDFs attached on the Update page, read once here; Regenerate reuses the text from the
  // review session. Same contract as Figma and the prototype: a bad file costs a warning only.
  let attachmentsContext = "";
  const attachmentPaths = attachmentPathsFromEnv();
  if (attachmentPaths.length) {
    try {
      const att = await analyzeAttachments(attachmentPaths, { issueKey: issueData.key, usageTally: runUsage });
      if (att.error) console.warn(`⚠️  Attachments: ${att.error}`);
      if (att.summary) {
        attachmentsContext = att.summary;
        const st = att.stats || {};
        console.log(
          `📎 Attachments analyzed: ${st.analyzed || 0} of ${st.files || 0} file(s) (${st.images || 0} image(s), ${st.pdfs || 0} PDF(s)) via ${st.model}.`,
        );
      }
    } catch (err) {
      console.warn(`⚠️  Attachment analysis crashed (continuing without it): ${err.message}`);
    }
  }
  // Comments under the analysed story (on by default; ENABLE_ISSUE_COMMENTS=false turns it off).
  // Not on submit: that stage only writes the reviewed rows, it builds no prompt.
  let commentsContext = "";
  try {
    if (PIPELINE_STAGE !== "submit") {
      commentsContext = (await loadIssueComments(jiraClient, issueData.key || contextIssueKey)).text || "";
    }
  } catch (err) {
    console.warn(`⚠️  Reading issue comments crashed (continuing without them): ${err.message}`);
  }
  // Confluence (Setup → "Search Confluence"): the Update page's "Confluence link" field
  // (CONFLUENCE_LINKS) and the links in the story's description. Read once; Regenerate reuses it.
  let confluenceContext = "";
  if (PIPELINE_STAGE !== "submit" && process.env.ENABLE_CONFLUENCE_SEARCH === "true") {
    try {
      const { links: fieldLinks } = parseConfluenceLinks(process.env.CONFLUENCE_LINKS || "");
      if (fieldLinks.length) console.log(`🔗 Confluence link(s) from the Update page: ${fieldLinks.length}`);
      const found = await collectConfluencePages({
        issueData,
        extraLinks: fieldLinks,
        baseUrl: process.env.CONFLUENCE_BASE_URL || JIRA_BASE_URL,
        email: JIRA_EMAIL,
        token: JIRA_API_TOKEN,
      });
      confluenceContext = confluencePagesToText(found.pages);
      if (found.pages.length) {
        console.log(`📄 Read ${found.pages.length} Confluence document(s): ${found.pages.map((p) => p.title || "(untitled)").join("; ")}`);
      } else if (found.tried) {
        console.log("📄 No Confluence documents could be read from the links.");
      }
    } catch (err) {
      console.warn(`⚠️  Reading Confluence crashed (continuing without it): ${err.message}`);
    }
  }
  // The Helping Prompt (and the TMS cases it names) goes into every block's prompt; submit needs neither.
  const helping = PIPELINE_STAGE === "submit" ? { text: "", files: [] } : await resolveHelpingPromptContext();
  helpingContextFiles = helping.files;
  const designContext = { figmaContext, prototypeContext, attachmentsContext, commentsContext, confluenceContext, helpingPrompt: helping.text };

  const csvPath = readInputCsvFile();
  console.log(`📂 Input CSV: ${csvPath}`);
  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvRows(csvText);

  let mode = UPDATED_FLOW_MODE;
  if (!["auto", "testcases", "checklist"].includes(mode)) mode = "auto";
  const { blocks, tcCount, clCount } = collectUpdateBlocks(rows, mode);
  const summary = buildUpdatedFlowSummary(mode, tcCount, clCount, path.basename(csvPath));

  // PIPELINE_STAGE=submit turns what the reviewer approved in the panel into the CSV and attaches
  // it. One file for the whole update: the blocks are sections inside it, in CSV order.
  if (PIPELINE_STAGE === "submit") {
    const envelope = readPipelineIo();
    const edited = envelope.blocks || [];
    if (!edited.length) throw new Error("Nothing to submit: the reviewed block list is empty");

    const { sections, approvedCount, reviewedCount, skipped } = approvedSectionsFromBlocks(edited);
    if (!sections.length) {
      throw new Error(
        `Nothing to submit: none of the ${reviewedCount} reviewed row(s) are marked APPROVED`
      );
    }
    if (skipped) {
      console.log(`ℹ️  ${skipped} block(s) with nothing approved — left out of the CSV`);
    }

    const sourceKey = extractIssueKeyFromSources(issueData.key, issueData.summary, contextIssueKey);
    const outPath = path.join(
      CHECKLIST_OUTPUT_DIR,
      buildUpdatedOutputNameFromParent(issueData.summary, sourceKey, issueData.key || contextIssueKey)
    );
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedUpdatedDesignCsv(issueData, sections, outPath);
    console.log(
      `📄 Approved CSV: ${outPath} (${approvedCount} of ${reviewedCount} row(s), ${sections.length} block(s))`
    );

    const host = envelope.testDesignKey || testDesignKey;
    await attachApprovedCsv(jiraClient, host, outPath, "Approved updated test design (CSV)");
    console.log(`✅ Reviewed update attached to ${host}`);
    writePipelineIo({
      ok: true,
      mode: "update",
      targetKey: host,
      submittedCount: approvedCount,
      reviewedCount,
      csvPath: outPath,
    });
    return;
  }

  // Understand the area once, before the first block: the ticket's context plus the picked test
  // management cases, with the titles of the cases about to be updated as a hint of what matters.
  const studied = await areaBriefLib.generateAreaBrief(
    {
      issueKey: issueData.key,
      issueDescription: issueData.description,
      issueLabels: issueData.labels || [],
      ticket: issueData.ticket || { summary: issueData.summary || "" },
      existingTests: loadAdoPickedContext(),
      confluenceContext,
      figmaContext,
      prototypeContext,
      attachmentsContext,
      commentsContext,
      helpingPrompt: helping.text,
      csvOutline: blocks.map(blockOutlineTitle).filter(Boolean),
    },
    { callLLM, guard: guardLlmResult }
  );
  areaBrief = { text: studied.text, edited: false };

  // Each block is its own LLM call and sees only its own rows, so it is told what else the file
  // holds and what the blocks before it already added for this ticket — otherwise one new
  // behaviour comes back as a new case from every block that finds it relevant. The outline is
  // kept on the block, so a Regenerate of that block gets the same picture.
  // Two passes when the file has more than one case and the run ends in the review panel: plan the
  // whole file first (update-plan.js), then touch only what the plan names. A one-case file has
  // nothing to plan across, and the CLI "full" stage keeps posting block by block as it always did.
  const plan =
    PIPELINE_STAGE === "generate" && updatePlan.planEnabled() && blocks.length > 1
      ? await planUpdate(issueData, blocks, designContext)
      : null;
  let planSummary = null;

  let generated = [];
  const addedSoFar = [];
  let unchangedBlocks = 0;
  if (plan) {
    generated = await executePlannedUpdate(issueData, blocks, plan, designContext, testDesignKey);
    planSummary = updatePlan.summarizePlan(plan, generated);
    const rowsOf = (b) => (b.type === "testcase" ? b.payload.testCases || [] : b.payload.checklistItems || []);
    const existing = generated.filter((b) => !b.isNew);
    const updated = existing.filter((b) => rowsOf(b).some((r) => r.changeType !== "unchanged") || (b.payload.removed || []).length).length;
    const added = generated.filter((b) => b.isNew).reduce((n, b) => n + rowsOf(b).length, 0);
    const by = (s) => planSummary.changes.filter((c) => c.status === s);
    console.log(
      `🧾 Update result: ${updated} of ${existing.length} case(s) updated, ${existing.length - updated} unchanged, ${added} new. ` +
        `Ticket changes: ${by("covered").length} covered${by("skipped").length ? `, ${by("skipped").length} skipped` : ""}${
          by("uncovered").length ? `, ${by("uncovered").length} NOT covered` : ""
        }.`
    );
    for (const c of by("uncovered")) console.log(`⚠️  Not covered by any case: ${c.id} ${c.text}`);
  }
  for (const block of plan ? [] : blocks) {
    block.outline = {
      otherTitles: blocks.filter((b) => b !== block).map(blockOutlineTitle).filter(Boolean),
      alreadyAdded: [...addedSoFar],
    };
    const payload = await generateUpdatedBlock(issueData, block, designContext, testDesignKey);
    addedSoFar.push(...addedTitlesOf(block, payload));
    const rows = block.type === "testcase" ? payload.testCases || [] : payload.checklistItems || [];
    if (rows.length && rows.every((r) => r.changeType === "unchanged") && !(payload.removed || []).length) unchangedBlocks += 1;
    generated.push({ ...block, payload });
  }
  if (!plan && blocks.length > 1) {
    console.log(
      `🧾 Update result: ${blocks.length - unchangedBlocks} of ${blocks.length} block(s) changed, ${unchangedBlocks} left as they were, ${addedSoFar.length} new ${addedSoFar.length === 1 ? "entry" : "entries"} added.`
    );
  }

  if (PIPELINE_STAGE === "generate") {
    writePipelineIo({
      flow: "update",
      issueKey,
      contextIssueKey,
      testDesignKey,
      issueSummary: issueData.summary || "",
      csvFile: path.basename(csvPath),
      mode,
      summary,
      // The file plan's outcome — what the ticket changes and where each change landed; null when
      // the run had no plan (one case, UPDATE_PLAN=off, or planning failed).
      plan: planSummary,
      usage: { ...runUsage },
      // Regeneration reuses this instead of re-reading the CSV, re-analysing Figma and
      // re-crawling the prototype — the expensive half of the run happens exactly once.
      promptContext: {
        issueData: {
          key: issueData.key,
          summary: issueData.summary,
          description: issueData.description,
          labels: issueData.labels || [],
          ticket: issueData.ticket || null,
        },
        figmaContext,
        prototypeContext,
        attachmentsContext,
        commentsContext,
        confluenceContext,
        helpingPrompt: helping.text,
        helpingPromptTestCases: helping.files,
        // Shown in the review panel; an edit there comes back with areaBriefEdited.
        areaBrief: areaBrief.text,
      },
      blocks: generated,
    });
    const total = generated.length;
    console.log(
      `📝 Generated ${total} block(s) for review — nothing posted to ${testDesignKey} yet.`
    );
    return;
  }

  for (const block of generated) {
    await postUpdatedBlock(jiraClient, testDesignKey, block, block.payload);
  }
  await jiraClient.addComment(testDesignKey, summary);
  console.log(
    `✅ Updated CSV (${mode}): ${tcCount} test case block(s), ${clCount} checklist block(s) → ${testDesignKey}`
  );
}

// The regenerate stage works purely off the stored review session — no Jira issue needed.
const entryPoint = PIPELINE_STAGE === "regenerate" ? runUpdateRegenerateStage : run;

entryPoint()
  .then(() => logUsage(runUsage))
  .catch((err) => {
    // Report the spend even on failure — the tokens burnt before the error are still billed.
    logUsage(runUsage);
    console.error("❌ Error:", err.message);
    process.exit(1);
  });

