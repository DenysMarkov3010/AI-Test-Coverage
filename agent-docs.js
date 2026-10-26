const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

const { JiraClient, contextIssueKeyFor } = require("./jira-client");
const { ConfluenceClient } = require("./confluence-client");
const {
  generateTestChecklistPrompt,
  generateTestCasesPrompt,
  generateBddTestCasesPrompt,
  regenerateChecklistItemPrompt,
  regenerateTestCasePrompt,
  regenerateBddTestCasePrompt,
} = require("./prompts-docs");
const bddFormat = require("./web/bdd-format.js");
const { guardLlmResult } = require("./placeholder-guard");
// The approved CSV — writers, the Jira attach, and reading the newest one back. Shared with
// agent-update-csv.js, which produces the same artefact for a whole CSV's blocks.
const {
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
} = require("./approved-csv.js");
const { createUsageTally, formatUsage, logUsage, mergeUsage } = require("./llm-usage");
const { callOpenRouter } = require("./llm-client");
const { analyzeFigmaUrl, isFigmaUrl } = require("./figma-client");
const { analyzePrototypeUrl, isHttpUrl } = require("./prototype-client");
const { analyzeAttachments, attachmentPathsFromEnv } = require("./attachment-analyzer");
const { loadIssueComments } = require("./issue-comments");
const { appendTicketDataFiles } = require("./ticket-data-files");
const { collectConfluencePages, confluencePagesToText, parseConfluenceLinks } = require("./confluence-pages");
const promptContextLib = require("./prompt-context");
const {
  getTitleSearchWords,
  parseRelatedIssuesKeywords,
  resolveRelatedIssueTypes,
  buildRelatedIssuesJql,
} = require("./related-issues");
const adoContextStore = require("./ado-context-store.js");
const tmsContext = require("./tms-context.js");
const examplesStore = require("./examples-store.js");

const fetch = globalThis.fetch || require("node-fetch");

// Environment variables
const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || JIRA_BASE_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "PROJ";
const REQUIRED_LABELS = process.env.REQUIRED_LABELS 
  ? JSON.parse(process.env.REQUIRED_LABELS) 
  : [];
const CHANGE_REQUEST_LABEL = process.env.CHANGE_REQUEST_LABEL || "change-request";
// Folder where approved checklist CSV files are saved (not in project). Use CHECKLIST_OUTPUT_DIR in .env to override.
const CHECKLIST_OUTPUT_DIR = process.env.CHECKLIST_OUTPUT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", "OneDrive", "Desktop", "Checklists and Test cases");
// Project folder with test case files (CSV/TXT) for analysis before checklist. Use when ENABLE_TEST_CASES_ANALYSIS=true.
const TEST_CASES_FOLDER = process.env.TEST_CASES_FOLDER || path.join(__dirname, "Test cases");
const ENABLE_TEST_CASES_ANALYSIS = process.env.ENABLE_TEST_CASES_ANALYSIS === "true";
const GENERATE_MODE_RAW = (process.env.GENERATE_MODE || "checklist").toLowerCase().replace(/\s+/g, "");

/**
 * Standard or BDD — the "Test design format" toggle on the Create page.
 *
 * Orthogonal to which test management system is in use: a Gherkin scenario
 * reaches Azure DevOps and TestRail through exactly the same approved CSV as a
 * standard case, because the keywords ride inside the step text
 * (see web/bdd-format.js).
 *
 * BDD output is a Feature made of Scenarios, which is the test-case shape — a
 * "BDD checklist" is not a thing. So the format wins over GENERATE_MODE rather
 * than producing something neither the CSV nor the review panel can read.
 */
const TEST_DESIGN_FORMAT =
  String(process.env.TEST_DESIGN_FORMAT || "standard").toLowerCase().trim() === "bdd"
    ? "bdd"
    : "standard";
const IS_BDD = TEST_DESIGN_FORMAT === "bdd";
const GENERATE_MODE = IS_BDD ? "testcases" : GENERATE_MODE_RAW;

/**
 * Which slice of the pipeline this process should run.
 *
 *   full       - generate AND post to Jira (the original behaviour; still the default)
 *   generate   - generate, write the result to PIPELINE_IO_FILE, post nothing
 *   regenerate - reuse a stored context to redo one item / one case / the whole set
 *   submit     - post the (edited) payload from PIPELINE_IO_FILE to Jira
 *   import-tms - write the (edited) payload as a CSV and import it straight into the
 *                test management system, without touching Jira at all
 *
 * The web UI drives generate → regenerate* → submit so the QA engineer can edit the generated
 * content before anything reaches the Jira ticket. Nothing is posted until "submit".
 *
 * "Cover a bug" (web/issue-case.html) drives generate → regenerate* → import-tms
 * instead: there is no approval round-trip through Jira, the reviewed cases go directly into
 * the Test Plan / Suite (Azure DevOps) or Section (TestRail) chosen on the page.
 */
/** Token spend for this process, accumulated by callLLM and reported at the end of the run. */
const runUsage = createUsageTally();

const PIPELINE_STAGE = (process.env.PIPELINE_STAGE || "full").toLowerCase().trim();
const PIPELINE_IO_FILE = process.env.PIPELINE_IO_FILE || "";

/**
 * "Cover a bug": generate from the pasted ticket and import into the TMS, never post to
 * Jira. Two things follow from that, and both are wrong for every other flow:
 *
 *   - the Test design QA sub-task is not required (nothing is commented anywhere), and
 *   - the ticket in the link IS the subject, so an Epic above a Story must not replace it.
 */
const DIRECT_TMS_IMPORT = process.env.DIRECT_TMS_IMPORT === "true";

/**
 * Log lines that narrate a *setting* — which context sources were searched, which cap applied.
 *
 * They earn their place in the Create and Update flows, where the QA engineer picked those
 * switches on the page and wants to see them echoed back. In "Cover a bug" none of it is
 * a choice: related-issue and Confluence search are not merely switched off, they have no meaning
 * for a single case built from one ticket, and the cap IS the flow. Printing "…disabled" there
 * would advertise settings that the page deliberately does not offer, so the lines are dropped
 * instead of reworded.
 */
function logSettingEcho(...args) {
  if (DIRECT_TMS_IMPORT) return;
  console.log(...args);
}

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

/**
 * Resolve max number of test cases for GENERATE_MODE=testcases (Create new test design flow).
 * Accepts integer (e.g. "10", "20", "30") or "unlimited" / "0" / "none" / empty -> null = no cap.
 * Default when unset: 10 (matches the historical hard-cap).
 */
function resolveTestCasesLimit() {
  const raw = String(process.env.TEST_CASES_LIMIT || "").trim().toLowerCase();
  if (raw === "") return 10;
  if (raw === "unlimited" || raw === "none" || raw === "0") return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return n;
}

// Validate required environment variables
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

if (!OPENROUTER_API_KEY) {
  console.error("❌ Error: OPENROUTER_API_KEY is not set");
  process.exit(1);
}

