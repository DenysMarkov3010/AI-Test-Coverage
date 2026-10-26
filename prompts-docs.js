const pc = require("./prompt-context");

/**
 * The Area Path the prompt asks the model to write, and the example it is shown.
 *
 * It used to be a hardcoded literal — one project's root, baked into the instructions every
 * other project's generation run also received. It is a Setup value now: `Default Area Path`, or
 * failing that the Azure DevOps project name, because in Azure DevOps the root Area Path of a
 * project *is* the project's name. With neither set the model is told to leave the field empty,
 * which lands the work item at that root anyway — the one answer that is right everywhere.
 *
 * Both settings are Azure DevOps ones, so they only apply while it is the provider in use. The
 * others have no area axis — Zephyr and Xray turn the value into a label, TestRail drops it — and
 * an ADO project name left over in the config would otherwise be stamped on every case.
 *
 * @returns {{ value: string, hint: string, jsonExample: string }}
 */
function areaPathForPrompt() {
  const isAdo = require("./config-store.js").activeProvider() === "ado";
  const value = isAdo ? String(process.env.ADO_DEFAULT_AREA_PATH || process.env.ADO_PROJECT || "").trim() : "";
  return {
    value,
    hint: value ? `(use "${value}")` : '(use "" unless the context names one)',
    jsonExample: value,
  };
}

/**
 * Bans redaction-style PII placeholders ([PERSON_NAME], [EMAIL_ADDRESS], …) in generated content.
 * Models emit that de-identification vocabulary wherever they lack a concrete value; nothing in this
 * project asks for it, and it silently ends up in the approved CSV and in Azure DevOps.
 * Shared by every generation prompt (create + update, checklist + test cases).
 */
const NO_REDACTION_PLACEHOLDERS_BLOCK = `
NO REDACTION PLACEHOLDERS (hard rule):
- NEVER output typed PII/redaction placeholders in square brackets: [PERSON_NAME], [PERSON], [NAME], [EMAIL], [EMAIL_ADDRESS], [PHONE_NUMBER], [DATE_OF_BIRTH], [ADDRESS], [LOCATION], [ORGANIZATION], [ID_NUMBER], [SSN], [REDACTED] or any other [UPPER_SNAKE_CASE] token of that kind. These are de-identification artifacts, not test data, and they make the test case unusable.
- When a concrete value exists in the issue, Confluence, Figma or the existing tests, use that value verbatim.
- When no concrete value exists, use realistic SYNTHETIC test data instead — e.g. user "Test User", email "test.user@example.com", phone "+1 555 0100", date of birth "1990-01-15". Never use real personal data.
- Only when the value must stay deliberately generic, use this project's placeholder convention: lowercase angle brackets such as <user>, <organization>, <amount>, <email>.
- Square brackets are allowed ONLY when they are part of a literal UI label copied from the product (e.g. an actual button rendered as [OK]).`;

/**
 * Classical test-design techniques — shared between checklist and full test-case generation.
 * Apply WHERE APPLICABLE (don't force a technique when the story does not call for it).
 * The model must briefly note in "reasoning" which techniques informed which parts of coverage.
 */
const TEST_DESIGN_TECHNIQUES = `
TEST DESIGN TECHNIQUES (apply WHERE APPLICABLE — not every technique fits every story; in "reasoning", briefly note which techniques informed which items / test cases):

1) Equivalence Partitioning (EP)
   Partition inputs, outputs, roles, configurations, and environmental factors into equivalence classes (valid vs invalid, or distinct business meanings). For each class that changes expected behavior include one representative item / test case — avoid redundant copies of the same class unless the workflow genuinely differs.

2) Boundary Value Analysis (BVA)
   For ordered domains (numeric ranges, min/max lengths, pagination limits, thresholds, dates, quotas, counts), defects cluster at edges. Add items / cases for values at and immediately adjacent to boundaries (just below min, at min, just inside valid range, just inside max, at max, just above max) wherever the requirement defines inclusivity or exclusivity.

3) Decision Table Testing
   When behavior depends on combinations of conditions (e.g. role AND state AND feature flag AND data type), treat it as a decision table: every combination that produces a different action or outcome must be covered by at least one item / case. Impossible or explicitly unsupported combinations may be a single negative item with a clear expected response.

4) State Transition Testing
   When the work item implies states and transitions (e.g. draft → submitted → approved, online/offline, locked/unlocked, subscription/order status), cover valid transitions, invalid or disallowed transitions, and events received in the wrong state — including guard conditions and error messages.

5) Use Case Testing
   Derive scenarios from primary user goals: cover the main success path end-to-end, plus alternative and exception flows (validation errors, cancellations, timeouts, payment or save failures, partial completion, concurrency where stated) as separate items / cases with concrete expected outcomes.

GUIDANCE:
- Do NOT invent a technique application that is not supported by the description or supplementary context.
- Do NOT add an item / test case solely to "demonstrate a technique" if the requirement does not need it.
- Prefer combining techniques inside one well-scoped scenario when natural (e.g. a single BVA case can also cover a state transition guard).`;

/**
 * A test written from a defect report must assert the FIXED behaviour.
 *
 * The "Cover a bug" flow feeds the defect straight in, and a model that simply mirrors it writes
 * the failure as the expected result — "Then the message is not sent while the token refreshes".
 * That assertion passes only while the bug is alive and starts failing the day it is fixed, which
 * is backwards for a regression test. Shared by the standard and the BDD prompt because the flow
 * offers both formats.
 */
const DEFECT_SOURCE_BLOCK = `
WHEN THE SOURCE TICKET IS A DEFECT (bug report, incident, "does not work" / "is duplicated" / "is not saved" ticket):
- The ticket describes what went WRONG. Every expected result you write must state the CORRECT behaviour — what the product must do once the defect is fixed. The reproduction path becomes the STEPS; the fixed behaviour becomes the ASSERTIONS. That is what makes it a regression test.
- NEVER write the reported failure as an expected outcome. If the bug is "the message is not delivered", the expected result is "the message is delivered", not "the message is not delivered". If the bug is "the row appears twice", assert "the row appears exactly once", not "appears twice".
- Do not describe the broken state as an intermediate checkpoint either (no "Then nothing happens yet" steps that only hold while the defect exists).
- Keep the observable symptom in view as the thing being guarded against, and phrase the assertion as its absence of failure: "exactly once", "is displayed", "is persisted after reload".
- If the ticket does not state what the correct behaviour should be, derive it from the surrounding requirement and say so in "reasoning" rather than asserting the failure.`;

