/**
 * Universal building blocks for the generation prompts — nothing in here knows the product, the
 * domain or the tracker project, so the agent can be pointed at any Jira project.
 *
 * Shape every generation prompt now follows:
 *   role → <ticket> + <description> → SOURCE PRIORITY → sources (each in its own tag) →
 *   method (domain model, behaviour change, often-missed areas, techniques) → rules → output.
 *
 * Also here, because they are about the same material:
 *   - ticketFactsFromIssue(): the tracker facts the prompt used to miss (summary, type, parent,
 *     components, versions, explicit links);
 *   - compactExistingTests() / selectExistingTests(): existing test cases as compact text, labelled
 *     by origin, within a size budget;
 *   - rankRelatedIssues(): how strongly each related issue is related, and the most related first;
 *   - checkCoverage(): requirements inventory ↔ "covers" — what no test verifies.
 *
 * Settings (env / .env only — none of this is on the Web UI):
 *   OUTPUT_LANGUAGE            language of the generated text, default English
 *   RELATED_ISSUES_MAX         related issues kept for the prompt, default 10
 *   EXISTING_TESTS_MAX_CHARS   budget for existing test cases in the prompt, default 60000
 */

const OUTPUT_LANGUAGE = String(process.env.OUTPUT_LANGUAGE || "").trim() || "English";

function intEnv(name, fallback) {
  const n = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** One sentence every prompt ends its formatting rules with. */
function languageRule() {
  return `Write all generated text in ${OUTPUT_LANGUAGE}; keep UI labels, messages and domain terms exactly as the sources spell them.`;
}

/* ── Ticket ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Tracker facts off a raw Jira issue (GET /issue/{key}). Everything optional; nothing here is
 * project specific — custom fields are not read.
 */
function ticketFactsFromIssue(issue) {
  const f = (issue && issue.fields) || {};
  const name = (x) => (x && (x.name || x.value)) || "";
  const parent = f.parent
    ? {
        key: f.parent.key,
        summary: (f.parent.fields && f.parent.fields.summary) || "",
        issueType: name(f.parent.fields && f.parent.fields.issuetype),
      }
    : null;
  const links = [];
  for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
    const other = l.outwardIssue || l.inwardIssue;
    if (!other) continue;
    const relation = (l.outwardIssue ? l.type && l.type.outward : l.type && l.type.inward) || (l.type && l.type.name) || "relates to";
    links.push({
      relation,
      key: other.key,
      summary: (other.fields && other.fields.summary) || "",
      status: name(other.fields && other.fields.status),
      issueType: name(other.fields && other.fields.issuetype),
    });
  }
  const subtasks = (Array.isArray(f.subtasks) ? f.subtasks : []).map((s) => ({
    key: s.key,
    summary: (s.fields && s.fields.summary) || "",
    status: name(s.fields && s.fields.status),
  }));
  return {
    summary: f.summary || "",
    issueType: name(f.issuetype),
    status: name(f.status),
    priority: name(f.priority),
    parent,
    components: (Array.isArray(f.components) ? f.components : []).map(name).filter(Boolean),
    fixVersions: (Array.isArray(f.fixVersions) ? f.fixVersions : []).map(name).filter(Boolean),
    links,
    subtasks,
  };
}

/**
 * <ticket> + <description>. Accepts the prompt context ({ issueKey, issueDescription, issueLabels,
 * ticket }) — `ticket` may be missing (old review sessions), then only key / labels show.
 */