const OPENROUTER_MODEL_CANDIDATES = (
  process.env.OPENROUTER_MODELS || "openai/gpt-oss-20b:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const RETRYABLE_LLM_STATUS = new Set([429, 500, 502, 503, 504]);

/** Output cap for checklist generation. Kept in step with TEST_CASES_MAX_TOKENS. */
function checklistMaxTokens() {
  const raw = parseInt(process.env.CHECKLIST_MAX_TOKENS || "12000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 12000;
}

/**
 * Thin wrapper over the shared OpenRouter client: this flow's token spend goes into `runUsage`,
 * and the truncation message names the two knobs a checklist / test-case run can raise.
 */
async function callLLM(prompt, maxTokens = 4000) {
  return callOpenRouter(prompt, {
    maxTokens,
    apiKey: OPENROUTER_API_KEY,
    models: OPENROUTER_MODEL_CANDIDATES,
    usageTally: runUsage,
    retryableStatus: RETRYABLE_LLM_STATUS,
    labels: {
      truncationRemedy:
        "The answer is incomplete, so it cannot be parsed. Raise the limit for this generation " +
        "(CHECKLIST_MAX_TOKENS for checklists, TEST_CASES_MAX_TOKENS for test cases) or ask for fewer items.",
    },
    hooks: {
      onNoChoices: (data) => console.error("LLM raw response:", JSON.stringify(data, null, 2)),
      onModelSwitch: (model, reason) =>
        console.warn(`LLM model "${model}" failed (${reason}). Trying next fallback model.`),
      onFinalError: (err) => console.error("Error calling LLM:", err.message),
    },
  });
}

function validateRequirements(issueData) {
  const errors = [];
  
  // The description already carries any CSV / JSON attached to the ticket (appendTicketDataFiles),
  // so it is empty only when the ticket has neither.
  if (!issueData.description || issueData.description.trim().length === 0) {
    errors.push("Missing description and no CSV / JSON requirements file attached to the ticket");
  }
  
  // Check for required labels if specified
  if (REQUIRED_LABELS.length > 0) {
    const issueLabels = (issueData.labels || []).map(l => l.toLowerCase());
    const missingLabels = REQUIRED_LABELS.filter(
      reqLabel => !issueLabels.includes(reqLabel.toLowerCase())
    );
    if (missingLabels.length > 0) {
      errors.push(`Missing required labels: ${missingLabels.join(", ")}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

function isChangeRequest(issueData) {
  const labels = (issueData.labels || []).map(l => l.toLowerCase());
  return labels.some(l => 
    l === CHANGE_REQUEST_LABEL.toLowerCase() || 
    l === "change-request" || 
    l === "change_request" || 
    l === "changerequest"
  );
}

/** Trim long context text (related issue descriptions) so the prompt stays focused. */
function truncateForPrompt(text, maxChars = 600) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Load existing test cases used as generation context, from two independent sources:
 *
 *  1. the project "Test cases" folder (CSV / TXT) — filled by `ado-export-tag-csv.js` or by hand;
 *  2. `.ado-context/` — Test Case work items picked plan-by-suite in the Web UI
 *     (see `ado-context-store.js`); several picks from different plans stack up there.
 *
 * Both arrive in the same `{ filename, content }` shape, so the prompt builders need no changes.
 * Used when ENABLE_TEST_CASES_ANALYSIS is effective.
 * Memoized per process: one run reads the folder once, and the context summary
 * posted to Jira reuses the same file list the prompt actually saw.
 * @returns {Array<{ filename: string, content: string }>}
 */
/** Existing tests as compact text (title, priority, "action → expected") — see prompt-context.js. */
function compactTestFile(file) {
  const { text, cases } = promptContextLib.compactExistingTests(file.content);
  return { ...file, content: text, cases };
}

/**
 * The existing tests a prompt gets: picked ones first, the rest by relevance to the ticket, within
 * EXISTING_TESTS_MAX_CHARS. The `cases` breakdown is dropped — the review session stores this.
 */
function existingTestsForPrompt(issueData) {
  const all = loadProjectTestCases();
  if (!all.length) return [];
  return promptContextLib
    .selectExistingTests(all, {
      summary: (issueData && (issueData.summary || (issueData.ticket && issueData.ticket.summary))) || "",
      keywords: parseRelatedIssuesKeywords(process.env.RELATED_ISSUES_KEYWORDS || "", 10),
    })
    .map(({ cases, ...rest }) => rest);
}

/** Related Keywords typed on the Create page — passed to the prompt as focus areas. */
function focusAreasFromEnv() {
  return parseRelatedIssuesKeywords(process.env.RELATED_ISSUES_KEYWORDS || "", 10);
}

let projectTestCasesCache = null;
function loadProjectTestCases() {
  if (projectTestCasesCache) return projectTestCasesCache;
  const results = [];
  projectTestCasesCache = results;
  try {
    if (fs.existsSync(TEST_CASES_FOLDER)) {
      const entries = fs.readdirSync(TEST_CASES_FOLDER, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (ext !== ".csv" && ext !== ".txt") continue;
        const filePath = path.join(TEST_CASES_FOLDER, ent.name);
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) results.push(compactTestFile({ filename: ent.name, content, origin: "folder" }));
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not read Test cases folder: ${err.message}`);
  }
  try {
    results.push(
      ...adoContextStore.loadContextFiles(__dirname).map((f) => compactTestFile({ ...f, origin: "picked" }))
    );
  } catch (err) {
    console.warn(`⚠️  Could not read picked test management context: ${err.message}`);
  }
  return results;
}

/**
 * Fetch the latest AI-generated checklist / test case titles previously posted
 * for a related issue (the agent posts them on the issue's "Test design"
 * QA sub-task). Returns scenario titles only — compact, high-signal context
 * that tells the LLM what was already designed for the neighbouring story.
 * @returns {Promise<string[]>} up to `maxItems` scenario lines, or []
 */
async function fetchPreviousQaChecklist(jiraClient, issueKey, maxItems = 30) {
  let targetKey = null;
  try {
    targetKey = await jiraClient.getTestDesignSubtaskKey(issueKey, PROJECT_KEY);
  } catch {
    return [];
  }
  if (!targetKey) return [];
  let comments;
  try {
    comments = await jiraClient.getComments(targetKey);
  } catch {
    return [];
  }
  // Latest agent-generated comment wins (checklist or test cases).
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.bodyText || "";
    if (!body.includes("AI-Generated Test")) continue;
    const items = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\s+\S/.test(l))
      .map((l) => l.replace(/\s*\(\d+\s+steps?\)\s*$/i, ""))
      .map((l) => truncateForPrompt(l, 160));
    if (items.length > 0) return items.slice(0, maxItems);
  }
  return [];
}

async function searchRelatedDocumentation(jiraClient, confluenceClient, issueData) {
  const results = {
    confluencePages: [],
    relatedJiraIssues: [],
    relatedSearchMeta: null,
    figmaContext: "",
    figmaStats: null,
    prototypeContext: "",
    prototypeStats: null,
    attachmentsContext: "",
    attachmentsStats: null,
    commentsContext: "",
    commentsStats: null,
  };

  // Skip Confluence search if ENABLE_CONFLUENCE_SEARCH is not set to "true"
  const enableConfluenceSearch = process.env.ENABLE_CONFLUENCE_SEARCH === "true";
  
  if (enableConfluenceSearch) {
    try {
      // The "Confluence link" field on the Create page (CONFLUENCE_LINKS) first, then the links in
      // the Jira description. The host comes from each link — see confluence-pages.js.
      const { links: fieldLinks } = parseConfluenceLinks(process.env.CONFLUENCE_LINKS || "");
      if (fieldLinks.length) console.log(`🔗 Confluence link(s) from the Create page: ${fieldLinks.length}`);
      const found = await collectConfluencePages({
        issueData,
        extraLinks: fieldLinks,
        baseUrl: CONFLUENCE_BASE_URL,
        email: JIRA_EMAIL,
        token: JIRA_API_TOKEN,
      });
      results.confluencePages.push(...found.pages);

      if (!found.tried) {
        console.log("📄 No Confluence links: none on the Create page and none in the Jira description.");
      } else if (results.confluencePages.length > 0) {
        console.log(`📄 Read ${results.confluencePages.length} Confluence document(s):`);
        results.confluencePages.forEach((p, i) => {
          console.log(
            `   ${i + 1}. ${p.title || "(untitled)"}${p.space ? ` [${p.space}]` : ""}${p.source === "field" ? " (Confluence link field)" : ""}`
          );
        });
      } else {
        console.log("📄 No Confluence documents could be read from the links.");
      }
    } catch (error) {
      console.warn(`⚠️  Error reading Confluence docs: ${error.message}`);
      console.log(`ℹ️  Continuing without Confluence documentation...`);
    }
  } else {
    logSettingEcho(`ℹ️  Confluence search disabled. Working with Jira issue description only.`);
  }

  // Search related Jira issues by custom keywords (if provided) or by similar title.
  const enableRelatedIssuesSearch = process.env.ENABLE_RELATED_ISSUES_SEARCH !== "false";
  const inputKeywords = parseRelatedIssuesKeywords(process.env.RELATED_ISSUES_KEYWORDS || "", 10);
  const queryWords = inputKeywords.length > 0
    ? inputKeywords
    : getTitleSearchWords(issueData.summary);
  const searchMode = inputKeywords.length > 0 ? "custom keywords" : "similar title";
  results.relatedSearchMeta = { mode: searchMode, queryWords };

  if (enableRelatedIssuesSearch && queryWords.length > 0) {
    try {
      const jql = buildRelatedIssuesJql({
        projectKey: PROJECT_KEY,
        issueTypes: resolveRelatedIssueTypes(process.env.RELATED_ISSUES_TYPES || ""),
        queryWords,
        excludeKey: issueData.key,
      });
      console.log(`🔍 Searching related Jira issues with JQL (${searchMode}): ${jql}`);
      const jiraResults = await jiraClient.searchIssues(jql, [
        "key", "summary", "status", "labels", "description", "issuetype", "parent"
      ], 30);

      if (jiraResults.issues && jiraResults.issues.length > 0) {
        // Description is ADF (API v3): convert to compact plain text so 30 issues
        // do not flood the prompt with serialized ADF trees.
        // Ranked by how they are related (explicit link > same parent > search words in the summary)
        // and cut to RELATED_ISSUES_MAX — see rankRelatedIssues() in prompt-context.js.
        results.relatedJiraIssues = promptContextLib.rankRelatedIssues(
          jiraResults.issues.map(issue => ({
            key: issue.key,
            summary: issue.fields.summary,
            labels: issue.fields.labels || [],
            status: issue.fields.status?.name || null,
            issueType: issue.fields.issuetype?.name || null,
            parentKey: issue.fields.parent?.key || null,
            description: truncateForPrompt(JiraClient.adfToText(issue.fields.description)) || null,
          })),
          { ticket: issueData.ticket || null, queryWords }
        );
        console.log(`📋 Found ${results.relatedJiraIssues.length} related Jira issue(s) (by ${searchMode}):`);
        results.relatedJiraIssues.forEach((issue, i) => {
          console.log(`   ${i + 1}. ${issue.key} — ${issue.summary || "(no summary)"}`);
        });

        // Value loop: reuse previously designed QA scenarios of the closest related
        // issues, so this generation aligns with (and does not duplicate) them.
        const enableRelatedChecklists = process.env.ENABLE_RELATED_CHECKLISTS !== "false";
        if (enableRelatedChecklists) {
          const enrichLimit = Math.min(5, results.relatedJiraIssues.length);
          let enriched = 0;
          for (let i = 0; i < enrichLimit; i++) {
            const rel = results.relatedJiraIssues[i];
            const previous = await fetchPreviousQaChecklist(jiraClient, rel.key);
            if (previous.length > 0) {
              rel.previousQaChecklist = previous;
              enriched += 1;
            }
          }
          if (enriched > 0) {
            console.log(`🧠 Reusing previously designed QA scenarios from ${enriched} related issue(s).`);
          }
        }
      } else {
        console.log(`📋 No related Jira issues found`);
      }
    } catch (error) {
      console.warn(`⚠️  Error searching related Jira issues: ${error.message}`);
    }
  } else if (enableRelatedIssuesSearch && queryWords.length === 0) {
    console.log(`ℹ️  No search keywords provided and no significant words in summary for related issues search.`);
  } else {
    logSettingEcho(`ℹ️  Related issues search disabled.`);
  }

  const figmaUrl = (process.env.FIGMA_URL || "").trim();
  if (figmaUrl) {
    if (!isFigmaUrl(figmaUrl)) {
      console.warn(`⚠️  FIGMA_URL is set but does not look like a Figma link — skipping design analysis. Value: ${figmaUrl}`);
    } else {
      try {
        const figma = await analyzeFigmaUrl(figmaUrl);
        if (figma.error) {
          console.warn(`⚠️  Figma: ${figma.error}`);
        }
        if (figma.summary) {
          results.figmaContext = figma.summary;
          results.figmaStats = figma.stats || null;
          if (figma.stats) {
            const visionNote = figma.stats.visionFrames
              ? `, vision: ${figma.stats.visionFrames} frame(s) via ${figma.stats.visionModel}`
              : ", vision: skipped";
            console.log(
              `🎨 Figma analyzed: ${figma.stats.scopeKind} "${figma.stats.scopeName || "(unnamed)"}" — ${figma.stats.framesAnalyzed} frame(s)${visionNote}.`,
            );
          }
        }
      } catch (err) {
        console.warn(`⚠️  Figma analysis crashed (continuing without design context): ${err.message}`);
      }
    }
  }

  // The live prototype, when the Setup page's "Read prototype" switch is on and the QA engineer
  // pasted a link on the Create page. The Web UI is what sets PROTOTYPE_URL, so a run started from
  // the shell simply does not have it — same contract as FIGMA_URL.
  const prototypeUrl = (process.env.PROTOTYPE_URL || "").trim();
  if (prototypeUrl) {
    if (!isHttpUrl(prototypeUrl)) {
      console.warn(`⚠️  PROTOTYPE_URL is not an http(s) link — skipping the prototype crawl. Value: ${prototypeUrl}`);
    } else {
      try {
        const proto = await analyzePrototypeUrl(prototypeUrl);
        if (proto.error) {
          console.warn(`⚠️  Prototype: ${proto.error}`);
        }
        if (proto.summary) {
          results.prototypeContext = proto.summary;
          results.prototypeStats = proto.stats || null;
          if (proto.stats) {
            const visionNote = proto.stats.visionScreens
              ? `, vision: ${proto.stats.visionScreens} screen(s) via ${proto.stats.visionModel}`
              : ", vision: skipped";
            console.log(
              `🧭 Prototype analyzed: ${proto.stats.screens} screen(s) crawled${proto.stats.truncated ? " (page budget reached)" : ""}${visionNote}.`,
            );
          }
        }
      } catch (err) {
        console.warn(`⚠️  Prototype crawl crashed (continuing without it): ${err.message}`);
      }
    }
  }

  // Images / PDFs attached on the Create or Cover a bug page. Like FIGMA_URL and PROTOTYPE_URL, the
  // Web UI is what sets REQUIREMENT_ATTACHMENTS; an unreadable file costs a warning, never the run.
  const attachmentPaths = attachmentPathsFromEnv();
  if (attachmentPaths.length) {
    try {
      const att = await analyzeAttachments(attachmentPaths, {
        issueKey: issueData.key,
        flowHint: DIRECT_TMS_IMPORT ? "screenshots or logs of the reported defect" : "",
        usageTally: runUsage,
      });
      if (att.error) console.warn(`⚠️  Attachments: ${att.error}`);
      if (att.summary) {
        results.attachmentsContext = att.summary;
        results.attachmentsStats = att.stats || null;
        const s = att.stats || {};
        console.log(
          `📎 Attachments analyzed: ${s.analyzed || 0} of ${s.files || 0} file(s) (${s.images || 0} image(s), ${s.pdfs || 0} PDF(s)) via ${s.model}.`,
        );
      }
    } catch (err) {
      console.warn(`⚠️  Attachment analysis crashed (continuing without it): ${err.message}`);
    }
  }

  // Comments under the analysed issue (on by default; ENABLE_ISSUE_COMMENTS=false turns it off).
  // The agent's own and approval comments are filtered out in issue-comments.js.
  try {
    const comments = await loadIssueComments(jiraClient, issueData.key);
    results.commentsContext = comments.text || "";
    results.commentsStats = comments.stats || null;
  } catch (err) {
    console.warn(`⚠️  Reading issue comments crashed (continuing without them): ${err.message}`);
  }

  // The Helping Prompt from the page, plus the TMS suites / sections / folders it names.
  const helping = await resolveHelpingPromptContext();
  results.helpingPrompt = helping.text;
  results.helpingPromptTestCases = helping.files;

  return results;
}

/**
 * The Helping Prompt typed on the Create / Cover a bug page (HELPING_PROMPT), and the existing
 * test cases it asks for by name.
 *
 * The text itself goes into every prompt of this draft (generation and each later Regenerate) —
 * see buildHelpingPromptBlock in prompts-docs.js, which also tells the model how to resolve what
 * it says about the design, prototype, attachments, Confluence and existing tests. A suite /
 * section / folder of the TMS In use that it names is fetched the same way a Regenerate's
 * guidance does it (tms-context.js), once, here: the files are stored with the session, so a
 * Regenerate does not call the TMS again for them. Never throws — an unreadable TMS means less
 * context, not a failed run.
 *
 * @returns {Promise<{ text: string, files: Array<{ filename: string, content: string, origin: string }> }>}
 */
async function resolveHelpingPromptContext() {
  const text = String(process.env.HELPING_PROMPT || "").trim();
  if (!text) return { text: "", files: [] };
  console.log(`🧭 Helping prompt: ${text}`);
  try {
    const guided = await tmsContext.resolveGuidanceContext(text, {
      projectDir: __dirname,
      log: (line) => console.log(String(line).replace(/\bGuidance\b/g, "Helping prompt")),
    });
    const files = guided.files.map((f) => ({
      ...f,
      filename: String(f.filename).replace("named in the reviewer guidance", "named in the Helping Prompt"),
      origin: "helping",
    }));
    return { text, files };
  } catch (err) {
    console.warn(`⚠️  Could not read the test cases the helping prompt names (continuing without them): ${err.message}`);
    return { text, files: [] };
  }
}

/**
 * Existing tests for a prompt, with the ones the Helping Prompt named on top.
 * Those were asked for explicitly, so they count even when "Analyze existing test cases" is off.
 */
function withHelpingTestCases(files, helpingFiles) {
  const extra = Array.isArray(helpingFiles) ? helpingFiles : [];
  return extra.length ? [...extra, ...files] : files;
}

/**
 * Everything the checklist prompt needs, as one serialisable object.
 * Split out from the LLM call so the review flow can stash it in a session and reuse the exact
 * same context when the QA engineer asks to regenerate an item — no second Confluence/Figma pass.
 */
function buildChecklistPromptContext(issueData, relatedDocs) {
  const projectTestCases = ENABLE_TEST_CASES_ANALYSIS ? existingTestsForPrompt(issueData) : [];
  if (ENABLE_TEST_CASES_ANALYSIS) {
    if (projectTestCases.length > 0) {
      logSettingEcho(`📂 Using ${projectTestCases.length} test case file(s) from project folder for analysis`);
    } else {
      logSettingEcho(`ℹ️  Test cases analysis enabled but no .csv/.txt files found in "${TEST_CASES_FOLDER}"`);
    }
  }
  return {
    issueKey: issueData.key,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    // Tracker facts, Related Keywords and how related issues were found — see prompt-context.js.
    ticket: issueData.ticket || null,
    focusAreas: focusAreasFromEnv(),
    relatedSearchMeta: relatedDocs.relatedSearchMeta || null,
    confluencePages: relatedDocs.confluencePages,
    relatedJiraIssues: relatedDocs.relatedJiraIssues,
    projectTestCases: withHelpingTestCases(projectTestCases, relatedDocs.helpingPromptTestCases),
    // A later Regenerate re-reads the folder and the picked context rather than reusing this
    // snapshot, and needs to know whether this run was allowed to use them at all.
    analyzeTestCases: ENABLE_TEST_CASES_ANALYSIS,
    figmaContext: relatedDocs.figmaContext || "",
    prototypeContext: relatedDocs.prototypeContext || "",
    attachmentsContext: relatedDocs.attachmentsContext || "",
    commentsContext: relatedDocs.commentsContext || "",
    // Kept with the session: every Regenerate of this draft still follows it.
    helpingPrompt: relatedDocs.helpingPrompt || "",
    helpingPromptTestCases: relatedDocs.helpingPromptTestCases || [],
  };
}

/**
 * @param {Object} promptContext - from buildChecklistPromptContext
 * @param {string} userGuidance - reviewer's free-text ask, "" for the first generation
 */
/**
 * Requirements inventory ↔ "covers": which requirements no generated item verifies. Kept on the
 * result (and in report.yaml) only — nothing on the Web UI reads it. Old-shaped answers without
 * an inventory simply report zero requirements.
 */
function withCoverageCheck(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  parsed.requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
  parsed.assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
  parsed.openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [];
  parsed.coverageCheck = promptContextLib.checkCoverage(parsed);
  return parsed;
}

function traceabilityOf(result) {
  if (!result || !result.coverageCheck) return null;
  return {
    ...result.coverageCheck,
    requirements: result.requirements || [],
    assumptions: result.assumptions || [],
    openQuestions: result.openQuestions || [],
  };
}

async function generateChecklistFromContext(promptContext, userGuidance = "") {
  console.log("🤖 Generating test checklist with LLM...");
  const prompt = generateTestChecklistPrompt({ ...promptContext, userGuidance });
  const response = await callLLM(prompt, checklistMaxTokens());

  // Try to parse JSON from response
  try {
    // Remove markdown code blocks if present
    const cleanedResponse = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return withCoverageCheck(guardLlmResult(JSON.parse(cleanedResponse), `checklist for ${promptContext.issueKey}`));
  } catch (error) {
    console.error("Failed to parse LLM response as JSON:", error.message);
    console.error("Response:", response);
    throw new Error("LLM did not return valid JSON");
  }
}

async function generateTestChecklist(issueData, relatedDocs) {
  return generateChecklistFromContext(buildChecklistPromptContext(issueData, relatedDocs));
}

/**
 * BDD/Gherkin prompt block in TEST_CASE_FORMAT.md is for Azure DevOps CSV import / Description only —
 * do not inject it into GENERATE_MODE=testcases LLM context.
 *
 * Strips ANY top-level section whose heading starts with "## Prompt: BDD / Gherkin"
 * (covers current "## Prompt: BDD / Gherkin for Azure DevOps Summary ..." heading
 * and any historical / future variations).
 */
function stripBddPromptSectionFromTestCaseFormat(md) {
  const re = /\n## Prompt: BDD \/ Gherkin[^\n]*\n/g;
  let result = String(md || "");
  let match;
  while ((match = re.exec(result)) !== null) {
    const start = match.index;
    const after = result.indexOf("\n## ", start + match[0].length);
    const head = result.slice(0, start).replace(/\n---\s*$/, "").trimEnd();
    if (after === -1) {
      result = head;
    } else {
      result = `${head}\n\n${result.slice(after + 1).trimStart()}`;
    }
    re.lastIndex = 0;
  }
  return result.trim();
}

/**
 * The format reference injected into the generation prompt: the prose rules from
 * TEST_CASE_FORMAT.md plus the worked examples.
 *
 * The examples themselves no longer live in the .md — they are stored locally and
 * edited on the Setup page (see examples-store.js). The .md carries a
 * `<!-- FORMAT_EXAMPLES -->` marker where they used to sit, and they are spliced
 * back in here, so the prompt keeps the same shape it always had while the user
 * gets to curate them in the UI.
 */
function loadTestCaseFormatRef() {
  const filePath = path.join(__dirname, "TEST_CASE_FORMAT.md");
  try {
    if (fs.existsSync(filePath)) {
      const md = stripBddPromptSectionFromTestCaseFormat(fs.readFileSync(filePath, "utf8").trim());
      return examplesStore.injectIntoDoc(md).trim();
    }
  } catch (e) {
    console.warn("⚠️  Could not load TEST_CASE_FORMAT.md:", e.message);
  }
  return "";
}


/**
 * Everything the test-cases prompt needs, as one serialisable object.
 * `testCaseFormatRef` is deliberately left out: it is the whole of TEST_CASE_FORMAT.md and is
 * reloaded from disk on demand instead of being copied into every review session.
 */
function buildTestCasesPromptContext(issueData, relatedDocs) {
  const projectTestCases = ENABLE_TEST_CASES_ANALYSIS ? existingTestsForPrompt(issueData) : [];
  if (ENABLE_TEST_CASES_ANALYSIS && projectTestCases.length > 0) {
    logSettingEcho(`📂 Using ${projectTestCases.length} test case file(s) from project folder for analysis`);
  }

  const testCasesLimit = resolveTestCasesLimit();
  logSettingEcho(
    `🔢 Test cases limit: ${testCasesLimit === null ? "unlimited" : testCasesLimit} (TEST_CASES_LIMIT env)`
  );

  return {
    issueKey: issueData.key,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    // Tracker facts, Related Keywords and how related issues were found — see prompt-context.js.
    ticket: issueData.ticket || null,
    focusAreas: focusAreasFromEnv(),
    relatedSearchMeta: relatedDocs.relatedSearchMeta || null,
    confluencePages: relatedDocs.confluencePages || [],
    relatedJiraIssues: relatedDocs.relatedJiraIssues || [],
    projectTestCases: withHelpingTestCases(projectTestCases, relatedDocs.helpingPromptTestCases),
    analyzeTestCases: ENABLE_TEST_CASES_ANALYSIS,
    testCasesLimit,
    figmaContext: relatedDocs.figmaContext || "",
    prototypeContext: relatedDocs.prototypeContext || "",
    attachmentsContext: relatedDocs.attachmentsContext || "",
    commentsContext: relatedDocs.commentsContext || "",
    // Kept with the session: every Regenerate of this draft still follows it.
    helpingPrompt: relatedDocs.helpingPrompt || "",
    helpingPromptTestCases: relatedDocs.helpingPromptTestCases || [],
    // Carried in the review session so a later Regenerate keeps the format the
    // reviewer is looking at, without re-reading the env of a finished process.
    format: TEST_DESIGN_FORMAT,
  };
}

/** The stored session decides; a session written before the toggle existed is standard. */
function contextIsBdd(promptContext) {
  return String((promptContext && promptContext.format) || TEST_DESIGN_FORMAT) === "bdd";
}

/**
 * Some models answer the test-cases prompt with the export CSV (the layout
 * TEST_CASE_FORMAT.md describes) instead of the requested JSON. The content is
 * still usable, so read it with the same parser the import path uses rather
 * than failing the whole run.
 */
function testCasesFromCsvResponse(csvText) {
  const { parseCsvRows, csvRowsToTestCases } = require("./ado-sync-csv");
  const cases = csvRowsToTestCases(parseCsvRows(csvText));
  if (!cases.length) throw new Error("LLM returned CSV with no test cases");
  console.warn(`⚠️  LLM returned CSV instead of JSON; parsed ${cases.length} test case(s) from it.`);
  return {
    testCases: cases.map((c) => ({
      title: c.title,
      priority: parseInt(c.priority, 10) === 1 ? 1 : 2,
      areaPath: c.areaPath,
      steps: c.steps,
    })),
    reasoning: "",
    coverageNotes: "",
  };
}

async function generateTestCasesFromContext(promptContext, userGuidance = "") {
  const isBdd = contextIsBdd(promptContext);
  console.log(isBdd ? "🤖 Generating BDD scenarios (Gherkin) with LLM..." : "🤖 Generating test cases with LLM...");

  // The format reference documents the standard CSV style — irrelevant, and
  // actively misleading, when the output is Gherkin.
  const testCaseFormatRef = isBdd ? "" : loadTestCaseFormatRef();
  if (testCaseFormatRef) {
    console.log("📋 Using TEST_CASE_FORMAT.md as mandatory format reference");
  }
  const testCasesLimit = promptContext.testCasesLimit ?? null;

  const prompt = isBdd
    ? generateBddTestCasesPrompt({ ...promptContext, userGuidance })
    : generateTestCasesPrompt({ ...promptContext, testCaseFormatRef, userGuidance });

  const response = await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "12000", 10));

  try {
    const cleanedResponse = response.replace(/```(?:json|csv)?\n?/g, "").trim();
    const raw = !isBdd && /^"?ID"?,"?Work Item Type"?,/i.test(cleanedResponse)
      ? testCasesFromCsvResponse(cleanedResponse)
      : JSON.parse(cleanedResponse);
    const parsed = guardLlmResult(raw, `test cases for ${promptContext.issueKey}`);
    if (!parsed.testCases || !Array.isArray(parsed.testCases)) {
      throw new Error("LLM response missing testCases array");
    }
    // BDD steps arrive as plain Gherkin lines; the canonical {action, expected}
    // rows are built here rather than asked of the model, so the grouping is the
    // same whichever model answered.
    parsed.testCases = isBdd
      ? bddFormat.normalizeBddTestCases(parsed.testCases)
      : normalizeExpectedInTestCases(parsed.testCases);
    if (isBdd) {
      parsed.format = "bdd";
      parsed.feature = String(parsed.feature || "").trim();
      parsed.featureDescription = String(parsed.featureDescription || "").trim();
      const empty = parsed.testCases.filter((tc) => !(tc.steps || []).length).length;
      if (empty) console.warn(`⚠️  ${empty} scenario(s) came back with no Gherkin lines and will be empty.`);
    }
    if (testCasesLimit !== null && parsed.testCases.length > testCasesLimit) {
      console.log(
        `⚠️  LLM returned ${parsed.testCases.length} test cases; trimming to TEST_CASES_LIMIT=${testCasesLimit}.`
      );
      parsed.testCases = parsed.testCases.slice(0, testCasesLimit);
    }
    return withCoverageCheck(parsed);
  } catch (error) {
    console.error("Failed to parse LLM test cases response:", error.message);
    console.error("Response:", response);
    throw new Error("LLM did not return valid test cases JSON");
  }
}

async function generateTestCases(issueData, relatedDocs) {
  return generateTestCasesFromContext(buildTestCasesPromptContext(issueData, relatedDocs));
}

/**
 * Human-readable summary of every context source this generation actually used.
 * Posted with the checklist/test cases so reviewers can see what the result is
 * based on (and notice when the wrong context slipped in, e.g. a stale export).
 * @returns {string} multi-line text block, or "" when there was no extra context
 */
function buildContextUsedText(relatedDocs, projectTestCaseFiles = []) {
  const lines = [];
  const related = relatedDocs.relatedJiraIssues || [];
  if (related.length > 0) {
    const meta = relatedDocs.relatedSearchMeta;
    const modeNote = meta
      ? ` (by ${meta.mode}: ${meta.queryWords.join(", ")})`
      : "";
    const withPrev = related.filter((r) => (r.previousQaChecklist || []).length > 0);
    lines.push(`- Related Jira issues${modeNote}: ${related.map((r) => r.key).join(", ")}`);
    if (withPrev.length > 0) {
      lines.push(`- Previously designed QA scenarios reused from: ${withPrev.map((r) => r.key).join(", ")}`);
    }
  }
  const pages = relatedDocs.confluencePages || [];
  if (pages.length > 0) {
    lines.push(`- Confluence pages: ${pages.map((p) => p.title || "(untitled)").join("; ")}`);
  }
  if (projectTestCaseFiles.length > 0) {
    lines.push(`- Existing test case files analyzed: ${projectTestCaseFiles.join(", ")}`);
  }
  if (relatedDocs.figmaStats) {
    const fs2 = relatedDocs.figmaStats;
    lines.push(`- Figma: ${fs2.scopeKind || "scope"} "${fs2.scopeName || "(unnamed)"}", ${fs2.framesAnalyzed || 0} frame(s)`);
  }
  if (relatedDocs.prototypeStats) {
    const ps = relatedDocs.prototypeStats;
    lines.push(
      `- Prototype: ${ps.entryUrl} — ${ps.screens} screen(s) crawled${ps.visionScreens ? `, ${ps.visionScreens} reviewed visually` : ""}`,
    );
  }
  if (relatedDocs.attachmentsStats && (relatedDocs.attachmentsStats.names || []).length) {
    lines.push(`- Attached files: ${relatedDocs.attachmentsStats.names.join(", ")}`);
  }
  if (relatedDocs.commentsStats && relatedDocs.commentsStats.used) {
    lines.push(`- Issue comments: ${relatedDocs.commentsStats.used} of ${relatedDocs.commentsStats.total}`);
  }
  if (relatedDocs.helpingPrompt) {
    const named = (relatedDocs.helpingPromptTestCases || []).length;
    lines.push(`- Helping prompt: yes${named ? ` (+ ${named} test case source(s) it names)` : ""}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return lines.join("\n");
}

function formatTestCasesComment(testCasesResult) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const humanList = testCases
    .map((tc, idx) => `${idx + 1}. ${(tc.title || "").trim()} (${(tc.steps || []).length} steps)`)
    .join("\n");
  const payload = JSON.stringify({ testCases, reasoning }, null, 2);
  return `🤖 AI-Generated Test Cases

To approve specific test cases, reply with:

APPROVED: 1,2,3

(or APPROVED: all). Then run the agent again with CHECK_APPROVAL=true to generate a CSV with only approved test cases.

---
${reasoning ? `Reasoning:\n${reasoning}\n---\n` : ""}
Proposed test cases (summary):
${humanList}

---
📌 Generated automatically from Jira issue.

\`\`\`json
${payload}
\`\`\``;
}