/**
 * Build the "FIGMA DESIGN CONTEXT" block to inject into a prompt.
 * `figmaContext` should already be the text summary produced by `figma-client.analyzeFigmaUrl`.
 * Returns empty string when nothing is available, so call sites can concat unconditionally.
 */
function buildFigmaContextBlock(figmaContext) {
  const s = String(figmaContext || "").trim();
  if (!s) return "";
  return `\n\n<figma_design>\n${s}\n</figma_design>\n\nWhen this Figma block is present:
- Anchor every UI-related test step to the exact labels listed above (do not invent labels).
- Prefer scenarios that exercise the visible states, variants, and forms found in the design.
- If the Figma block lists an element but the issue description does not mention it, include at least one test that verifies its behavior anyway — it is part of the delivered surface area.`;
}

/**
 * Build the "LIVE PROTOTYPE CONTEXT" block to inject into a prompt.
 *
 * `prototypeContext` is already the text summary produced by `prototype-client.analyzePrototypeUrl`
 * — a screen-by-screen inventory of a real, running build. It sits next to the Figma block rather
 * than replacing it: a ticket can carry both, and they disagree in useful ways (the design says
 * what was drawn, the prototype says what was actually built).
 *
 * Returns empty string when nothing is available, so call sites can concat unconditionally.
 */
function buildPrototypeContextBlock(prototypeContext) {
  const s = String(prototypeContext || "").trim();
  if (!s) return "";
  return `\n\n<prototype>\n${s}\n</prototype>\n\nWhen this prototype block is present:
- It outranks guesswork about the UI: the screens listed above are the ones that exist, with the labels they actually render.
- Design at least one scenario per screen in the inventory, and cover the transitions between them as flows.
- If a Figma block is also present and the two disagree, prefer the prototype for what the UI does today, and note the discrepancy in "reasoning".`;
}

/**
 * Build the "REQUIREMENTS FROM ATTACHED FILES" block to inject into a prompt.
 *
 * `attachmentsContext` is the text produced by `attachment-analyzer.analyzeAttachments` from the
 * images / PDFs the QA engineer attached to the run. Unlike Figma and the prototype, which describe
 * the UI, an attachment is often the requirement itself (a spec page, an acceptance-criteria
 * screenshot, a bug screenshot), so it is weighed like the description, and every file carries a
 * label ([A1], [A2]…) the reasoning can cite so the reviewer can trace a case back to its file.
 *
 * Returns empty string when nothing is available, so call sites can concat unconditionally.
 */
function buildAttachmentsContextBlock(attachmentsContext) {
  const s = String(attachmentsContext || "").trim();
  if (!s) return "";
  return `\n\n<attachments>\n${s}\n</attachments>\n\nWhen this attachments block is present:
- Treat it as part of the requirements, alongside the issue description: every rule, validation, limit, label, message and flow it lists must be covered by at least one test, or named as out of scope in "reasoning".
- Use the labels and messages exactly as quoted there; never invent ones the attachment does not show.
- Use its concrete values (limits, formats, enumerations) for boundary and equivalence-class tests.
- If an attachment contradicts the issue description, follow the issue description and name the conflict (with the file label, e.g. [A2]) in "reasoning".
- A screenshot of a defect shows the BROKEN state: use it for the reproduction path and test data, never as an expected result.
- Where a test comes mainly from an attachment, mention its label ([A1], [A2]…) in "reasoning" so the reviewer can trace it.
- The block never copies personal-data values; do not invent real-looking ones in their place.`;
}

/**
 * Build the block for the comments under the analysed Jira issue.
 *
 * `commentsContext` is the text produced by `issue-comments.buildIssueCommentsContext`: the
 * discussion under the ticket with the agent's own and approval comments already removed, authors
 * anonymised and obvious personal-data values masked. Comments are where decisions made after the
 * description was written live, so a decided change outranks the description — but a question is
 * not a requirement.
 *
 * Returns empty string when nothing is available, so call sites can concat unconditionally.
 */
function buildIssueCommentsBlock(commentsContext) {
  const s = String(commentsContext || "").trim();
  if (!s) return "";
  return `\n\n<issue_comments>\n${s}\n</issue_comments>\n\nWhen this comments block is present:
- Comments refine the description: a decision, clarification, changed value or removed scope stated in a comment is a requirement and must be covered.
- If a comment states a decision that contradicts the description, the comment wins; if two comments disagree, the newer one wins. Name such conflicts in "reasoning".
- A question nobody answered, or a proposal nobody confirmed, is NOT a requirement — list it in "openQuestions" (or in "reasoning" where the output has no such field) instead of designing a test around it.
- For a defect: reproduction steps, environment and data from the comments belong in preconditions and steps; the observed failure is never an expected result.
- Values shown as "(… removed)" were masked on purpose: never copy them and never invent real-looking personal data in their place.`;
}

/**
 * Build the "CONFLUENCE PAGES" block for prompts that have no structured Confluence slot: the
 * Update flow and every single-item Regenerate. `confluenceContext` is the text produced by
 * `confluence-pages.confluencePagesToText`. (The Create generation prompts receive the page
 * objects themselves, see `confluencePages`.)
 *
 * Returns empty string when nothing is available, so call sites can concat unconditionally.
 */
function buildConfluenceContextBlock(confluenceContext) {
  const s = String(confluenceContext || "").trim();
  if (!s) return "";
  return `\n\n<confluence_pages>\n${s}\n</confluence_pages>\n\nWhen this Confluence block is present:
- Treat it as requirements documentation for this ticket: rules, limits, field definitions, roles and flows it states must be reflected in the tests that touch them.
- Use its exact terms and labels; do not invent ones it does not use.
- If it contradicts the issue description or a decision in the comments, follow the issue / the comment (they are newer) and name the conflict in "reasoning".`;
}

/**
 * Existing test cases from the test management system: picked in the Web UI's context panel, or
 * named in a Regenerate's reviewer guidance. Each file's name says which TMS and which suite /
 * section / folder it came from.
 *
 * The create-flow generation prompts already receive these through `projectTestCases`; the
 * update-flow prompts and the single-item Regenerate prompts have no such slot, so they compose
 * this block instead.
 *
 * @param {Array<{ filename: string, content: string }>} files
 * @returns {string} "" when nothing was picked
 */
