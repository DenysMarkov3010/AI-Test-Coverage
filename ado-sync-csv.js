/**
 * Parse Azure DevOps-style approved CSV and create Test Case work items in Azure DevOps.
 * Used after Jira approval CSV is generated (checklist or test cases format — same columns).
 */
const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

const { AdoClient } = require("./ado-client");
const { JiraClient, contextIssueKeyFor } = require("./jira-client");
const { callOpenRouter } = require("./llm-client");
const { createUsageTally, logUsage } = require("./llm-usage");
const bddFormat = require("./web/bdd-format.js");

const COL = {
  ID: 0,
  TYPE: 1,
  TITLE: 2,
  STEP: 3,
  ACTION: 4,
  EXPECTED: 5,
  PRIORITY: 6,
  AREA: 7,
  ASSIGNED: 8,
  STATE: 9,
};

/** Minimal CSV parser (RFC4180-style quoted fields). */
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

/**
 * @param {string[][]} rows
 * @returns {Array<{ refId: string, title: string, priority: string, areaPath: string, steps: { stepNumber: number, action: string, expected: string }[] }>}
 */
function csvRowsToTestCases(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((c) => (c || "").trim().toLowerCase());
  if (!header.includes("title") || !header.includes("test step")) {
    throw new Error("CSV does not look like the test-case format (expected Title, Test Step columns)");
  }
  const cases = [];
  /** @type {{ refId: string, title: string, priority: string, areaPath: string, steps: object[] } | null} */
  let current = null;
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    while (line.length < 10) line.push("");
    const title = (line[COL.TITLE] || "").trim();
    const wit = (line[COL.TYPE] || "").trim();
    if (title && wit.toLowerCase() === "test case") {
      current = {
        refId: (line[COL.ID] || "").trim(),
        title,
        priority: (line[COL.PRIORITY] || "2").trim() || "2",
        areaPath: (line[COL.AREA] || "").trim(),
        steps: [],
      };
      cases.push(current);
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
  return cases.filter((c) => c.steps.length > 0 || c.title);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Legacy: BDD was previously appended as a synthetic CSV step with this prefix
 * (when ADO sync auto-built System.Description). That logic is removed — BDD is now
 * generated separately from approved test cases / checklists via the LLM prompt
 * documented in TEST_CASE_FORMAT.md → "Prompt: BDD / Gherkin for Azure DevOps Summary".
 * This filter stays as a defensive cleanup so any old CSVs that still contain such
 * synthetic rows do not produce junk Test Case steps in Azure DevOps.
 */
const LEGACY_BDD_CSV_STEP_PREFIX = "__BDD_HTML__";

function partitionManualStepsForSync(steps) {
  return (steps || []).filter((s) => !String(s.action || "").startsWith(LEGACY_BDD_CSV_STEP_PREFIX));
}

// ---------------------------------------------------------------------------
// BDD / Gherkin generation for ADO Test Case System.Description (Summary tab)
// ---------------------------------------------------------------------------
// Calls OpenRouter with the prompt documented in TEST_CASE_FORMAT.md →
// "Prompt: BDD / Gherkin for Azure DevOps Summary". One LLM call PER imported
// Test Case, producing one focused Scenario in that work item's Description.
// Failure of BDD generation is non-fatal: the imported Test Case is preserved
// and the user gets a console warning.

function adoSyncBddFromPromptEnabled() {
  // The test design IS Gherkin when the BDD toggle was used, so a generated Description would be
  // a second, differently-worded copy of the work item's own steps — paid for with one LLM call
  // per case. The per-case content check further down catches this too, but only by recognising
  // the steps; this reads the choice the QA engineer actually made, so a scenario the sniffer
  // fails to parse still cannot trigger a Summary.
  if (String(process.env.TEST_DESIGN_FORMAT || "").toLowerCase().trim() === "bdd") return false;
  const v = String(process.env.ADO_SYNC_BDD_FROM_PROMPT ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Cap on the Scenarios in a checklist work item's Summary. A checklist Summary is a curated Feature,
 * not a Scenario per item, so the BDD prompt's own default of "at most 10, prefer fewer" fits.
 */
const CHECKLIST_SUMMARY_MAX_SCENARIOS = Math.max(
  1,
  parseInt(process.env.ADO_BDD_CHECKLIST_MAX_SCENARIOS || "10", 10) || 10
);

let cachedBddPromptText = null;

/**
 * Read the BDD prompt body (the inner ```text block) from TEST_CASE_FORMAT.md.
 * Result is cached for the lifetime of the process.
 */
function loadBddPromptText() {
  if (cachedBddPromptText !== null) return cachedBddPromptText;
  const file = path.join(__dirname, "TEST_CASE_FORMAT.md");
  try {
    if (!fs.existsSync(file)) {
      cachedBddPromptText = "";
      return cachedBddPromptText;
    }
    const md = fs.readFileSync(file, "utf8");
    const sectionMarker = "## Prompt: BDD / Gherkin for Azure DevOps Summary";
    const sectionStart = md.indexOf(sectionMarker);
    if (sectionStart < 0) {
      cachedBddPromptText = "";
      return cachedBddPromptText;
    }
    const section = md.slice(sectionStart);
    const fenceStart = section.indexOf("```text");
    if (fenceStart < 0) {
      cachedBddPromptText = "";
      return cachedBddPromptText;
    }
    const after = section.slice(fenceStart + "```text".length);
    const fenceEnd = after.indexOf("\n```");
    if (fenceEnd < 0) {
      cachedBddPromptText = "";
      return cachedBddPromptText;
    }
    cachedBddPromptText = after.slice(0, fenceEnd).trim();
    return cachedBddPromptText;
  } catch (e) {
    console.warn(`   BDD: could not load prompt from TEST_CASE_FORMAT.md — ${e.message}`);
    cachedBddPromptText = "";
    return cachedBddPromptText;
  }
}

/**
 * Decide BDD mode for one ADO Test Case based on its CSV step rows:
 * if no Step Expected has content → checklist-style (logical phrasing in prompt);
 * else test_case-style (UI-anchored phrasing).
 * @param {{ steps: Array<{ stepNumber: number, action: string, expected: string }> }} tc
 */
function detectBddModeForTestCase(tc) {
  const steps = (tc?.steps || []).filter((s) => Number(s.stepNumber) >= 2);
  if (!steps.length) return "test_case";
  const withExpected = steps.filter((s) => String(s.expected || "").trim().length > 0).length;
  return withExpected === 0 ? "checklist" : "test_case";
}

/**
 * Render one parsed test case as the input artifact text expected by the BDD prompt.
 * @param {{ title: string, priority?: string, areaPath?: string, steps: Array<{ stepNumber: number, action: string, expected: string }> }} tc
 */
function formatTestCaseAsBddArtifact(tc) {
  const lines = [];
  lines.push(`Title: ${String(tc.title || "").trim()}`);
  if (tc.priority) lines.push(`Priority: ${tc.priority}`);
  if (tc.areaPath) lines.push(`Area Path: ${tc.areaPath}`);
  lines.push("");
  lines.push("Steps:");
  const sorted = [...(tc.steps || [])].sort(
    (a, b) => (a.stepNumber || 0) - (b.stepNumber || 0)
  );
  for (const s of sorted) {
    const action = String(s.action || "").trim();
    const expected = String(s.expected || "").trim();
    lines.push(`Step ${s.stepNumber}:`);
    lines.push(`  Action: ${action || "(empty)"}`);
    lines.push(`  Expected: ${expected || "(empty)"}`);
  }
  return lines.join("\n");
}

/**
 * Render the parent Jira requirement as the input artifact text used for BDD generation
 * when the Test Case being synced was produced from a checklist (mode = "checklist").
 *
 * Rationale: checklist items are intent-level, terse phrases. Asking the LLM to
 * "curate and merge them into Scenarios" produces shallow, repetitive BDD. Feeding the
 * original parent requirement (the Jira story / feature) gives the model the full
 * business context to write a meaningful curated Feature.
 *
 * @param {{ key?: string, summary?: string, description?: string, labels?: string[] }} parent
 */
function formatParentRequirementAsBddArtifact(parent) {
  const lines = [];
  const key = String(parent?.key || "").trim();
  const summary = String(parent?.summary || "").trim();
  const description = String(parent?.description || "").trim();
  const labels = Array.isArray(parent?.labels) ? parent.labels.filter(Boolean) : [];

  lines.push("Source: parent Jira requirement");
  if (key) lines.push(`Parent key: ${key}`);
  if (summary) lines.push(`Summary: ${summary}`);
  if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
  lines.push("");
  lines.push("Description:");
  lines.push(description || "(no description on parent)");
  return lines.join("\n");
}

/**
 * Compose the full LLM prompt: the prompt body + a single test case as artifact + meta.
 * @param {object} args
 * @param {string} args.promptBody
 * @param {"test_case" | "checklist"} args.mode
 * @param {object} args.tc
 * @param {string} [args.jiraKey]
 * @param {{ key?: string, summary?: string, description?: string, labels?: string[] } | null} [args.parentRequirement]
 *   When provided AND mode === "checklist", the artifact fed to the prompt is built from this
 *   parent requirement instead of from the checklist test case rows. Ignored for "test_case" mode.
 */
function buildLlmPromptForTestCaseBdd({ promptBody, mode, tc, jiraKey, parentRequirement }) {
  const useParentArtifact = mode === "checklist" && parentRequirement;
  const artifact = useParentArtifact
    ? formatParentRequirementAsBddArtifact(parentRequirement)
    : formatTestCaseAsBddArtifact(tc);

  const metaLines = [];
  if (jiraKey) metaLines.push(`jira_key: ${jiraKey}`);
  if (tc.areaPath) metaLines.push(`area_path: ${tc.areaPath}`);
  if (useParentArtifact && parentRequirement?.key) {
    metaLines.push(`parent_jira_key: ${parentRequirement.key}`);
  }
  const meta = metaLines.length ? metaLines.join("\n") : "(none)";

  const overrideLines = [
    "ADO-SUMMARY OVERRIDE (this invocation only):",
    "- Do PHASE 1 and PHASE 2 silently, internally — DO NOT include them in the response.",
    "- Output ONLY the PHASE 3 artifact: a single Gherkin Feature block.",
    "- Your response MUST start with the literal token `Feature:` on the very first line.",
    "- No markdown headings (no `#`, no `##`). No prose. No markdown fences. No JSON.",
  ];

  if (useParentArtifact) {
    overrideLines.push(
      "- Source override for checklist mode: the artifact above is the PARENT Jira requirement (summary + description), NOT a list of checklist items. Treat it as the single source of truth for what to cover.",
      "- Produce a CURATED Feature with several grouped Scenarios that cover the requirement (happy path + key negative / boundary / integration cases that the requirement implies). Do not invent rules outside the requirement.",
      "- Skip the `# Coverage map` comment block — there are no item indices to map to.",
      "- Do not echo or quote the checklist test case title / steps; they are not the source for this run."
    );
  }

  return [
    promptBody,
    "",
    "---",
    "",
    "INPUT (the artifact to convert):",
    `mode: ${mode}`,
    `meta:\n${meta}`,
    "",
    "artifact:",
    artifact,
    "",
    ...overrideLines,
  ].join("\n");
}

/**
 * BDD token spend. This file runs two ways: standalone from the CLI, and required in-process by
 * agent-docs.js during the approval run. So it keeps its own tally, logs it when run standalone,
 * and returns it so the caller can fold it into the run total — until now these tokens were
 * simply missing from the "Tokens used this run" line.
 */
const bddUsage = createUsageTally();

const ADO_BDD_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Call OpenRouter once with the assembled prompt; one retry on retryable error.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callOpenRouterForBdd(prompt) {
  // 2000 was too tight: in checklist mode the artifact is the whole parent requirement and the
  // model is asked for a curated multi-scenario Feature. When it also emitted the PHASE 1/PHASE 2
  // preamble (which the prompt forbids, but models do it anyway) the answer was cut off before
  // `Feature:` was ever written, and the caller reported "no Feature block" for what was really a
  // truncation.
  const maxTokens = parseInt(process.env.ADO_SYNC_BDD_MAX_TOKENS || "4000", 10);
  return callOpenRouter(prompt, {
    maxTokens,
    usageTally: bddUsage,
    // One BDD call per test case inside a longer sync; the surrounding log is already indented
    // and noisy, so tick without the per-call "asking / responded" pair.
    heartbeatLabel: "the model (BDD)",
    announce: false,
    trimResult: true,
    retryableStatus: ADO_BDD_RETRYABLE_STATUS,
    truncationErrorName: "BddTruncatedError",
    labels: {
      httpError: "OpenRouter error",
      noChoices: "OpenRouter returned no choices",
      unknownFailure: "OpenRouter call failed",
      truncationRemedy: "Raise ADO_SYNC_BDD_MAX_TOKENS.",
    },
    hooks: {
      onModelSwitch: (model, reason) =>
        console.warn(`   ADO BDD: model "${model}" failed; trying next model — ${reason}`),
    },
  });
}

/**
 * Clean up the model output: drop any markdown fences and any preamble the LLM
 * may have emitted (Phase 1 "Detected mode and inputs", Phase 2 "Scenario plan",
 * etc.) so that the result starts at the first `Feature:` line. Also drops any
 * trailing markdown sections that some models append after the Feature block.
 */
function extractGherkinFromLlmResponse(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:gherkin|cucumber|text)?\s*\n/i, "").replace(/\n```\s*$/i, "");
  // Models decorate the keyword even when told not to: leading indentation, `**Feature:**`,
  // `## Feature:`. Find the line however it is dressed, then strip the decoration so the
  // `^Feature:` check downstream — and Gherkin itself — sees a clean keyword.
  const featureLine = s.search(/^[ \t>]*(?:#{1,6}\s*)?\**\s*Feature:/m);
  if (featureLine > 0) {
    s = s.slice(featureLine);
  }
  // `[ \t]*` rather than `\s*` on the tail: `\s` would swallow the newline after a bare
  // "Feature:" line, and the rebuilt keyword keeps exactly one space so the result stays
  // valid Gherkin.
  s = s.replace(/^[ \t>]*(?:#{1,6}[ \t]*)?\**[ \t]*Feature:[ \t]*\**[ \t]*/m, "Feature: ");
  // Drop a trailing markdown section if one slipped through (e.g. "# Self-check ...").
  const trailingHeading = s.search(/\n#{1,6}\s+\w/);
  if (trailingHeading > 0) {
    s = s.slice(0, trailingHeading);
  }
  return s.trim();
}

/**
 * Wrap plain Gherkin text into ADO HTML (Description renders <pre>).
 * Prepends one empty line (`<p><br/></p>`) so the BDD block does not stick to the
 * top of the Summary tab > Description field.
 */
function wrapGherkinAsAdoDescription(gherkin) {
  const escaped = upperCaseGherkinKeywords(gherkin)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div><p><br/></p><pre>${escaped}</pre></div>`;
}

/**
 * Build a Jira client from env vars used elsewhere in the project. Returns null when any
 * of the credentials is missing (the caller falls back to the test-case-based BDD artifact).
 */
function buildJiraClientForBddFromEnv() {
  const baseUrl = process.env.JIRA_BASE_URL || process.env.BASE_URL;
  const email = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) return null;
  try {
    return new JiraClient(baseUrl, email, token);
  } catch {
    return null;
  }
}

/**
 * Build a memoized loader that fetches the parent Jira requirement once per sync run.
 *
 * For BDD generation on checklist-mode Test Cases, the BDD prompt is fed the requirement: the
 * parent story when `jiraKey` is a "Test design" sub-task, and the issue itself otherwise.
 * `jiraKey` comes from the CSV file name, which normally already holds the story — climbing off
 * it regardless would feed the prompt that story's Epic. contextIssueKeyFor() draws that line.
 *
 * The loader returns null (and logs once) when Jira creds are missing or the fetch fails —
 * callers then fall back to the checklist-rows artifact, preserving the old behavior.
 *
 * @param {string} jiraKey - QA subtask Jira key (e.g. "PROJ-17132").
 * @returns {() => Promise<{ key: string, summary: string, description: string, labels: string[] } | null>}
 */
function createParentRequirementLoader(jiraKey) {
  let cached = null;
  let attempted = false;
  let warned = false;

  return async function loadOnce() {
    if (cached) return cached;
    if (attempted) return null;
    attempted = true;

    if (!jiraKey) {
      if (!warned) {
        console.warn(
          "   ADO BDD: no Jira key passed to sync — checklist BDD will fall back to test case rows"
        );
        warned = true;
      }
      return null;
    }

    const client = buildJiraClientForBddFromEnv();
    if (!client) {
      if (!warned) {
        console.warn(
          "   ADO BDD: JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN missing — checklist BDD will fall back to test case rows"
        );
        warned = true;
      }
      return null;
    }

    try {
      const child = await client.getIssueWithExpand(jiraKey);
      const contextKey = contextIssueKeyFor(child, jiraKey);
      const parentKey = contextKey !== jiraKey ? contextKey : null;
      const sourceIssue = parentKey ? await client.getIssueWithExpand(parentKey) : child;
      const data = client.extractIssueData(sourceIssue);
      cached = {
        key: data.key || (parentKey || jiraKey),
        summary: data.summary || "",
        description: data.description || "",
        labels: Array.isArray(data.labels) ? data.labels : [],
      };
      console.log(
        parentKey
          ? `   ADO BDD: checklist BDD will be generated from parent ${cached.key} (parent of ${jiraKey})`
          : `   ADO BDD: ${jiraKey} is the requirement itself — using it for checklist BDD`
      );
      return cached;
    } catch (e) {
      if (!warned) {
        console.warn(
          `   ADO BDD: could not fetch parent requirement for ${jiraKey} — ${e.message}. Falling back to test case rows.`
        );
        warned = true;
      }
      return null;
    }
  };
}

/**
 * End-to-end BDD generation for one parsed Test Case. Returns the HTML to put
 * into /fields/System.Description; throws when the model answered with
 * something other than a Feature block, which the caller treats as non-fatal.
 * @param {object} args
 * @param {object} args.tc
 * @param {string} [args.jiraKey]
 * @param {string} args.promptBody
 * @param {{ key?: string, summary?: string, description?: string, labels?: string[] } | null} [args.parentRequirement]
 *   When provided and the test case is detected as checklist mode, the BDD input
 *   artifact is built from the parent Jira requirement instead of the checklist rows.
 */
/**
 * Gherkin for System.Description, written by the SAME prompt the BDD toggle uses.
 *
 * The older path below converts the finished test case into Gherkin line by line, which is
 * faithful but verbose — a 15-step case became a 62-line Scenario, nothing like the compact
 * design the toggle produces from the ticket. When the caller can hand over the generation
 * context that was actually reviewed (the "Cover a bug" import does), the Description is designed
 * from the ticket with `generateBddTestCasesPrompt`, so picking Standard gives you the standard
 * steps PLUS exactly the Feature that picking BDD would have produced.
 *
 * A checklist is the exception to one-Scenario-per-work-item: it is imported as ONE work item
 * whose steps are the whole checklist, so its Description is the whole ticket's Feature — several
 * Scenarios, the way the checklist path always wrote it — rather than one Scenario named after
 * the ticket (`wholeTicket`).
 *
 * @param {object} promptContext the `promptContext` of the review envelope
 * @param {string} [focusTitle] the behaviour this work item covers (test cases only)
 * @param {{ wholeTicket?: boolean }} [options]
 * @returns {Promise<string>} `<pre>`-wrapped Feature block for System.Description
 */
async function generateBddDescriptionFromDesignContext(promptContext, focusTitle = "", options = {}) {
  const { generateBddTestCasesPrompt } = require("./prompts-docs.js");
  const prompt = options.wholeTicket
    ? generateBddTestCasesPrompt({
        ...promptContext,
        testCasesLimit: CHECKLIST_SUMMARY_MAX_SCENARIOS,
        userGuidance:
          "This Feature is the Summary of ONE Azure DevOps work item that holds the whole approved checklist for the ticket. " +
          "Design a curated Feature with several grouped Scenarios that together cover the ticket: the happy path plus the key negative, boundary and integration cases it implies. " +
          "Do not invent rules outside the ticket." +
          (promptContext.userGuidance ? `\n${promptContext.userGuidance}` : ""),
      })
    : // One Scenario per work item: the Description belongs to one Test Case, so the prompt is
      // pinned to a single scenario and — when the import carries several cases — told which
      // behaviour of the ticket this particular work item covers. That keeps the 1:1 mapping the
      // old per-case conversion had, while the wording and depth come from the BDD toggle's own prompt.
      generateBddTestCasesPrompt({
        ...promptContext,
        testCasesLimit: 1,
        userGuidance: String(focusTitle || "").trim()
          ? `The single Scenario must cover exactly this behaviour of the ticket, and nothing else: "${String(focusTitle).trim()}". Use the ticket for the domain detail, but do not widen the scope beyond that behaviour.`
          : promptContext.userGuidance || "",
      });
  const raw = await callOpenRouterForBdd(prompt);
  const cleaned = String(raw || "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`LLM did not return valid BDD JSON — ${e.message}`);
  }
  const cases = bddFormat.normalizeBddTestCases(parsed.testCases || []);
  if (!cases.length) throw new Error("LLM returned no scenarios for the Description");
  const gherkin = bddFormat.testCasesToFeatureText(parsed.feature, cases, parsed.featureDescription);
  return wrapGherkinAsAdoDescription(gherkin);
}

async function generateBddDescriptionHtmlForTestCase({ tc, jiraKey, promptBody, parentRequirement }) {
  const mode = detectBddModeForTestCase(tc);
  const prompt = buildLlmPromptForTestCaseBdd({
    promptBody,
    mode,
    tc,
    jiraKey,
    parentRequirement: mode === "checklist" ? parentRequirement || null : null,
  });
  const raw = await callOpenRouterForBdd(prompt);
  const gherkin = extractGherkinFromLlmResponse(raw);
  if (!gherkin || !/^Feature:/m.test(gherkin)) {
    // Quote the start of the reply: "no Feature block" alone gives the reader nothing to act on,
    // and the usual cause (a PHASE preamble the model was told to keep internal) is visible here.
    const preview = String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    throw new Error(
      `LLM response did not contain a Feature block${preview ? ` — reply started with: "${preview}…"` : " (empty reply)"}`
    );
  }
  return wrapGherkinAsAdoDescription(gherkin);
}

/**
 * One step cell as the HTML Azure DevOps actually renders.
 *
 * `isformatted="true"` means the cell is HTML, so a bare newline collapses into
 * a space in the steps grid. Two multi-line shapes reach here: the standard
 * format's bulleted expected result ("- a\n- b"), which becomes a real list, and
 * a BDD scenario's `Then … / And …` block, which becomes `<br/>`-separated lines
 * so each Gherkin keyword keeps the start of its own line.
 */
/**
 * HTML for one step cell (action or expected result).
 *
 * Returns real HTML — the caller is responsible for encoding it into the XML, see
 * buildTcmStepsXml(). Text is HTML-escaped here; quotes are left as-is because inside HTML text
 * a quote is just a character, and that is how Azure DevOps stores its own cells.
 */
function escapeCellText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Line breaks, nothing else.
 *
 * A "- " list used to be turned into <ul><li>, which looked tidier in isolation but made the
 * work item disagree with the draft the QA engineer approved: the browser indents <ul> (every
 * expected result gained a left margin) and swaps the literal "-" for its own bullet glyph.
 * The review panel shows the raw lines, so the work item shows the raw lines — what you approve
 * is what you get.
 */
/**
 * Upper-case the leading Gherkin keyword of every step line: `Given …` → `GIVEN …`.
 *
 * Azure DevOps only — the review panel, the CSV and the Jira comment keep the canonical
 * `Given`/`When`/`Then` casing that `web/bdd-format.js` parses, so nothing downstream has to
 * learn a second spelling. Applied per line and only when the line really is a Gherkin step, so
 * prose such as "Click Save and then verify" is left alone; the keyword is never uppercased
 * mid-sentence.
 */
function upperCaseGherkinKeywords(text) {
  return String(text == null ? "" : text)
    .split("\n")
    .map((line) => {
      const parsed = bddFormat.parseGherkinLine(line);
      if (!parsed || !parsed.keyword) return line;
      // Keep whatever indentation the line carried; only the keyword itself changes.
      const indent = (line.match(/^[ \t]*/) || [""])[0];
      return `${indent}${parsed.keyword.toUpperCase()}${parsed.text ? ` ${parsed.text}` : ""}`;
    })
    .join("\n");
}

function stepCellHtml(raw) {
  const lines = String(raw == null ? "" : raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return lines.map(escapeCellText).join("<br/>");
}

/**
 * Azure DevOps Test Case steps field (HTML/XML).
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} steps
 */
function buildTcmStepsXml(steps) {
  const sorted = [...steps].sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
  const last = sorted.length;
  const stepNodes = sorted.map((s, idx) => {
    const id = idx + 1;
    // The cell HTML is the TEXT CONTENT of <parameterizedString>, not markup inside it, so it is
    // XML-escaped on the way in. Azure DevOps stores its own steps exactly this way — read any
    // hand-written Test Case and the field holds `&lt;DIV&gt;&lt;P&gt;…`, never a raw <DIV>.
    // Emitting raw <ul>/<li>/<br/> turned them into child elements of <parameterizedString>,
    // so the formatting was lost (and multi-line expected results ran together) in the work item.
    const act = escapeXml(stepCellHtml(upperCaseGherkinKeywords(s.action)));
    const exp = escapeXml(stepCellHtml(upperCaseGherkinKeywords(s.expected || "")));
    return `<step id="${id}" type="ValidateStep"><parameterizedString isformatted="true">${act}</parameterizedString><parameterizedString isformatted="true">${exp}</parameterizedString><description/></step>`;
  });
  return `<steps id="0" last="${last}">${stepNodes.join("")}</steps>`;
}

function resolveAreaPath(rowArea) {
  const fromRow = (rowArea || "").trim();
  const prefix = (process.env.ADO_AREA_PATH_PREFIX || "").trim();
  if (prefix && fromRow) {
    if (fromRow.includes("\\")) return fromRow;
    // The generated CSV often carries the project root in its Area column, which is already
    // the prefix. Prepending it again produced "MyProject\\MyProject" and Azure DevOps
    // rejected the whole work item with TF401347 (invalid tree name).
    if (fromRow.toLowerCase() === prefix.toLowerCase()) return fromRow;
    if (fromRow.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) return fromRow;
    return `${prefix}\\${fromRow}`;
  }
  if (fromRow) return fromRow;
  // Setup's Default Area Path, then the project name — in Azure DevOps a project's root Area Path
  // *is* its name, so that is the one fallback correct in every organisation rather than in the
  // one this script was written against. Empty is fine too: the field is then left off the patch
  // entirely and Azure DevOps files the work item at that same root.
  return (process.env.ADO_DEFAULT_AREA_PATH || process.env.ADO_PROJECT || "").trim();
}

/**
 * TF401347 / WorkItemFieldInvalidTreeNameException — the Area Path does not exist
 * in this project. Worth one retry without the field: the test case is what
 * matters, and Azure DevOps then files it under the project root.
 */
function isInvalidAreaPathError(message) {
  const m = String(message || "");
  return /TF401347|WorkItemFieldInvalidTreeNameException/i.test(m) && /System\.AreaPath/i.test(m);
}

function getAdoClientFromEnv() {
  const org = process.env.ADO_ORG || process.env.AZURE_DEVOPS_ORG;
  const project = process.env.ADO_PROJECT || process.env.AZURE_DEVOPS_PROJECT;
  const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
  if (!org || !project || !pat) {
    throw new Error("Set ADO_ORG, ADO_PROJECT, ADO_PAT for Azure DevOps sync");
  }
  const baseUrl = process.env.ADO_SERVER_URL;
  return new AdoClient(org, project, pat, baseUrl ? { baseUrl } : {});
}

const WORK_ITEM_TYPE = process.env.ADO_TEST_CASE_WORK_ITEM_TYPE || "Test Case";

/**
 * Parse planId/suiteId from the Test Plan page address bar (e.g.
 * `.../_testPlans/define?planId=1234&suiteId=5678` or a full https URL).
 * Same values as ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID and the REST API.
 * @param {string} raw
 * @returns {{ planId: number, suiteId: number }} NaN for a parameter when missing
 */
function parsePlanSuiteFromAdoUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { planId: NaN, suiteId: NaN };
  let search = "";
  try {
    if (/^https?:\/\//i.test(s)) {
      search = new URL(s).search || "";
    } else if (s.includes("?")) {
      search = s.slice(s.indexOf("?"));
    } else if (/planId=/i.test(s)) {
      search = s.startsWith("?") ? s : `?${s}`;
    }
  } catch {
    search = "";
  }
  const q = search.startsWith("?") ? search : search ? `?${search}` : "";
  const params = new URLSearchParams(q || "?");
  const planId = parseInt(params.get("planId") || params.get("planid") || "", 10);
  const suiteId = parseInt(params.get("suiteId") || params.get("suiteid") || "", 10);
  return {
    planId: Number.isFinite(planId) && planId > 0 ? planId : NaN,
    suiteId: Number.isFinite(suiteId) && suiteId > 0 ? suiteId : NaN,
  };
}

/**
 * Precedence: CLI -p/-s → --ado-url → ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID → ADO_SYNC_TEST_PLAN_URL.
 * Numeric .env values match the browser query planId=…&suiteId=….
 */
function resolvePlanSuiteIds({ cliPlan, cliSuite, cliAdoUrl }) {
  const fromCliUrl = parsePlanSuiteFromAdoUrl(cliAdoUrl || "");
  const fromEnvUrl = parsePlanSuiteFromAdoUrl(process.env.ADO_SYNC_TEST_PLAN_URL || "");
  const envP = parseInt(process.env.ADO_SYNC_PLAN_ID || "", 10);
  const envS = parseInt(process.env.ADO_SYNC_SUITE_ID || "", 10);
  const basePlan = Number.isFinite(envP) && envP > 0 ? envP : fromEnvUrl.planId;
  const baseSuite = Number.isFinite(envS) && envS > 0 ? envS : fromEnvUrl.suiteId;

  const planId = Number.isFinite(cliPlan) && cliPlan > 0
    ? cliPlan
    : Number.isFinite(fromCliUrl.planId) && fromCliUrl.planId > 0
      ? fromCliUrl.planId
      : basePlan;
  const suiteId = Number.isFinite(cliSuite) && cliSuite > 0
    ? cliSuite
    : Number.isFinite(fromCliUrl.suiteId) && fromCliUrl.suiteId > 0
      ? fromCliUrl.suiteId
      : baseSuite;
  return { planId, suiteId };
}

/** Same as ado-plan-tools `envActiveTestPlanId`: active (feature) plan id from .env. */
function envActiveTestPlanIdNumber() {
  const raw = process.env.ADO_ACTIVE_TEST_PLAN_ID || process.env.ADO_TEST_PLAN_ID || "";
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Automate import (the approved CSV attached to the ticket): Test Plan id must come **only**
 * from `ADO_ACTIVE_TEST_PLAN_ID` (legacy: `ADO_TEST_PLAN_ID`). Ignores `ADO_SYNC_PLAN_ID` and plan id from URLs.
 * Suite: `ADO_SYNC_SUITE_ID`, or `suiteId` from `ADO_SYNC_TEST_PLAN_URL` / optional `cliAdoUrl` (suite only).
 */
function resolvePlanSuiteIdsApprovalRun({ cliSuite, cliAdoUrl }) {
  const planId = envActiveTestPlanIdNumber();
  const fromEnvUrl = parsePlanSuiteFromAdoUrl(process.env.ADO_SYNC_TEST_PLAN_URL || "");
  const fromCliUrl = parsePlanSuiteFromAdoUrl(cliAdoUrl || "");
  const envS = parseInt(process.env.ADO_SYNC_SUITE_ID || "", 10);
  const suiteId = Number.isFinite(cliSuite) && cliSuite > 0
    ? cliSuite
    : Number.isFinite(fromCliUrl.suiteId) && fromCliUrl.suiteId > 0
      ? fromCliUrl.suiteId
      : Number.isFinite(envS) && envS > 0
        ? envS
        : Number.isFinite(fromEnvUrl.suiteId) && fromEnvUrl.suiteId > 0
          ? fromEnvUrl.suiteId
          : NaN;
  return { planId, suiteId };
}

/**
 * Jira-style key from CSV basename, e.g. `approved-testcases-PROJ-123.csv` → `PROJ-123`.
 * @param {string} csvFilePath
 */
function extractJiraKeyFromCsvFilename(csvFilePath) {
  const base = path.basename(csvFilePath || "");
  // Not `\b` on the left: an underscore is a word character, so `\bPROJ-123` never matches in
  // "Maintenance_PROJ-123 …" — and a file named that way lost its key silently, taking the
  // container match, the tags and the issue link with it.
  const m = base.match(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/i);
  return m ? m[1].toUpperCase() : "";
}

/**
 * The story summary from the CSV basename, e.g. `Order address edit (PROJ-123).csv` → `Order
 * address edit`.
 *
 * The approval step writes the file as `"<story summary> (PROJ-123).csv"`, so the ticket's title is
 * already on disk and no importer needs a Jira round trip to name the container it creates. The
 * trailing `(KEY)` is what gets stripped; a file named after the key alone yields "".
 *
 * @param {string} csvFilePath
 * @param {string} [jiraKey] returned when the name carries nothing else
 */
function titleFromCsvFilename(csvFilePath, jiraKey) {
  const base = path.basename(String(csvFilePath || ""), path.extname(String(csvFilePath || "")));
  const key = String(jiraKey || "").trim();
  const SEP = "[\\s._-]";

  // Every trailing "(…)" group, not just the last one: the update flow writes
  // "<summary> (PROJ-123) (updated by AI).csv", so stripping one leaves the key in a pair of
  // parentheses for the next rule to empty out.
  let out = base.replace(/(\s*\([^()]*\)\s*)+$/, "").trim();

  // The key anywhere else, with the separators around it — a file dropped in by hand is as likely
  // to be "Maintenance_PROJ-123 Some title.csv", and a container called
  // "PROJ-123 Maintenance_PROJ-123 Some title" reads like a bug because it is one.
  if (key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not `\b`: an underscore is a word character, so `\bPROJ-123` never matches in
    // "Maintenance_PROJ-123". The guards are explicit about what may not touch the key instead,
    // and the trailing one is what keeps PROJ-123 from matching inside PROJ-1234.
    out = out.replace(new RegExp(`${SEP}*(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])${SEP}*`, "gi"), " ");
  }

  // What this project's own generated names lead with, once the key is gone.
  out = out.replace(/^approved[\s._-]*(test[\s._-]*cases?|checklist)[\s._-]*/i, "");

  out = out
    // Whatever the key left behind: "Title ( )" from a name that parenthesised it mid-string.
    .replace(/\(\s*\)/g, " ")
    .replace(new RegExp(`^${SEP}+|${SEP}+$`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || key;
}

/**
 * The name a container created for one ticket gets: `PROJ-123 Story summary`.
 *
 * Shared by the TestRail section and the Zephyr folder, because both are matched back by
 * pickSuiteForJiraKey() on the next run — it takes the key as a token anywhere in the name, so
 * what follows the key is free for humans. The key still leads, and the summary is capped: a
 * container header is read at a glance, not at length.
 */
function containerNameForJiraKey(jiraKey, title) {
  const summary = String(title || "").trim();
  if (!summary || summary === jiraKey) return jiraKey;
  return `${jiraKey} ${summary}`.slice(0, 200).trim();
}

function normalizeJiraIssueKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  const m = s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Jira key as a distinct token in path or suite title (avoids PROJ-1 inside PROJ-123; allows [PROJ-123], (PROJ-123)).
 * Combines path-segment boundaries with a general “non-alphanumeric before / no digit after” rule.
 */
function pathOrNameHasJiraKeyToken(path, name, kUpper) {
  const k = String(kUpper || "").trim().toUpperCase();
  if (!k) return false;
  const esc = escapeRegExp(k);
  const reSegment = new RegExp(`(^|[\\s/])${esc}([\\s/]|$)`, "i");
  const reToken = new RegExp(`(?<![A-Za-z0-9])${esc}(?!\\d)`, "i");
  const hit = (s) => reSegment.test(s) || reToken.test(s);
  if (hit(String(name || ""))) return true;
  return hit(String(path || ""));
}

/**
 * Pick the suite whose name or path contains the Jira key as a token (prefer exact suite name).
 * @param {Array<{ suiteId: number, suiteName: string, path: string }>} flat
 * @param {string} jiraKey e.g. PROJ-123
 */
function pickSuiteForJiraKey(flat, jiraKey) {
  const k = String(jiraKey || "").trim().toUpperCase();
  if (!k || !flat.length) return null;
  const titleOnly = process.env.ADO_SYNC_SUITE_MATCH_TITLE_ONLY === "true";
  const pool = titleOnly
    ? flat.filter((s) => pathOrNameHasJiraKeyToken("", s.suiteName, k))
    : flat;
  if (titleOnly && pool.length === 0) {
    return null;
  }
  const list = titleOnly ? pool : flat;
  const suffix = ` / ${k}`;
  /** @type {{ suite: (typeof flat)[0], score: number } | null} */
  let best = null;
  for (const s of list) {
    const nameU = (s.suiteName || "").toUpperCase();
    const pathU = (s.path || "").toUpperCase();
    if (!pathOrNameHasJiraKeyToken(titleOnly ? "" : s.path, s.suiteName, k)) continue;
    let score = 0;
    if (nameU === k) score = 100;
    else if (pathU.endsWith(suffix)) score = 95;
    else if (pathOrNameHasJiraKeyToken("", s.suiteName, k)) score = 70;
    else score = 40;
    if (
      !best ||
      score > best.score ||
      (score === best.score && s.path.length < best.suite.path.length)
    ) {
      best = { suite: s, score };
    }
  }
  return best ? best.suite : null;
}

/**
 * Automatic sync: load suites under `ADO_ACTIVE_TEST_PLAN_ID`, match key from filename (or issue key).
 * Logs one line: matched suite or `Not found`. Set `ADO_SYNC_SUITE_LIST_VERBOSE=true` to print many suite lines.
 * @param {object} client - AdoClient with listFlatSuitesInPlan
 * @param {number} planId
 * @param {string} csvFilePath
 * @param {string} jiraIssueKey
 * @param {number} fallbackSuiteId
 * @returns {Promise<number>}
 */
async function resolveSuiteIdForApprovalByCsvKey(client, planId, csvFilePath, jiraIssueKey, fallbackSuiteId) {
  if (process.env.ADO_SYNC_SUITE_MATCH_CSV_KEY === "false") {
    return fallbackSuiteId;
  }
  const keyForSuite =
    extractJiraKeyFromCsvFilename(csvFilePath) || normalizeJiraIssueKey(jiraIssueKey);
  if (!keyForSuite) {
    console.warn(
      "   ⚠️  ADO sync: no Jira key in CSV filename (e.g. approved-testcases-PROJ-123.csv) and no issue key — using ADO_SYNC_SUITE_ID / URL only"
    );
    return fallbackSuiteId;
  }

  try {
    const t0 = Date.now();
    const flat = await client.listFlatSuitesInPlan(planId);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const titleOnly = process.env.ADO_SYNC_SUITE_MATCH_TITLE_ONLY === "true";
    const verbose = process.env.ADO_SYNC_SUITE_LIST_VERBOSE === "true";

    if (verbose) {
      const maxLog = parseInt(process.env.ADO_SYNC_SUITE_LIST_MAX || "50", 10) || 50;
      console.log(
        `   Azure DevOps: ${flat.length} suite(s) in ${elapsed}s — "${keyForSuite}" (${titleOnly ? "title only" : "name/path"}), listing up to ${maxLog}:`
      );
      const show = flat.slice(0, maxLog);
      for (const s of show) {
        console.log(`      ${s.suiteId}\t${s.path}`);
      }
      if (flat.length > show.length) {
        console.log(`      … and ${flat.length - show.length} more (raise ADO_SYNC_SUITE_LIST_MAX)`);
      }
    }

    const picked = pickSuiteForJiraKey(flat, keyForSuite);
    if (picked) {
      console.log(
        `   Azure DevOps: "${keyForSuite}" → suite ${picked.suiteId} — ${picked.path}`
      );
      return picked.suiteId;
    }
    console.log(`   Azure DevOps: "${keyForSuite}" → Not found (${flat.length} suites, ${elapsed}s)`);
    console.warn(
      titleOnly
        ? `   ⚠️  No suite in this plan has "${keyForSuite}" in its title (ADO_SYNC_SUITE_MATCH_TITLE_ONLY=true) — using ADO_SYNC_SUITE_ID / URL fallback if set`
        : `   ⚠️  No suite in this plan contains "${keyForSuite}" in name or path — using ADO_SYNC_SUITE_ID / URL fallback if set`
    );
    return fallbackSuiteId;
  } catch (e) {
    console.warn(`   ⚠️  Could not list suites for Jira key match: ${e.message}`);
    return fallbackSuiteId;
  }
}

/**
 * Create Test Cases in Azure DevOps from an on-disk approved CSV file.
 * @param {string} csvFilePath
 * @param {{ jiraIssueKey?: string, planId?: number, suiteId?: number, syncFromApprovalRun?: boolean }} [opts]
 *   When `syncFromApprovalRun` is true (agent after approval), plan id is taken **only** from `ADO_ACTIVE_TEST_PLAN_ID` (not `ADO_SYNC_PLAN_ID` / URL plan).
 * @returns {Promise<{ created: { id: number, title: string }[], errors: string[] }>}
 */
async function syncApprovedCsvToAzureDevOps(csvFilePath, opts = {}) {
  const jiraKey = opts.jiraIssueKey || "";
  const text = fs.readFileSync(csvFilePath, "utf8");
  const rows = parseCsvRows(text);
  const testCases = csvRowsToTestCases(rows);
  if (testCases.length === 0) {
    return { created: [], errors: ["No test cases parsed from CSV"], usage: { ...bddUsage } };
  }

  const client = getAdoClientFromEnv();
  let planId;
  let suiteId;
  if (opts.syncFromApprovalRun) {
    const r = resolvePlanSuiteIdsApprovalRun({
      cliSuite: opts.suiteId,
      cliAdoUrl: opts.adoUrl || "",
    });
    planId = r.planId;
    suiteId = r.suiteId;
    if (!Number.isFinite(planId) || planId <= 0) {
      throw new Error(
        "Automate import: pick the Active Test Plan on the Setup page (Azure DevOps card) — ADO_SYNC_PLAN_ID is not used for this flow."
      );
    }
    console.log(`   Azure DevOps: Test Plan id ${planId} (from ADO_ACTIVE_TEST_PLAN_ID)`);
    const fallbackSuite = suiteId;
    suiteId = await resolveSuiteIdForApprovalByCsvKey(
      client,
      planId,
      csvFilePath,
      jiraKey,
      fallbackSuite
    );
  } else {
    const r = resolvePlanSuiteIds({
      cliPlan: opts.planId,
      cliSuite: opts.suiteId,
      cliAdoUrl: opts.adoUrl || "",
    });
    planId = r.planId;
    suiteId = r.suiteId;
  }
  const tagPrefix = process.env.ADO_JIRA_TAG_PREFIX || "Jira";

  const created = [];
  const errors = [];

  // Cases the QA engineer already designed as Gherkin (Create page → Test design
  // format: BDD). Their steps ARE the scenario, so generating a second Gherkin
  // copy into System.Description would duplicate the work item's own content and
  // cost one LLM call per case for nothing. Detected from the CSV rather than
  // from a flag, so the manual `npm run ado:sync-csv` path behaves identically.
  const alreadyBdd = testCases.filter((tc) => bddFormat.isBddTestCase(tc)).length;

  const bddEnabled = adoSyncBddFromPromptEnabled();

  /**
   * Requirement context for designing the Description, resolved once per run.
   *
   * `opts.bddPromptContext` is what a caller that already has it hands over (the review flows pass
   * the generation context the design was approved against). The CLI has only a Jira key, so the
   * same parent-requirement fetch the checklist path uses supplies it instead. Null means no Jira
   * reach at all, and the per-case conversion below stays the fallback.
   */
  let designContextResolved;
  async function resolveDesignContext() {
    if (designContextResolved !== undefined) return designContextResolved;
    if (opts.bddPromptContext) {
      designContextResolved = opts.bddPromptContext;
      return designContextResolved;
    }
    const req = await loadParentRequirementForBdd();
    designContextResolved = req
      ? {
          issueKey: req.key,
          issueDescription: [req.summary, req.description].filter(Boolean).join("\n\n"),
          issueLabels: Array.isArray(req.labels) ? req.labels : [],
        }
      : null;
    return designContextResolved;
  }

  let bddPromptBody = "";
  if (bddEnabled && alreadyBdd === testCases.length) {
    console.log(
      `   ADO BDD: all ${testCases.length} case(s) in this CSV are already Gherkin scenarios — no Summary/Description is generated`
    );
  } else if (bddEnabled) {
    bddPromptBody = loadBddPromptText();
    if (!bddPromptBody) {
      console.warn(
        "   ADO BDD: prompt body not found in TEST_CASE_FORMAT.md — System.Description will be left empty"
      );
    } else if (!process.env.OPENROUTER_API_KEY) {
      console.warn(
        "   ADO BDD: OPENROUTER_API_KEY is not set — System.Description will be left empty"
      );
      bddPromptBody = "";
    } else {
      const target = testCases.length - alreadyBdd;
      console.log(
        `   ADO BDD: per-Test-Case Gherkin generation is ON for ${target} case(s) (set ADO_SYNC_BDD_FROM_PROMPT=false to disable)` +
          (alreadyBdd ? `; ${alreadyBdd} already-Gherkin case(s) are skipped` : "")
      );
    }
  }

  // Lazy: only hits Jira on the first checklist-mode test case we encounter.
  const loadParentRequirementForBdd = createParentRequirementLoader(jiraKey);

  for (const tc of testCases) {
    const manualSteps = partitionManualStepsForSync(tc.steps);
    if (!manualSteps.length) {
      errors.push(`Skipped (no steps): ${tc.title}`);
      continue;
    }
    const area = resolveAreaPath(tc.areaPath);
    const stepsXml = buildTcmStepsXml(manualSteps);
    /** @type {Array<{ op: string, path: string, value?: unknown }>} */
    const patch = [
      { op: "add", path: "/fields/System.Title", value: tc.title },
      { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: stepsXml },
    ];
    const pri = parseInt(tc.priority, 10);
    if (Number.isFinite(pri)) {
      patch.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: pri });
    }
    if (area) {
      patch.push({ op: "add", path: "/fields/System.AreaPath", value: area });
    }
    if (jiraKey) {
      patch.push({ op: "add", path: "/fields/System.Tags", value: `${tagPrefix}:${jiraKey}` });
    }

    try {
      let wi;
      try {
        wi = await client.createWorkItem(WORK_ITEM_TYPE, patch);
      } catch (e) {
        // A bad Area Path must not cost us the test case.
        if (!area || !isInvalidAreaPathError(e.message)) throw e;
        console.warn(
          `   ADO: Area Path "${area}" does not exist in this project — creating "${tc.title}" without it`
        );
        wi = await client.createWorkItem(
          WORK_ITEM_TYPE,
          patch.filter((op) => op.path !== "/fields/System.AreaPath")
        );
      }
      const id = wi.id;
      if (id != null) {
        created.push({ id, title: tc.title });
        if (Number.isFinite(planId) && Number.isFinite(suiteId) && planId > 0 && suiteId > 0) {
          try {
            await client.addTestCasesToSuite(planId, suiteId, [id]);
          } catch (e) {
            errors.push(`Work item ${id} created but not linked to suite: ${e.message}`);
          }
        }
        const tcIsBdd = bddFormat.looksLikeGherkinSteps(manualSteps);
        // Only worth naming in a mixed CSV; when every case is Gherkin the line
        // above already said it once for the whole file.
        if (tcIsBdd && alreadyBdd !== testCases.length) {
          console.log(
            `   ADO BDD: work item ${id} is already a Gherkin scenario — Summary/Description left untouched`
          );
        }
        if (bddEnabled && bddPromptBody && !tcIsBdd) {
          try {
            const tcForBdd = { ...tc, steps: manualSteps };
            // Preferred: design the Scenario from the requirement with the BDD toggle's prompt, so
            // every flow produces the same compact Gherkin. Transcribing the finished steps is the
            // fallback for when the requirement cannot be reached (no Jira credentials, fetch
            // failure) — it needs no network beyond the model call.
            const ctx = await resolveDesignContext();
            // A checklist work item (steps with no Expected) is the whole ticket's checklist, so its
            // Summary is the whole ticket's Feature; a test case gets the one Scenario it covers.
            const bddMode = detectBddModeForTestCase(tcForBdd);
            let descHtml;
            let source;
            if (ctx) {
              const wholeTicket = bddMode === "checklist";
              descHtml = await generateBddDescriptionFromDesignContext(ctx, tc.title, { wholeTicket });
              source = `designed from ${ctx.issueKey || "the ticket"}${wholeTicket ? ", whole-ticket Feature for a checklist" : ""}`;
            } else {
              descHtml = await generateBddDescriptionHtmlForTestCase({
                tc: tcForBdd,
                jiraKey,
                promptBody: bddPromptBody,
                parentRequirement: null,
              });
              source = `transcribed from ${bddMode} (no requirement context)`;
            }
            await client.updateWorkItem(id, [
              { op: "add", path: "/fields/System.Description", value: descHtml },
            ]);
            console.log(
              `   ADO BDD: Description set for work item ${id} (${source}) — ${tc.title}`
            );
          } catch (e) {
            console.warn(
              `   ADO BDD: skipped Description for work item ${id} (${tc.title}) — ${e.message}`
            );
          }
        }
      }
    } catch (e) {
      errors.push(`${tc.title}: ${e.message}`);
    }
  }

  // Returned so an in-process caller (agent-docs.js during the approval run) can fold these
  // tokens into its own run total.
  return { created, errors, usage: { ...bddUsage } };
}

/**
 * CLI args: [options] <path-to-approved.csv>
 * Options: --plan-id / -p, --suite-id / -s, --ado-url / -u, --jira-key / -j, --help
 */
function parseAdoSyncCliArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let planId = NaN;
  let suiteId = NaN;
  let adoUrl = "";
  let jiraKey = process.env.ADO_SYNC_JIRA_KEY || "";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--plan-id" || a === "-p") {
      planId = parseInt(args[++i], 10);
    } else if (a.startsWith("--plan-id=")) {
      planId = parseInt(a.slice("--plan-id=".length), 10);
    } else if (a === "--suite-id" || a === "-s") {
      suiteId = parseInt(args[++i], 10);
    } else if (a.startsWith("--suite-id=")) {
      suiteId = parseInt(a.slice("--suite-id=".length), 10);
    } else if (a === "--ado-url" || a === "-u") {
      adoUrl = args[++i] || "";
    } else if (a.startsWith("--ado-url=")) {
      adoUrl = a.slice("--ado-url=".length);
    } else if (a === "--jira-key" || a === "-j") {
      jiraKey = args[++i] || "";
    } else if (a.startsWith("--jira-key=")) {
      jiraKey = a.slice("--jira-key=".length);
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      help = true;
    } else {
      positional.push(a);
    }
  }

  const csvPath = positional.length ? positional[positional.length - 1] : "";
  if (!help && !csvPath) help = true;
  return { csvPath, planId, suiteId, adoUrl, jiraKey, help };
}

function printAdoSyncUsage() {
  console.log(`Usage:
  node ado-sync-csv.js [options] <path-to-approved.csv>

Options:
  -p, --plan-id <id>     Test Plan id (same as planId= in the browser, _testPlans/define?…)
  -s, --suite-id <id>    Test suite id (same as suiteId= in the URL)
  -u, --ado-url <url>    Full URL or query fragment (?planId=&suiteId=); paste from the address bar
  -j, --jira-key <KEY>   Tag each work item as Jira:<KEY> (overrides ADO_SYNC_JIRA_KEY)
  -h, --help             Show this help

Examples:
  node ado-sync-csv.js -p 1234 -s 5678 "C:\\path\\approved-testcases-ABC-1.csv"
  npm run ado:sync-csv -- -u "https://dev.azure.com/your-org/YourProject/_testPlans/define?planId=1234&suiteId=5678" ./export.csv

Precedence: -p/-s → -u → ADO_SYNC_PLAN_ID / ADO_SYNC_SUITE_ID or ADO_SYNC_TEST_PLAN_URL in .env.
The path your-org/YourProject/… in the UI is org/project (ADO_ORG / ADO_PROJECT), not the plan id.

List suites for a plan (pick suite id):
  npm run ado:list-suites -- 1234
`);
}

async function cliMain() {
  const parsed = parseAdoSyncCliArgs(process.argv);
  if (parsed.help) {
    printAdoSyncUsage();
    process.exit(0);
  }
  const filePath = parsed.csvPath;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("❌ CSV file not found. Pass a valid path as the last argument.");
    printAdoSyncUsage();
    process.exit(1);
  }
  const { planId: resPlan, suiteId: resSuite } = resolvePlanSuiteIds({
    cliPlan: parsed.planId,
    cliSuite: parsed.suiteId,
    cliAdoUrl: parsed.adoUrl || "",
  });
  const hasPlan = Number.isFinite(resPlan) && resPlan > 0;
  const hasSuite = Number.isFinite(resSuite) && resSuite > 0;
  if (hasPlan !== hasSuite) {
    console.error(
      "❌ Set both planId and suiteId (same as in the browser ?planId=&suiteId=), via -p/-s, --ado-url, ADO_SYNC_PLAN_ID/ADO_SYNC_SUITE_ID, or ADO_SYNC_TEST_PLAN_URL in .env; or leave all unset (no suite link)."
    );
    process.exit(1);
  }
  console.log(`📤 Syncing ${path.basename(filePath)} to Azure DevOps...`);
  if (hasPlan && hasSuite) {
    console.log(`   Target suite: plan ${resPlan}, suite ${resSuite}`);
  }
  const result = await syncApprovedCsvToAzureDevOps(filePath, {
    jiraIssueKey: parsed.jiraKey,
    planId: hasPlan ? resPlan : undefined,
    suiteId: hasSuite ? resSuite : undefined,
  });
  result.created.forEach((c) => console.log(`   ✅ #${c.id} ${c.title}`));
  if (result.errors.length) {
    result.errors.forEach((e) => console.warn(`   ⚠️  ${e}`));
    if (result.created.length === 0) process.exit(1);
  }
  console.log(`Done. Created ${result.created.length} test case(s).`);
}

if (require.main === module) {
  cliMain()
    .then(() => logUsage(bddUsage, "for this ADO sync"))
    .catch((e) => {
      // Report the spend even on failure — tokens burnt before the error are still billed.
      logUsage(bddUsage, "for this ADO sync");
      console.error("❌", e.message);
      process.exit(1);
    });
}

module.exports = {
  parseCsvRows,
  csvRowsToTestCases,
  buildTcmStepsXml,
  syncApprovedCsvToAzureDevOps,
  parseAdoSyncCliArgs,
  parsePlanSuiteFromAdoUrl,
  resolvePlanSuiteIds,
  resolvePlanSuiteIdsApprovalRun,
  envActiveTestPlanIdNumber,
  extractJiraKeyFromCsvFilename,
  titleFromCsvFilename,
  containerNameForJiraKey,
  normalizeJiraIssueKey,
  pickSuiteForJiraKey,
  // Shared with testrail-sync-csv.js: parsing an approved CSV and finding the
  // container from the Jira key are provider-independent. BDD is not — it is an
  // Azure DevOps Description, and TestRail has nowhere equivalent to put it.
  partitionManualStepsForSync,
};