/**
 * Build ADF document for test cases comment (heading + approval + optional reasoning, then tables).
 * JSON is stored in an attachment, not in the comment. Reasoning stays above tables so nothing
 * long appears after the generated steps (avoids looking like “instructions after” the cases).
 */
function buildTestCasesCommentAdf(testCasesResult, extras = {}) {
  const testCases = testCasesResult.testCases || [];
  const reasoning = testCasesResult.reasoning || "";
  const coverageNotes = String(testCasesResult.coverageNotes || "").trim();
  const contextUsed = String(extras.contextUsed || "").trim();
  // A Gherkin scenario read out of a 3-column table is unreadable — the reviewer
  // needs to see the Given/When/Then flow.
  const isBdd =
    testCasesResult.format === "bdd" || bddFormat.anyBddTestCase(testCases);
  // No approval instructions any more: replying "APPROVED: 1,2,3" is read by nothing. Only a
  // direct CLI run reaches this comment — every web-UI run approves in the review panel, which
  // posts the CSV instead of this. So the comment says what it is, and where approving happens.
  const content = [
    JiraClient.buildAdfHeading(isBdd ? "🤖 AI-Generated BDD Scenarios (Gherkin)" : "🤖 AI-Generated Test Cases", 3),
    JiraClient.buildAdfParagraph(
      `Generated design, for reference. Approving happens in the review panel of the web UI (npm run web): mark each ${
        isBdd ? "scenario" : "test case"
      } APPROVED there and press Submit to Jira, which attaches the approved rows as a CSV.`
    ),
  ];
  if (isBdd) {
    const feature = String(testCasesResult.feature || "").trim();
    if (feature) content.push(JiraClient.buildAdfHeading(`Feature: ${feature}`, 4));
    const featureDescription = String(testCasesResult.featureDescription || "").trim();
    if (featureDescription) content.push(JiraClient.buildAdfParagraph(featureDescription));
  }
  if (reasoning) {
    content.push(JiraClient.buildAdfHeading("Reasoning", 4));
    content.push(JiraClient.buildAdfParagraph(reasoning));
  }
  if (coverageNotes) {
    content.push(JiraClient.buildAdfHeading("Coverage notes (vs existing tests)", 4));
    content.push(JiraClient.buildAdfParagraph(coverageNotes));
  }
  if (contextUsed) {
    content.push(JiraClient.buildAdfHeading("Context used", 4));
    content.push(JiraClient.buildAdfParagraph(contextUsed));
  }
  testCases.forEach((tc, idx) => {
    content.push(JiraClient.buildAdfParagraph(`${idx + 1}. ${(tc.title || "").trim()}`));
    if (isBdd) {
      // Preconditions are not part of the scenario, so they get their own line
      // above it — the reviewer approves from this comment and must see both.
      const { preconditions } = bddFormat.splitPreconditionsRow(tc.steps);
      if (preconditions) {
        content.push(JiraClient.buildAdfParagraph(`Preconditions: ${preconditions.replace(/\n/g, " ")}`));
      }
      content.push(
        JiraClient.buildAdfCodeBlock(bddFormat.testCaseToScenarioText(tc), "gherkin")
      );
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

function parseTestCasesFromComment(commentText) {
  if (!commentText || typeof commentText !== "string") return null;
  let jsonStr = null;
  const codeBlockMatch = commentText.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const idx = commentText.indexOf('"testCases"');
    if (idx !== -1) {
      let start = commentText.lastIndexOf("{", idx);
      if (start !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < commentText.length; i++) {
          if (commentText[i] === "{") depth++;
          else if (commentText[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end !== -1) jsonStr = commentText.slice(start, end + 1);
      }
    }
  }
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.testCases && Array.isArray(parsed.testCases) ? parsed.testCases : null;
  } catch {
    return null;
  }
}

function formatChecklistComment(checklist, reasoning, extras = {}) {
  const items = checklist.checklistItems || [];
  const itemsList = items
    .map((item, idx) => `${idx + 1}. [${item.category}] ${item.description}`)
    .join("\n");
  const coverageNotes = String(checklist.coverageNotes || "").trim();
  const contextUsed = String(extras.contextUsed || "").trim();
  const coverageBlock = coverageNotes
    ? `\n---\nCoverage notes (vs existing tests):\n${coverageNotes}\n`
    : "";
  const contextBlock = contextUsed
    ? `\n---\nContext used:\n${contextUsed}\n`
    : "";

  return `🤖 AI-Generated Test Checklist

Generated design, for reference. Approving happens in the review panel of the web UI (npm run web):
mark each item APPROVED there and press Submit to Jira, which attaches the approved items as a CSV.
Replying to this comment approves nothing.

---
Proposed test scenarios:
${itemsList}

---
Label Matching Analysis:
${reasoning || "N/A"}
${coverageBlock}${contextBlock}
---
📌 Generated automatically from Jira issue + related Confluence pages`;
}

function parseApprovalComment(commentBody, totalItems) {
  if (!commentBody) return null;

  // Safety: do not treat checklist instructions as approval.
  // We only accept approval if the FIRST non-empty line starts with "APPROVED:".
  // This prevents matching example text like "APPROVED: 1,2,3" embedded in the checklist comment.
  const firstNonEmptyLine =
    commentBody
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";

  if (!/^approved:/i.test(firstNonEmptyLine)) {
    return null;
  }

  // Look for APPROVED: pattern (case-insensitive, flexible whitespace)
  // Supports formats like:
  // - APPROVED: 1,2,3
  // - APPROVED: 1, 2, 3
  // - APPROVED: all
  // - Approved: 1,2,3
  // - approved: 1,2,3
  const approvalMatch = firstNonEmptyLine.match(/^APPROVED:\s*([\d,\s]+|all)\s*$/i);
  
  if (!approvalMatch) {
    return null;
  }

  const approvedValue = approvalMatch[1].toLowerCase().trim();
  
  if (approvedValue === "all") {
    // Return all item indices (1-based)
    console.log(`   📋 Approval: ALL items (${totalItems} total)`);
    return Array.from({ length: totalItems }, (_, i) => String(i + 1));
  }

  // Parse comma-separated numbers
  const approvedItems = approvedValue
    .split(",")
    .map(n => n.trim())
    .filter(n => n.length > 0 && !isNaN(n))
    .map(n => {
      const num = parseInt(n, 10);
      // Validate that the number is within range
      if (num < 1 || num > totalItems) {
        console.warn(`   ⚠️  Warning: Item ${num} is out of range (1-${totalItems})`);
        return null;
      }
      return String(num);
    })
    .filter(n => n !== null);

  if (approvedItems.length > 0) {
    console.log(`   📋 Approval: Items ${approvedItems.join(", ")}`);
    return approvedItems;
  }
  
  return null;
}



function parseChecklistItemsFromChecklistComment(checklistCommentText) {
  // Expects lines like:
  // 1. [Functional] Some description
  // 2. [Negative] Another description
  if (!checklistCommentText || typeof checklistCommentText !== "string") return [];

  const lines = checklistCommentText.split(/\r?\n/);
  const itemsByNumber = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\s*(.+)$/);
    if (!m) continue;

    const num = parseInt(m[1], 10);
    const category = (m[2] || "").trim();
    const description = (m[3] || "").trim();

    if (!Number.isFinite(num) || num < 1) continue;
    if (!description) continue;

    // Keep first occurrence per number
    if (!itemsByNumber.has(num)) {
      itemsByNumber.set(num, { id: `CL-${String(num).padStart(3, "0")}`, category, description });
    }
  }

  // Return dense array in numeric order (1..N), skipping gaps if any
  return Array.from(itemsByNumber.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
}

function findLatestCommentTextContaining(comments, needle) {
  const needleLower = String(needle || "").toLowerCase();
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const text = (c.bodyText || c.body || "").toString();
    if (text.toLowerCase().includes(needleLower)) {
      return { comment: c, text };
    }
  }
  return null;
}

/** All comments containing needle, oldest first (matches post order for updated CSV segments). */
function findAllCommentsTextContaining(comments, needle) {
  const needleLower = String(needle || "").toLowerCase();
  const out = [];
  for (const c of comments) {
    const text = (c.bodyText || c.body || "").toString();
    if (text.toLowerCase().includes(needleLower)) {
      out.push({ comment: c, text });
    }
  }
  out.sort((a, b) => new Date(a.comment.created || 0) - new Date(b.comment.created || 0));
  return out;
}

const UPDATED_CSV_FLOW_TC_MARKER = "ai-generated test cases (updated csv flow)";

/**
 * Ordered JSON attachments for generated-testcases-*.json (same sort as merge).
 * @returns {Promise<Array<{ filename: string, created: number, testCases: object[] }>>}
 */
async function loadOrderedTestCaseJsonSlices(jiraClient, issueKey) {
  try {
    const attachments = await jiraClient.getAttachments(issueKey);
    if (!attachments || !attachments.length) return [];
    const jsonAtts = attachments.filter(
      (a) =>
        (a.filename || "").startsWith("generated-testcases-") && (a.filename || "").endsWith(".json")
    );
    if (!jsonAtts.length) return [];
    jsonAtts.sort((a, b) => {
      const fa = a.filename || "";
      const fb = b.filename || "";
      const ma = fa.match(/-seg(\d+)\.json$/i);
      const mb = fb.match(/-seg(\d+)\.json$/i);
      if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
      if (ma && !mb) return 1;
      if (!ma && mb) return -1;
      return fa.localeCompare(fb);
    });
    const slices = [];
    for (const att of jsonAtts) {
      if (!att.content) continue;
      try {
        const raw = await jiraClient.getAttachmentContent(att.content);
        const parsed = JSON.parse(raw);
        if (parsed.testCases && Array.isArray(parsed.testCases) && parsed.testCases.length) {
          const created = Date.parse(att.created) || 0;
          slices.push({ filename: att.filename || "", created, testCases: parsed.testCases });
        }
      } catch (e) {
        console.warn(`   ⚠️  Skip attachment ${att.filename}: ${e.message}`);
      }
    }
    return slices;
  } catch (e) {
    console.warn(`   ⚠️  Could not read test case attachments: ${e.message}`);
    return [];
  }
}

/**
 * Blocks from Update test design / updated CSV flow only (detected via comment markers).
 * Order = chronological merge of checklist comments and test-case JSON posts (by Jira timestamps).
 * @returns {Promise<Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', items: object[], partLabel: string }>>}
 */
async function buildUpdatedDesignApprovalBlocks(jiraClient, commentHostKey, comments) {
  const checklistHits = findAllCommentsTextContaining(
    comments,
    "AI-Generated Test Checklist (Updated CSV flow)"
  );
  const clEvents = checklistHits.map((h) => ({
    t: new Date(h.comment.created || 0).getTime(),
    type: "checklist",
    text: h.text,
  }));

  const jsonSlices = await loadOrderedTestCaseJsonSlices(jiraClient, commentHostKey);
  const tcMarkerComments = comments
    .filter((c) => {
      const body = (c.bodyText || c.body || "").toString().toLowerCase();
      return body.includes(UPDATED_CSV_FLOW_TC_MARKER);
    })
    .sort((a, b) => new Date(a.created || 0).getTime() - new Date(b.created || 0).getTime());

  const tcEvents = [];
  for (let i = 0; i < tcMarkerComments.length; i++) {
    const c = tcMarkerComments[i];
    const slice = jsonSlices[i];
    if (!slice || !slice.testCases.length) {
      console.warn(`   ⚠️  Updated-design test case comment without matching JSON attachment (index ${i + 1})`);
      continue;
    }
    tcEvents.push({
      t: new Date(c.created || 0).getTime(),
      type: "testcases",
      testCases: slice.testCases,
    });
  }
  if (jsonSlices.length > tcMarkerComments.length) {
    console.warn(
      `   ⚠️  ${jsonSlices.length - tcMarkerComments.length} test case JSON attachment(s) have no matching "(Updated CSV flow)" comment — ignored for block ordering`
    );
  }

  const merged = [...clEvents, ...tcEvents].sort((a, b) => a.t - b.t);
  const blocks = [];
  for (const e of merged) {
    if (e.type === "checklist") {
      const items = parseChecklistItemsFromChecklistComment(e.text);
      if (!items.length) continue;
      blocks.push({
        type: "checklist",
        items,
        partLabel: parseChecklistPartLabelFromComment(e.text),
      });
    } else {
      blocks.push({ type: "testcases", testCases: e.testCases });
    }
  }
  return blocks;
}

/**
 * Approval for Update test design only. Block indices are 1-based in post order (see summary comment).
 * - First line "APPROVED" or "APPROVED:" / "APPROVED: all" → all blocks fully approved.
 * - "APPROVED (n)" → whole block n (checklist or test-case segment).
 * - "APPROVED (n): 1,2,3" → only items 1,2,3 inside block n (checklist lines or numbered test cases in that post).
 * - "APPROVED (n): all" → whole block n (same as plain APPROVED (n)).
 * - If exactly one block: "APPROVED: 1,2,3" still means approve items 1..n within that block (legacy).
 * When there are 2+ blocks, `processUpdatedDesignApprovalFromBlocks` requires every block index to be covered (see getBlockIndicesRequiringExplicitApproval) unless the comment is blanket APPROVED / APPROVED: all.
 */
/**
 * Find every "APPROVED (n)" / "APPROVED (n): <rhs>" directive in the text, regardless of whether
 * each one is on its own line or several are comma-separated on a single line, e.g.:
 *   "APPROVED (1): all, APPROVED (2): all, APPROVED (5): 5,10,15,25"
 * The RHS of a directive runs from the directive header until the next "APPROVED (" header (or end
 * of text); a trailing separator (comma/semicolon/whitespace) is stripped so numbers stay intact.
 * @param {string} text
 * @returns {Array<{ blockIndex: number, hasColon: boolean, rhs: string }>}
 */
function tokenizeUpdatedDesignDirectives(text) {
  const s = String(text || "");
  const headerRe = /APPROVED\s*\(\s*(\d+)\s*\)\s*(:)?/gi;
  const headers = [];
  let m;
  while ((m = headerRe.exec(s)) !== null) {
    headers.push({
      start: m.index,
      end: headerRe.lastIndex,
      blockIndex: parseInt(m[1], 10),
      hasColon: !!m[2],
    });
  }
  const out = [];
  for (let i = 0; i < headers.length; i += 1) {
    const cur = headers[i];
    const next = headers[i + 1];
    let rhs = s.slice(cur.end, next ? next.start : s.length);
    rhs = rhs.replace(/^[\s,;]+/, "").replace(/[\s,;]+$/, "").trim();
    out.push({ blockIndex: cur.blockIndex, hasColon: cur.hasColon, rhs });
  }
  return out;
}

function parseUpdatedDesignApprovalComment(commentBody, blocks) {
  if (!commentBody || !blocks || !blocks.length) return null;
  const lines = String(commentBody)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return null;

  const first = lines[0];
  if (
    /^APPROVED\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*all\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*[.!]*\s*$/i.test(first)
  ) {
    return { kind: "all" };
  }

  const blockCount = blocks.length;
  /** @type {Map<number, { mode: 'all' } | { mode: 'pick', items: Set<number> }>} */
  const byBlock = new Map();

  // Tokenize the WHOLE comment (not line-by-line): supports multiple "APPROVED (n)…"
  // directives separated by commas on a single line as well as one-per-line.
  for (const directive of tokenizeUpdatedDesignDirectives(commentBody)) {
    const bi = directive.blockIndex;
    if (!Number.isFinite(bi) || bi < 1 || bi > blockCount) continue;
    const rhs = directive.rhs;
    // "APPROVED (n)" (no colon), "APPROVED (n):" (empty), or "APPROVED (n): all" → whole block.
    if (!directive.hasColon || rhs === "" || /^all\s*[.!]*$/i.test(rhs)) {
      byBlock.set(bi, { mode: "all" });
      continue;
    }
    const nums = rhs
      .split(/[,;]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) continue;
    const cur = byBlock.get(bi);
    if (cur && cur.mode === "all") continue;
    const set = cur && cur.mode === "pick" ? new Set(cur.items) : new Set();
    nums.forEach((n) => set.add(n));
    byBlock.set(bi, { mode: "pick", items: set });
  }

  if (byBlock.size > 0) {
    /** @type {Array<{ blockIndex: number, mode: 'all' } | { blockIndex: number, mode: 'pick', items: number[] }>} */
    const entries = [];
    for (const bi of [...byBlock.keys()].sort((a, b) => a - b)) {
      const spec = byBlock.get(bi);
      const b = blocks[bi - 1];
      const max =
        b.type === "checklist" ? b.items.length : ((b.testCases || []).length || 0);
      if (spec.mode === "all") {
        entries.push({ blockIndex: bi, mode: "all" });
      } else {
        const ok = [...spec.items].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b);
        if (!ok.length) continue;
        entries.push({ blockIndex: bi, mode: "pick", items: ok });
      }
    }
    if (entries.length) return { kind: "byBlock", entries };
  }

  if (blocks.length === 1) {
    const b0 = blocks[0];
    const total =
      b0.type === "checklist" ? b0.items.length : (b0.testCases || []).length;
    if (total < 1) return null;
    const approvedKeys = parseApprovalComment(commentBody, total);
    if (approvedKeys && approvedKeys.length) {
      return { kind: "items", approvedKeys };
    }
  }

  return null;
}