function buildAdoContextBlock(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && String(f.content || "").trim()) : [];
  if (list.length === 0) return "";
  const body = list.map((f) => `--- ${f.filename}\n${String(f.content).trim()}`).join("\n\n");
  return `

EXISTING TEST CASES FROM THE TEST MANAGEMENT SYSTEM (reference only — do not copy, do not re-output them):
These are real, already-maintained test cases from the suites / sections / folders the reviewer
selected or named. Use them to match this product area's wording, Preconditions style and step
depth, to account for the related areas they cover, and to avoid re-designing coverage that
already exists. They are NOT part of the content you must produce.

${body}`;
}

function generateTestChecklistPrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels,
    confluencePages = [],
    relatedJiraIssues = [],
    projectTestCases = [],
    existingTestCases = [],
    isChangeRequest = false,
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    userGuidance = "",
    helpingPrompt = "",
  } = context;
  const figmaBlock =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext);

  const confluenceJson = JSON.stringify(confluencePages, null, 2);
  const jiraIssuesJson = JSON.stringify(relatedJiraIssues, null, 2);
  const hasProjectTestCases = projectTestCases && projectTestCases.length > 0;
  const projectTestCasesSection = hasProjectTestCases
    ? projectTestCases.map((f) => `--- ${f.filename}\n${f.content}`).join("\n\n")
    : "";
  const existingTestCasesJson = existingTestCases.length > 0 
    ? JSON.stringify(existingTestCases, null, 2)
    : null;

  if (isChangeRequest && existingTestCasesJson) {
    return `You are a QA expert specializing in change impact analysis and test design.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
CHANGE REQUEST ANALYSIS:
0. AREA CONTEXT: From the change description and existing test documentation, infer the affected product area, impacted surfaces, and domain vocabulary before proposing updates—so recommendations are specific to that area, not generic.
1. COMPARE: Carefully compare the change request description with existing test documentation
2. IDENTIFY CHANGES: Determine what functionality is being modified, added, or removed
3. IMPACT ASSESSMENT: Identify which existing test cases are affected
4. PROPOSE UPDATES: Suggest specific updates to existing test cases
5. NEW COVERAGE: Identify gaps requiring new test cases (functional behavior, acceptance criteria, roles, integrations). Put the bulk of coverage here.

${pc.buildTicketSection(context)}

Existing Test Documentation:
${existingTestCasesJson}
${TEST_DESIGN_TECHNIQUES}
${figmaBlock}

IMPORTANT: This is a CHANGE REQUEST. Analyze what has changed compared to existing documentation and propose:
1. Which existing test cases need to be updated (Updated Tests)
2. New test cases required for new or changed behavior (New Tests) — this must be the largest set

REQUIREMENTS:
- Do NOT create a separate "Regression" or "Regression Tests" category. Do NOT label any item as regression-only. If related areas must be re-verified, express that as an Updated Test or as a concrete New Test tied to the change—never as a standalone regression bucket.
- You MUST generate items for BOTH categories below:
  - Updated Tests — at least 3 items (existing cases or flows that must change because of this request)
  - New Tests — at least 7 items (primary focus: functional coverage of new/changed behavior, roles, data, UI, APIs; this category must have strictly more items than Updated Tests)
- Return the result as valid JSON matching this exact schema:

{
  "checklistItems": [
    {
      "id": "string",
      "description": "string",
      "category": "Updated Tests" | "New Tests",
      "affectedTestCase": "string (optional, for Updated Tests)"
    }
  ],
  "reasoning": "string explaining label matching, prioritization, and which test design techniques (EP, BVA, decision tables, state transitions, use cases) informed which Updated / New items",
  "changeImpactSummary": "string summarizing the impact of changes"
}

IMPORTANT: 
- ${pc.languageRule()} Do NOT use asterisks or any other markdown formatting in descriptions.
- Return ONLY valid JSON output that exactly matches the required schema.
- Ensure all required fields are present: checklistItems, reasoning, and changeImpactSummary.
- Each checklistItem must have: id, description, category (one of: Updated Tests, New Tests only), and affectedTestCase (optional for Updated Tests).`;
  }

  // Sources in their own tags, in the order of SOURCE PRIORITY; then the method. See prompt-context.js.
  let contextSection = pc.buildSourcesSection(context, "checklist", figmaBlock);
  contextSection += pc.buildMethodSection("checklist");
  contextSection += `\n${TEST_DESIGN_TECHNIQUES}`;

  return `You are a QA expert specializing in test design based on user stories and acceptance criteria.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
Generate comprehensive test checklists using industry best practices: functional tests (primary), negative scenarios, boundary cases, and critical integration points. Do not produce regression-only checklist items.

${pc.buildTicketSection(context)}
${contextSection}
${PRIORITY_RULES}

REQUIREMENTS:
${pc.buildTraceabilityRules("checklist")}
- FUNCTIONAL (highest priority): Generate the MOST items in this category—at least 8–12 concrete checklist items covering happy paths, main user goals, acceptance criteria, roles, and observable outcomes. Functional count must be greater than the count in any other single category.
- NEGATIVE: Second priority—at least 5–8 items (errors, validation, permissions, invalid data).
- BOUNDARY: At least 2–4 items (limits, edge values, empty/max volume where relevant).
- INTEGRATION: Only the most important points—1–3 essential items. Do not add marginal integration cases.
- FORBIDDEN: Do NOT use category "Regression". Do NOT add items whose sole purpose is generic "regression" or "nothing else broke" wording. Fold any necessary re-check of adjacent behavior into Functional or Integration with a specific scenario.
- You MUST include items in ALL of these categories only: Functional, Negative, Boundary, Integration. Do NOT skip any of these four.
- Return the result as valid JSON matching this exact schema:

{
${pc.TRACEABILITY_SCHEMA_FIELDS}
  "checklistItems": [
    {
      "id": "string",
      "description": "string",
      "category": "Functional" | "Negative" | "Boundary" | "Integration",
      "covers": ["R1"]
    }
  ],
  "reasoning": "string: start with the DOMAIN MODEL, then how the sources were weighed (SOURCE PRIORITY, labels, relations), then which test design techniques (EP, BVA, decision tables, state transitions, use cases) shaped which checklist categories — only those that were applicable, then any deliberate gaps",
  "coverageNotes": "string: ONLY if existing test cases or previousQaChecklist context was provided — 2–5 short lines: which scenarios are already covered by the existing tests (name the file/issue) and were deliberately NOT duplicated, plus any coverage gap you noticed in the existing tests. Empty string when no such context was given."
}

${NO_REDACTION_PLACEHOLDERS_BLOCK}

IMPORTANT:
- ${pc.languageRule()} Do NOT use asterisks or any other markdown formatting in descriptions.
- Return ONLY valid JSON output that exactly matches the required schema.
- Ensure all required fields are present: requirements, assumptions, openQuestions, checklistItems, reasoning, and coverageNotes.
- Each checklistItem must have: id, description, category and covers.`;
}

