/**
 * The area-study pass: one LLM call that reads every source in full and writes down how the
 * product area around the ticket works today — before any test is designed.
 *
 * Why a separate pass. The context fields (existing test cases from the test management system,
 * related issues, Confluence, design, prototype, attachments, comments) exist so the tool
 * understands the feature and the areas next to it. Fed straight into the generation prompt they
 * compete with the output contract, the format rules and the design method for the model's
 * attention, and whatever understanding the model forms stays invisible: nobody can check it, and
 * in the Update flow every block forms its own. Here the model has one job — understand — and the
 * result is a short text that
 *   - goes into every generation prompt of the run (Create, Update blocks, each Regenerate), so
 *     all of them start from the same picture of the area;
 *   - is shown in the review panel, where the QA engineer can correct it and regenerate;
 *   - says which sources turned out to have nothing to do with the ticket (a selection left over
 *     from the previous ticket, a related issue matched by one word).
 *
 * The sources still go into the generation prompt as before; the brief is added, not swapped in.
 *
 * Nothing here knows a product or a domain. Never throws: a failed study pass means "no brief",
 * and the run continues exactly as it did before this file existed.
 *
 * Settings (env / .env only):
 *   AREA_BRIEF                  "off" to skip the pass; anything else leaves it on
 *   AREA_BRIEF_MAX_TOKENS       output cap of the pass, default 12000 (a ceiling, not a charge —
 *                               with the Claude API the model's thinking counts towards it)
 *   AREA_BRIEF_TESTS_MAX_CHARS  existing test cases the pass reads, default 200000
 */

const pc = require("./prompt-context");