function isUpdatedFlowSummaryCommentBody(text) {
  return String(text || "").includes("Updated CSV flow: source file");
}

/** Latest `Updated CSV flow: source file …` summary comment time (ms), or 0 if none. */
function findLatestUpdatedCsvSummaryCommentMs(comments) {
  let max = 0;
  for (const c of comments || []) {
    const body = (c.bodyText || c.body || "").toString();
    if (!isUpdatedFlowSummaryCommentBody(body)) continue;
    const ms = new Date(c.created || 0).getTime();
    if (Number.isFinite(ms) && ms >= max) max = ms;
  }
  return max;
}

function isBlanketApprovalFirstLineOfComment(text) {
  const first =
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  return (
    /^APPROVED\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*all\s*[.!]*\s*$/i.test(first) ||
    /^APPROVED:\s*[.!]*\s*$/i.test(first)
  );
}

/**
 * Lines that are approval directives only (avoids bullets like "• … APPROVED …" in footers).
 */
function extractApprovedDirectiveLines(text) {
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      /^APPROVED\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*all\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*[.!]*\s*$/i.test(line) ||
      /^APPROVED:\s*[\d,\s]+$/i.test(line) ||
      /^APPROVED\s*\(\s*\d+\s*\)/i.test(line)
    ) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Merge APPROVED… directives from one or more Jira comments (same or separate comments).
 * - After the latest "Updated CSV flow: source file" summary, all matching lines are concatenated in time order.
 * - If there is no summary anchor, only the last 30 non-summary comments are considered.
 * - If the newest matching comment is a blanket APPROVED / APPROVED: all, only that comment body is used.
 */
function getMergedApprovalTextForUpdatedDesign(comments, blocks) {
  if (!comments || !comments.length || !blocks || !blocks.length) return null;

  const sorted = [...comments].sort(
    (a, b) => new Date(a.created || 0).getTime() - new Date(b.created || 0).getTime()
  );
  const anchorMs = findLatestUpdatedCsvSummaryCommentMs(sorted);

  let pool = sorted.filter((c) => !isUpdatedFlowSummaryCommentBody(c.bodyText || c.body || ""));
  if (anchorMs > 0) {
    pool = pool.filter((c) => new Date(c.created || 0).getTime() >= anchorMs);
  } else {
    pool = pool.slice(-30);
  }

  for (let i = pool.length - 1; i >= 0; i--) {
    const t = (pool[i].bodyText || pool[i].body || "").toString();
    if (isBlanketApprovalFirstLineOfComment(t)) {
      const parsed = parseUpdatedDesignApprovalComment(t.trim(), blocks);
      if (parsed) return t.trim();
    }
  }

  const lines = [];
  for (const c of pool) {
    lines.push(...extractApprovedDirectiveLines(c.bodyText || c.body || ""));
  }
  if (!lines.length) return null;
  const merged = lines.join("\n");
  return parseUpdatedDesignApprovalComment(merged, blocks) ? merged : null;
}


/** First line e.g. "Part 1/3 — Title" from updated CSV flow checklist comments. */
function parseChecklistPartLabelFromComment(commentText) {
  const first = String(commentText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  const m = first.match(/^Part\s+(\d+)\/(\d+)\s*(?:[—\-]\s*(.+))?$/i);
  if (!m) return "";
  const subtitle = (m[3] || "").trim();
  return subtitle ? `Part ${m[1]}/${m[2]}: ${subtitle}` : `Part ${m[1]}/${m[2]}`;
}

/**
 * When the update posted more than one block (any mix of test-case segments + checklists),
 * each global block index 1..N must appear in the approval before CSV export (unless APPROVED / APPROVED: all).
 */
function getBlockIndicesRequiringExplicitApproval(blocks) {
  if (!blocks || blocks.length <= 1) return new Set();
  return new Set(blocks.map((_, i) => i + 1));
}

function explicitApprovalCoversBlockIndices(spec, blocks, requiredIndices) {
  if (!requiredIndices || requiredIndices.size === 0) return true;
  if (spec.kind === "all") return true;

  const covered = new Set();
  if (spec.kind === "byBlock") {
    for (const ent of spec.entries) {
      if (requiredIndices.has(ent.blockIndex)) covered.add(ent.blockIndex);
    }
  } else if (spec.kind === "items" && blocks.length === 1 && requiredIndices.has(1)) {
    covered.add(1);
  }

  for (const idx of requiredIndices) {
    if (!covered.has(idx)) return false;
  }
  return true;
}

/**
 * Merge test cases from all generated-testcases-*.json attachments (base + -seg2, -seg3, …).
 * @returns {Promise<object[]|null>}
 */
async function mergeTestCasesFromAttachments(jiraClient, issueKey) {
  const slices = await loadOrderedTestCaseJsonSlices(jiraClient, issueKey);
  if (!slices.length) return null;
  const all = [];
  for (const s of slices) all.push(...s.testCases);
  return all.length ? all : null;
}

/**
 * Resolve the issue key where CSV (attachment + comment) must be added:
 * the QA Sub-task with title "Test design" that belongs to the same story/improvement
 * to which the checklist was created (parent of the current issue, or current issue if it is the parent).
 * @param {import("./jira-client").JiraClient} jiraClient
 * @param {string} issueKey - Current issue (where checklist was created or where we're processing)
 * @param {object} issue - Full Jira issue (must have fields.issuetype and fields.parent)
 * @returns {Promise<string>} Issue key of the Test design subtask (Azure DevOps only), or issueKey
 */
async function resolveCsvTargetIssueKey(jiraClient, issueKey, issue) {
  const mainIssueKey = contextIssueKeyFor(issue, issueKey);
  const testDesignKey = await testDesignSubtaskKeyFor(jiraClient, mainIssueKey, PROJECT_KEY);
  const target = testDesignKey || issueKey;
  if (target !== issueKey) {
    console.log(`   📎 CSV will be added to Test design subtask: ${target} (of story ${mainIssueKey})`);
  }
  return target;
}

async function processApprovalAndGenerateTestCases(issueKey, checklistResult, jiraClient, confluenceClient, issueData, relatedDocs) {
  console.log("⏳ Checking for approval comments...");
  
  // Get all comments
  const comments = await jiraClient.getComments(issueKey);
  console.log(`   📝 Found ${comments.length} comment(s) in issue`);
  
  if (comments.length === 0) {
    console.log("ℹ️  No comments found. Skipping CSV generation.");
    console.log("   To generate CSV, add a comment with: APPROVED: 1,2,3 or APPROVED: all");
    return null;
  }
  
  // Find the most recent approval comment (check from newest to oldest)
  let approvedItems = null;
  let approvalCommentAuthor = null;
  let approvalCommentDate = null;
  
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    // Jira API v3 comment body is ADF; jira-client adds bodyText for convenience
    const commentBody = comment.bodyText || comment.body || "";
    
    // Check if this comment contains approval
    approvedItems = parseApprovalComment(commentBody, checklistResult.checklistItems.length);
    
    if (approvedItems) {
      approvalCommentAuthor = comment.author?.displayName || "Unknown";
      approvalCommentDate = comment.created || "Unknown";
      console.log(`✅ Found approval comment from ${approvalCommentAuthor} (${approvalCommentDate})`);
      console.log(`   Approved items: ${approvedItems.join(", ")}`);
      break;
    }
  }

  if (!approvedItems || approvedItems.length === 0) {
    console.log("ℹ️  No approval comment found. Skipping CSV generation.");
    console.log("   To generate CSV, add a comment with: APPROVED: 1,2,3 or APPROVED: all");
    console.log(`   Current checklist has ${checklistResult.checklistItems.length} items`);
    return null;
  }

  // Build list of approved checklist items { number, item }
  const approvedItemsList = approvedItems
    .map((idx) => parseInt(idx, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= checklistResult.checklistItems.length)
    .map((n) => ({ number: n, item: checklistResult.checklistItems[n - 1] }));

  // CSV must be added to the Test design subtask of the same story/improvement
  const issueForTarget = await jiraClient.getIssueWithExpand(issueKey);
  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issueForTarget);

  // Generate CSV file with approved checklist (save to CHECKLIST_OUTPUT_DIR, not in project)
  const csvFileName = approvedChecklistCsvFilename(issueKey, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedChecklistCSV(issueData, approvedItemsList, csvFilePath);
    console.log(`\n📄 Generated CSV: ${csvFilePath}`);
    // Upload CSV as attachment to Jira (on Test design subtask)
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    // Add comment with link to the CSV attachment (on Test design subtask)
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved checklist (CSV)", attachmentUrl, attachmentFileName);
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
  }

  return { csvPath: csvFilePath, approvedCount: approvedItemsList.length };
}