/**
 * Build prompt for generating full test cases (Azure DevOps format) with steps.
 * Used when GENERATE_MODE=testcases. Must follow TEST_CASE_FORMAT.md.
 */
/**
 * What "priority" 1 and 2 mean. Without this the model picked them by feel; now the same rule
 * ranks requirements under a test-case limit and fills the Priority column, so the two agree.
 */
const PRIORITY_RULES = `
PRIORITY RULES (use them for the "priority" field and, under a limit, to decide what goes first):
- Priority 1 (critical): the main business flow of the ticket and its acceptance criteria; anything whose failure loses or corrupts data, exposes data or actions to the wrong role, harms the safety or health of people, breaks legal or regulatory compliance, or moves money incorrectly; and the exact behaviour a defect ticket reports.
- Priority 2 (normal): secondary flows, validation of non-critical fields, UI states and wording, sorting / filtering / pagination, rare edge cases.
- When unsure between the two, ask: "if only this case were run before release, would a failure here block the release?" Yes → 1.`;

/**
 * What a test-case limit of N (> 1) means on the Create page: the SHAPE of the test design, not a
 * ceiling on coverage. The QA engineer who types 5 wants the whole ticket covered in 5 cases —
 * longer, denser cases rather than requirements left out. So the model plans the coverage first,
 * groups it into exactly N scenarios, and makes each case as long as its group needs.
 *
 * `testCasesLimitMode: "cap"` keeps the older "at most N" reading, for callers where N really is
 * an upper bound (the Azure DevOps whole-ticket Summary, see ado-sync-csv.js).
 *
 * @param {number} n
 * @param {"standard"|"bdd"} kind
 */
function coverageWithinLimitBlock(n, kind) {
  const unit = kind === "bdd" ? "Scenario" : "test case";
  const units = kind === "bdd" ? "Scenarios" : "test cases";
  const grow =
    kind === "bdd"
      ? "A Scenario may alternate When → Then → When → Then as often as its group needs and run well past the usual 3–10 lines (15–30 lines is fine); after the main flow, continue with And/When lines that exercise the negative, boundary and permission checks of the same group. With a limit, this overrides the typical-length and one-behaviour-per-scenario style rules below."
      : "Cases are expected to be long (often 15–40 steps): after the main flow, keep going in the same case with the negative, validation, boundary, permission/role and error-handling checks of its group (e.g. \"Clear the required field and click Save\" → the exact validation message), instead of leaving them out.";
  return `- The limit of ${n} is a PACKAGING limit: produce EXACTLY ${n} ${units} and use every one of them. Within it, deliver the most valuable coverage the ticket allows.
- Plan before writing:
  1. List the requirements (the "requirements" inventory) — every explicit rule, field, control, state, acceptance criterion, role, limit and error message in the description and the supplied context.
  2. Rank them by risk (see PRIORITY RULES): what breaks the main business flow, loses or corrupts data, opens access it should not, harms people's safety, compliance or money, or contradicts an acceptance criterion comes first; cosmetic details and rare edge cases come last.
  3. Group them into ${n} coherent ${units} (by flow, screen, role or lifecycle stage), highest-risk groups first, and write each ${unit} so it carries its whole group.
- ${grow}
- Every critical requirement MUST be covered, however long that makes a ${unit}. Lower-risk ones are covered as far as the ${n} ${units} can carry them while staying executable (as a rough guide, a ${unit} should not grow past about 40 ${kind === "bdd" ? "lines" : "steps"}). If the ticket is bigger than that, leave out from the BOTTOM of the ranking, never from the top.
- Only if the ticket honestly has fewer distinct behaviours than ${n} may you return fewer — never pad with near-duplicates.
- Order the testCases array by risk: the most critical ${unit} first.
- Requirements you could not fit stay in "requirements" with no ${unit} covering them, and are named in "reasoning" as "not covered (lower risk)" — so the reviewer sees exactly what the limit cost.`;
}

