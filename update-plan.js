/**
 * The file plan of the Update flow: one LLM call that reads the ticket and EVERY case of the CSV
 * and decides, before anything is rewritten, what the ticket changes, which cases that touches,
 * and which new cases are needed.
 *
 * Why. The Update flow used to ask every case, in its own call, "does this ticket concern you?".
 * Nobody saw the file as a whole: a new behaviour was added by whichever case came first, a case
 * the ticket never touched could still be "improved", and nothing checked that every change of
 * the ticket ended up somewhere. With a plan:
 *   - a case judged "keep" is returned from the CSV as it is — no model call, so it cannot drift;
 *   - a case judged "update" is rewritten knowing which change it is affected by;
 *   - a case judged "check" (the plan could not tell) goes through the ordinary update prompt,
 *     where "unchanged" stays a valid answer;
 *   - new cases are written once, in one call, from the list the plan drew up;
 *   - afterwards every change of the ticket is traced to the cases it landed in.
 *
 * This file holds the pure parts — prompts, normalisation, the coverage summary. The calls, the
 * blocks and the session live in agent-update-csv.js. Nothing here knows a product or a domain.
 *
 * Settings (env / .env only):
 *   UPDATE_PLAN            "off" keeps the old one-call-per-case update with no plan
 *   UPDATE_PLAN_MAX_TOKENS output cap of the planning call, default 12000
 */

const pc = require("./prompt-context");

function planEnabled() {
  return !["off", "false", "0", "no"].includes(String(process.env.UPDATE_PLAN || "").trim().toLowerCase());
}

function planMaxTokens() {
  const n = Number.parseInt(String(process.env.UPDATE_PLAN_MAX_TOKENS || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 12000;
}

const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();

/** One case of the CSV as the planning prompt shows it: numbered, compact, with its steps. */
function caseTextForPlan(block, n) {
  const src = (block && block.source) || {};
  if (block.type !== "testcase") {
    const items = (src.items || []).map((it, i) => `  ${i + 1}. ${oneLine(it.description)}`);
    return `[${n}] CHECKLIST: ${oneLine(src.workItemTitle) || "(untitled checklist)"}\n${items.join("\n")}`;
  }
  const steps = (src.steps || []).map((s, i) => {
    const action = oneLine(s.action);
    const expected = oneLine(s.expected);
    return `  ${s.stepNumber || i + 1}. ${action}${expected && expected !== "—" ? ` → ${expected}` : ""}`;
  });
  return `[${n}] ${oneLine(src.title) || "(untitled case)"}\n${steps.join("\n")}`;
}

/**
 * @param {Object} o
 * @param {string} o.ticketSection - ticket + source priority + area brief, as the update prompts get it
 * @param {string} [o.guidanceBlock] - the Helping Prompt block, "" when none
 * @param {Array<Object>} o.blocks - the update blocks, in CSV order
 * @param {string} [o.contextBlocks] - comments / Confluence / design / prototype / attachments blocks
 */
function buildPlanPrompt({ ticketSection, guidanceBlock = "", blocks, contextBlocks = "" }) {
  const hasTestCases = blocks.some((b) => b.type === "testcase");
  const cases = blocks.map((b, i) => caseTextForPlan(b, i + 1)).join("\n\n");
  const newRule = hasTestCases
    ? `- "newCases": a new test case only for a change (or a part of one) that fits the flow of NO existing case. One new case may carry several changes when they belong to one flow. Never plan a new case for what a case with verdict "update" will cover. Fewer is better; [] is a normal answer.`
    : `- This file holds checklists only, so "newCases" stays []. Assign every change to the checklist it belongs to (verdict "update"); the new items are added there.`;
  return `You are a senior QA engineer planning the maintenance of an existing test file for a ticket. In this step you decide — you do NOT rewrite anything. Your plan is then executed case by case: a case you mark "keep" is left exactly as it is without anyone looking at it again, so be exact.
${guidanceBlock}
${ticketSection}
${contextBlocks}

THE FILE — every case in it, in order (the number in brackets is the case number):
${cases}

HOW TO PLAN:
1. "changes": list what the ticket changes in the product's behaviour, as a tester would see it — one entry per change, ids "C1", "C2"…, each one short sentence ("was → becomes" where behaviour is replaced, or what is new). Split compound changes. Typically 2–8. A part of the ticket a tester cannot verify through the product (unit tests, refactoring, deployment chores) is not a change to cover: put it into "notCovered" with the reason.
2. "cases": give EVERY case of the file a verdict, by its number:
   - "update" — at least one of its steps (items) exercises or asserts behaviour a change alters, so it must be edited. Name the changes and the step numbers you mean.
   - "keep" — nothing in it is affected. Passing through a screen the ticket touches is not enough; a step must do or assert something the change alters.
   - "check" — you cannot tell from the text. Use it sparingly, but prefer it to guessing "keep": a "keep" you got wrong is never corrected.
   "why" is at most 12 words and names the reason, not the verdict ("paging is not affected", "filters now combine with Order type").
${newRule}
3. Every change must land somewhere: in the "changes" of at least one "update" case${hasTestCases ? ', in the "covers" of a new case,' : ""} or in "notCovered" with the reason.
4. Maintenance, not improvement: a case that is merely weak, vague or out of style is "keep". Only the ticket decides.
5. A HELPING PROMPT above may widen the task ("add negative cases for …"): then plan for what it asks.
- ${pc.languageRule()} No markdown.

Return ONLY valid JSON, no code fences and no text around it:
{
  "changes": [
    { "id": "C1", "text": "string" }
  ],
  "cases": [
    { "n": 1, "verdict": "update" | "keep" | "check", "why": "string", "changes": ["C1"], "steps": [3, 5] }
  ],
  "newCases": [
    { "title": "string", "covers": ["C1"], "why": "string" }
  ],
  "notCovered": [
    { "change": "string: a change id, or a short description when it never became a change", "why": "string" }
  ]
}`;
}

const strList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x || "").trim()).filter(Boolean);

