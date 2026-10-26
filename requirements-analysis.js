#!/usr/bin/env node
/**
 * "Analyze requirements" — the grooming helper behind web/analyze.html.
 *
 * Reads one Jira ticket (summary, description, comments, tracker facts) and every source the QA
 * engineer attached to the run, and asks the model for what to raise in backlog refinement:
 * questions, gaps, differences between the sources and ISO/IEC/IEEE 29148 quality findings.
 * Nothing is written to Jira or to the test management system.
 *
 * Inputs (env — the Web UI sets them per run; the same works from a shell):
 *   JIRA_ISSUE_KEY            required
 *   ANALYZE_RELATED_KEYS      related tickets, comma / newline separated
 *   CONFLUENCE_LINKS          Confluence page links (read regardless of Search Confluence — they
 *                             were given explicitly; links inside the description follow the switch)
 *   ANALYZE_FIGMA_URLS        Figma links, one per line
 *   ANALYZE_PROTOTYPE_URLS    prototype links, one per line
 *   REQUIREMENT_ATTACHMENTS   attachments (JSON array of paths, see attachment-analyzer.js)
 *   ANALYZE_USE_PICKED_TESTS  "false" to ignore the picked test cases (.ado-context), default on
 *   ANALYZE_MAX_TOKENS        output cap, default 16000 (Setup → Analyze requirements)
 *   PIPELINE_IO_FILE          when set, the JSON result is written there (the Web UI path);
 *                             otherwise the Markdown report is printed.
 */

const fs = require("fs");
const path = require("path");
require("./config-store.js").loadEnv();

const { JiraClient } = require("./jira-client");
const pc = require("./prompt-context");
const { loadIssueComments } = require("./issue-comments");
const { collectConfluencePages, confluencePagesToText, parseConfluenceLinks } = require("./confluence-pages");
const { analyzeFigmaUrl } = require("./figma-client");
const { analyzePrototypeUrl } = require("./prototype-client");
const { analyzeAttachments, attachmentPathsFromEnv } = require("./attachment-analyzer");
const adoContextStore = require("./ado-context-store.js");
const { callModel, missingLlmKeyMessage, LlmTruncatedError } = require("./llm-client");
const { createUsageTally, logUsage } = require("./llm-usage");
const { buildRequirementsAnalysisPrompt } = require("./prompts-analyze");
const AnalysisFormat = require("./web/analysis-format.js");

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || process.env.BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL || process.env.LOGIN_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const runUsage = createUsageTally();

function list(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cap(text, max) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max)} …(cut)` : s;
}

async function readRelatedTickets(jira, keys) {
  const out = [];
  for (const key of keys) {
    try {
      const raw = await jira.getIssueWithExpand(key);
      const d = jira.extractIssueData(raw);
      const facts = pc.ticketFactsFromIssue(raw);
      out.push(
        [
          `--- ${d.key}${facts.issueType ? ` (${facts.issueType})` : ""}${facts.status ? ` [${facts.status}]` : ""} — ${d.summary || ""}`,
          `Description:\n${cap(d.description, 4000) || "(empty)"}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
      console.log(`   ✓ related ticket ${d.key} — ${d.summary || ""}`);
    } catch (e) {
      console.warn(`   ⚠️  Could not read related ticket ${key}: ${e.message}`);
    }
  }
  return out.join("\n\n");
}

