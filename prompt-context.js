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
 *   TEST_CASE_GRANULARITY      "packed" (default) or "atomic" — how much one test case carries
 *                              when no "exactly N" limit shapes the design, see caseGranularity()
 *   AREA_BRIEF                 "off" skips the area-study pass before generation (area-brief.js)
 *   RELATED_ISSUE_DESC_MAX_CHARS  description kept per related issue, default 3000
 */

const OUTPUT_LANGUAGE = String(process.env.OUTPUT_LANGUAGE || "").trim() || "English";

function intEnv(name, fallback) {
  const n = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How much one test case carries when the QA engineer set no "exactly N" limit.
 *
 * Teams disagree on this, and both sides are right for their own test management system:
 *   packed — fewer, deeper cases: the main flow plus the negative / boundary / role checks that
 *            belong to it, in one case. The behaviour this tool always had, so it is the default.
 *   atomic — one behaviour per case, so a failed case points at one thing and can be re-run alone.
 * A numeric limit (Create → Test cases limit) is a packaging request of its own and wins over this.
 */
function caseGranularity() {
  return String(process.env.TEST_CASE_GRANULARITY || "").trim().toLowerCase() === "atomic" ? "atomic" : "packed";
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
3. <attachments>, <confluence_pages>, design and prototype blocks — supporting specification. Use their exact labels and values. Where they contradict 1–2, design the tests by 1–2, but do not settle the contradiction silently: the specification may be the side that is right. Put it into "openQuestions" (which source says what; in "reasoning" where the output has no such field) so a person resolves it.
4. <related_issues> — neighbouring work: integration points, shared vocabulary, already shipped behaviour this ticket must not break. Never a source of new requirements for this ticket.
5. <existing_tests> — verified knowledge of how this area behaves today, and how it is tested: screens, states, rules, wording, test data, existing coverage. Not a source of new requirements for this ticket — but the main source for what this ticket could break.
Material that turns out to be unrelated to this ticket is ignored — say so in "reasoning" instead of designing around it.`;

/* ── Focus areas (Related Keywords) ─────────────────────────────────────────────────────────── */

function buildFocusAreasBlock(focusAreas) {
  const list = (Array.isArray(focusAreas) ? focusAreas : []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return "";
  return `

<focus_areas>
${list.join(", ")}
</focus_areas>
The QA engineer named these areas for this run. Look for the interaction between this ticket and each of them in the sources — shared screens, shared data, navigation between them, side effects — and give every interaction the sources show its own explicit coverage. Say in "reasoning" which tests touch which area. Where the sources show no interaction with an area, say that too and put the doubt into "openQuestions" instead of inventing a link to test. They are a focus, not new requirements.`;
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

function buildRelatedIssuesSection(issues, meta, { bare = false } = {}) {
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
  // `bare`: the sources alone, for the area-study pass — it reads them, it does not design from them.
  if (bare) return `\n\n<related_issues found_by="${foundBy}">\n${body}\n</related_issues>`;
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
  helping: "named in the Helping Prompt, from the test management system",
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
  // Keywords are phrases ("Pal concept A"); titles are compared word by word, so a phrase kept
  // whole never matched anything and the ranking silently fell back to file order.
  const words = new Set(
    [String(summary), ...keywords.map((k) => String(k))]
      .flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u))
      .filter((w) => w.length > 3)
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

function buildExistingTestsSection(files, kind, { bare = false } = {}) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && String(f.content || "").trim());
  if (!list.length) return "";
  const body = list
    .map((f) => `--- [${ORIGIN_LABEL[f.origin] || "existing tests"}] ${f.filename}${f.trimmed ? " (only the cases most related to this ticket fit)" : ""}\n${String(f.content).trim()}`)
    .join("\n\n");
  // `bare`: the sources alone, for the area-study pass (area-brief.js).
  if (bare) return `\n\n<existing_tests>\n${body}\n</existing_tests>`;
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
- Current behaviour: every "action → expected" pair is a verified statement of how this area works today. Learn the area from them — its screens and labels, states and transitions, roles, data and rules — and let that knowledge make the new ${unit} concrete and show you what this ticket really changes.
- Style and data: match their wording, Preconditions style and depth, and reuse their roles and the kinds of test data they rely on so the new ${unit} fit next to them. Never copy them — and where they name a specific person or record (a full name, an order number), generalise it as GENERIC TEST DATA says instead of reusing it.
- Existing coverage: files picked in the Web UI were chosen for this run and weigh most. Do not re-design what they already cover; spend your ${unit} on what this ticket adds or changes.
- Impact: for every existing case that exercises behaviour this ticket touches (the same screen, data, filter, status or permission), decide "still valid", "needs update" or "obsolete", and report it in "coverageNotes" (file and case title).
- What the ticket could break: where the change can alter behaviour an existing case describes, do not leave it as a note — add ONE concrete check for it (the specific thing that could go wrong: a total that no longer matches, a filter that loses its value, a role that gains access), inside a functional or integration scenario. Enter it in "requirements" with source "impact: <case title>". Only where a source shows the ticket touches that behaviour — never "re-test the module".${bdd}`;
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
4. Write this model into "analysis" — the FIRST field of the output, written before the requirements and before any ${unit} — compactly:
   Domain: 2–3 sentences.
   Glossary: up to 10 "term — meaning", as the sources use the term.
   Roles and permissions: who can do what (only when the ticket involves roles).
   Entities and states: the objects and the states / transitions they go through (only when relevant).`;
}

const BEHAVIOUR_CHANGE_BLOCK = `
WHEN THE TICKET CHANGES EXISTING BEHAVIOUR (wording like "instead of", "no longer", "change", "replace", "rename", "remove", "from now on"):
- Identify the old and the new behaviour explicitly ("was → becomes") and write it down before designing: in "analysis", or at the start of "reasoning" where the output has no "analysis" field.
- Assert the NEW behaviour, and add at least one check that the OLD behaviour is gone (the old label, option, limit or path no longer appears or works).
- Where data created under the old behaviour can still exist, check how it is shown or handled now.`;

const OFTEN_MISSED_BLOCK = `
OFTEN-MISSED AREAS (cover one ONLY when the ticket or its sources imply it — never as filler):
persistence after reload / re-login; audit or history entries; notifications, e-mails and messages; dates, time zones and number / currency formats; concurrent edits by two users; empty, loading and error states; pagination, sorting and filtering of what the ticket adds; permissions for every role the ticket names; import / export and integrations the ticket feeds.`;

/* ── Requirements inventory and traceability ───────────────────────────────────────────────── */

function buildTraceabilityRules(kind) {
  const unit = kind === "checklist" ? "checklist item" : kind === "bdd" ? "scenario" : "test case";
  return `- REQUIREMENTS INVENTORY: before designing, extract the requirements into "requirements" — one entry per rule or behaviour, ids "R1", "R2"… in source order, each with a one-sentence "text", its "source" (description | comment | attachment [A#] | confluence | design | prototype | related issue KEY | impact: <existing case title or related issue KEY>), "risk" ("critical" or "normal", by the PRIORITY RULES) and "testable". Split compound requirements: "title, rich text and mentions work" is three entries, not one.
- "testable" is false for what cannot be verified through the product by a tester — unit-test or code-coverage tasks, refactoring, implementation notes, deployment chores. Keep such entries in the inventory with "testable": false, design nothing for them, and do not count them as gaps. Everything else is true.
- TRACEABILITY: every ${unit} lists in "covers" the requirement ids it verifies. Every critical requirement appears in at least one "covers"; a testable requirement no ${unit} covers is a deliberate gap and must be named in "reasoning".
- "assumptions": what you had to assume because the sources did not say (one sentence each). ${
    kind === "checklist"
      ? "Reflect the assumption in the wording of the checklist item it affects; if it is a setup condition for the whole run, put it into the Preconditions item (see CHECKLIST PRECONDITIONS) — never into the other items."
      : `Put the assumption into the ${unit} too (preconditions / steps).`
  } Never silently invent labels, values or rules.
- "openQuestions": what is ambiguous, contradictory or missing and should be asked before testing (one sentence each).
- "contextInsights": what the supporting material taught you that shaped a ${unit} — everything except the ticket's own description: existing tests, related issues, comments, Confluence, design, prototype, attachments (for a fact you took from the area brief, name the source the brief gives for it). One entry per fact: "source" (existing test: <case title> | related issue KEY | comment | confluence: <page title> | design | prototype | attachment [A#]), "fact" (one sentence, what you learned), "usedIn" (${
    kind === "checklist" ? 'the ids of the checklist items it shaped, e.g. ["CL-4"]' : `the ${unit}s it shaped, by their position in "testCases", e.g. ["T2", "T5"]`
  }). List only facts that changed what you wrote. If the supporting material added nothing, return [] — an honest empty list tells the QA engineer more than a padded one.`;
}

/** Goes right after the array of generated rows in every generation schema — it refers to them. */
const CONTEXT_INSIGHTS_SCHEMA_FIELD = `  "contextInsights": [
    { "source": "existing test: <case title>", "fact": "string", "usedIn": ["string"] }
  ],`;

/* ── Area brief ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The area brief (area-brief.js) as a prompt block: what an earlier pass, which read every source
 * in full and designed nothing, wrote down about the product area the ticket lands in.
 *
 * It does not replace the sources — they follow as before. It is there so the design starts from
 * an understanding of the area instead of building one in passing, and so that understanding is a
 * text a person can read and correct. Once the QA engineer has edited it in the review panel it
 * outranks the sources it was distilled from: they looked at it and fixed it.
 *
 * @param {string} brief
 * @param {{ edited?: boolean, kind?: "design"|"update"|"single" }} [options]
 */
function buildAreaBriefBlock(brief, { edited = false, kind = "design" } = {}) {
  const text = String(brief || "").trim();
  if (!text) return "";
  const trust = edited
    ? "The QA engineer has reviewed and corrected it: where it differs from a source below, the brief is right."
    : "Where it disagrees with a source below, the source is right — say so in \"reasoning\".";
  const use =
    kind === "update"
      ? `- Use it to understand the area and to judge which steps the ticket really affects.
- It does not widen the task: HOW TO UPDATE below still decides what you may change. When the changed behaviour does need a new step or a new case, prefer the checks its "What it could break" lines point at.`
      : kind === "single"
        ? `- Use it to make this one rewrite concrete: real screens, labels, states and data of the area. It does not widen the scope of the item you are rewriting.`
        : `- Start the DOMAIN MODEL ("analysis") from it instead of rebuilding it; add what it lacks.
- It is deliberately short — a few key facts, not the whole area; the sources below hold the detail.
- "Where this ticket touches it" and "What it could break": go through them line by line. Each line is either covered by a concrete check, or named in "reasoning" as not applicable with the reason.
- "Not known from the sources": put each into "openQuestions" unless a source answers it after all.`;
  return `

<area_brief>
${text}
</area_brief>
How to use the area brief:
- It was written by an earlier pass that read all the sources below in full, to understand the product area before any test was designed. ${trust}
${use}
- It describes the area. It is not a list of requirements for this ticket.`;
}

const TRACEABILITY_SCHEMA_FIELDS = `  "analysis": "string: the DOMAIN MODEL (Domain / Glossary / Roles and permissions / Entities and states), and what the ticket changes (was → becomes) when it changes existing behaviour",
  "requirements": [
    { "id": "R1", "text": "string", "source": "description", "risk": "critical", "testable": true }
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
  // "testable": false — unit-test tasks, refactoring, implementation notes: in the inventory so the
  // reviewer sees they were read, but nothing a test case could cover, so never a gap.
  const notTestable = reqs.filter((r) => r.testable === false || String(r.testable).toLowerCase() === "false");
  const testable = reqs.filter((r) => !notTestable.includes(r));
  const uncovered = testable.filter((r) => !covered.has(String(r.id).trim()));
  return {
    total: reqs.length,
    notTestable: notTestable.length,
    covered: testable.length - uncovered.length,
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
  s += buildAreaBriefBlock(ctx.areaBrief, { edited: Boolean(ctx.areaBriefEdited) });
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

/**
 * A checklist may open with ONE preparatory item — what a tester sets up before running the whole
 * checklist — and nowhere else. The CSV turns every item into a step, so that item lands as step 1,
 * where Azure DevOps keeps preconditions for a test case too. Every other item stays one check.
 */
const CHECKLIST_PRECONDITIONS_BLOCK = `CHECKLIST PRECONDITIONS:
- The checklist MAY start with exactly one preparatory item: its "description" starts with "Preconditions: " and lists, in one sentence or a short semicolon-separated list, what a tester needs before running the whole checklist — environment, accounts and roles, feature flags or configuration, seeded test data. Category "Functional", "covers": [].
- Only as the FIRST item, at most one, and only when the ticket needs setup beyond a normal working environment; otherwise leave it out. It is setup, not a check, and covers no requirement.
- Every other item is ONE verifiable check: no "Preconditions:", no setup steps, no numbered steps, no "Given" context inside it. Setup the whole run needs goes into the Preconditions item; a condition specific to one check is stated briefly inside that check ("with two unread messages, …").`;

module.exports = {
  CHECKLIST_PRECONDITIONS_BLOCK,
  OUTPUT_LANGUAGE,
  caseGranularity,
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
  CONTEXT_INSIGHTS_SCHEMA_FIELD,
  buildAreaBriefBlock,
  checkCoverage,
  buildSourcesSection,
  buildMethodSection,
};