/**
 * Make the model's plan safe to execute: every block has a verdict, every change lands somewhere.
 * Never throws on a sloppy answer; returns null only when there is nothing to work with.
 *
 * @returns {{ changes: Array<{id: string, text: string}>, cases: Array<{verdict: string, why: string, changes: string[], steps: number[]}>,
 *            newCases: Array<{title: string, covers: string[], why: string}>, notCovered: Array<{change: string, why: string}> } | null}
 */
function normalizePlan(parsed, blocks) {
  if (!parsed || typeof parsed !== "object") return null;
  const changes = (Array.isArray(parsed.changes) ? parsed.changes : [])
    .map((c, i) => ({ id: String((c && c.id) || `C${i + 1}`).trim(), text: String((c && c.text) || "").trim() }))
    .filter((c) => c.text);
  if (!changes.length && !Array.isArray(parsed.cases)) return null;
  const known = new Set(changes.map((c) => c.id));
  const ids = (v) => strList(v).filter((id) => known.has(id));

  const byNumber = new Map();
  for (const c of Array.isArray(parsed.cases) ? parsed.cases : []) {
    const n = Number(c && c.n);
    if (Number.isInteger(n) && n >= 1 && n <= blocks.length && !byNumber.has(n)) byNumber.set(n, c);
  }
  const cases = blocks.map((_, i) => {
    const c = byNumber.get(i + 1);
    // A case the plan forgot is looked at the old way rather than silently kept.
    if (!c) return { verdict: "check", why: "not classified by the plan", changes: [], steps: [] };
    const verdict = ["update", "keep", "check"].includes(String(c.verdict)) ? String(c.verdict) : "check";
    return {
      verdict,
      why: String(c.why || "").trim(),
      changes: verdict === "keep" ? [] : ids(c.changes),
      steps: (Array.isArray(c.steps) ? c.steps : []).map(Number).filter((x) => Number.isInteger(x) && x > 0),
    };
  });

  const hasTestCases = blocks.some((b) => b.type === "testcase");
  let newCases = (Array.isArray(parsed.newCases) ? parsed.newCases : [])
    .map((nc) => ({ title: String((nc && nc.title) || "").trim(), covers: ids(nc && nc.covers), why: String((nc && nc.why) || "").trim() }))
    .filter((nc) => nc.title);

  const notCovered = (Array.isArray(parsed.notCovered) ? parsed.notCovered : [])
    .map((x) => ({ change: String((x && x.change) || "").trim(), why: String((x && x.why) || "").trim() }))
    .filter((x) => x.change);
  const skipped = new Set(notCovered.map((x) => x.change));

  // Every change lands somewhere. One the plan left hanging becomes a new case of its own — or,
  // in a checklist-only file, goes to the first checklist the plan wants updated (else the first).
  const assigned = new Set([...cases.flatMap((c) => c.changes), ...newCases.flatMap((nc) => nc.covers)]);
  const hanging = changes.filter((c) => !assigned.has(c.id) && !skipped.has(c.id));
  if (hasTestCases) {
    for (const c of hanging) newCases.push({ title: c.text.length > 110 ? `${c.text.slice(0, 109)}…` : c.text, covers: [c.id], why: "no case in the plan covered this change" });
  } else {
    // Checklists take their additions inside the segment, so there is no separate new block.
    const moved = [...hanging.map((c) => c.id), ...newCases.flatMap((nc) => nc.covers)];
    newCases = [];
    if (moved.length) {
      let target = cases.findIndex((c) => c.verdict === "update");
      if (target < 0) target = 0;
      cases[target].verdict = "update";
      cases[target].changes = [...new Set([...cases[target].changes, ...moved])];
      if (!cases[target].why) cases[target].why = "takes the changes no other checklist covers";
    }
  }
  return { changes, cases, newCases, notCovered };
}