/**
 * One importer per provider, all returning the same `{ created, errors, usage }`.
 *
 * There is no per-provider on/off switch: choosing "Automate import into …" in Steps is the
 * decision to import, and a second switch on the Setup page only made that step quietly do nothing.
 */
const TMS_IMPORTERS = {
  ado: {
    title: "Azure DevOps",
    created: (c) => `Azure DevOps Test Case #${c.id}`,
    // `target` is the container the Manual Import step picked. Empty for the automate step, which
    // is what `syncFromApprovalRun` switches on: match the suite from the Jira key instead.
    run: (csvFilePath, jiraIssueKey, bddPromptContext, target) =>
      require("./ado-sync-csv").syncApprovedCsvToAzureDevOps(csvFilePath, {
        jiraIssueKey: jiraIssueKey || "",
        ...(target && target.suiteId ? target : { syncFromApprovalRun: true }),
        bddPromptContext,
      }),
  },
  testrail: {
    title: "TestRail",
    created: (c) => `TestRail case C${c.id}`,
    run: (csvFilePath, jiraIssueKey, bddPromptContext, target) =>
      require("./testrail-sync-csv").syncApprovedCsvToTestRail(csvFilePath, {
        jiraIssueKey: jiraIssueKey || "",
        ...(target && target.sectionId ? target : {}),
      }),
  },
  zephyr: {
    title: "Zephyr Essential",
    // Zephyr addresses a case by key, not by a numeric id like the other two.
    created: (c) => `Zephyr case ${c.id}`,
    run: (csvFilePath, jiraIssueKey, bddPromptContext, target) =>
      require("./zephyr-sync-csv").syncApprovedCsvToZephyr(csvFilePath, {
        jiraIssueKey: jiraIssueKey || "",
        ...(target && target.folderId ? target : {}),
      }),
  },
  xray: {
    title: "Xray",
    // An Xray test is a Jira issue, so what comes back is a Jira key — clickable in the same tab
    // as the story it covers.
    created: (c) => `Xray test ${c.id}`,
    run: (csvFilePath, jiraIssueKey, bddPromptContext, target) =>
      require("./xray-sync-csv").syncApprovedCsvToXray(csvFilePath, {
        jiraIssueKey: jiraIssueKey || "",
        ...(target && target.folderPath ? target : {}),
      }),
  },
};

/**
 * Import the approved CSV into the provider marked "In use" on the Setup page
 * (`TMS_PROVIDER`). An approved CSV has one destination, so a provider that is
 * merely configured never receives it.
 *
 * Azure DevOps needs ADO_ORG / ADO_PROJECT / ADO_PAT with Work Items **Write**;
 * TestRail needs the instance URL, email, API key, project and suite, and finds
 * its section from the Jira key (see TESTRAIL.md).
 */
async function maybeSyncCsvToTms(csvFilePath, jiraIssueKey, issueData = null) {
  const { id: provider, title } = require("./config-store.js").activeProviderInfo();
  const importer = TMS_IMPORTERS[provider];

  if (!provider) {
    console.log(`ℹ️  ${require("./config-store.js").NO_PROVIDER_MESSAGE} Nothing was imported.`);
    return null;
  }
  // Only the provider in use is reported on: the others are not part of this run.
  if (!importer) {
    console.log(`ℹ️  No CSV importer for "${title}" yet — nothing was imported.`);
    return null;
  }
  if (!csvFilePath || !fs.existsSync(csvFilePath)) {
    console.warn(`⚠️  Approved CSV file not found, skipping ${title}`);
    return null;
  }
  try {
    console.log(`📤 Syncing approved CSV to ${title}...`);
    // The requirement behind the approved CSV, for the importer's Gherkin Summary. Only the three
    // fields the BDD prompt reads are handed over — the rest of issueData is irrelevant to it.
    const bddPromptContext = issueData
      ? {
          issueKey: issueData.key,
          issueDescription: issueData.description || "",
          issueLabels: Array.isArray(issueData.labels) ? issueData.labels : [],
        }
      : null;
    const r = await importer.run(csvFilePath, jiraIssueKey, bddPromptContext);
    // BDD text is generated inside the sync; fold those tokens into this run's total.
    mergeUsage(runUsage, r.usage);
    r.created.forEach((c) => console.log(`   ✅ ${importer.created(c)}: ${c.title}`));
    if (r.errors.length) {
      r.errors.forEach((e) => console.warn(`   ⚠️  ${title} sync: ${e}`));
    }
    return r;
  } catch (e) {
    console.warn(`⚠️  ${title} sync failed: ${e.message}`);
    return null;
  }
}

/**
 * The approved CSV for a ticket, taken back off Jira.
 *
 * Both import steps start here. There is nothing to interpret any more: the reviewer approved
 * rows in the panel, Submit wrote them as a CSV and attached it to the Test design sub-task, so
 * an import is "fetch the newest CSV for this key and load it". No APPROVED comment is read, and
 * none is required.
 *
 * The copy is written to a sub-folder of its own so it never overwrites the file Submit produced
 * locally — same content, but one is this machine's artefact and the other is the ticket's.
 *
 * @returns {Promise<{ csvPath: string, fileName: string, hostKey: string, issueData: object }>}
 */
async function approvedCsvFromJira(jiraClient, jiraIssueKey) {
  const issue = await jiraClient.getIssueWithExpand(jiraIssueKey);
  const contextIssueKey = contextIssueKeyFor(issue, jiraIssueKey);

  // The rows were written against the story; with Azure DevOps the attachment lives on its
  // Test design sub-task, with any other TMS on the typed-in key.
  let issueData = jiraClient.extractIssueData(issue);
  if (contextIssueKey !== jiraIssueKey) {
    try {
      issueData = jiraClient.extractIssueData(await jiraClient.getIssueWithExpand(contextIssueKey));
    } catch (e) {
      console.warn(`⚠️  Could not load ${contextIssueKey} for CSV metadata: ${e.message}`);
    }
  }

  const testDesignKey = await testDesignSubtaskKeyFor(jiraClient, contextIssueKey, PROJECT_KEY);
  const hostKey = testDesignKey || jiraIssueKey;
  if (hostKey !== jiraIssueKey) {
    console.log(`   Reading the approved CSV from Test design subtask ${hostKey} (story ${contextIssueKey})`);
  }

  const found = await fetchLatestApprovedCsv(jiraClient, hostKey, path.join(CHECKLIST_OUTPUT_DIR, "From Jira"));
  return { ...found, hostKey, issueData };
}

/**
 * "Automate import into …": take the ticket's approved CSV and import it into the container
 * matched from the Jira key. What used to be the CHECK_APPROVAL run, minus the approval comment.
 */
async function importApprovedCsvFromJira(issueKey) {
  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  const { csvPath, fileName, issueData } = await approvedCsvFromJira(jiraClient, issueKey);
  const tmsImport = await maybeSyncCsvToTms(csvPath, issueData.key, issueData);
  return { status: "success", csvPath, fileName, tmsImport };
}

/**
 * Approval + CSV when the Test design subtask has Update test design / "(Updated CSV flow)" blocks.
 */