function buildTicketSection(ctx) {
  const t = (ctx && ctx.ticket) || {};
  const lines = [`Issue Key: ${ctx.issueKey || ""}`];
  if (t.summary) lines.push(`Summary: ${t.summary}`);
  const kind = [t.issueType && `Type: ${t.issueType}`, t.status && `Status: ${t.status}`, t.priority && `Tracker priority: ${t.priority}`].filter(Boolean);
  if (kind.length) lines.push(kind.join(" | "));
  if (t.parent && t.parent.key) {
    lines.push(`Parent: ${t.parent.key}${t.parent.issueType ? ` (${t.parent.issueType})` : ""}${t.parent.summary ? ` — ${t.parent.summary}` : ""}`);
  }
  if (t.components && t.components.length) lines.push(`Components: ${t.components.join(", ")}`);
  if (t.fixVersions && t.fixVersions.length) lines.push(`Fix versions: ${t.fixVersions.join(", ")}`);
  lines.push(`Labels: ${(ctx.issueLabels || []).join(", ") || "none"}`);
  if (t.links && t.links.length) {
    lines.push("Explicit links in the tracker:");
    for (const l of t.links.slice(0, 15)) {
      lines.push(`- ${l.relation} ${l.key}${l.issueType ? ` (${l.issueType})` : ""}${l.summary ? ` — ${l.summary}` : ""}${l.status ? ` [${l.status}]` : ""}`);
    }
  }
  if (t.subtasks && t.subtasks.length) {
    lines.push(`Sub-tasks: ${t.subtasks.slice(0, 15).map((s) => `${s.key} ${s.summary}`.trim()).join("; ")}`);
  }
  const description = String(ctx.issueDescription || "").trim() || "(empty)";
  return `<ticket>
${lines.join("\n")}
</ticket>

<description>
${description}
</description>
The summary states the intent of the ticket; read the description in its light.`;
}

const SOURCE_PRIORITY_BLOCK = `
SOURCE PRIORITY (how to weigh the material in this prompt):
1. <ticket> and <description> — the requirement itself: summary, description, acceptance criteria.
2. Decisions in <issue_comments> — newer than the description: a stated decision refines or overrides it; a question or an unconfirmed proposal does not.
3. <attachments>, <confluence_pages>, design and prototype blocks — supporting specification. Use their exact labels and values; where they contradict 1–2, follow 1–2 and name the conflict in "reasoning".
4. <related_issues> — neighbouring work: integration points, shared vocabulary, already shipped behaviour this ticket must not break. Never a source of new requirements for this ticket.
5. <existing_tests> — how this area is tested today: wording, test data, existing coverage. Never a source of requirements.
Material that turns out to be unrelated to this ticket is ignored — say so in "reasoning" instead of designing around it.`;

/* ── Focus areas (Related Keywords) ─────────────────────────────────────────────────────────── */

function buildFocusAreasBlock(focusAreas) {
  const list = (Array.isArray(focusAreas) ? focusAreas : []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return "";
  return `

<focus_areas>
${list.join(", ")}
</focus_areas>
The QA engineer named these areas for this run. Give the interaction between this ticket and each of them explicit coverage (shared data, navigation between them, side effects in them), and say in "reasoning" which tests touch which area. They are a focus, not new requirements.`;
}

/* ── Related issues ─────────────────────────────────────────────────────────────────────────── */

/**
 * Tag every related issue with how it is related and keep the strongest first:
 * explicitly linked → same parent → most search words in the summary → most recently updated
 * (the order the search returned).
 */
function rankRelatedIssues(issues, { ticket = null, queryWords = [], max = intEnv("RELATED_ISSUES_MAX", 10) } = {}) {
  const linked = new Map(((ticket && ticket.links) || []).map((l) => [l.key, l.relation]));
  const parentKey = ticket && ticket.parent && ticket.parent.key;
  const words = (queryWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  const scored = (Array.isArray(issues) ? issues : []).map((it, order) => {
    const summary = String(it.summary || "").toLowerCase();
    const hits = words.filter((w) => summary.includes(w)).length;
    let relation;
    let rank;
    if (linked.has(it.key)) {
      relation = `explicitly linked (${linked.get(it.key)})`;
      rank = 3;
    } else if (parentKey && it.parentKey === parentKey) {
      relation = `same parent ${parentKey}`;
      rank = 2;
    } else {
      relation = words.length ? `summary shares ${hits} of ${words.length} search word(s)` : "found by search";
      rank = 1;
    }
    return { ...it, relation, _rank: rank, _hits: hits, _order: order };
  });
  scored.sort((a, b) => b._rank - a._rank || b._hits - a._hits || a._order - b._order);
  return scored.slice(0, max).map(({ _rank, _hits, _order, parentKey: _p, ...rest }) => rest);
}

function buildRelatedIssuesSection(issues, meta) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) return "";
  const foundBy =
    meta && meta.mode === "custom keywords"
      ? `keywords typed by the QA engineer: ${(meta.queryWords || []).join(", ")}`
      : meta && (meta.queryWords || []).length
        ? `words from this ticket's summary: ${(meta.queryWords || []).join(", ")}`
        : "search";
  const body = list
    .map((r) => {
      const lines = [`- ${r.key}${r.issueType ? ` (${r.issueType})` : ""}${r.status ? ` [${r.status}]` : ""} — ${r.summary || ""}`];
      lines.push(`  Relation: ${r.relation || "found by search"}`);
      if (r.labels && r.labels.length) lines.push(`  Labels: ${r.labels.join(", ")}`);
      if (r.description) lines.push(`  Description: ${r.description}`);
      if (r.previousQaChecklist && r.previousQaChecklist.length) {
        lines.push("  Already designed QA scenarios:");
        r.previousQaChecklist.forEach((s) => lines.push(`    ${s}`));
      }
      return lines.join("\n");
    })
    .join("\n");
  return `

<related_issues found_by="${foundBy}">
${body}
</related_issues>
How to use the related issues:
- Weigh them by "Relation": explicitly linked > same parent > word match. Shared labels with this ticket make a match stronger. A word match alone may be a coincidence — ignore unrelated ones.
- Done / closed issues describe behaviour already shipped: where this ticket touches it, verify it still works inside a functional scenario. Open issues may still change — do not assert their behaviour.
- "Already designed QA scenarios" are covered elsewhere: align wording with them, do not duplicate them, and focus on what this ticket adds or changes.`;
}