/**
 * The plan as the update prompt of ONE case sees it. `verdict` "keep" only reaches a prompt when
 * the reviewer pressed "Update anyway", so it reads as a second look.
 *
 * @param {{ verdict: string, why: string, changes: string[], steps: number[] }} casePlan
 * @param {Array<{id: string, text: string}>} allChanges
 * @param {"testcase"|"bdd"|"checklist"} kind
 */
function buildPlanNote(casePlan, allChanges, kind) {
  if (!casePlan || !Array.isArray(allChanges) || !allChanges.length) return "";
  const unit = kind === "checklist" ? "checklist" : kind === "bdd" ? "scenario" : "test case";
  const part = kind === "checklist" ? "items" : kind === "bdd" ? "lines" : "steps";
  const mine = (casePlan.changes || []).filter((id) => allChanges.some((c) => c.id === id));
  const why = casePlan.why ? ` (${casePlan.why})` : "";
  let verdict;
  if (casePlan.verdict === "update" && mine.length) {
    const hint = casePlan.steps && casePlan.steps.length && kind !== "checklist" ? ` The plan points at ${part} ${casePlan.steps.join(", ")} — a hint, not a limit.` : "";
    verdict = `This ${unit}: affected by ${mine.join(", ")}${why}.${hint}`;
  } else if (casePlan.verdict === "keep") {
    verdict = `This ${unit}: the plan judged it NOT affected${why}, and the QA engineer asked for a second look. Decide for yourself; returning it unchanged is still a valid answer.`;
  } else {
    verdict = `This ${unit}: the plan could not tell whether it is affected${why}. Decide for yourself; returning it unchanged is a valid answer.`;
  }
  const newNote =
    kind === "checklist"
      ? `New items are added here only for the changes named for this ${unit}.`
      : `New ${unit}s for this ticket are written in a separate step — do not add one here.`;
  return `

FILE PLAN (an earlier pass read the ticket and the whole file):
What the ticket changes:
${allChanges.map((c) => `- ${c.id}: ${c.text}`).join("\n")}
${verdict}
${newNote}
Start every "changeReason" with the id of the change behind it ("C1 — …").`;
}

/**
 * The prompt that writes the new cases the plan asked for — all of them in one call, so two of
 * them cannot turn out to be the same case.
 *
 * @param {Object} o
 * @param {string} o.ticketSection
 * @param {string} [o.guidanceBlock]
 * @param {Array<{title: string, covers: string[], why: string}>} o.specs
 * @param {Array<{id: string, text: string}>} o.changes
 * @param {string[]} o.existingTitles
 * @param {Object|null} o.styleSample - one existing case of the file, in the output shape
 * @param {"standard"|"bdd"} o.format
 * @param {string} [o.contextBlocks]
 * @param {string} [o.areaPathExample]
 * @param {{ priorityRules: string, noRedaction: string, bddStyle: string, bddSteps: string, bddPreconditions: string }} o.blocks
 */