async function processUpdatedDesignApprovalFromBlocks(
  issueKey,
  jiraClient,
  issue,
  issueData,
  commentHostKey,
  comments,
  blocks
) {
  const approvalText = getMergedApprovalTextForUpdatedDesign(comments, blocks);
  if (!approvalText) {
    console.log(
      "ℹ️  No approval comment found for Update test design flow. Use APPROVED / APPROVED: all, or APPROVED (n) / APPROVED (n): 1,2,3 (directives can be in one comment or split across several comments after the latest \"Updated CSV flow: source file\" summary)."
    );
    return { status: "skipped", reason: "No approval comment" };
  }

  const spec = parseUpdatedDesignApprovalComment(approvalText, blocks);
  if (!spec) {
    console.log(
      "ℹ️  Approval text not recognized for this flow. Examples: APPROVED (1), APPROVED (2): 1,3,5, APPROVED (1): 1,2,3,4. With a single block you may use APPROVED: 1,2,3 for items."
    );
    return { status: "skipped", reason: "No valid approval" };
  }

  const requiredBlockIndices = getBlockIndicesRequiringExplicitApproval(blocks);
  if (!explicitApprovalCoversBlockIndices(spec, blocks, requiredBlockIndices)) {
    const sortedNeed = [...requiredBlockIndices].sort((a, b) => a - b);
    const example = sortedNeed.map((i) => `APPROVED (${i})`).join(" and ");
    const covered = new Set();
    if (spec.kind === "byBlock") {
      for (const ent of spec.entries) {
        if (requiredBlockIndices.has(ent.blockIndex)) covered.add(ent.blockIndex);
      }
    } else if (spec.kind === "items" && blocks.length === 1 && requiredBlockIndices.has(1)) {
      covered.add(1);
    }
    const missing = sortedNeed.filter((idx) => !covered.has(idx));
    console.log(
      `ℹ️  This update posted ${blocks.length} block(s) (test case groups and/or checklists). Each block needs its own approval line before a CSV is generated (for example: ${example}), or use a first line APPROVED or APPROVED: all for everything. Missing block index(es): ${missing.join(
        ", "
      )}. CSV not generated.`
    );
    return { status: "skipped", reason: "Incomplete multi-block approval" };
  }

  /** @type {Array<{ type: 'testcases', testCases: object[] } | { type: 'checklist', partLabel: string, approvedItems: { number: number, item: object }[] }>} */
  const sections = [];

  if (spec.kind === "all") {
    for (const b of blocks) {
      if (b.type === "testcases") {
        sections.push({ type: "testcases", testCases: [...b.testCases] });
      } else {
        const approvedItems = b.items.map((item, idx) => ({ number: idx + 1, item }));
        sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
      }
    }
    console.log(`✅ Approval: all ${blocks.length} block(s) (Update test design flow)`);
  } else if (spec.kind === "byBlock") {
    const parts = [];
    for (const ent of spec.entries) {
      const b = blocks[ent.blockIndex - 1];
      if (!b) continue;
      if (ent.mode === "all") {
        parts.push(String(ent.blockIndex));
        if (b.type === "testcases") {
          sections.push({ type: "testcases", testCases: [...b.testCases] });
        } else {
          const approvedItems = b.items.map((item, idx) => ({ number: idx + 1, item }));
          sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
        }
      } else if (ent.mode === "pick" && ent.items && ent.items.length) {
        parts.push(`${ent.blockIndex}:${ent.items.join(",")}`);
        if (b.type === "checklist") {
          const approvedItems = ent.items
            .map((n) => ({ number: n, item: b.items[n - 1] }))
            .filter((x) => x.item);
          if (approvedItems.length) {
            sections.push({ type: "checklist", partLabel: b.partLabel || "", approvedItems });
          }
        } else {
          const approvedTCs = ent.items.map((n) => b.testCases[n - 1]).filter(Boolean);
          if (approvedTCs.length) {
            sections.push({ type: "testcases", testCases: approvedTCs });
          }
        }
      }
    }
    console.log(`✅ Approval: by-block ${parts.join(" | ")} (${blocks.length} block(s) on issue) — Update test design flow`);
  } else if (spec.kind === "items") {
    const b0 = blocks[0];
    const keys = spec.approvedKeys;
    if (b0.type === "checklist") {
      const approvedItems = keys
        .map((k) => parseInt(k, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= b0.items.length)
        .map((n) => ({ number: n, item: b0.items[n - 1] }))
        .filter((x) => x.item);
      sections.push({ type: "checklist", partLabel: b0.partLabel || "", approvedItems });
    } else {
      const approvedTCs = keys
        .map((k) => parseInt(k, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= b0.testCases.length)
        .map((n) => b0.testCases[n - 1])
        .filter(Boolean);
      sections.push({ type: "testcases", testCases: approvedTCs });
    }
    console.log(`✅ Approval: items ${keys.join(", ")} within the only block (Update test design flow)`);
  }

  if (!sections.length) {
    return { status: "skipped", reason: "No approved content after filtering" };
  }

  let totalLines = 0;
  for (const s of sections) {
    if (s.type === "testcases") totalLines += (s.testCases || []).length;
    else totalLines += (s.approvedItems || []).length;
  }

  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
  const csvFileName = approvedChecklistCsvFilename(issueData.key, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedUpdatedDesignCsv(issueData, sections, csvFilePath);
    console.log(`\n📄 Generated CSV (Update test design): ${csvFilePath}`);
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl =
          att.content ||
          `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(
          csvTargetKey,
          "Approved test design (CSV)",
          attachmentUrl,
          attachmentFileName
        );
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
    return { status: "skipped", reason: err.message };
  }

  const tmsImport = await maybeSyncCsvToTms(csvFilePath, issueData.key, issueData);
  return {
    status: "success",
    csvPath: csvFilePath,
    approvedCount: totalLines,
    tmsImport,
  };
}

/**
 * LEGACY — nothing calls this any more.
 *
 * This is the old approval round-trip: read the ticket's comments, find "APPROVED: 1,2,3" (or the
 * "APPROVED (n)" directives an Update run needed), match the numbers against the design that was
 * posted earlier, and build the CSV from what survived. Approval moved into the review panel, so
 * both import steps now call approvedCsvFromJira() instead and no comment is parsed anywhere.
 *
 * It is kept, with the comment-parsing helpers below it, for tickets approved the old way whose
 * CSV was never generated — and as the reference for what those comments meant. Deleting the
 * chain is a separate pass; nothing here is on a live path.
 */
async function processApprovalOnlyFromExistingChecklist(issueKey) {
  console.log(`🚀 Processing approvals-only for: ${issueKey}`);

  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);

  const issue = await jiraClient.getIssueWithExpand(issueKey);
  const contextIssueKey = contextIssueKeyFor(issue, issueKey);

  // CSV rows: parent story key/title (same as checklist generation context).
  let parentIssueForData = issue;
  if (contextIssueKey !== issueKey) {
    try {
      parentIssueForData = await jiraClient.getIssueWithExpand(contextIssueKey);
    } catch (e) {
      console.warn(`⚠️  Could not load parent for CSV metadata: ${e.message}`);
    }
  }
  const issueData = jiraClient.extractIssueData(parentIssueForData);

  // Checklist / test case comments and generated-testcases JSON are on the Test design subtask.
  const testDesignKey = await testDesignSubtaskKeyFor(jiraClient, contextIssueKey, PROJECT_KEY);
  const commentHostKey = testDesignKey || issueKey;
  if (commentHostKey !== issueKey) {
    console.log(`   Reading comments/attachments from Test design subtask ${commentHostKey} (story ${contextIssueKey})`);
  }
  const comments = await jiraClient.getComments(commentHostKey);

  const updatedDesignBlocks = await buildUpdatedDesignApprovalBlocks(jiraClient, commentHostKey, comments);
  if (updatedDesignBlocks.length > 0) {
    console.log(
      `📌 Update test design flow: ${updatedDesignBlocks.length} posted block(s) in chronological order (checklist comments + test case JSON segments)`
    );
    return await processUpdatedDesignApprovalFromBlocks(
      issueKey,
      jiraClient,
      issue,
      issueData,
      commentHostKey,
      comments,
      updatedDesignBlocks
    );
  }

  const approvalHit = findLatestCommentTextContaining(comments, "APPROVED:");
  if (!approvalHit) {
    console.log("ℹ️  No approval comment found. Skipping.");
    return { status: "skipped", reason: "No approval comment" };
  }

  // 1) Try test cases: all generated-testcases-*.json attachments (seg2, seg3, …) then fallback to comment body
  let testCases = await mergeTestCasesFromAttachments(jiraClient, commentHostKey);
  const testCasesHit = findLatestCommentTextContaining(comments, "AI-Generated Test Cases");
  if (!testCases || testCases.length === 0) {
    if (testCasesHit) testCases = parseTestCasesFromComment(testCasesHit.text);
  }
  if (testCases && testCases.length > 0) {
      console.log(`📋 Loaded ${testCases.length} test case(s) for approval (all segments / attachments merged)`);
      const approvedNumbers = parseApprovalComment(approvalHit.text, testCases.length);
      if (!approvedNumbers || approvedNumbers.length === 0) {
        console.log("ℹ️  Approval comment present, but no valid approved numbers. Skipping.");
        return { status: "skipped", reason: "No valid approved numbers" };
      }
      console.log(`✅ Approved test case numbers: ${approvedNumbers.join(", ")}`);
      const approvedTestCases = approvedNumbers
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= testCases.length)
        .map((n) => testCases[n - 1])
        .filter(Boolean);
      if (approvedTestCases.length === 0) {
        return { status: "skipped", reason: "Approved test cases empty after validation" };
      }
      const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
      const csvFileName = approvedTestCasesCsvFilename(issueData.key, issueData.summary);
      const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
      try {
        fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
        generateApprovedTestCasesCSV(issueData, approvedTestCases, csvFilePath);
        console.log(`📄 Generated CSV (test cases): ${csvFilePath}`);
        let attachmentUrl = null;
        let attachmentFileName = csvFileName;
        try {
          const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
          console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
          if (attachments && attachments[0]) {
            const att = attachments[0];
            attachmentFileName = att.filename || csvFileName;
            attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
          }
        } catch (attachErr) {
          console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
        }
        if (attachmentUrl) {
          try {
            await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved test cases (CSV)", attachmentUrl, attachmentFileName);
            console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
          } catch (commentErr) {
            console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️  Could not write CSV: ${err.message}`);
      }
      const tmsImport = await maybeSyncCsvToTms(csvFilePath, issueData.key, issueData);
      return {
        status: "success",
        csvPath: csvFilePath,
        approvedCount: approvedTestCases.length,
        tmsImport,
      };
  }

  // 2) Fallback: all checklist comments (updated CSV flow may post several) → one CSV, N Test Case blocks → N ADO work items
  const checklistHits = findAllCommentsTextContaining(comments, "AI-Generated Test Checklist");
  if (!checklistHits.length) {
    console.log("ℹ️  No checklist or test cases comment found. Skipping.");
    return { status: "skipped", reason: "No checklist comment" };
  }

  /** @type {{ partLabel: string, approvedItems: { number: number, item: object }[] }[]} */
  const checklistGroups = [];
  let totalApprovedItems = 0;

  for (const { text } of checklistHits) {
    const checklistItems = parseChecklistItemsFromChecklistComment(text);
    if (checklistItems.length === 0) {
      console.log("ℹ️  One checklist comment skipped (no numbered items parsed).");
      continue;
    }
    const approvedNumbers = parseApprovalComment(approvalHit.text, checklistItems.length);
    if (!approvedNumbers || approvedNumbers.length === 0) {
      console.log(
        `ℹ️  Approval does not apply to one checklist (${checklistItems.length} item(s)); skipped that block.`
      );
      continue;
    }
    const approvedItems = approvedNumbers
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= checklistItems.length)
      .map((n) => ({ number: n, item: checklistItems[n - 1] }))
      .filter((x) => x.item);

    if (approvedItems.length === 0) continue;

    const partLabel = parseChecklistPartLabelFromComment(text);
    checklistGroups.push({ partLabel, approvedItems });
    totalApprovedItems += approvedItems.length;
  }

  if (checklistGroups.length === 0) {
    console.log("ℹ️  No checklist blocks with valid approval. Skipping.");
    return { status: "skipped", reason: "No approved checklist blocks" };
  }

  console.log(
    `📋 ${checklistGroups.length} checklist block(s) → CSV with ${checklistGroups.length} Test Case header(s) (${totalApprovedItems} approved line(s) total)`
  );

  const csvTargetKey = await resolveCsvTargetIssueKey(jiraClient, issueKey, issue);
  const csvFileName = approvedChecklistCsvFilename(issueData.key, issueData.summary);
  const csvFilePath = path.join(CHECKLIST_OUTPUT_DIR, csvFileName);
  try {
    fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });
    generateApprovedMultiChecklistCSV(issueData, checklistGroups, csvFilePath);
    console.log(`📄 Generated CSV: ${csvFilePath}`);
    let attachmentUrl = null;
    let attachmentFileName = csvFileName;
    try {
      const attachments = await jiraClient.addAttachment(csvTargetKey, csvFilePath);
      console.log(`✅ CSV attached to Jira issue ${csvTargetKey}`);
      if (attachments && attachments[0]) {
        const att = attachments[0];
        attachmentFileName = att.filename || csvFileName;
        attachmentUrl = att.content || `${JIRA_BASE_URL.replace(/\/$/, "")}/secure/attachment/${att.id}/${encodeURIComponent(attachmentFileName)}`;
      }
    } catch (attachErr) {
      console.warn(`⚠️  Could not attach CSV to Jira: ${attachErr.message}`);
    }
    if (attachmentUrl) {
      try {
        await jiraClient.addCommentWithFileLink(csvTargetKey, "Approved checklist (CSV)", attachmentUrl, attachmentFileName);
        console.log(`✅ Comment with CSV file link added to Jira issue ${csvTargetKey}`);
      } catch (commentErr) {
        console.warn(`⚠️  Could not add comment with file link: ${commentErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not write CSV: ${err.message}`);
  }

  const tmsImport = await maybeSyncCsvToTms(csvFilePath, issueData.key, issueData);
  return {
    status: "success",
    csvPath: csvFilePath,
    approvedCount: totalApprovedItems,
    tmsImport,
  };
}

/**
 * Post generated test cases to Jira: ADF tables in the comment, raw JSON as an attachment so the
 * approval step can read the exact payload back. Unchanged behaviour — just lifted out of
 * processIssue so both the direct run and the "submit reviewed content" stage share it.
 */
async function postTestCasesToJira(jiraClient, targetKey, testCasesResult, contextUsed) {
  const adfBody = buildTestCasesCommentAdf(testCasesResult, { contextUsed });
  const isBdd =
    testCasesResult.format === "bdd" || bddFormat.anyBddTestCase(testCasesResult.testCases);
  console.log(
    isBdd
      ? "💬 Posting BDD scenarios comment to Jira (Gherkin blocks)..."
      : "💬 Posting test cases comment to Jira (tables only)..."
  );
  await jiraClient.addCommentAdf(targetKey, adfBody);
  // `format` / `feature` are recorded for the human reading the attachment; the
  // approval step does not depend on them — it re-detects Gherkin from the steps,
  // which also covers attachments written before the toggle existed.
  const jsonPayload = JSON.stringify(
    {
      testCases: testCasesResult.testCases,
      reasoning: testCasesResult.reasoning,
      ...(isBdd
        ? { format: "bdd", feature: testCasesResult.feature || "", featureDescription: testCasesResult.featureDescription || "" }
        : {}),
    },
    null,
    2
  );
  const jsonFileName = `generated-testcases-${targetKey}.json`;
  const jsonTempPath = path.join(__dirname, jsonFileName);
  try {
    fs.writeFileSync(jsonTempPath, jsonPayload, "utf8");
    await jiraClient.addAttachment(targetKey, jsonTempPath);
    console.log(`   📎 Test cases data attached as ${jsonFileName} (for approval step).`);
  } catch (err) {
    console.warn(`⚠️  Could not attach test cases JSON: ${err.message}`);
  } finally {
    try { fs.unlinkSync(jsonTempPath); } catch (_) {}
  }
  console.log("ℹ️  Test cases posted. Approve them in the review panel (npm run web) to get the CSV.");
}

async function postChecklistToJira(jiraClient, targetKey, checklistResult, contextUsed) {
  const checklistComment = formatChecklistComment(checklistResult, checklistResult.reasoning, { contextUsed });
  console.log("💬 Posting checklist comment to Jira...");
  await jiraClient.addComment(targetKey, checklistComment);
  console.log("ℹ️  Checklist posted. Approve it in the review panel (npm run web) to get the CSV.");
}

/**
 * Hand the generated content to the caller (the web UI) instead of posting it.
 * `promptContext` rides along so a later regenerate can reuse the very same Confluence / Figma /
 * prototype / project-folder context without paying for a second gathering pass.
 */
function emitReviewEnvelope(envelope) {
  writePipelineIo(envelope);
  const count =
    envelope.mode === "testcases"
      ? (envelope.payload.testCases || []).length
      : (envelope.payload.checklistItems || []).length;
  const unit =
    envelope.format === "bdd"
      ? "BDD scenario(s)"
      : envelope.mode === "testcases"
      ? "test case(s)"
      : "checklist item(s)";
  console.log(
    DIRECT_TMS_IMPORT
      ? `📝 Generated ${count} ${unit} for review — nothing imported yet. Pick the destination on step 2, then press Import.`
      : `📝 Generated ${count} ${unit} for review — nothing posted to Jira yet.`
  );
}

/** A row the reviewer marked APPROVED in the panel. Anything else never reaches the CSV. */
function isApprovedRow(row) {
  return !!(row && row.approved);
}

/**
 * The issue the CSV rows are written against.
 *
 * The ID column carries the story, not the Test design sub-task — that is what the approval flow
 * always wrote, and what the importers match a container by. `assignee` only fills a CSV column,
 * so a ticket that cannot be read is not worth failing the submit over.
 */
async function csvIssueDataFor(jiraClient, envelope) {
  const key = envelope.contextIssueKey || envelope.issueKey || "";
  const issueData = { key, summary: envelope.issueSummary || "", assignee: "" };
  try {
    const issue = await jiraClient.getIssueWithExpand(key);
    issueData.assignee = jiraClient.extractIssueData(issue).assignee || "";
  } catch (e) {
    console.warn(`⚠️  Could not read ${key} for the CSV's Assigned To column: ${e.message}`);
  }
  return issueData;
}

/**
 * PIPELINE_STAGE=submit: build the approved CSV and put it on the ticket.
 *
 * Approval used to be a Jira round-trip: the whole design was posted as a comment, the QA
 * engineer replied "APPROVED: 1,2,3", and a second run turned that reply into a CSV. Now the
 * approving happens in the review panel — every checklist item and every test case carries its
 * own APPROVED mark — so Submit has one job left: write the marked rows as the CSV and attach it.
 * Unmarked rows are left out entirely; they were reviewed and not approved, which is an answer.
 *
 * Reads the (edited) envelope from PIPELINE_IO_FILE; the payload shape matches what
 * emitReviewEnvelope produced, so anything the UI did not touch round-trips unchanged.
 */
async function submitReviewedEnvelope(jiraClient, targetKeyFallback) {
  const envelope = readPipelineIo();
  const targetKey = envelope.postTargetKey || targetKeyFallback;
  const payload = envelope.payload || {};
  const issueData = await csvIssueDataFor(jiraClient, envelope);

  fs.mkdirSync(CHECKLIST_OUTPUT_DIR, { recursive: true });

  if (envelope.mode === "testcases") {
    const reviewed = payload.testCases || [];
    const approved = reviewed.filter(isApprovedRow);
    if (!approved.length) {
      throw new Error(
        `Nothing to submit: none of the ${reviewed.length} test case(s) are marked APPROVED`
      );
    }
    // The reviewer edits a scenario as free Gherkin text, so re-derive the
    // canonical rows here — the browser may have handed back lines that regroup.
    const isBdd = envelope.format === "bdd" || bddFormat.anyBddTestCase(approved);
    const testCases = isBdd
      ? bddFormat.normalizeBddTestCases(approved)
      : normalizeExpectedInTestCases(approved);

    const csvPath = path.join(
      CHECKLIST_OUTPUT_DIR,
      approvedTestCasesCsvFilename(issueData.key, issueData.summary)
    );
    generateApprovedTestCasesCSV(issueData, testCases, csvPath);
    console.log(`📄 Approved CSV: ${csvPath} (${approved.length} of ${reviewed.length} test case(s))`);
    await attachApprovedCsv(jiraClient, targetKey, csvPath, "Approved test cases (CSV)");
    return { mode: "testcases", targetKey, submittedCount: approved.length, reviewedCount: reviewed.length, csvPath };
  }

  const reviewed = payload.checklistItems || [];
  const approved = reviewed.filter(isApprovedRow);
  if (!approved.length) {
    throw new Error(`Nothing to submit: none of the ${reviewed.length} checklist item(s) are marked APPROVED`);
  }
  // The writer numbers the steps itself; `number` is kept because it is the shape it takes.
  const approvedItems = approved.map((item, i) => ({ number: i + 1, item }));
  const csvPath = path.join(
    CHECKLIST_OUTPUT_DIR,
    approvedChecklistCsvFilename(issueData.key, issueData.summary)
  );
  generateApprovedChecklistCSV(issueData, approvedItems, csvPath);
  console.log(`📄 Approved CSV: ${csvPath} (${approved.length} of ${reviewed.length} item(s))`);
  await attachApprovedCsv(jiraClient, targetKey, csvPath, "Approved checklist (CSV)");
  return { mode: "checklist", targetKey, submittedCount: approved.length, reviewedCount: reviewed.length, csvPath };
}