async function readMany(urls, analyze, label) {
  const parts = [];
  for (const url of urls) {
    try {
      const r = await analyze(url);
      if (r && r.error) console.warn(`   ⚠️  ${label} ${url}: ${r.error}`);
      if (r && r.summary) {
        parts.push(`--- ${url}\n${r.summary}`);
        console.log(`   ✓ ${label} read: ${url}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  ${label} ${url} could not be read: ${e.message}`);
    }
  }
  return parts.join("\n\n");
}

function parseJson(text) {
  const s = String(text || "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}

/** Every list present, every question numbered — the page and the Markdown can trust the shape. */
function normalizeAnalysis(parsed) {
  const a = parsed && typeof parsed === "object" ? parsed : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  a.understanding = String(a.understanding || "");
  a.verdict = ["ready", "needs clarification", "not ready"].includes(a.verdict) ? a.verdict : "needs clarification";
  a.verdictReason = String(a.verdictReason || "");
  a.setAssessment = arr(a.setAssessment);
  const rank = { blocker: 0, high: 1, medium: 2 };
  a.questions = arr(a.questions)
    .filter((q) => q && q.question)
    .map((q) => ({ ...q, priority: rank[q.priority] !== undefined ? q.priority : "medium" }))
    .sort((x, y) => rank[x.priority] - rank[y.priority]);
  a.questions.forEach((q, i) => {
    q.id = `Q${i + 1}`;
  });
  a.differences = arr(a.differences).filter((d) => d && d.topic);
  a.qualityIssues = arr(a.qualityIssues).filter((q) => q && (q.text || q.problem));
  a.gaps = arr(a.gaps).filter((g) => g && (g.missing || g.area));
  a.alreadyDecided = arr(a.alreadyDecided);
  a.assumptions = arr(a.assumptions);
  a.contextNotes = arr(a.contextNotes);
  return a;
}

async function main() {
  const issueKey = String(process.env.JIRA_ISSUE_KEY || "").trim().toUpperCase();
  if (!issueKey) throw new Error("JIRA_ISSUE_KEY is required");
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error("Jira is not configured (Setup → Jira)");
  if (missingLlmKeyMessage()) throw new Error(missingLlmKeyMessage());

  const jira = new JiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  console.log(`🔎 Analyzing requirements of ${issueKey}…`);
  const raw = await jira.getIssueWithExpand(issueKey);
  const issueData = jira.extractIssueData(raw);
  // Only this ticket is analysed: its parent, tracker links and sub-tasks are left out on purpose.
  // Neighbouring work enters the analysis only through the "Related Jira tickets" field.
  const { parent: _parent, links: _links, subtasks: _subtasks, ...ticket } = pc.ticketFactsFromIssue(raw);
  console.log(`📋 ${issueData.key} — ${issueData.summary || "(no summary)"}${ticket.issueType ? ` [${ticket.issueType}]` : ""}`);

  // Comments: all human discussion, including open questions (agent / approval / bot ones out).
  const comments = await loadIssueComments(jira, issueKey);

  const relatedKeys = list(process.env.ANALYZE_RELATED_KEYS).filter((k) => k.toUpperCase() !== issueKey);
  if (relatedKeys.length) console.log(`🔗 Related tickets: ${relatedKeys.join(", ")}`);
  const relatedTickets = await readRelatedTickets(jira, relatedKeys);

  // Confluence: the links typed on the page always; the description's links only with the switch.
  const { links: confluenceLinks } = parseConfluenceLinks(process.env.CONFLUENCE_LINKS || "");
  let confluenceText = "";
  if (confluenceLinks.length || process.env.ENABLE_CONFLUENCE_SEARCH === "true") {
    const found = await collectConfluencePages({
      issueData: process.env.ENABLE_CONFLUENCE_SEARCH === "true" ? issueData : null,
      extraLinks: confluenceLinks,
      baseUrl: process.env.CONFLUENCE_BASE_URL || JIRA_BASE_URL,
      email: JIRA_EMAIL,
      token: JIRA_API_TOKEN,
    });
    confluenceText = confluencePagesToText(found.pages);
    if (found.pages.length) console.log(`📄 Confluence: ${found.pages.map((p) => p.title || "(untitled)").join("; ")}`);
  }

  const figmaUrls = list(process.env.ANALYZE_FIGMA_URLS);
  const prototypeUrls = list(process.env.ANALYZE_PROTOTYPE_URLS);
  if (figmaUrls.length) console.log(`🎨 Reading ${figmaUrls.length} design link(s)…`);
  const designText = await readMany(figmaUrls, (u) => analyzeFigmaUrl(u), "Design");
  if (prototypeUrls.length) console.log(`🧭 Reading ${prototypeUrls.length} prototype link(s)…`);
  const prototypeText = await readMany(prototypeUrls, (u) => analyzePrototypeUrl(u), "Prototype");

  let attachmentsText = "";
  const attachmentPaths = attachmentPathsFromEnv();
  if (attachmentPaths.length) {
    const att = await analyzeAttachments(attachmentPaths, { issueKey, usageTally: runUsage });
    if (att.error) console.warn(`⚠️  Attachments: ${att.error}`);
    attachmentsText = att.summary || "";
  }

  // "Related test cases from <TMS>": the picks made on the page (shared store with Create / Update).
  let existingTests = [];
  if (process.env.ANALYZE_USE_PICKED_TESTS !== "false") {
    try {
      const files = adoContextStore.loadContextFiles(__dirname).map((f) => {
        const { text, cases } = pc.compactExistingTests(f.content);
        return { ...f, content: text, cases, origin: "picked" };
      });
      existingTests = pc.selectExistingTests(files, { summary: issueData.summary || "" }).map(({ cases, ...rest }) => rest);
      if (existingTests.length) console.log(`🧪 Related test cases: ${existingTests.length} source(s)`);
    } catch (e) {
      console.warn(`⚠️  Could not read the picked test cases: ${e.message}`);
    }
  }

  const prompt = buildRequirementsAnalysisPrompt({
    issueKey: issueData.key,
    issueDescription: issueData.description,
    issueLabels: issueData.labels || [],
    ticket,
    commentsText: comments.text || "",
    relatedTickets,
    confluenceText,
    designText,
    prototypeText,
    attachmentsText,
    existingTests,
  });

  console.log("🤖 Analyzing with the model…");
  const maxTokens = parseInt(process.env.ANALYZE_MAX_TOKENS || "16000", 10) || 16000;
  let response;
  try {
    response = await callModel(prompt, {
      maxTokens,
      usageTally: runUsage,
      labels: { truncationRemedy: "Raise 'Max tokens per analysis' on Setup → Analyze requirements (ANALYZE_MAX_TOKENS), or attach fewer sources." },
      hooks: {
        onModelSwitch: (model, reason) => console.warn(`LLM model "${model}" failed (${reason}). Trying next fallback model.`),
      },
    });
  } catch (e) {
    if (e instanceof LlmTruncatedError) throw new Error(e.message);
    throw e;
  }

  let analysis;
  try {
    analysis = normalizeAnalysis(parseJson(response));
  } catch (e) {
    console.error("Response:", String(response).slice(0, 2000));
    throw new Error(`The model did not return valid JSON (${e.message})`);
  }

  const result = {
    issueKey: issueData.key,
    summary: issueData.summary || "",
    generatedAt: new Date().toISOString(),
    sources: {
      comments: (comments.stats && comments.stats.used) || 0,
      relatedTickets: relatedKeys,
      confluence: confluenceText ? confluenceLinks.length || 1 : 0,
      design: figmaUrls.length,
      prototype: prototypeUrls.length,
      attachments: attachmentPaths.length,
      relatedTestCases: existingTests.map((f) => f.filename),
    },
    analysis,
    usage: { ...runUsage },
  };

  const a = analysis;
  console.log(
    `✅ ${a.questions.length} question(s) (${a.questions.filter((q) => q.priority === "blocker").length} blocker), ${a.differences.length} difference(s), ${a.gaps.length} gap(s), ${a.qualityIssues.length} quality issue(s) — verdict: ${a.verdict}`
  );
  logUsage(runUsage);

  if (process.env.PIPELINE_IO_FILE) {
    fs.writeFileSync(process.env.PIPELINE_IO_FILE, JSON.stringify(result), "utf8");
  } else {
    process.stdout.write(`\n${AnalysisFormat.toMarkdown(result)}\n`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err && err.message ? err.message : err}`);
  process.exit(1);
});