function intEnv(name, fallback) {
  const n = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function areaBriefEnabled() {
  return !["off", "false", "0", "no"].includes(String(process.env.AREA_BRIEF || "").trim().toLowerCase());
}

const tagged = (tag, text) => {
  const s = String(text || "").trim();
  return s ? `\n\n<${tag}>\n${s}\n</${tag}>` : "";
};

/**
 * @typedef {Object} AreaBriefInput
 * @property {string} issueKey
 * @property {string} issueDescription
 * @property {string[]} [issueLabels]
 * @property {Object} [ticket] - tracker facts (prompt-context.ticketFactsFromIssue)
 * @property {Array<{filename: string, content: string, origin?: string}>} [existingTests]
 * @property {Array<Object>} [relatedJiraIssues]
 * @property {Object} [relatedSearchMeta]
 * @property {string} [confluenceContext] - confluence-pages.confluencePagesToText()
 * @property {string} [figmaContext]
 * @property {string} [prototypeContext]
 * @property {string} [attachmentsContext]
 * @property {string} [commentsContext]
 * @property {string[]} [focusAreas]
 * @property {string} [helpingPrompt]
 * @property {string[]} [csvOutline] - Update flow: titles of the cases in the CSV being updated
 */

/**
 * Is there anything to study besides the ticket itself? Comments alone do not count: they are
 * about the ticket, and the generation prompt reads them anyway.
 */
function hasAreaSources(input) {
  const i = input || {};
  return Boolean(
    (i.existingTests || []).some((f) => f && String(f.content || "").trim()) ||
      (i.relatedJiraIssues || []).length ||
      String(i.confluenceContext || "").trim() ||
      String(i.figmaContext || "").trim() ||
      String(i.prototypeContext || "").trim() ||
      String(i.attachmentsContext || "").trim()
  );
}

/** @param {AreaBriefInput} input */
function buildAreaBriefPrompt(input) {
  const tests = pc.selectExistingTests(input.existingTests || [], {
    summary: (input.ticket && input.ticket.summary) || "",
    keywords: input.focusAreas || [],
    maxChars: intEnv("AREA_BRIEF_TESTS_MAX_CHARS", 200000),
  });
  const focus = (input.focusAreas || []).map((s) => String(s).trim()).filter(Boolean);
  const helping = String(input.helpingPrompt || "").trim();
  const outline = (input.csvOutline || []).map((t) => String(t || "").trim()).filter(Boolean);

  const sources =
    pc.buildExistingTestsSection(tests, "testcases", { bare: true }) +
    pc.buildRelatedIssuesSection(input.relatedJiraIssues, input.relatedSearchMeta, { bare: true }) +
    tagged("confluence_pages", input.confluenceContext) +
    tagged("figma_design", input.figmaContext) +
    tagged("prototype", input.prototypeContext) +
    tagged("attachments", input.attachmentsContext) +
    tagged("issue_comments", input.commentsContext);

  return `You are a senior QA engineer who has just been handed a ticket in a product you must first understand. Before any test is designed, you study the product area the ticket lands in. Your output is an AREA BRIEF: what the sources say about how this area works today, where the ticket touches it, and what the ticket could break there. You do NOT design tests in this step.

${pc.buildTicketSection(input)}${
    focus.length
      ? `\n\nThe QA engineer named these related areas: ${focus.join(", ")}. Find out from the sources how each of them works and whether the ticket touches it.`
      : ""
  }${helping ? `\n\nWhat the QA engineer asked to focus on in this run (it tells you which parts of the area matter most):\n<helping_prompt>\n${helping}\n</helping_prompt>` : ""}${
    outline.length
      ? `\n\nThe test cases about to be updated for this ticket are titled:\n${outline.slice(0, 150).map((t) => `- ${t}`).join("\n")}`
      : ""
  }

SOURCES ABOUT THE AREA:${sources}

HOW TO STUDY THE SOURCES:
- Read every source in full. Existing test cases are the richest one: each "action → expected" pair is a verified statement of how the product behaves today. Related issues that are done or closed describe shipped behaviour; open ones describe plans — mark a fact taken from an open issue with "(planned)".
- State only what a source says. No guesses and no general knowledge of how such products usually work. Every fact names its source.
- Keep UI labels, statuses, messages, limits and role names exactly as the sources spell them.
- Choose facts by their bearing on THIS ticket: the same screen, the same data, the same roles, the same filters or statuses, whatever feeds into or reads from what the ticket changes. Leave out behaviour the ticket cannot affect.
- BE BRIEF. This is a note a QA engineer reads in half a minute, not a report. At most 8 facts, 3 role / data lines, 4 touch points, 4 risks and 3 unknowns — the ones that matter most for this ticket; fewer is better when fewer matter. Every line is one plain statement of at most about 18 words: no sub-clauses, no lists inside a line, no restating the ticket. "area" is one sentence.
- "touchPoints": the concrete places where the ticket's change meets existing behaviour (a shared screen, a total computed from the same data, a permission that also guards something else).
- "risks": what the ticket could break in the existing behaviour. Each one is a specific observable failure tied to a fact above ("the status total no longer equals the sum of the cards"), never "regression in the module".
- "unknowns": what you needed in order to understand the area and the sources do not say.
- A source that has nothing to do with this ticket goes into "unrelatedSources" with one short reason, and no facts are taken from it. Saying so is useful: it tells the QA engineer that context was picked by mistake.
- ${pc.languageRule()} No markdown.

Return ONLY valid JSON, no code fences and no text around it:
{
  "area": "string: ONE sentence — the product area, its screen and who uses it",
  "howItWorksToday": [
    { "fact": "string: one short sentence", "source": "existing test: <case title> | related issue KEY | confluence: <page title> | design | prototype | attachment [A#] | comment" }
  ],
  "rolesAndData": ["string: a role with what it may do, or test data / accounts the existing tests rely on"],
  "touchPoints": ["string"],
  "risks": ["string"],
  "unknowns": ["string"],
  "unrelatedSources": [
    { "source": "string", "why": "string" }
  ]
}`;
}

const list = (v) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x.trim() : x)).filter(Boolean);

/**
 * "existing test: Replace the status bars to new approach" → "TMS". A full case title after every
 * fact doubled the length of the brief; which kind of source a fact came from is what a reader
 * (and the generation prompt, which has the sources themselves) needs.
 */