async function processIssue(issueKey) {
  console.log(`🚀 Processing Jira issue: ${issueKey}`);
  
  const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  
  // Only create Confluence client if Confluence search is enabled
  const enableConfluenceSearch = process.env.ENABLE_CONFLUENCE_SEARCH === "true";
  const confluenceClient = enableConfluenceSearch 
    ? new ConfluenceClient(CONFLUENCE_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)
    : null;

  // Step 1: Get issue details and resolve context (parent) + where to post checklist
  console.log("📋 Fetching issue details...");
  const issue = await jiraClient.getIssueWithExpand(issueKey);
  // Direct import never climbs: the pasted link is the requirement itself, whatever its type.
  // Every other flow analyses the key as typed, except a "Test design" sub-task, which stands in
  // for its parent — see contextIssueKeyFor().
  const contextIssueKey = DIRECT_TMS_IMPORT ? issueKey : contextIssueKeyFor(issue, issueKey);
  let issueData;
  if (contextIssueKey !== issueKey) {
    console.log(`   Trigger: ${issueKey} (Test design subtask) → scanning parent ${contextIssueKey}`);
    const contextIssue = await jiraClient.getIssueWithExpand(contextIssueKey);
    issueData = jiraClient.extractIssueData(contextIssue);
    issueData.ticket = promptContextLib.ticketFactsFromIssue(contextIssue);
  } else {
    issueData = jiraClient.extractIssueData(issue);
    issueData.ticket = promptContextLib.ticketFactsFromIssue(issue);
    // Names a checklist and a parent hop, neither of which this flow has — and the
    // "Issue (context)" line below already says which ticket is being read.
    logSettingEcho(`   Trigger: ${issueKey} (parent) → scanning parent for checklist`);
  }
  let checklistPostTargetKey = null;
  if (DIRECT_TMS_IMPORT) {
    // Every DIRECT_TMS_IMPORT path ends in a review panel and then PIPELINE_STAGE=import-tms.
    // Refuse anything else outright rather than fall through to a post with no target key.
    if (PIPELINE_STAGE !== "generate") {
      throw new Error(`DIRECT_TMS_IMPORT requires PIPELINE_STAGE=generate (got "${PIPELINE_STAGE}")`);
    }
  } else {
    // Azure DevOps: a parent key posts to its Test design sub-task. Every other TMS posts to
    // the typed-in key, so a missing sub-task is only an error for Azure DevOps.
    checklistPostTargetKey = await testDesignSubtaskKeyFor(jiraClient, contextIssueKey, PROJECT_KEY);
    if (!checklistPostTargetKey) {
      if (usesTestDesignSubtask() && contextIssueKey === issueKey) {
        throw new Error("No QA Sub-task with title 'Test design' found for this issue. Create one to post the checklist.");
      }
      checklistPostTargetKey = issueKey;
    } else {
      console.log(`   Checklist will be posted to Test design subtask: ${checklistPostTargetKey}`);
    }
  }

  console.log(`   Issue (context): ${issueData.key} - ${issueData.summary}`);
  console.log(`   Status: ${issueData.status}`);
  console.log(`   Labels: ${issueData.labels.join(", ") || "none"}`);

  // PIPELINE_STAGE=submit posts content that was already generated and edited in the review UI,
  // so it must not generate anything again — jump straight to posting.
  if (PIPELINE_STAGE === "submit") {
    const submitted = await submitReviewedEnvelope(jiraClient, checklistPostTargetKey);
    // Back out through the same file the envelope came in on, so the panel can say how many rows
    // it actually wrote rather than guessing from what it sent.
    writePipelineIo({ ok: true, ...submitted });
    const report = {
      issueKey: issueData.key,
      issueSummary: issueData.summary,
      issueDescription: issueData.description,
      issueLabels: issueData.labels,
      isChangeRequest: isChangeRequest(issueData),
      submittedFromReview: submitted,
      approvalCsv: null,
      relatedDocumentation: { confluencePages: 0, relatedJiraIssues: 0 },
      generatedAt: new Date().toISOString(),
    };
    report.llmUsage = { ...runUsage };
    logUsage(runUsage);
    fs.writeFileSync("report.yaml", JSON.stringify(report, null, 2));
    console.log("✅ Report saved to report.yaml");
    return report;
  }

  const checkApproval = process.env.CHECK_APPROVAL === "true";

  // CHECK_APPROVAL=true is the "Automate import into …" run: no generation, no approval comment —
  // it takes the CSV the review panel approved and Submit attached, and imports that.
  if (checkApproval) {
    console.log("📥 Import mode: taking the approved CSV attached to this ticket (no comment is read)...");
    const approvalResult = await importApprovedCsvFromJira(issueKey);
    const report = {
      issueKey: issueData.key,
      issueSummary: issueData.summary,
      issueDescription: issueData.description,
      issueLabels: issueData.labels,
      isChangeRequest: isChangeRequest(issueData),
      checklist: null,
      approvalCsv: approvalResult.status === "success" ? { csvPath: approvalResult.csvPath, fileName: approvalResult.fileName } : null,
      relatedDocumentation: { confluencePages: 0, relatedJiraIssues: 0 },
      generatedAt: new Date().toISOString(),
    };
    report.llmUsage = { ...runUsage };
    logUsage(runUsage);
    fs.writeFileSync("report.yaml", JSON.stringify(report, null, 2));
    console.log("✅ Report saved to report.yaml");
    return report;
  }

  // CSV / JSON files attached to the ticket are part of the requirement: appended to the
  // description before validation, so a ticket whose requirements are only a file still passes,
  // and every prompt (and every later Regenerate, via promptContext) reads them. On by default;
  // ENABLE_TICKET_DATA_FILES=false turns it off — see ticket-data-files.js.
  await appendTicketDataFiles(jiraClient, issueData);

  // Step 2: Validate requirements (only when generating checklist)
  console.log("✅ Validating requirements...");
  const validation = validateRequirements(issueData);
  
  if (!validation.valid) {
    // Direct import promises a read-only Jira, and there is no comment host anyway
    // (checklistPostTargetKey is null here) — so the reason goes to the run log, not to the ticket.
    if (!DIRECT_TMS_IMPORT) {
      const errorComment = `⚠️ Validation Error

This task does not meet the minimum requirements for test case generation:

${validation.errors.map(e => `☐ ${e}`).join("\n")}

Please add the necessary information and try again.`;

      await jiraClient.addComment(checklistPostTargetKey, errorComment);
    }
    throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
  }

  // Step 3: Search related documentation (optional, can be disabled)
  const relatedDocs = await searchRelatedDocumentation(jiraClient, confluenceClient, issueData);
  
  const figmaNote =
    (relatedDocs.figmaContext ? `, Figma: ${relatedDocs.figmaStats?.framesAnalyzed || 0} frame(s)` : "") +
    (relatedDocs.attachmentsContext ? `, attachments: ${relatedDocs.attachmentsStats?.analyzed || 0} file(s)` : "") +
    (relatedDocs.commentsContext ? `, comments: ${relatedDocs.commentsStats?.used || 0}` : "");
  logSettingEcho(`📊 Documentation context: ${relatedDocs.confluencePages.length} Confluence pages, ${relatedDocs.relatedJiraIssues.length} related issues${figmaNote}`);

  // Step 4: Check if it's a change request
  const isChangeReq = isChangeRequest(issueData);
  
  if (isChangeReq && confluenceClient) {
    console.log("🔄 Detected change request - reusing Confluence docs from Jira-linked requirements...");
    if (relatedDocs.confluencePages.length > 0) {
      relatedDocs.existingTestCases = relatedDocs.confluencePages;
      console.log(`📚 Using ${relatedDocs.existingTestCases.length} Jira-linked Confluence document(s) as existing test context`);
    } else {
      console.log("ℹ️  No Jira-linked Confluence documents found for change request context.");
    }
  } else if (isChangeReq && !confluenceClient) {
    console.log("ℹ️  Change request detected, but Confluence search is disabled. Working with issue description only.");
  }

  if (IS_BDD) {
    console.log(
      GENERATE_MODE_RAW === "checklist"
        ? "🥒 Test design format: BDD (Gherkin) — generating a Feature with Scenarios; the Checklist mode does not apply to BDD"
        : "🥒 Test design format: BDD (Gherkin) — one Scenario per test case"
    );
  }

  let checklistResult = null;
  let testCasesResult = null;

  // File names of everything the analysis step will feed to the prompt (memoized,
  // so this is the same list the generator sees), for the "Context used" summary.
  const projectTestCaseFiles = ENABLE_TEST_CASES_ANALYSIS
    ? loadProjectTestCases().map((f) => f.filename)
    : [];

  const contextUsed = buildContextUsedText(relatedDocs, projectTestCaseFiles);
  const wantsReview = PIPELINE_STAGE === "generate";

  if (GENERATE_MODE === "testcases") {
    // Step 5b: Generate test cases and post as ADF (tables only); JSON stored in attachment for approval
    const promptContext = buildTestCasesPromptContext(issueData, relatedDocs);
    testCasesResult = await generateTestCasesFromContext(promptContext);
    if (wantsReview) {
      emitReviewEnvelope({
        mode: "testcases",
        format: TEST_DESIGN_FORMAT,
        // Read back by /issue-case/import to refuse a session that belongs to the Create flow,
        // whose reviewed content is meant for a Jira comment and an approval round-trip.
        flow: DIRECT_TMS_IMPORT ? "issue" : "create",
        issueKey,
        contextIssueKey,
        postTargetKey: checklistPostTargetKey,
        issueSummary: issueData.summary,
        contextUsed,
        promptContext,
        // Requirements inventory / covers / assumptions / open questions — kept with the session,
        // not sent to the review panel (see web-ui-server.js, which forwards only the payload).
        traceability: traceabilityOf(testCasesResult),
        usage: { ...runUsage },
        payload: {
          testCases: testCasesResult.testCases,
          reasoning: testCasesResult.reasoning || "",
          coverageNotes: testCasesResult.coverageNotes || "",
          ...(IS_BDD
            ? {
                feature: testCasesResult.feature || issueData.summary || "",
                featureDescription: testCasesResult.featureDescription || "",
              }
            : {}),
        },
      });
    } else {
      await postTestCasesToJira(jiraClient, checklistPostTargetKey, testCasesResult, contextUsed);
    }
  } else {
    // Step 5a: Generate test checklist and post
    const promptContext = buildChecklistPromptContext(issueData, relatedDocs);
    checklistResult = await generateChecklistFromContext(promptContext);
    if (wantsReview) {
      emitReviewEnvelope({
        mode: "checklist",
        issueKey,
        contextIssueKey,
        postTargetKey: checklistPostTargetKey,
        issueSummary: issueData.summary,
        contextUsed,
        promptContext,
        traceability: traceabilityOf(checklistResult),
        usage: { ...runUsage },
        payload: {
          checklistItems: checklistResult.checklistItems,
          reasoning: checklistResult.reasoning || "",
          coverageNotes: checklistResult.coverageNotes || "",
        },
      });
    } else {
      await postChecklistToJira(jiraClient, checklistPostTargetKey, checklistResult, contextUsed);
    }
  }

  const report = {
    issueKey: issueData.key,
    issueSummary: issueData.summary,
    issueDescription: issueData.description,
    issueLabels: issueData.labels,
    isChangeRequest: isChangeReq,
    checklist: checklistResult,
    testCases: testCasesResult ? { testCases: testCasesResult.testCases, reasoning: testCasesResult.reasoning } : null,
    approvalCsv: null,
    relatedDocumentation: {
      confluencePages: relatedDocs.confluencePages.length,
      relatedJiraIssues: relatedDocs.relatedJiraIssues.length,
      relatedJiraIssuesUsed: relatedDocs.relatedJiraIssues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        previousQaChecklistItems: (issue.previousQaChecklist || []).length,
      })),
      relatedSearchMeta: relatedDocs.relatedSearchMeta || null,
      projectTestCaseFiles,
      figma: relatedDocs.figmaStats || null,
      prototype: relatedDocs.prototypeStats || null,
    },
    coverageNotes:
      (testCasesResult && testCasesResult.coverageNotes) ||
      (checklistResult && checklistResult.coverageNotes) ||
      null,
    // Requirements inventory, what no test covers, assumptions and open questions (prompt-context.js).
    traceability: traceabilityOf(testCasesResult || checklistResult),
    generatedAt: new Date().toISOString(),
  };

  report.llmUsage = { ...runUsage };
  logUsage(runUsage);

  // Save report
  fs.writeFileSync("report.yaml", JSON.stringify(report, null, 2));
  console.log("✅ Report saved to report.yaml");

  return report;
}

/** Strip code fences, parse, and run the placeholder guard — the shape every LLM reply here needs. */
function parseLlmJson(response, label) {
  const cleaned = String(response || "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return guardLlmResult(JSON.parse(cleaned), label);
  } catch (error) {
    console.error(`Failed to parse LLM response for ${label}:`, error.message);
    console.error("Response:", response);
    throw new Error(`LLM did not return valid JSON for ${label}`);
  }
}

const CHECKLIST_CATEGORIES = ["Functional", "Negative", "Boundary", "Integration"];

/**
 * Existing test cases a Regenerate shows the model.
 *
 * Not the snapshot stored with the session: the "Test cases" folder and the picked context are
 * re-read, so a source added in the panel after the first generation counts. On top of that come
 * the cases of every suite / section / folder the reviewer's guidance names in the TMS that is In
 * use — asked for explicitly, so they apply even when the run had "Analyze existing test cases" off.
 *
 * @returns {Promise<{ files: Array<{ filename: string, content: string }>, guidance: object|null }>}
 */
async function regenerateReferenceContext(storedContext, userGuidance) {
  // A session written before the flag existed only had cases in its context if analysis was on.
  const analyze =
    typeof storedContext.analyzeTestCases === "boolean"
      ? storedContext.analyzeTestCases
      : (storedContext.projectTestCases || []).length > 0;
  const picked = withHelpingTestCases(
    analyze ? existingTestsForPrompt({ summary: (storedContext.ticket && storedContext.ticket.summary) || "" }) : [],
    // Fetched once at generation and stored with the session — not asked of the TMS again.
    storedContext.helpingPromptTestCases
  );
  if (picked.length) console.log(`📂 Using ${picked.length} existing test case source(s) as context`);
  if (storedContext.helpingPrompt) console.log(`🧭 Helping prompt (from generation): ${storedContext.helpingPrompt}`);
  if (!userGuidance) return { files: picked, guidance: null };

  const guided = await tmsContext.resolveGuidanceContext(userGuidance, { projectDir: __dirname });
  return {
    files: [...picked, ...guided.files],
    guidance: guided.provider
      ? {
          providerTitle: guided.providerTitle,
          matched: guided.matched,
          unmatchedQuotes: guided.unmatchedQuotes,
          notes: guided.notes,
        }
      : null,
  };
}

/**
 * PIPELINE_STAGE=regenerate — redo part of an already generated set, using the context stored in
 * the review session. Deliberately touches no Jira API at all: the ticket is only read during
 * "generate" and only written during "submit", so a reviewer can iterate here for free.
 *
 * Input (PIPELINE_IO_FILE): { mode, kind, index, userGuidance, promptContext, payload }
 *   kind "all"      - regenerate the whole checklist / whole suite
 *   kind "item"     - regenerate checklist item at `index`
 *   kind "testcase" - regenerate test case at `index`
 * The same file is overwritten with the result.
 */