function buildNewCasesPrompt({ ticketSection, guidanceBlock = "", specs, changes, existingTitles, styleSample, format, contextBlocks = "", areaPathExample = "", blocks }) {
  const isBdd = format === "bdd";
  const unit = isBdd ? "scenario" : "test case";
  const text = (id) => (changes.find((c) => c.id === id) || {}).text || "";
  const todo = specs
    .map((s, i) => {
      const covers = s.covers.length ? s.covers.map((id) => `${id}: ${text(id)}`).join("; ") : "see the title";
      return `${i + 1}. "${s.title}"\n   covers — ${covers}${s.why ? `\n   why new — ${s.why}` : ""}`;
    })
    .join("\n");
  const titles = (existingTitles || []).filter(Boolean).slice(0, 200).map((t) => `- ${t}`).join("\n");
  const sample = styleSample
    ? `

STYLE SAMPLE — one existing ${unit} of this file. Match its wording, ${isBdd ? "line" : "step"} granularity and Preconditions layout so the new ones read as part of the same file. Never copy its content, and do not reuse a person's name or a record number it contains (see GENERIC TEST DATA):
${JSON.stringify(styleSample, null, 2)}`
    : "";
  const shape = isBdd
    ? `${blocks.bddStyle}
${blocks.bddSteps}
${blocks.bddPreconditions}`
    : `- Step 1 is the preconditions step: "action" starts with the line "Preconditions:" and lists one precondition per line, each starting with "- "; its "expected" is "—".
- Every other step is one user action with its observable result; several expected facts go on their own "- " lines. Name exact UI labels, limits, states and messages from the sources — never "works correctly".`;
  const schemaCase = isBdd
    ? `{
      "title": "string: the Scenario name, no \\"Scenario:\\" prefix",
      "priority": 1,
      "areaPath": "${areaPathExample}",
      "covers": ["C1"],
      "changeReason": "string: \\"C1, C3 — …\\" — why this ${unit} is needed",
      "preconditions": "string: environment/setup, one per line; \\"\\" when none",
      "steps": ["Given ...", "When ...", "Then ..."]
    }`
    : `{
      "title": "string",
      "priority": 1,
      "areaPath": "${areaPathExample}",
      "covers": ["C1"],
      "changeReason": "string: \\"C1, C3 — …\\" — why this ${unit} is needed",
      "steps": [
        { "stepNumber": 1, "action": "string", "expected": "string" }
      ]
    }`;
  return `You are a senior QA engineer extending an existing test file for a ticket.
${guidanceBlock}
Task: write the NEW ${unit}(s) listed under TO WRITE. They join an existing file whose cases are being updated separately — do not rewrite those and do not repeat what they are about.

${ticketSection}

WHAT THE TICKET CHANGES:
${changes.map((c) => `- ${c.id}: ${c.text}`).join("\n")}

TO WRITE:
${todo}

ALREADY IN THE FILE (titles only — stay out of their scope):
${titles || "- (none)"}${sample}
${contextBlocks}
${blocks.priorityRules}

Rules:
- One ${unit} per entry of TO WRITE, in the same order. You may sharpen a title; you may not merge entries or add ${unit}s that are not listed.
- Each ${unit} covers its changes completely: the main flow, and the negative, boundary or role check a change implies (a new limit → at the limit and just past it; a new state → the transition that is no longer allowed; a new permission → the role that lacks it). Only what the sources state or clearly imply.
- If an entry turns out to be fully covered by a case already in the file, leave it out and say so in "reasoning".
${shape}
- ${pc.languageRule()} No markdown in the ${isBdd ? "lines" : "steps"}.
- Return ONLY valid JSON, no code fences and no text around it:
{
  "reasoning": "string: one or two sentences — anything the reviewer should know, and any entry you left out",
  "testCases": [
    ${schemaCase}
  ]
}
${blocks.noRedaction}`;
}

/**
 * After execution: where did every change of the ticket end up?
 *
 * A change counts as covered by a case only if that case actually came back changed — a plan that
 * said "update" and an answer that changed nothing is not coverage.
 *
 * @param {Object} plan - normalizePlan() result
 * @param {Array<Object>} generated - the blocks with their payloads, existing ones first (CSV order)
 * @returns {{ changes: Array<{id: string, text: string, status: "covered"|"skipped"|"uncovered", landed: string[], why: string}> }}
 */
function summarizePlan(plan, generated) {
  const rowsOf = (b) => (b.type === "testcase" ? (b.payload && b.payload.testCases) || [] : (b.payload && b.payload.checklistItems) || []);
  const changed = (b) => rowsOf(b).some((r) => r.changeType !== "unchanged") || ((b.payload && b.payload.removed) || []).length > 0;
  const skipped = new Map((plan.notCovered || []).map((x) => [x.change, x.why]));
  const changes = (plan.changes || []).map((c) => {
    const landed = [];
    generated.forEach((b, i) => {
      if (b.isNew) return;
      const p = plan.cases[i];
      if (p && p.changes.includes(c.id) && changed(b)) landed.push(`case ${i + 1}`);
    });
    const newBlock = generated.find((b) => b.isNew);
    const inNew = newBlock ? rowsOf(newBlock).filter((r) => Array.isArray(r.covers) && r.covers.includes(c.id)).length : 0;
    if (inNew) landed.push(inNew > 1 ? `${inNew} new cases` : "new case");
    const status = landed.length ? "covered" : skipped.has(c.id) ? "skipped" : "uncovered";
    return { id: c.id, text: c.text, status, landed, why: status === "skipped" ? skipped.get(c.id) || "" : "" };
  });
  // What the plan set aside without ever making it a change ("unit tests are added").
  for (const [change, why] of skipped) {
    if (!changes.some((c) => c.id === change)) changes.push({ id: "", text: change, status: "skipped", landed: [], why });
  }
  return { changes };
}

module.exports = {
  planEnabled,
  planMaxTokens,
  caseTextForPlan,
  buildPlanPrompt,
  normalizePlan,
  buildPlanNote,
  buildNewCasesPrompt,
  summarizePlan,
};