function shortSource(source) {
  const s = String(source || "").trim();
  const l = s.toLowerCase();
  if (!s) return "";
  if (l.startsWith("existing test")) return "TMS";
  const key = /\b[A-Z][A-Z0-9_]+-\d+\b/.exec(s);
  if (l.startsWith("related issue")) return key ? key[0] : "related issue";
  if (l.startsWith("confluence")) return "Confluence";
  const att = /\[A\d+\]/.exec(s);
  if (l.startsWith("attachment")) return att ? att[0].slice(1, -1) : "attachment";
  if (l.startsWith("comment")) return "comment";
  if (l.startsWith("design") || l.startsWith("figma")) return "design";
  if (l.startsWith("prototype")) return "prototype";
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

/** Hard caps behind the prompt's "be brief": the panel shows this text above the test cases. */
const BRIEF_CAPS = { facts: 8, rolesAndData: 3, touchPoints: 4, risks: 4, unknowns: 3, unrelated: 4 };

/** The parsed brief → the plain text that goes into prompts and into the review panel. */
function renderAreaBrief(parsed) {
  const p = parsed || {};
  const lines = [];
  const area = String(p.area || "").trim();
  if (area) lines.push(`AREA: ${area}`);
  // No blank lines between sections and one line per item: the whole brief is meant to fit in
  // a glance (about 25 short lines at the caps above).
  const section = (title, items, cap) => {
    if (!items.length) return;
    lines.push(`${title}:`);
    for (const it of items.slice(0, cap)) lines.push(`- ${String(it).replace(/\s+/g, " ").trim()}`);
  };
  section(
    "How it works today",
    list(p.howItWorksToday)
      .map((f) => {
        if (typeof f === "string") return f;
        const fact = String((f && f.fact) || "").trim().replace(/[.;]+$/, "");
        const source = shortSource(f && f.source);
        return fact ? `${fact}${source ? ` (${source})` : ""}` : "";
      })
      .filter(Boolean),
    BRIEF_CAPS.facts
  );
  section("Roles and data", list(p.rolesAndData).map(String), BRIEF_CAPS.rolesAndData);
  section("Where this ticket touches it", list(p.touchPoints).map(String), BRIEF_CAPS.touchPoints);
  section("What it could break", list(p.risks).map(String), BRIEF_CAPS.risks);
  section("Not known from the sources", list(p.unknowns).map(String), BRIEF_CAPS.unknowns);
  section(
    "Unrelated context",
    list(p.unrelatedSources)
      .map((u) => {
        if (typeof u === "string") return u;
        const source = String((u && u.source) || "").trim();
        const why = String((u && u.why) || "").trim();
        return source ? `${source}${why ? ` — ${why}` : ""}` : "";
      })
      .filter(Boolean),
    BRIEF_CAPS.unrelated
  );
  return lines.join("\n").trim();
}

function parseBriefJson(response) {
  const cleaned = String(response || "").replace(/```(?:json)?\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("the model did not return JSON");
  }
}

/**
 * Run the study pass.
 *
 * @param {AreaBriefInput} input
 * @param {{ callLLM: (prompt: string, maxTokens: number) => Promise<string>, guard?: Function, log?: Function }} deps
 *   `callLLM` is the calling agent's own wrapper, so the tokens land in its usage tally;
 *   `guard` is placeholder-guard's guardLlmResult, applied to the parsed answer when given.
 * @returns {Promise<{ text: string, facts: number, unrelated: string[], skipped?: string }>}
 */
async function generateAreaBrief(input, { callLLM, guard = null, log = console.log } = {}) {
  const none = (skipped) => ({ text: "", facts: 0, unrelated: [], skipped });
  if (!areaBriefEnabled()) return none("AREA_BRIEF is off");
  if (!hasAreaSources(input)) return none("no context besides the ticket");
  if (typeof callLLM !== "function") return none("no LLM available");
  try {
    log("🧭 Studying the product area from the context (area brief)...");
    const response = await callLLM(buildAreaBriefPrompt(input), intEnv("AREA_BRIEF_MAX_TOKENS", 12000));
    let parsed = parseBriefJson(response);
    if (guard) parsed = guard(parsed, `area brief for ${input.issueKey || "the ticket"}`);
    const text = renderAreaBrief(parsed);
    if (!text) return none("the model returned an empty brief");
    const facts = list(parsed.howItWorksToday).length;
    const unrelated = list(parsed.unrelatedSources)
      .map((u) => (typeof u === "string" ? u : String((u && u.source) || "").trim()))
      .filter(Boolean);
    log(
      `🧭 Area brief: ${facts} fact(s) about how the area works today, ${list(parsed.touchPoints).length} touch point(s), ${
        list(parsed.risks).length
      } risk(s), ${list(parsed.unknowns).length} unknown(s).`
    );
    for (const u of unrelated) log(`⚠️  Context not related to this ticket: ${u}`);
    return { text, facts, unrelated };
  } catch (err) {
    log(`⚠️  Area brief failed (continuing without it): ${err && err.message ? err.message : err}`);
    return none("the study pass failed");
  }
}

module.exports = {
  areaBriefEnabled,
  hasAreaSources,
  buildAreaBriefPrompt,
  renderAreaBrief,
  generateAreaBrief,
};