function generateTestCasesPrompt(context) {
  const areaPath = areaPathForPrompt();
  const {
    issueKey,
    issueDescription,
    issueLabels,
    confluencePages = [],
    relatedJiraIssues = [],
    projectTestCases = [],
    testCaseFormatRef = "",
    testCasesLimit = 10,
    testCasesLimitMode = "coverage",
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    userGuidance = "",
    helpingPrompt = "",
  } = context;
  const figmaBlock =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext);

  // null / 0 / negative / non-finite -> "unlimited"; otherwise an explicit cap.
  const limitNum =
    testCasesLimit === null ||
    testCasesLimit === undefined ||
    !Number.isFinite(Number(testCasesLimit)) ||
    Number(testCasesLimit) <= 0
      ? null
      : Math.floor(Number(testCasesLimit));
  const isUnlimited = limitNum === null;
  // A cap of 1 is not "at most 1": it is the whole test design for the ticket, which is what the
  // Cover a bug flow asks for. "At most" invites a thin case, so it gets its own wording.
  const isSingle = limitNum === 1;
  const limitHeaderClause = isUnlimited
    ? ""
    : isSingle
      ? " (exactly one test case)"
      : testCasesLimitMode === "cap"
        ? ` (maximum ${limitNum} test cases total)`
        : ` (exactly ${limitNum} test cases that together cover the whole ticket)`;
  const limitRequirementBullet = isUnlimited
    ? "- Generate as many test cases as the story actually requires—no fixed cap. Prefer fewer, deeper cases over many shallow ones: pack functional, negative, validation, boundary, permission/role, and error handling into well-scoped scenarios with rich step-by-step detail. Favor functional and end-to-end story coverage; do not dedicate test cases solely to generic \"regression\"—if adjacent behavior matters, cover it inside a functional scenario with explicit steps."
    : isSingle
      ? "- Generate EXACTLY ONE test case. It is the entire test design for this issue, so make it the deepest one you can: walk the main flow end to end and fold the validation, negative, boundary, permission/role and error handling checks that belong to that flow into the step sequence. Do not split the coverage across several cases, and do not leave the case shallow just because there is only one."
      : testCasesLimitMode === "cap"
        ? `- Generate at most ${limitNum} test cases (hard cap: never more than ${limitNum}). Prefer fewer, deeper cases over many shallow ones: pack functional, negative, validation, boundary, permission/role, and error handling into well-scoped scenarios with rich step-by-step detail. Favor functional and end-to-end story coverage; do not dedicate test cases solely to generic "regression"—if adjacent behavior matters, cover it inside a functional scenario with explicit steps.`
        : `${coverageWithinLimitBlock(limitNum, "standard")}
- Favor functional and end-to-end story coverage; do not dedicate a test case solely to generic "regression"—if adjacent behavior matters, cover it inside a functional scenario with explicit steps.`;
  const limitImportantBullet = isUnlimited
    ? "- The testCases array length is up to you—size it to the story; do not pad with redundant cases."
    : isSingle
      ? "- The testCases array MUST contain exactly one item."
      : testCasesLimitMode === "cap"
        ? `- The testCases array MUST contain no more than ${limitNum} items.`
        : `- The testCases array MUST contain exactly ${limitNum} items (fewer only when the ticket truly has fewer distinct behaviours), never more.`;

  // Sources in their own tags, in the order of SOURCE PRIORITY; then the method. See prompt-context.js.
  let contextSection = pc.buildSourcesSection(context, "testcases", figmaBlock);
  contextSection += pc.buildMethodSection("testcases");
  contextSection += `\n${TEST_DESIGN_TECHNIQUES}`;
  contextSection += `\n${DEFECT_SOURCE_BLOCK}`;

  const formatSection = testCaseFormatRef
    ? `

MANDATORY FORMAT (follow exactly as in reference):
${testCaseFormatRef}

The reference above describes the CSV layout the cases are later exported to (columns ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path). Follow its style, wording and step granularity, but do NOT output CSV and ignore any "OUTPUT CONTRACT" or phase instructions inside it: your output is the JSON object defined under REQUIREMENTS below (Step Action → "action", Step Expected → "expected", Test Step → "stepNumber"). First step of each test case is usually Preconditions with expected "—".`
    : "";

  return `You are a senior QA engineer. Generate thorough, high-detail test cases${limitHeaderClause}, returned as JSON (never CSV). Prioritize depth of each case over count: do not omit important scenarios—express them in granular steps. Each test case has a Title, Priority (1 or 2), Area Path ${areaPath.hint}, and ordered Steps. Each step has Test Step (number), Step Action, Step Expected. Preconditions are step 1 with expected "—".
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}${formatSection}

${pc.buildTicketSection(context)}
${contextSection}

${PRIORITY_RULES}

REQUIREMENTS:
${limitRequirementBullet}
${pc.buildTraceabilityRules("testcases")}
- Be exhaustive with the issue description and any related context: every explicit rule, field, button, state, acceptance criterion, URL, role, or error message mentioned must appear in at least one concrete step (or explain in reasoning why it is out of scope).
- Steps must be detailed and executable: spell out where to navigate, what to enter, what to observe. Avoid vague actions like "verify it works" or "check the feature". Expected results must name observable UI text, control states (enabled/disabled/visible), counts, messages, or outcomes where inferable from context.
- Expected formatting rule: if a single step has more than one expected sentence/outcome, write each sentence as a separate bullet line starting with "- ".
- Do NOT reduce expected-result detail for formatting reasons. Keep full specificity (UI labels, limits, button states, validation text, counters, side effects) from the scenario; formatting into bullets must preserve all details, not summarize.
- Happy-path and complex flows: use enough steps (often 8 to 22 per case when the story is non-trivial, and more when a test-case limit packs several behaviours into one case) so a tester can follow without guessing. Simpler negative checks may use fewer steps but must still state exact trigger and exact expected system response.
- Cover combinations: empty/invalid input, max length, wrong role, missing prerequisites, concurrent edits, cancel vs save, refresh/back navigation if relevant.
- Each test case MUST have: "title", "priority" (1 or 2, see PRIORITY RULES), "covers" (requirement ids), "areaPath" ${areaPath.hint}, "steps" (array).
- Each step MUST have: "stepNumber" (1-based), "action", "expected" (use "—" or "" for preconditions).
- First step is usually preconditions: action = "Preconditions: ...", expected = "—".
- In "reasoning": start with the DOMAIN MODEL; then the coverage strategy and how the sources were weighed; then which test design techniques (EP, BVA, decision tables, state transitions, use cases) shaped which test cases — only the genuinely applicable ones; finally any deliberate gaps (requirements no test case covers).
- Return ONLY valid JSON matching this schema:

{
${pc.TRACEABILITY_SCHEMA_FIELDS}
  "testCases": [
    {
      "title": "string",
      "priority": 1,
      "covers": ["R1", "R2"],
      "areaPath": "${areaPath.jsonExample}",
      "steps": [
        { "stepNumber": 1, "action": "string", "expected": "string" }
      ]
    }
  ],
  "reasoning": "string",
  "coverageNotes": "string: ONLY if existing test cases or previousQaChecklist context was provided — 2–5 short lines: which scenarios are already covered by the existing tests (name the file/issue) and were deliberately NOT duplicated, plus any coverage gap you noticed in the existing tests. Empty string when no such context was given."
}

${NO_REDACTION_PLACEHOLDERS_BLOCK}

IMPORTANT:
- ${pc.languageRule()} No markdown in action/expected.
- Return ONLY valid JSON. No code fences or extra text.
${limitImportantBullet}
- Every test case must have at least one step. Match the style and structure of the reference format.`;
}

/**
 * The Helping Prompt typed on the Create / Update / Cover a bug page before generation.
 *
 * It steers the whole test design — what to focus on, what to take into account — and is often
 * written *about* the other context ("check every state of the card from the design", "keep the
 * wording of the Checkout suite"), so the model is told where each source it may name lives in
 * this prompt. It rides along with every Regenerate of the same draft (stored in promptContext),
 * and a Regenerate's reviewer guidance outranks it, being the newer, more specific ask.
 */