/* ── Confluence ─────────────────────────────────────────────────────────────────────────────── */

function buildConfluencePagesSection(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return "";
  const text = require("./confluence-pages").confluencePagesToText(list);
  return `

<confluence_pages>
${text}
</confluence_pages>`;
}

/* ── Existing tests ─────────────────────────────────────────────────────────────────────────── */

const ORIGIN_LABEL = {
  picked: "picked in the Web UI from the test management system",
  folder: 'project "Test cases" folder',
};

/**
 * A test-case CSV → compact text (title, priority, preconditions, "action → expected" lines):
 * the prompt needs the content, not the IDs and empty columns. Anything that does not parse as
 * the test-case CSV is returned unchanged.
 * @returns {{ text: string, cases: Array<{ title: string, text: string }> | null }}
 */
function compactExistingTests(content) {
  const raw = String(content || "").trim();
  let cases = null;
  try {
    const { parseCsvRows, csvRowsToTestCases } = require("./ado-sync-csv");
    const parsed = csvRowsToTestCases(parseCsvRows(raw));
    if (parsed && parsed.length) {
      cases = parsed.map((tc) => {
        const lines = [`# ${String(tc.title || "").trim()}${tc.priority ? ` (priority ${tc.priority})` : ""}`];
        for (const s of tc.steps || []) {
          const action = String(s.action || "").replace(/\s*\n\s*/g, " / ").trim();
          const expected = String(s.expected || "").replace(/\s*\n\s*/g, " / ").trim();
          if (!action && !expected) continue;
          lines.push(expected && expected !== "—" ? `${s.stepNumber || ""}. ${action} → ${expected}` : `${s.stepNumber || ""}. ${action}`);
        }
        return { title: String(tc.title || ""), text: lines.join("\n") };
      });
    }
  } catch {
    cases = null;
  }
  return cases ? { text: cases.map((c) => c.text).join("\n\n"), cases } : { text: raw, cases: null };
}

/**
 * Fit the existing tests into the budget: picked files first, then folder files; inside an
 * oversized file, the cases whose titles share most words with the ticket go first.
 * @param {Array<{ filename: string, content: string, origin?: string, cases?: Array }>} files
 */
function selectExistingTests(files, { summary = "", keywords = [], maxChars = intEnv("EXISTING_TESTS_MAX_CHARS", 60000) } = {}) {
  const list = (Array.isArray(files) ? files : []).slice();
  list.sort((a, b) => (a.origin === "picked" ? 0 : 1) - (b.origin === "picked" ? 0 : 1));
  const words = new Set(
    [...String(summary).toLowerCase().split(/[^\p{L}\p{N}]+/u), ...keywords.map((k) => String(k).toLowerCase())].filter((w) => w.length > 3)
  );
  const score = (title) => String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => words.has(w)).length;
  const out = [];
  let used = 0;
  for (const f of list) {
    const left = maxChars - used;
    if (left < 500) break;
    let content = f.content;
    let trimmed = false;
    if (content.length > left) {
      if (Array.isArray(f.cases) && f.cases.length) {
        const ranked = f.cases.map((c, i) => ({ ...c, s: score(c.title), i })).sort((a, b) => b.s - a.s || a.i - b.i);
        const keep = [];
        let size = 0;
        for (const c of ranked) {
          if (size + c.text.length + 2 > left) continue;
          keep.push(c);
          size += c.text.length + 2;
        }
        keep.sort((a, b) => a.i - b.i);
        content = keep.map((c) => c.text).join("\n\n");
      } else {
        content = content.slice(0, left);
      }
      trimmed = true;
    }
    out.push({ ...f, content, trimmed });
    used += content.length;
  }
  return out;
}