async function runRegenerateStage() {
  const input = readPipelineIo();
  const mode = input.mode === "testcases" ? "testcases" : "checklist";
  const kind = String(input.kind || "all");
  const userGuidance = String(input.userGuidance || "").trim();
  const payload = input.payload || {};

  if (userGuidance) {
    console.log(`🗣️  Reviewer guidance: ${userGuidance}`);
  }

  const reference = await regenerateReferenceContext(input.promptContext || {}, userGuidance);
  const promptContext = { ...(input.promptContext || {}), projectTestCases: reference.files };
  const referenceTestCases = reference.files;
  // Every answer says which suites the guidance pulled in, so the panel can tell the reviewer.
  const respond = (result) => writePipelineIo({ ...result, guidanceContext: reference.guidance });

  if (kind === "all") {
    if (mode === "testcases") {
      const result = await generateTestCasesFromContext(promptContext, userGuidance);
      respond({
        ok: true,
        kind,
        usage: { ...runUsage },
        payload: {
          testCases: result.testCases,
          reasoning: result.reasoning || "",
          coverageNotes: result.coverageNotes || "",
          ...(contextIsBdd(promptContext)
            ? {
                feature: result.feature || payload.feature || "",
                featureDescription: result.featureDescription || payload.featureDescription || "",
              }
            : {}),
        },
      });
    } else {
      const result = await generateChecklistFromContext(promptContext, userGuidance);
      respond({
        ok: true,
        kind,
        usage: { ...runUsage },
        payload: {
          checklistItems: result.checklistItems,
          reasoning: result.reasoning || "",
          coverageNotes: result.coverageNotes || "",
        },
      });
    }
    return;
  }

  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`regenerate: index must be a non-negative integer, got ${input.index}`);
  }

  if (kind === "item") {
    const items = payload.checklistItems || [];
    const item = items[index];
    if (!item) throw new Error(`regenerate: no checklist item at index ${index}`);
    console.log(`🤖 Regenerating checklist item ${index + 1} of ${items.length}...`);
    const prompt = regenerateChecklistItemPrompt({
      issueKey: promptContext.issueKey,
      issueDescription: promptContext.issueDescription,
      issueLabels: promptContext.issueLabels || [],
      ticket: promptContext.ticket || null,
      figmaContext: promptContext.figmaContext || "",
      prototypeContext: promptContext.prototypeContext || "",
      attachmentsContext: promptContext.attachmentsContext || "",
      commentsContext: promptContext.commentsContext || "",
      confluenceContext: confluencePagesToText(promptContext.confluencePages),
      item,
      siblingItems: items.filter((_, i) => i !== index),
      referenceTestCases,
      userGuidance,
      helpingPrompt: promptContext.helpingPrompt || "",
    });
    // One item plus a short rationale — a small slice of the checklist budget is plenty.
    const parsed = parseLlmJson(
      await callLLM(prompt, Math.min(2500, checklistMaxTokens())),
      `checklist item ${index + 1}`
    );
    const description = String(parsed.description || "").trim();
    if (!description) throw new Error("regenerate: LLM returned an empty item description");
    const category = CHECKLIST_CATEGORIES.includes(parsed.category) ? parsed.category : item.category;
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
    const cases = payload.testCases || [];
    const testCase = cases[index];
    if (!testCase) throw new Error(`regenerate: no test case at index ${index}`);
    // The session's format decides, but a case that is plainly Gherkin is
    // regenerated as Gherkin either way — an older session has no format field.
    const isBdd = contextIsBdd(promptContext) || bddFormat.isBddTestCase(testCase);
    console.log(
      `🤖 Regenerating ${isBdd ? "scenario" : "test case"} ${index + 1} of ${cases.length}...`
    );
    const prompt = isBdd
      ? regenerateBddTestCasePrompt({
          issueKey: promptContext.issueKey,
          issueDescription: promptContext.issueDescription,
          issueLabels: promptContext.issueLabels || [],
          ticket: promptContext.ticket || null,
          figmaContext: promptContext.figmaContext || "",
          prototypeContext: promptContext.prototypeContext || "",
          attachmentsContext: promptContext.attachmentsContext || "",
          commentsContext: promptContext.commentsContext || "",
          confluenceContext: confluencePagesToText(promptContext.confluencePages),
          feature: payload.feature || "",
          // The model reads the scenario the way the reviewer sees it, not as
          // action/expected rows it would then try to imitate.
          testCase: {
            title: testCase.title || "",
            priority: testCase.priority,
            areaPath: testCase.areaPath,
            steps: bddFormat.stepsToGherkinLines(testCase.steps),
          },
          siblingTitles: cases.filter((_, i) => i !== index).map((c) => c.title || ""),
          referenceTestCases,
          userGuidance,
          helpingPrompt: promptContext.helpingPrompt || "",
        })
      : regenerateTestCasePrompt({
          issueKey: promptContext.issueKey,
          issueDescription: promptContext.issueDescription,
          issueLabels: promptContext.issueLabels || [],
          ticket: promptContext.ticket || null,
          figmaContext: promptContext.figmaContext || "",
          prototypeContext: promptContext.prototypeContext || "",
          attachmentsContext: promptContext.attachmentsContext || "",
          commentsContext: promptContext.commentsContext || "",
          confluenceContext: confluencePagesToText(promptContext.confluencePages),
          testCaseFormatRef: loadTestCaseFormatRef(),
          testCase,
          siblingTitles: cases.filter((_, i) => i !== index).map((c) => c.title || ""),
          referenceTestCases,
          userGuidance,
          helpingPrompt: promptContext.helpingPrompt || "",
        });
    const parsed = parseLlmJson(
      await callLLM(prompt, parseInt(process.env.TEST_CASES_MAX_TOKENS || "12000", 10)),
      `test case ${index + 1}`
    );
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
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

  throw new Error(`regenerate: unknown kind "${kind}" (expected all | item | testcase)`);
}

/**
 * PIPELINE_STAGE=import-tms — the second half of "Cover a bug".
 *
 * Writes the reviewed test cases as an approved-format CSV and hands that CSV to the same
 * importer the approval flow uses, with the container picked on the page instead of the one
 * matched from the Jira key. Jira is never written to; the CSV is kept as the audit trail.
 *
 * Input  (PIPELINE_IO_FILE): { envelope, target: { planId, suiteId } | { sectionId } }
 * Output (PIPELINE_IO_FILE): { ok, provider, providerTitle, csvPath, created, errors, usage }
 */
async function runImportTmsStage() {
  const io = readPipelineIo();
  const envelope = io.envelope || {};
  const target = io.target || {};
  const payload = envelope.payload || {};

  const rawTestCases = payload.testCases || [];
  if (!rawTestCases.length) {
    throw new Error("Nothing to import: the reviewed test case list is empty");
  }

  // The reviewer edits a scenario as free Gherkin text, so re-derive the canonical rows — same
  // rule as submitReviewedEnvelope(), because the CSV writer expects step objects either way.
  const isBdd = envelope.format === "bdd" || bddFormat.anyBddTestCase(rawTestCases);
  const testCases = isBdd
    ? bddFormat.normalizeBddTestCases(rawTestCases)
    : normalizeExpectedInTestCases(rawTestCases);

  const issueKey = envelope.issueKey || "";
  const issueData = { key: issueKey, summary: envelope.issueSummary || "", assignee: "" };

  // A sub-folder of its own: the Create flow writes `<summary> (KEY).csv` straight into
  // CHECKLIST_OUTPUT_DIR, and an import run for the same ticket would otherwise overwrite the
  // CSV that was actually approved in Jira.
  const outDir = path.join(CHECKLIST_OUTPUT_DIR, "From issue");
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, approvedTestCasesCsvFilename(issueKey, issueData.summary));
  generateApprovedTestCasesCSV(issueData, testCases, csvPath);
  console.log(`📄 CSV written: ${csvPath}`);

  // Tell the importer which format was reviewed. It runs in this same process, and
  // TEST_DESIGN_FORMAT is what switches its BDD-into-Summary generation off: when the design is
  // already Gherkin, a generated Description would just be a second copy of the work item's steps.
  if (isBdd) process.env.TEST_DESIGN_FORMAT = "bdd";

  const { id: provider, title } = require("./config-store.js").activeProviderInfo();
  if (!provider) throw new Error(require("./config-store.js").NO_PROVIDER_MESSAGE);
  let result;
  if (provider === "ado") {
    const planId = Number(target.planId);
    const suiteId = Number(target.suiteId);
    if (!Number.isInteger(planId) || planId < 1 || !Number.isInteger(suiteId) || suiteId < 1) {
      throw new Error("Pick a Test Plan and a Test Suite to import into");
    }
    console.log(`📤 Importing ${testCases.length} test case(s) into Azure DevOps plan ${planId} / suite ${suiteId}…`);
    result = await require("./ado-sync-csv.js").syncApprovedCsvToAzureDevOps(csvPath, {
      jiraIssueKey: issueKey,
      planId,
      suiteId,
      // Lets the importer design the Gherkin Summary from the very context this design was
      // reviewed against, instead of transcribing the finished steps back into Gherkin.
      bddPromptContext: envelope.promptContext || null,
    });
  } else if (provider === "testrail") {
    const sectionId = Number(target.sectionId);
    if (!Number.isInteger(sectionId) || sectionId < 1) {
      throw new Error("Pick a TestRail section to import into");
    }
    console.log(`📤 Importing ${testCases.length} test case(s) into TestRail section ${sectionId}…`);
    result = await require("./testrail-sync-csv.js").syncApprovedCsvToTestRail(csvPath, {
      jiraIssueKey: issueKey,
      sectionId,
    });
  } else if (provider === "zephyr") {
    const folderId = Number(target.folderId);
    if (!Number.isInteger(folderId) || folderId < 1) {
      throw new Error("Pick a Zephyr folder to import into");
    }
    console.log(`📤 Importing ${testCases.length} test case(s) into Zephyr folder ${folderId}…`);
    result = await require("./zephyr-sync-csv.js").syncApprovedCsvToZephyr(csvPath, {
      jiraIssueKey: issueKey,
      folderId,
    });
  } else if (provider === "xray") {
    // A path rather than an id, and "/" — the repository root — is a legitimate one.
    const folderPath = String(target.folderPath || "").trim();
    if (!folderPath) throw new Error("Pick an Xray Test Repository folder to import into");
    console.log(`📤 Importing ${testCases.length} test case(s) into Xray folder ${folderPath}…`);
    result = await require("./xray-sync-csv.js").syncApprovedCsvToXray(csvPath, {
      jiraIssueKey: issueKey,
      folderPath,
    });
  } else {
    throw new Error(`No CSV importer for "${title}" yet — switch the provider in use on the Setup page`);
  }

  mergeUsage(runUsage, result.usage);
  result.created.forEach((c) => console.log(`   ✅ ${title} #${c.id}: ${c.title}`));
  result.errors.forEach((e) => console.warn(`   ⚠️  ${title} import: ${e}`));

  writePipelineIo({
    ok: true,
    provider,
    providerTitle: title,
    csvPath,
    created: result.created,
    errors: result.errors,
    usage: { ...runUsage },
  });
}

/**
 * Which container this provider needs, checked before anything is written.
 *
 * Runs first on purpose: the stage below generates a CSV and attaches it to Jira on the way, and
 * doing that only to fail on a missing suite id would leave a real artefact behind for a run that
 * never imported anything.
 *
 * @param {string} provider
 * @param {string} title
 * @param {object} target
 * @returns {{ planId?: number, suiteId?: number, sectionId?: number }} importer options
 */
function importTargetOptions(provider, title, target) {
  if (provider === "ado") {
    const planId = Number(target.planId);
    const suiteId = Number(target.suiteId);
    if (!Number.isInteger(planId) || planId < 1 || !Number.isInteger(suiteId) || suiteId < 1) {
      throw new Error("Pick a Test Plan and a Test Suite to import into");
    }
    return { planId, suiteId };
  }
  if (provider === "testrail") {
    const sectionId = Number(target.sectionId);
    if (!Number.isInteger(sectionId) || sectionId < 1) {
      throw new Error("Pick a TestRail section to import into");
    }
    return { sectionId };
  }
  if (provider === "zephyr") {
    const folderId = Number(target.folderId);
    if (!Number.isInteger(folderId) || folderId < 1) {
      throw new Error("Pick a Zephyr folder to import into");
    }
    return { folderId };
  }
  if (provider === "xray") {
    // A path, not an id: "/" is the repository root and is a legitimate answer, so the check is
    // "was something picked", not "is it a positive number".
    const folderPath = String(target.folderPath || "").trim();
    if (!folderPath) throw new Error("Pick an Xray Test Repository folder to import into");
    return { folderPath };
  }
  throw new Error(`No CSV importer for "${title}" yet — switch the provider in use on the Setup page`);
}

/**
 * PIPELINE_STAGE=import-csv — the "Manual Import into …" step on the Create and Update pages.
 *
 * Same flow as "Automate import into …", with one difference: the container.
 *
 *   Automate   read the APPROVED comment → build the CSV → attach it to Jira → import into the
 *              container matched from the Jira key
 *   Manual     read the APPROVED comment → build the CSV → attach it to Jira → import into the
 *              container picked on the page
 *
 * So the CSV is generated here, not hunted for: it is the same artefact the automate step
 * produces, from the same approval, and it lands on the ticket either way. Only the destination
 * is chosen by hand — which is the whole point of the step. The CSV is taken off the ticket and
 * handed straight to the importer, never through maybeSyncCsvToTms(), so the cases are imported
 * once, into the picked container — not also into the matched one.
 *
 * Input  (PIPELINE_IO_FILE): { jiraIssueKey, target: { planId, suiteId } | { sectionId } | { folderId } }
 * Output (PIPELINE_IO_FILE): { ok, provider, providerTitle, csvPath, csvFile, created, errors, usage }
 */
async function runImportCsvStage() {
  const io = readPipelineIo();
  const target = io.target || {};
  const jiraIssueKey = String(io.jiraIssueKey || "").trim();

  if (!jiraIssueKey) throw new Error("No Jira key: the approved CSV is built from that ticket");

  const { id: provider, title } = require("./config-store.js").activeProviderInfo();
  if (!provider) throw new Error(require("./config-store.js").NO_PROVIDER_MESSAGE);
  const importer = TMS_IMPORTERS[provider];
  const targetOptions = importTargetOptions(provider, title, target);

  console.log(`🔍 Taking the approved CSV attached to ${jiraIssueKey}…`);
  let csvPath;
  try {
    const jiraClient = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
    ({ csvPath } = await approvedCsvFromJira(jiraClient, jiraIssueKey));
  } catch (e) {
    // JiraClient throws the whole response body in a sentence; a wrong key is the
    // overwhelmingly likely cause here, so say that instead of quoting Jira at the user.
    if (/\b404\b/.test(String(e.message))) {
      throw new Error(`No Jira issue ${jiraIssueKey} — check the Jira Key, or your access to it`);
    }
    throw new Error(String(e.message).slice(0, 300));
  }
  console.log(`📄 Approved CSV: ${csvPath}`);

  const where =
    provider === "ado"
      ? `plan ${targetOptions.planId} / suite ${targetOptions.suiteId}`
      : provider === "zephyr"
        ? `folder ${targetOptions.folderId}`
        : provider === "xray"
          ? `folder ${targetOptions.folderPath}`
          : `section ${targetOptions.sectionId}`;
  console.log(`📤 Importing ${path.basename(csvPath)} into ${title} ${where}…`);

  const result = await importer.run(csvPath, jiraIssueKey, null, targetOptions);

  mergeUsage(runUsage, result.usage);
  result.created.forEach((c) => console.log(`   ✅ ${importer.created(c)}: ${c.title}`));
  result.errors.forEach((e) => console.warn(`   ⚠️  ${title} import: ${e}`));

  writePipelineIo({
    ok: true,
    provider,
    providerTitle: title,
    csvPath,
    csvFile: path.basename(csvPath),
    created: result.created,
    errors: result.errors,
    usage: { ...runUsage },
  });
}

async function run() {
  // The regenerate stage works purely off the stored review session — no Jira issue needed.
  if (PIPELINE_STAGE === "regenerate") {
    try {
      await runRegenerateStage();
      logUsage(runUsage, "for this regeneration");
      console.log("✅ Regeneration completed");
    } catch (error) {
      logUsage(runUsage, "for this regeneration");
      console.error("❌ Regeneration error:", error.message);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
    return;
  }

  // Same for the import stage: everything it needs is in the session envelope the server wrote.
  if (PIPELINE_STAGE === "import-tms" || PIPELINE_STAGE === "import-csv") {
    try {
      await (PIPELINE_STAGE === "import-csv" ? runImportCsvStage() : runImportTmsStage());
      logUsage(runUsage, "for this import");
      console.log("✅ Import completed");
    } catch (error) {
      logUsage(runUsage, "for this import");
      console.error("❌ Import error:", error.message);
      if (error.stack) console.error(error.stack);
      process.exit(1);
    }
    return;
  }

  const issueKey = process.env.JIRA_ISSUE_KEY || process.env.AGENT_GOAL;

  if (!issueKey) {
    console.error("❌ Error: JIRA_ISSUE_KEY or AGENT_GOAL must be set");
    console.error("   Set JIRA_ISSUE_KEY to a Jira issue key (e.g., PROJ-123)");
    process.exit(1);
  }

  try {
    await processIssue(issueKey);
    console.log("✅ Agent completed successfully");
  } catch (error) {
    // Report the spend even on failure — tokens burnt before the error are still billed.
    logUsage(runUsage);
    console.error("❌ Agent error:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// CLI entry point. Nothing requires this file: the previous module.exports
// existed only for agent-batch.js, which is gone.
if (require.main === module) {
  run();
}