function buildHelpingPromptBlock(helpingPrompt) {
  const text = String(helpingPrompt || "").trim();
  if (!text) return "";
  return `
HELPING PROMPT (from the QA engineer, written before generation to steer this test design — high priority):
<helping_prompt>
${text}
</helping_prompt>
How to use it:
- Treat it as instructions on focus, scope, depth and what to take into account. Apply it across the whole output, not only to one item.
- It may refer to the other context in this prompt. Resolve each reference to its block: design / Figma / mockups / screens → <figma_design>; prototype → <prototype>; attached files, screenshots, PDFs ([A1], [A2]…) → <attachments>; Confluence / docs / spec pages → <confluence_pages>; comments / decisions → <issue_comments>; related tickets → <related_issues>; existing / TMS test cases, suites, sections, folders → <existing_tests> or the EXISTING TEST CASES FROM THE TEST MANAGEMENT SYSTEM block. Use the material it points to the way it asks (cover it, compare against it, follow its wording, avoid duplicating it).
- If it points to a source that is not present in this prompt, do not invent its content: say in "reasoning" which reference could not be resolved.
- It does not override the output schema or the rules below. If it contradicts the ticket, follow the helping prompt and note the conflict in "reasoning".
`;
}

/**
 * Free-text guidance the QA engineer types in the review UI before hitting Regenerate.
 * Rendered as its own high-salience section so it outweighs the generic instructions
 * without replacing the issue/Confluence/Figma context the prompt already carries.
 *
 * The Helping Prompt from the generation step comes first, so a Regenerate keeps honouring it;
 * the reviewer guidance follows and wins where the two disagree.
 */
function buildUserGuidanceBlock(userGuidance, helpingPrompt = "") {
  const helping = buildHelpingPromptBlock(helpingPrompt);
  const text = String(userGuidance || "").trim();
  if (!text) return helping;
  return `${helping}
REVIEWER GUIDANCE (highest priority — the QA engineer asked for this explicitly while reviewing the previous output):
${text}
Honour it as long as it does not contradict the output schema or the rules below. If it conflicts with something in the issue description${helping ? " or the helping prompt" : ""}, follow the guidance and note the conflict in "reasoning".
`;
}

/**
 * The Gherkin house style, shared by every BDD prompt (create, regenerate, update).
 *
 * Deliberately close to the rules in TEST_CASE_FORMAT.md → "Prompt: BDD / Gherkin
 * for Azure DevOps Summary", because both produce the same artifact. The
 * difference is the output channel: that prompt writes free Gherkin text into a
 * work item's Description, this one returns the scenario as a JSON array of
 * lines, so the result can be reviewed, edited row by row, approved and imported
 * like any other test design.
 */
const BDD_STYLE_BLOCK = `
GHERKIN STYLE (mandatory):
- Every step line starts with exactly one keyword: Given, When, Then, And or But. No line may start with anything else.
- Order inside a scenario: Given (setup) → When (action) → Then (observable outcome). Alternating When → Then → When → Then inside ONE scenario is allowed and encouraged when the behaviour naturally flows through several action/check pairs.
- The FIRST precondition is "Given"; every further precondition is its own "And" line. The FIRST action is "When"; every further action in the same flow is its own "And". The FIRST outcome is "Then"; every further observable fact is its own "And".
- Never pack several checks into one comma-heavy line — one verifiable fact per line.
- "And"/"But" must always follow a Given, When or Then line. Never start a scenario with "And".
- One scenario = one behaviour. A different setup, actor or rule means a NEW scenario.
- Assertions must be explicit and verifiable: "is displayed", "is disabled", "contains <value>", "equals <value>". Never "works correctly", "is fine", "is OK".
- Quote literal UI labels and field values copied from the requirement with double quotes, e.g. the "Save" button.
- Use lowercase angle-bracket placeholders (<user>, <amount>) only where the requirement itself is generic; otherwise use the concrete values from the context.
- Reuse the exact domain vocabulary (roles, entities, screens, controls) from the issue and the supplied context. Do not invent synonyms and do not translate.
- Typical scenario length is 3–10 lines. No Feature:, Scenario:, Background: or Examples: headers inside the step lines — the scenario title is a separate field and each scenario must stand on its own.
- ${pc.languageRule()} No markdown, no bullets, no numbering inside the step lines.`;

/**
 * The BDD format examples curated on the Setup page (Format examples card), as a prompt block.
 * The Gherkin counterpart of the examples the standard prompt gets through TEST_CASE_FORMAT.md:
 * they set the house style — line granularity, wording, how much goes into preconditions — and
 * are not content to copy. Empty when none are enabled, so the prompt is unchanged without them.
 */
function bddExamplesBlock() {
  const rendered = require("./examples-store.js").renderBddForPrompt();
  if (!rendered) return "";
  return `
FORMAT EXAMPLES (the project's house style for scenarios — match their step granularity, wording and level of detail; NEVER copy their content, the scenarios must come from this ticket):
${rendered}
`;
}

/** The JSON step contract every BDD prompt repeats — one Gherkin line per array entry. */
const BDD_STEPS_CONTRACT = `
- "steps" is a flat ARRAY OF STRINGS. Each string is ONE complete Gherkin line INCLUDING its keyword, e.g.
  "steps": [
    "Given the user is signed in as \\"Store Manager\\"",
    "And the order \\"#1001\\" has a tracking number",
    "When the user opens the \\"Orders\\" tab",
    "Then the \\"Latest order\\" card is displayed",
    "And the order date is shown in the store time zone"
  ]
- Do NOT return objects with "action"/"expected" here, and do NOT number the lines.`;

/**
 * The "preconditions" field on a BDD scenario — a different layer from `Given`.
 *
 * `Given` is the scenario's own business context, in the language of the domain.
 * The test management system's Preconditions section is for what a *run* needs
 * before the scenario can start at all: environment, build, access, seeded data,
 * feature flags. TestRail documents it in exactly those words ("data files,
 * hardware, security access, OS, browser, previous steps"), and the two are not
 * interchangeable — which is why the model is told, at length, not to restate
 * one as the other. An empty string is a perfectly good answer.
 */
const BDD_PRECONDITIONS_CONTRACT = `
- "preconditions" is the environment/setup a tester needs BEFORE the scenario can run, NOT a retelling of the Given lines. One item per line, no bullet characters, no keywords.
  Belongs here: environment or build under test, browser/OS/device when it matters, accounts and roles that must exist, permissions or licences, seeded test data and fixtures, feature flags or configuration that must be on, third-party/integration availability.
  Does NOT belong here: anything that is part of the scenario's flow, and anything already written as a "Given" line. Never paraphrase a Given into a precondition.
  Write "" (an empty string) when the requirement implies no setup beyond a normal working environment — that is expected and preferable to inventing prerequisites.
  Example of the distinction:
    "preconditions": "QA environment with the order-tracking feature flag enabled\\nA store account with the \\"Store Manager\\" role exists\\nAt least one order with a tracking number is seeded"
    "steps": ["Given the user is signed in as \\"Store Manager\\"", "When ...", "Then ..."]`;