function buildExistingTestsSection(files, kind) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && String(f.content || "").trim());
  if (!list.length) return "";
  const body = list
    .map((f) => `--- [${ORIGIN_LABEL[f.origin] || "existing tests"}] ${f.filename}${f.trimmed ? " (only the cases most related to this ticket fit)" : ""}\n${String(f.content).trim()}`)
    .join("\n\n");
  const unit = kind === "checklist" ? "checklist" : kind === "bdd" ? "Scenarios" : "test cases";
  const bdd =
    kind === "bdd"
      ? "\n- They are written in the project's own format, not in Gherkin: mine them for vocabulary, preconditions and depth, then express your coverage as Gherkin."
      : "";
  return `

<existing_tests>
${body}
</existing_tests>
How to use the existing tests:
- Style and data: match their wording, Preconditions style and depth, and reuse their roles, test accounts and test data names so the new ${unit} fit next to them. Never copy them.
- Existing coverage: files picked in the Web UI were chosen for this run and weigh most. Do not re-design what they already cover; spend your ${unit} on what this ticket adds or changes.
- Impact: for every existing case that exercises behaviour this ticket changes, decide "still valid", "needs update" or "obsolete", and report it in "coverageNotes" (file and case title).${bdd}`;
}

/* ── Method ─────────────────────────────────────────────────────────────────────────────────── */

/** Replaces the old "think about the area" paragraph with artefacts the reviewer can check. */
function buildDomainModelBlock(kind) {
  const unit = kind === "checklist" ? "checklist items" : kind === "bdd" ? "scenarios" : "test cases";
  return `
DOMAIN MODEL (build it BEFORE designing ${unit}):
1. Picture the product area: actors, vocabulary, main flows, where this ticket sits in the end-to-end journey, and which adjacent features or data it touches.
2. Cross-read every source by the SOURCE PRIORITY above to find implicit rules, constraints, data dependencies, permission boundaries and integration points — even when they are not written as acceptance criteria.
3. Let the model drive the ${unit}: real screens, states, roles and data, never "verify the feature works".
4. Start "reasoning" with this model, compactly:
   Domain: 2–3 sentences.
   Glossary: up to 10 "term — meaning", as the sources use the term.
   Roles and permissions: who can do what (only when the ticket involves roles).
   Entities and states: the objects and the states / transitions they go through (only when relevant).`;
}

const BEHAVIOUR_CHANGE_BLOCK = `
WHEN THE TICKET CHANGES EXISTING BEHAVIOUR (wording like "instead of", "no longer", "change", "replace", "rename", "remove", "from now on"):
- Identify the old and the new behaviour explicitly ("was → becomes") and note it in "reasoning".
- Assert the NEW behaviour, and add at least one check that the OLD behaviour is gone (the old label, option, limit or path no longer appears or works).
- Where data created under the old behaviour can still exist, check how it is shown or handled now.`;

const OFTEN_MISSED_BLOCK = `
OFTEN-MISSED AREAS (cover one ONLY when the ticket or its sources imply it — never as filler):
persistence after reload / re-login; audit or history entries; notifications, e-mails and messages; dates, time zones and number / currency formats; concurrent edits by two users; empty, loading and error states; pagination, sorting and filtering of what the ticket adds; permissions for every role the ticket names; import / export and integrations the ticket feeds.`;

/* ── Requirements inventory and traceability ───────────────────────────────────────────────── */

function buildTraceabilityRules(kind) {
  const unit = kind === "checklist" ? "checklist item" : kind === "bdd" ? "scenario" : "test case";
  return `- REQUIREMENTS INVENTORY: before designing, extract the testable requirements into "requirements" — one entry per rule or behaviour, ids "R1", "R2"… in source order, each with a one-sentence "text", its "source" (description | comment | attachment [A#] | confluence | design | prototype | related issue KEY) and "risk" ("critical" or "normal", by the PRIORITY RULES). Split compound requirements.
- TRACEABILITY: every ${unit} lists in "covers" the requirement ids it verifies. Every critical requirement appears in at least one "covers"; a requirement no ${unit} covers is a deliberate gap and must be named in "reasoning".
- "assumptions": what you had to assume because the sources did not say (one sentence each). Put the assumption into the ${unit} too (preconditions / steps); never silently invent labels, values or rules.
- "openQuestions": what is ambiguous, contradictory or missing and should be asked before testing (one sentence each).`;
}

const TRACEABILITY_SCHEMA_FIELDS = `  "requirements": [
    { "id": "R1", "text": "string", "source": "description", "risk": "critical" }
  ],
  "assumptions": ["string"],
  "openQuestions": ["string"],`;

/**
 * Requirements ↔ covers, after parsing. Never throws; works on old-shaped answers too.
 * @param {Object} parsed - { requirements, testCases | checklistItems }
 */
function checkCoverage(parsed) {
  const reqs = (Array.isArray(parsed && parsed.requirements) ? parsed.requirements : []).filter((r) => r && r.id);
  const rows = Array.isArray(parsed && parsed.testCases) ? parsed.testCases : Array.isArray(parsed && parsed.checklistItems) ? parsed.checklistItems : [];
  const covered = new Set();
  for (const row of rows) {
    for (const id of Array.isArray(row && row.covers) ? row.covers : []) covered.add(String(id).trim());
  }
  const uncovered = reqs.filter((r) => !covered.has(String(r.id).trim()));
  return {
    total: reqs.length,
    covered: reqs.length - uncovered.length,
    uncovered: uncovered.map((r) => r.id),
    criticalUncovered: uncovered.filter((r) => String(r.risk || "").toLowerCase() === "critical").map((r) => r.id),
    assumptions: Array.isArray(parsed && parsed.assumptions) ? parsed.assumptions.length : 0,
    openQuestions: Array.isArray(parsed && parsed.openQuestions) ? parsed.openQuestions.length : 0,
  };
}

/**
 * Everything between the ticket and the method: source priority, focus areas and the sources,
 * each in its own tag. `designBlocks` are the already-built Figma / prototype / attachments /
 * comments / Confluence-text blocks of the caller.
 */
function buildSourcesSection(ctx, kind, designBlocks = "") {
  let s = SOURCE_PRIORITY_BLOCK;
  s += buildFocusAreasBlock(ctx.focusAreas);
  s += buildConfluencePagesSection(ctx.confluencePages);
  s += buildRelatedIssuesSection(ctx.relatedJiraIssues, ctx.relatedSearchMeta);
  s += buildExistingTestsSection(ctx.projectTestCases, kind);
  s += designBlocks;
  const anything =
    (ctx.confluencePages || []).length || (ctx.relatedJiraIssues || []).length || (ctx.projectTestCases || []).length || String(designBlocks).trim();
  if (!anything) s += "\n\nNo supporting material was found: base the design on the ticket alone, and list in \"openQuestions\" what you would need to know.";
  return s;
}

function buildMethodSection(kind) {
  return `\n${buildDomainModelBlock(kind)}\n${BEHAVIOUR_CHANGE_BLOCK}\n${OFTEN_MISSED_BLOCK}`;
}

module.exports = {
  OUTPUT_LANGUAGE,
  languageRule,
  ticketFactsFromIssue,
  buildTicketSection,
  SOURCE_PRIORITY_BLOCK,
  buildFocusAreasBlock,
  rankRelatedIssues,
  buildRelatedIssuesSection,
  buildConfluencePagesSection,
  compactExistingTests,
  selectExistingTests,
  buildExistingTestsSection,
  buildDomainModelBlock,
  BEHAVIOUR_CHANGE_BLOCK,
  OFTEN_MISSED_BLOCK,
  buildTraceabilityRules,
  TRACEABILITY_SCHEMA_FIELDS,
  checkCoverage,
  buildSourcesSection,
  buildMethodSection,
};