/**
 * BDD (Gherkin) counterpart of generateTestCasesPrompt: one Scenario per test case.
 *
 * It shares the same context slots and the same limit semantics, so the Create
 * page's "Test cases limit" keeps meaning the same thing — a cap on scenarios.
 */
function generateBddTestCasesPrompt(context) {
  const areaPath = areaPathForPrompt();
  const {
    issueKey,
    issueDescription,
    issueLabels,
    confluencePages = [],
    relatedJiraIssues = [],
    projectTestCases = [],
    testCasesLimit = 10,
    testCasesLimitMode = "coverage",
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    userGuidance = "",
    helpingPrompt = "",
  } = context;

  const limitNum =
    testCasesLimit === null ||
    testCasesLimit === undefined ||
    !Number.isFinite(Number(testCasesLimit)) ||
    Number(testCasesLimit) <= 0
      ? null
      : Math.floor(Number(testCasesLimit));
  const isUnlimited = limitNum === null;
  // See the standard builder: a cap of 1 means "this one Scenario IS the coverage", not "at most 1".
  const isSingle = limitNum === 1;
  const limitHeaderClause = isUnlimited
    ? ""
    : isSingle
      ? " (exactly one Scenario)"
      : testCasesLimitMode === "cap"
        ? ` (maximum ${limitNum} scenarios total)`
        : ` (exactly ${limitNum} Scenarios that together cover the whole ticket)`;
  const limitRequirementBullet = isUnlimited
    ? "- Produce as many scenarios as the story actually requires — no fixed cap. Prefer fewer, sharper scenarios over many near-duplicates."
    : isSingle
      ? "- Produce EXACTLY ONE Scenario. It is the entire test design for this issue, so let it walk the main flow end to end with the And steps the flow really needs — do not split the coverage across several Scenarios, and do not leave it thin because there is only one."
      : testCasesLimitMode === "cap"
        ? `- Produce at most ${limitNum} scenarios (hard cap: never more than ${limitNum}). Prefer fewer, sharper scenarios over many near-duplicates.`
        : coverageWithinLimitBlock(limitNum, "bdd");
  const limitImportantBullet = isUnlimited
    ? "- The testCases array length is up to you — size it to the story; do not pad with redundant scenarios."
    : isSingle
      ? "- The testCases array MUST contain exactly one item."
      : testCasesLimitMode === "cap"
        ? `- The testCases array MUST contain no more than ${limitNum} items.`
        : `- The testCases array MUST contain exactly ${limitNum} items (fewer only when the ticket truly has fewer distinct behaviours), never more.`;

  // Sources in their own tags, in the order of SOURCE PRIORITY; then the method. See prompt-context.js.
  const designBlocks =
    buildFigmaContextBlock(figmaContext) +
    buildPrototypeContextBlock(prototypeContext) +
    buildAttachmentsContextBlock(attachmentsContext) +
    buildIssueCommentsBlock(commentsContext);
  let contextSection = pc.buildSourcesSection(context, "bdd", designBlocks);
  contextSection += pc.buildMethodSection("bdd");
  contextSection += `\n${TEST_DESIGN_TECHNIQUES}`;
  contextSection += `\n${DEFECT_SOURCE_BLOCK}`;

  return `You are a senior QA automation engineer specialising in Behaviour-Driven Development. Design the test coverage for this ticket as classical Gherkin${limitHeaderClause}: ONE Feature, and one Scenario per test case.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
${pc.buildTicketSection(context)}
${contextSection}
${BDD_STYLE_BLOCK}
${bddExamplesBlock()}
${PRIORITY_RULES}

REQUIREMENTS:
${limitRequirementBullet}
${pc.buildTraceabilityRules("bdd")}
- Be exhaustive with the issue description and the supplied context: every explicit rule, field, control, state, acceptance criterion, role or error message must appear in at least one scenario (or be explained in "reasoning" as out of scope).
- Cover the happy path first, then the negative, boundary, permission/role and integration behaviour the requirement implies. Do not invent rules the requirement does not support.
- Every scenario MUST have: "title" (the Scenario name, no "Scenario:" prefix), "priority" (1 or 2, see PRIORITY RULES), "covers" (requirement ids), "areaPath" ${areaPath.hint}, "preconditions", "steps".
${BDD_STEPS_CONTRACT}
${BDD_PRECONDITIONS_CONTRACT}
- "feature" is the Feature name for the whole set — short, the capability under test, no "Feature:" prefix.
- "featureDescription" is the 3-line role/capability/benefit narrative ("As a …" / "I want …" / "So that …"), one clause per line.
- In "reasoning": start with the DOMAIN MODEL; then the coverage strategy and how the sources were weighed; then which test design techniques (EP, BVA, decision tables, state transitions, use cases) shaped which scenarios — only the genuinely applicable ones; finally any deliberate gaps.
- Return ONLY valid JSON matching this schema:

{
${pc.TRACEABILITY_SCHEMA_FIELDS}
  "feature": "string",
  "featureDescription": "As a ...\\nI want ...\\nSo that ...",
  "testCases": [
    {
      "title": "string",
      "priority": 1,
      "covers": ["R1", "R2"],
      "areaPath": "${areaPath.jsonExample}",
      "preconditions": "string: environment/setup, one per line; \\"\\" when none",
      "steps": ["Given ...", "And ...", "When ...", "Then ...", "And ..."]
    }
  ],
  "reasoning": "string",
  "coverageNotes": "string: ONLY if existing test cases or previousQaChecklist context was provided — 2–5 short lines on what is already covered there and was deliberately not duplicated, plus any gap you noticed. Empty string when no such context was given."
}

${NO_REDACTION_PLACEHOLDERS_BLOCK}

IMPORTANT:
- Return ONLY valid JSON. No code fences, no prose before or after.
${limitImportantBullet}
- Every scenario must have at least one Given (or When) line and at least one Then line.`;
}

/**
 * Prompt for regenerating ONE Gherkin scenario in place. The BDD twin of
 * regenerateTestCasePrompt — same contract, same guard rails, Gherkin steps.
 */
function regenerateBddTestCasePrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels = [],
    testCase,
    siblingTitles = [],
    userGuidance = "",
    helpingPrompt = "",
    referenceTestCases = [],
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    confluenceContext = "",
    feature = "",
  } = context;
  return `You are a senior QA automation engineer specialising in Behaviour-Driven Development.

Rewrite EXACTLY ONE Gherkin scenario so it is sharper, more concrete and more verifiable than the current version.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
${pc.buildTicketSection(context)}
${pc.SOURCE_PRIORITY_BLOCK}
${feature ? `Feature this scenario belongs to: ${feature}\n` : ""}${buildFigmaContextBlock(figmaContext)}${buildPrototypeContextBlock(prototypeContext)}${buildAttachmentsContextBlock(attachmentsContext)}${buildIssueCommentsBlock(commentsContext)}${buildConfluenceContextBlock(confluenceContext)}${buildAdoContextBlock(referenceTestCases)}
Current scenario (steps are already one Gherkin line per entry):
${JSON.stringify(testCase, null, 2)}

Titles of the other scenarios in this Feature (stay out of their scope):
${JSON.stringify(siblingTitles, null, 2)}

Rules:
- Keep it ONE scenario covering ONE behaviour. Do not split it and do not merge others into it.
${BDD_STYLE_BLOCK}
${bddExamplesBlock()}${BDD_STEPS_CONTRACT}
${BDD_PRECONDITIONS_CONTRACT}
${NO_REDACTION_PLACEHOLDERS_BLOCK}

Return ONLY valid JSON, no code fences:
{
  "title": "string",
  "priority": 1,
  "areaPath": "string",
  "preconditions": "string: environment/setup, one per line; \\"\\" when none",
  "steps": ["Given ...", "When ...", "Then ..."],
  "reasoning": "string: one or two sentences on what you changed and why"
}`;
}

/**
 * Prompt for regenerating ONE checklist item in place, keeping the rest of the checklist untouched.
 * The sibling items are supplied so the model does not duplicate coverage that already exists.
 */
function regenerateChecklistItemPrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels = [],
    item,
    siblingItems = [],
    userGuidance = "",
    helpingPrompt = "",
    referenceTestCases = [],
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    confluenceContext = "",
  } = context;
  return `You are a QA expert specializing in test design.

Rewrite EXACTLY ONE checklist item so it is sharper, more concrete and more testable than the current version.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
${pc.buildTicketSection(context)}
${pc.SOURCE_PRIORITY_BLOCK}
${buildFigmaContextBlock(figmaContext)}${buildPrototypeContextBlock(prototypeContext)}${buildAttachmentsContextBlock(attachmentsContext)}${buildIssueCommentsBlock(commentsContext)}${buildConfluenceContextBlock(confluenceContext)}${buildAdoContextBlock(referenceTestCases)}
Current item:
${JSON.stringify(item, null, 2)}

Other items already in this checklist (do NOT duplicate their coverage):
${JSON.stringify(siblingItems, null, 2)}

Rules:
- Return the SAME item, improved — one scenario, not a bundle of several.
- Keep the category unless the guidance or the rewritten scenario clearly belongs to another one. Allowed: Functional, Negative, Boundary, Integration.
- Be concrete: name real screens, states, roles and data from the issue instead of "verify feature works".
- ${pc.languageRule()} No markdown formatting in the description.
${NO_REDACTION_PLACEHOLDERS_BLOCK}

Return ONLY valid JSON, no code fences:
{
  "description": "string",
  "category": "Functional" | "Negative" | "Boundary" | "Integration",
  "reasoning": "string: one or two sentences on what you changed and why"
}`;
}

/**
 * Prompt for regenerating ONE full test case (title + all steps) in place.
 * Sibling titles are supplied so the rewrite does not drift into another case's scenario.
 */
function regenerateTestCasePrompt(context) {
  const {
    issueKey,
    issueDescription,
    issueLabels = [],
    testCase,
    siblingTitles = [],
    testCaseFormatRef = "",
    userGuidance = "",
    helpingPrompt = "",
    referenceTestCases = [],
    figmaContext = "",
    prototypeContext = "",
    attachmentsContext = "",
    commentsContext = "",
    confluenceContext = "",
  } = context;
  const formatSection = testCaseFormatRef
    ? `
MANDATORY FORMAT REFERENCE (follow it exactly):
${testCaseFormatRef}
`
    : "";
  return `You are a senior QA engineer.

Rewrite EXACTLY ONE test case so its steps are more detailed and more precise than the current version.
${buildUserGuidanceBlock(userGuidance, helpingPrompt)}
${pc.buildTicketSection(context)}
${pc.SOURCE_PRIORITY_BLOCK}
${formatSection}${buildFigmaContextBlock(figmaContext)}${buildPrototypeContextBlock(prototypeContext)}${buildAttachmentsContextBlock(attachmentsContext)}${buildIssueCommentsBlock(commentsContext)}${buildConfluenceContextBlock(confluenceContext)}${buildAdoContextBlock(referenceTestCases)}
Current test case:
${JSON.stringify(testCase, null, 2)}

Titles of the other test cases in this suite (stay out of their scope):
${JSON.stringify(siblingTitles, null, 2)}

Rules:
- Keep it ONE test case covering ONE scenario. Do not split it and do not merge others into it.
- Step 1 stays the preconditions step: action starts with "Preconditions: ", expected is "—".
- Renumber steps from 1 with no gaps.
- Keep Step Expected highly detailed — exact UI labels, states, counters and messages. Multiple expectations go on their own "- " bullet lines.
- ${pc.languageRule()} No markdown in action/expected.
${NO_REDACTION_PLACEHOLDERS_BLOCK}

Return ONLY valid JSON, no code fences:
{
  "title": "string",
  "priority": 1,
  "areaPath": "string",
  "steps": [
    { "stepNumber": 1, "action": "string", "expected": "string" }
  ],
  "reasoning": "string: one or two sentences on what you changed and why"
}`;
}

module.exports = {
  areaPathForPrompt,
  generateTestChecklistPrompt,
  generateTestCasesPrompt,
  generateBddTestCasesPrompt,
  buildFigmaContextBlock,
  buildPrototypeContextBlock,
  buildAttachmentsContextBlock,
  buildIssueCommentsBlock,
  buildConfluenceContextBlock,
  buildAdoContextBlock,
  TEST_DESIGN_TECHNIQUES,
  NO_REDACTION_PLACEHOLDERS_BLOCK,
  BDD_STYLE_BLOCK,
  BDD_STEPS_CONTRACT,
  bddExamplesBlock,
  BDD_PRECONDITIONS_CONTRACT,
  buildUserGuidanceBlock,
  regenerateChecklistItemPrompt,
  regenerateTestCasePrompt,
  regenerateBddTestCasePrompt,
};
