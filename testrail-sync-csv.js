/**
 * Parse the approved agent CSV and create cases in TestRail.
 *
 * The TestRail counterpart of ado-sync-csv.js, and deliberately the same shape:
 * same CSV parser, same Jira-key container match, same BDD pipeline, same
 * `{ created, errors, usage }` result — so agent-docs.js can route to either
 * without caring which one it got.
 *
 * What genuinely differs is only the last step, writing the case:
 *
 *   Azure DevOps                        TestRail
 *   ─────────────────────────────────   ────────────────────────────────────
 *   create a work item, then link it    create it *inside* a section:
 *   into Plan → Suite                   POST add_case/{section_id}
 *   Microsoft.VSTS.TCM.Steps (XML)      custom_steps_separated[] or custom_steps
 *   Priority 1-4, 1 = highest           priority_id, 4 = Critical — inverted
 *   System.Tags = Jira:PROJ-123          refs = PROJ-123
 *   System.Description = Gherkin HTML   nothing — BDD is an Azure DevOps field
 *   System.AreaPath                     no second axis; the column is dropped
 *
 * The section is never a saved setting. It is matched per ticket by Jira key,
 * the way the Azure DevOps suite is, so nobody edits Setup between tickets —
 * see TESTRAIL.md section 2.
 *
 * BDD needs nothing special here. The "Description = Gherkin" row above is
 * about the *generated* Summary copy that the Azure DevOps import used to add
 * after the fact. When the QA engineer picks BDD as the test design format on
 * the Create page, the Gherkin IS the steps — keywords live inside the step text
 * (see web/bdd-format.js) — so it arrives through the ordinary steps field and
 * reads top to bottom: "Given …", "And …", "When …" in Step, "Then … / And …" in
 * Expected Result. This import still makes no LLM calls.
 */
const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
const configStore = require("./config-store.js");
configStore.loadEnv();

const { createUsageTally } = require("./llm-usage");
const bddFormat = require("./web/bdd-format.js");
/**
 * These fields are rich text, and TestRail stores them as HTML.
 *
 * `get_case_fields` still reports `"format": "markdown"`, but the editor is a
 * WYSIWYG one and the stored value is HTML: text posted as plain lines comes
 * back as a single `<p>` with the newlines intact, and a browser collapses
 * those to spaces. That is what turned a list of preconditions into one long
 * line. Markdown syntax does not help — `- a\nb`, `* a`, `1. a`, blank lines
 * and two-space hard breaks all round-trip verbatim inside that one `<p>`.
 *
 * Real list markup does work, and survives the round trip byte for byte:
 * `<ul>`, `<ol>`, `<br>` and `<em>` all come back exactly as sent.
 *
 * The rules themselves live in tms-rich-text.js, because Zephyr Essential
 * stores its fields the same way and punishes the same mistake.
 */
const {
  escapeHtml,
  htmlList,
  isFillerExpected,
  formatRichTextCell,
  formatPreconditions,
} = require("./tms-rich-text.js");
const {
  parseCsvRows,
  csvRowsToTestCases,
  partitionManualStepsForSync,
  extractJiraKeyFromCsvFilename,
  normalizeJiraIssueKey,
  pickSuiteForJiraKey,
  titleFromCsvFilename,
  containerNameForJiraKey,
} = require("./ado-sync-csv.js");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Stored value first, then `.env`, then empty — the order every entry script uses. */
function cfgValue(key) {
  const cfg = configStore.configEnv();
  return String(cfg[key] || process.env[key] || "").trim();
}

function cfgFlag(key, fallback) {
  const raw = cfgValue(key).toLowerCase();
  if (!raw) return fallback;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/**
 * Project and suite come from the Setup card. The suite is required even on a
 * single-suite project: `get_sections` rejects a multi-suite project without
 * one, and the import reads that tree on every run.
 */
function testrailTargetFromConfig() {
  const projectId = cfgValue("TESTRAIL_PROJECT_ID");
  const suiteId = cfgValue("TESTRAIL_SUITE_ID");
  if (!projectId) {
    throw new Error("TESTRAIL_PROJECT_ID is not set — pick a project on the Setup page");
  }
  return { projectId, suiteId };
}

function testrailClientOrThrow() {
  const built = configStore.testrailClientFrom();
  if (!built.ok) throw new Error(built.error);
  return built.client;
}

// ---------------------------------------------------------------------------
// Section: matched per ticket, never pinned
// ---------------------------------------------------------------------------

/**
 * `get_sections` answers with a flat list carrying `parent_id`, so the tree is
 * rebuilt in memory — no second request, unlike the Azure DevOps suite walk.
 *
 * The rows come back in the shape pickSuiteForJiraKey() expects (`suiteId`,
 * `suiteName`, `path`) so the scoring — exact name beats path tail beats a
 * mention anywhere — is literally the same code for both providers.
 *
 * @param {Array<Record<string, unknown>>} sections
 * @returns {Array<{ suiteId: number, suiteName: string, path: string }>}
 */
function flattenSections(sections) {
  const rows = (sections || []).filter((s) => s && s.id != null);
  const byId = new Map(rows.map((s) => [String(s.id), s]));

  /** Walks up `parent_id`; a cycle or a missing parent stops the climb. */
  const pathOf = (row) => {
    const parts = [];
    const seen = new Set();
    let cur = row;
    while (cur && !seen.has(String(cur.id))) {
      seen.add(String(cur.id));
      parts.unshift(String(cur.name || `Section ${cur.id}`));
      cur = cur.parent_id == null ? null : byId.get(String(cur.parent_id));
    }
    // " / " matches the separator pickSuiteForJiraKey() scores path tails on.
    return parts.join(" / ");
  };

  return rows.map((s) => ({
    suiteId: Number(s.id),
    suiteName: String(s.name || `Section ${s.id}`),
    path: pathOf(s),
  }));
}

/**
 * Find the section this ticket's cases belong in, or create it.
 *
 * Mirrors resolveSuiteIdForApprovalByCsvKey() in ado-sync-csv.js, minus the
 * fallback container: TestRail has no pinned section to fall back to, so a miss
 * is either a new section or a hard stop — whichever
 * `TESTRAIL_CREATE_MISSING_SECTION` says.
 *
 * @param {import("./testrail-client").TestRailClient} client
 * @param {{ projectId: string, suiteId: string, jiraKey: string, createMissing: boolean, title?: string }} args
 * @returns {Promise<{ sectionId: number, name: string, created: boolean }>}
 */
async function resolveSectionForJiraKey(client, { projectId, suiteId, jiraKey, createMissing, title }) {
  if (!jiraKey) {
    throw new Error(
      "No Jira key to match a section with — name the CSV approved-testcases-PROJ-123.csv, or pass --jira-key"
    );
  }

  const t0 = Date.now();
  const sections = await client.listSections(projectId, suiteId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const flat = flattenSections(sections);

  if (process.env.TESTRAIL_SYNC_SECTION_LIST_VERBOSE === "true") {
    console.log(`   TestRail: ${flat.length} section(s) in ${elapsed}s — looking for "${jiraKey}":`);
    for (const s of flat) console.log(`      ${s.suiteId}\t${s.path}`);
  }

  const picked = pickSuiteForJiraKey(flat, jiraKey);
  if (picked) {
    console.log(`   TestRail: "${jiraKey}" → section ${picked.suiteId} — ${picked.path}`);
    return { sectionId: picked.suiteId, name: picked.suiteName, created: false };
  }

  if (!createMissing) {
    throw new Error(
      `No section carries "${jiraKey}" (${flat.length} section(s) searched) and TESTRAIL_CREATE_MISSING_SECTION is off — create the section in TestRail, or switch that on in Setup`
    );
  }

  // "PROJ-123 Story summary", not "PROJ-123": the key is what the next run matches on — the matcher
  // takes it as a token anywhere in the name — but a board of bare keys tells a human reading
  // TestRail nothing about what is in each section. The summary comes from the CSV's own file
  // name, which the approval step writes as "<story summary> (PROJ-123).csv", so no extra Jira
  // round trip is needed; a file named after the key alone falls back to the old behaviour.
  const payload = { name: containerNameForJiraKey(jiraKey, title) };
  if (suiteId) payload.suite_id = Number(suiteId) || suiteId;
  const made = await client.addSection(projectId, payload);
  const id = Number(made && made.id);
  if (!Number.isFinite(id)) {
    throw new Error(`TestRail accepted add_section for "${jiraKey}" but returned no id`);
  }
  const name = String((made && made.name) || payload.name);
  console.log(`   TestRail: "${jiraKey}" → no section matched, created section ${id} — ${name}`);
  return { sectionId: id, name, created: true };
}



// ---------------------------------------------------------------------------
// Priority: the one scale that runs the other way
// ---------------------------------------------------------------------------

/**
 * CSV priority (1-4, **1 = highest**) → TestRail `priority_id`.
 *
 * A stock instance is the mirror image: Low(1), Medium(2), High(3),
 * Critical(4). So the rule is positional, not numeric — rank the instance's own
 * priorities lowest-first and count in from the top. That survives an instance
 * that renamed them, added a fifth, or dropped one.
 *
 * `priority_level` is the documented rank but plenty of instances omit it, in
 * which case `id` order is the fallback — TestRail lists priorities in rank
 * order.
 *
 * `TESTRAIL_PRIORITY_MAP` overrides the whole thing for a team whose scales do
 * not line up: `1:4,2:3,3:2,4:1` reads as "CSV 1 → priority_id 4", and so on.
 *
 * @param {import("./testrail-client").TestRailClient} client
 * @returns {Promise<(csvPriority: string|number) => number|undefined>}
 */
async function buildPriorityResolver(client) {
  const override = parsePriorityMapOverride(cfgValue("TESTRAIL_PRIORITY_MAP"));
  if (override) {
    console.log(
      `   TestRail: priority map from TESTRAIL_PRIORITY_MAP — ${[...override].map(([k, v]) => `${k}→${v}`).join(", ")}`
    );
    return (csvPriority) => override.get(normalizeCsvPriority(csvPriority));
  }

  let rows = [];
  try {
    rows = await client.listPriorities();
  } catch (e) {
    console.warn(`   TestRail: could not read priorities (${e.message}) — cases keep the instance default`);
    return () => undefined;
  }

  const ranked = (rows || [])
    .filter((p) => p && p.id != null)
    .sort((a, b) => {
      const la = Number(a.priority_level);
      const lb = Number(b.priority_level);
      if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return la - lb;
      return Number(a.id) - Number(b.id);
    });

  if (!ranked.length) return () => undefined;

  const names = ranked.map((p) => `${p.id}=${p.name}`).join(", ");
  console.log(`   TestRail: priorities lowest→highest — ${names}`);

  return (csvPriority) => {
    const p = normalizeCsvPriority(csvPriority);
    if (!p) return undefined;
    // CSV 1 is the most urgent, so it takes the last (highest) rank.
    const index = Math.min(Math.max(ranked.length - p, 0), ranked.length - 1);
    return Number(ranked[index].id);
  };
}

function normalizeCsvPriority(raw) {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `"1:4,2:3"` → Map(1→4, 2→3). Returns null for an empty or unusable value. */
function parsePriorityMapOverride(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const map = new Map();
  for (const pair of s.split(",")) {
    const [left, right] = pair.split(":");
    const from = normalizeCsvPriority(left);
    const to = parseInt(String(right || "").trim(), 10);
    if (from && Number.isFinite(to) && to > 0) map.set(from, to);
  }
  return map.size ? map : null;
}

// ---------------------------------------------------------------------------
// Steps: two fields, and the template decides which one is real
// ---------------------------------------------------------------------------

/**
 * Which field the steps go into.
 *
 * `custom_steps_separated` only renders on a template that has it — the stock
 * "Test Case (Steps)" one. On the default "Test Case (Text)" template TestRail
 * accepts the field and then shows nothing, which looks exactly like a failed
 * import. So `auto` reads the template that will actually be used and answers
 * accordingly, and an explicit setting that contradicts the template gets a
 * warning rather than silence.
 *
 * @param {import("./testrail-client").TestRailClient} client
 * @param {{ projectId: string, templateId: string }} args
 * @returns {Promise<"custom_steps_separated" | "custom_steps">}
 */
async function resolveStepsField(client, { projectId, templateId }) {
  const configured = cfgValue("TESTRAIL_STEPS_FIELD").toLowerCase();
  const template = await resolveTemplate(client, { projectId, templateId });
  const templateIsSteps = !!template && /step/i.test(String(template.name || ""));

  if (configured === "custom_steps" || configured === "custom_steps_separated") {
    if (configured === "custom_steps_separated" && template && !templateIsSteps) {
      console.warn(
        `   TestRail: steps field is set to custom_steps_separated but template "${template.name}" has no separated steps — they will not be visible on the case`
      );
    }
    return configured;
  }

  if (!template) {
    // No template list to reason about: the text block renders on every
    // template, so it is the safe answer.
    return "custom_steps";
  }
  return templateIsSteps ? "custom_steps_separated" : "custom_steps";
}

/** TestRail's Gherkin field type id — "BDD Scenarios" on a stock instance. */
const BDD_FIELD_TYPE_ID = 13;
/** The plain-text Steps field, used as the fallback for Gherkin on older instances. */
const TEXT_STEPS_FIELD = "custom_steps";

const isActiveField = (f) => f && f.is_active !== false;

/**
 * Where a Gherkin scenario should be written — the answer to "which template?".
 *
 * `TESTRAIL_TEMPLATE_ID` stays the template for **standard** cases, because
 * "Test Case (Steps)" genuinely is the right shape for action + expected-result
 * rows. A scenario has neither shape: rendered in that grid every Gherkin line
 * becomes a numbered step with an empty Expected Result column, and the whole
 * `Then` block lands in the last cell. So the template is chosen per case.
 *
 * Resolved from `get_case_fields` rather than from a new Setup dropdown: the
 * field carries the `template_ids` it belongs to, so the instance tells us which
 * template to use and there is nothing to keep in sync by hand. Preference order:
 *
 *  1. the BDD template (a field of type 13) — TestRail's native Gherkin field;
 *  2. the text template (`custom_steps`) — one readable block, for instances
 *     older than the BDD field;
 *  3. null — the caller keeps today's behaviour and writes ordinary steps.
 *
 * @param {import("./testrail-client").TestRailClient} client
 * @param {{ projectId: string, fields: Array<Record<string, unknown>> }} args
 * @returns {Promise<{ kind: "bdd" | "text", templateId: number, fieldName: string, label: string } | null>}
 */
async function resolveBddTarget(client, { projectId, fields }) {
  let templates;
  try {
    templates = await client.listTemplates(projectId);
  } catch (e) {
    console.warn(`   TestRail: could not read templates (${e.message}) — Gherkin will be written as ordinary steps`);
    return null;
  }
  const rows = (templates || []).filter((t) => t && t.id != null);
  const nameOf = (id) => {
    const hit = rows.find((t) => String(t.id) === String(id));
    return (hit && hit.name) || `template ${id}`;
  };
  // Only a template this project actually offers — a field can be bound to one
  // that was removed from the project.
  const known = new Set(rows.map((t) => Number(t.id)));
  const templateFor = (field) => {
    const ids = Array.isArray(field && field.template_ids) ? field.template_ids.map(Number) : [];
    return ids.find((id) => known.has(id)) || 0;
  };

  const bddField = (fields || []).find((f) => isActiveField(f) && Number(f.type_id) === BDD_FIELD_TYPE_ID);
  const bddTemplateId = templateFor(bddField);
  if (bddField && bddTemplateId) {
    return {
      kind: "bdd",
      templateId: bddTemplateId,
      fieldName: String(bddField.system_name),
      label: `"${nameOf(bddTemplateId)}" → ${bddField.label || bddField.system_name}`,
    };
  }

  const textField = (fields || []).find((f) => isActiveField(f) && f.system_name === TEXT_STEPS_FIELD);
  const textTemplateId = templateFor(textField);
  if (textField && textTemplateId) {
    return {
      kind: "text",
      templateId: textTemplateId,
      fieldName: TEXT_STEPS_FIELD,
      label: `"${nameOf(textTemplateId)}" → ${textField.label || TEXT_STEPS_FIELD} (no BDD field on this instance)`,
    };
  }
  return null;
}

/**
 * The Feature name for the scenarios of one CSV.
 *
 * The CSV carries no Feature column — a scenario's Feature is the story it came
 * from, and that is already in the file name the approval step writes:
 * `"<story summary> (PROJ-123).csv"`. So it is read back from there rather than
 * threaded through the whole pipeline, and falls back to the Jira key.
 *
 * @param {string} csvFilePath
 * @param {string} jiraKey
 */
function featureNameFromCsv(csvFilePath, jiraKey) {
  return titleFromCsvFilename(csvFilePath, jiraKey);
}

/** The configured template, else the project default, else null. */
async function resolveTemplate(client, { projectId, templateId }) {
  let templates;
  try {
    templates = await client.listTemplates(projectId);
  } catch (e) {
    console.warn(`   TestRail: could not read templates (${e.message}) — assuming a text steps field`);
    return null;
  }
  const rows = (templates || []).filter((t) => t && t.id != null);
  if (!rows.length) return null;
  if (templateId) {
    const byId = rows.find((t) => String(t.id) === String(templateId));
    if (byId) return byId;
  }
  return rows.find((t) => t.is_default) || rows[0];
}

// ---------------------------------------------------------------------------
// CSV rows → one TestRail case
// ---------------------------------------------------------------------------

/**
 * Split off the preconditions row.
 *
 * Agent CSVs put preconditions in step 1 with expected "—", which is an Azure
 * DevOps convention: that product has nowhere else to put them. TestRail has a
 * real Preconditions field, so the row moves there instead of pretending to be
 * a step.
 *
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} steps
 * @returns {{ preconditions: string, steps: Array<{ stepNumber: number, action: string, expected: string }> }}
 */
function splitPreconditionsFromSteps(steps) {
  const sorted = [...(steps || [])].sort((a, b) => (a.stepNumber || 0) - (b.stepNumber || 0));
  const first = sorted[0];
  const action = String((first && first.action) || "").trim();
  if (!first || !/^preconditions\s*:/i.test(action)) {
    return { preconditions: "", steps: sorted };
  }
  return {
    preconditions: action.replace(/^preconditions\s*:\s*/i, "").trim(),
    steps: sorted.slice(1),
  };
}

/**
 * The one-text-block form of the steps, for templates without separated steps.
 *
 * An `<ol>` rather than "1. …" lines, for the same reason the preconditions are
 * a `<ul>`: plain newlines collapse into one paragraph. The expectation sits
 * under its own step on a `<br>`.
 */
function buildStepsText(steps) {
  const items = [];
  for (const s of steps) {
    const action = String(s.action || "").trim();
    const expected = String(s.expected || "").trim();
    if (!action && !expected) continue;
    let item = action ? formatRichTextCell(action) : escapeHtml("(no action)");
    if (expected && !isFillerExpected(expected)) {
      item += `<br><em>Expected:</em> ${formatRichTextCell(expected)}`;
    }
    items.push(item);
  }
  return items.length ? htmlList("ol", items) : "";
}

/**
 * The separated form: one row per step, exactly what the Steps template renders.
 * Each cell is its own field, so there is nothing to collapse — but the cells
 * are still rich text, so a literal `<` in a step has to be escaped.
 */
function buildStepsSeparated(steps) {
  return steps
    .map((s) => ({
      content: String(s.action || "").trim(),
      expected: String(s.expected || "").trim(),
    }))
    .filter((s) => s.content || s.expected)
    .map((s) => ({
      content: formatRichTextCell(s.content),
      expected: isFillerExpected(s.expected) ? "" : formatRichTextCell(s.expected),
    }));
}

/**
 * The add_case body for one Gherkin scenario.
 *
 * Two things about the BDD field were established against a live instance and
 * are not guessable from the docs:
 *
 *  1. `custom_testrail_bdd_scenario` takes a real **array** of `{ content }`.
 *     Posting the JSON *string* that `get_case` hands back — the usual TestRail
 *     round-trip contract — is rejected with
 *     `Field :custom_testrail_bdd_scenario is not a valid array. (HTTP 400)`.
 *  2. One element holds the whole `.feature` text: the `Feature:` header plus
 *     the indented `Scenario:` block, exactly as TestRail's own sample case
 *     stores it. Our model is one case per scenario, so each case gets a
 *     one-scenario feature.
 *
 * `custom_preconds` gets the scenario's own Preconditions row — the environment
 * and setup a run needs, which is what TestRail documents that section for. It
 * is NOT the `Given` lines: those are the scenario's business context and stay
 * in the Gherkin, because moving them out would leave an invalid scenario.
 *
 * @param {object} args
 * @param {object} args.tc parsed case from csvRowsToTestCases()
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} args.steps
 * @param {{ kind: "bdd" | "text", templateId: number, fieldName: string }} args.target
 * @param {string} args.feature Feature name for the whole CSV
 * @param {number|undefined} args.priorityId
 * @param {string} args.jiraKey
 * @param {string} args.typeId
 */
function buildBddCasePayload({ tc, steps, target, feature, priorityId, jiraKey, typeId }) {
  // The same split the standard path does, so both formats fill Preconditions
  // from the same row and only the scenario itself goes into the Gherkin field.
  const { preconditions, steps: scenarioSteps } = bddFormat.splitPreconditionsRow(steps);
  const featureText = bddFormat.testCasesToFeatureText(feature, [{ ...tc, steps: scenarioSteps }]);

  /** @type {Record<string, unknown>} */
  const payload = { title: String(tc.title || "").trim(), template_id: Number(target.templateId) };
  if (typeId) payload.type_id = Number(typeId) || typeId;
  if (priorityId !== undefined) payload.priority_id = priorityId;
  if (jiraKey) payload.refs = jiraKey;

  const preconds = formatPreconditions(preconditions);
  if (preconds) payload.custom_preconds = preconds;

  if (target.kind === "bdd") {
    // No `Feature:` header. This field holds one case's scenario, so a Feature line naming the
    // whole CSV is a heading over a document of one, above a Scenario line that already repeats
    // the case title.
    //
    // `<pre>` is not decoration — it is the only way to stop TestRail editing the value. Every
    // write to this field runs the markdown conversion described in section 8 of TESTRAIL.md,
    // and content that does not begin with a block-level tag comes back wrapped in `<p>…</p>`.
    // That was measured against a live instance: plain text, a leading newline, a leading CRLF,
    // four-space indentation, a fenced code block and an HTML comment were all wrapped; `<pre>`,
    // `<div>`, `<code>` and `<blockquote>` all passed through untouched. There is no shape that
    // stores with no tag at all, so the choice is which tag to leave — and for a Gherkin block
    // that is `<pre>`: preformatted text, which is exactly what a scenario is.
    const scenario = bddFormat.testCaseToScenarioText({ ...tc, steps: scenarioSteps });
    payload[target.fieldName] = [{ content: `<pre>${scenario}</pre>` }];
    return payload;
  }
  // Text template: the field is rich text, so plain lines would collapse into
  // one paragraph (see section 8 of TESTRAIL.md). `<pre>` keeps the indentation
  // that makes Gherkin readable.
  payload[target.fieldName] = `<pre>${escapeHtml(featureText)}</pre>`;
  return payload;
}

/**
 * Assemble the add_case body for one parsed CSV test case.
 *
 * @param {object} args
 * @param {object} args.tc parsed case from csvRowsToTestCases()
 * @param {Array<{ stepNumber: number, action: string, expected: string }>} args.steps manual steps only
 * @param {"custom_steps_separated" | "custom_steps"} args.stepsField
 * @param {number|undefined} args.priorityId
 * @param {string} args.jiraKey
 * @param {string} args.typeId
 * @param {string} args.templateId
 */
function buildCasePayload({ tc, steps, stepsField, priorityId, jiraKey, typeId, templateId }) {
  const { preconditions, steps: manualSteps } = splitPreconditionsFromSteps(steps);

  /** @type {Record<string, unknown>} */
  const payload = { title: String(tc.title || "").trim() };

  if (templateId) payload.template_id = Number(templateId) || templateId;
  if (typeId) payload.type_id = Number(typeId) || typeId;
  if (priorityId !== undefined) payload.priority_id = priorityId;
  // TestRail's own cross-reference field. Unlike System.Tags it needs no
  // prefix — the instance's issue-tracker pattern turns it into a link.
  if (jiraKey) payload.refs = jiraKey;

  const preconds = formatPreconditions(preconditions);
  if (preconds) payload.custom_preconds = preconds;

  if (stepsField === "custom_steps_separated") {
    const separated = buildStepsSeparated(manualSteps);
    if (separated.length) payload.custom_steps_separated = separated;
  } else {
    const text = buildStepsText(manualSteps);
    if (text) payload.custom_steps = text;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

/**
 * Create TestRail cases from an on-disk approved CSV.
 *
 * Same signature and same result shape as syncApprovedCsvToAzureDevOps(),
 * so the caller in agent-docs.js only has to pick which one to call.
 *
 * @param {string} csvFilePath
 * @param {{ jiraIssueKey?: string, sectionId?: number, syncFromApprovalRun?: boolean }} [opts]
 * @returns {Promise<{ created: { id: number, title: string }[], errors: string[], usage: object }>}
 */
async function syncApprovedCsvToTestRail(csvFilePath, opts = {}) {
  const jiraKey =
    extractJiraKeyFromCsvFilename(csvFilePath) || normalizeJiraIssueKey(opts.jiraIssueKey || "");
  const text = fs.readFileSync(csvFilePath, "utf8");
  const testCases = csvRowsToTestCases(parseCsvRows(text));
  if (testCases.length === 0) {
    return { created: [], errors: ["No test cases parsed from CSV"], usage: createUsageTally() };
  }

  const client = testrailClientOrThrow();
  const { projectId, suiteId } = testrailTargetFromConfig();
  const typeId = cfgValue("TESTRAIL_TYPE_ID");
  const templateId = cfgValue("TESTRAIL_TEMPLATE_ID");

  // The story summary, read back from the CSV's file name. It names a section created for this
  // ticket, and further down it is the Feature name for any Gherkin scenarios.
  const feature = featureNameFromCsv(csvFilePath, jiraKey);

  // An explicit section (CLI) skips the match entirely; the approval run never
  // passes one, which is the whole point of dropping the Setup field.
  const section = opts.sectionId
    ? { sectionId: Number(opts.sectionId), name: `section ${opts.sectionId}`, created: false }
    : await resolveSectionForJiraKey(client, {
        projectId,
        suiteId,
        jiraKey,
        createMissing: cfgFlag("TESTRAIL_CREATE_MISSING_SECTION", true),
        title: feature,
      });

  // Scenarios need a different template from standard cases, so the case fields
  // are read once here and shared by both resolvers instead of fetched twice.
  const caseFields = await client.listCaseFields().catch((e) => {
    console.warn(`   TestRail: could not read case fields (${e.message})`);
    return [];
  });
  const bddCount = testCases.filter((tc) => bddFormat.isBddTestCase(tc)).length;

  const [resolvePriority, stepsField, bddTarget] = await Promise.all([
    buildPriorityResolver(client),
    resolveStepsField(client, { projectId, templateId }),
    bddCount ? resolveBddTarget(client, { projectId, fields: caseFields }) : Promise.resolve(null),
  ]);
  console.log(`   TestRail: steps go to ${stepsField}`);
  if (bddCount) {
    console.log(
      bddTarget
        ? `   TestRail: ${bddCount}/${testCases.length} case(s) are Gherkin scenarios → ${bddTarget.label}`
        : `   ⚠️  TestRail: ${bddCount}/${testCases.length} case(s) are Gherkin scenarios, but this instance offers neither a BDD nor a text template — they are written as ordinary steps`
    );
  }

  const created = [];
  const errors = [];

  for (const tc of testCases) {
    const manualSteps = partitionManualStepsForSync(tc.steps);
    if (!manualSteps.length) {
      errors.push(`Skipped (no steps): ${tc.title}`);
      continue;
    }

    const asScenario = !!bddTarget && bddFormat.looksLikeGherkinSteps(manualSteps);

    try {
      const payload = asScenario
        ? buildBddCasePayload({
            tc,
            steps: manualSteps,
            target: bddTarget,
            feature,
            priorityId: resolvePriority(tc.priority),
            jiraKey,
            typeId,
          })
        : buildCasePayload({
            tc,
            steps: manualSteps,
            stepsField,
            priorityId: resolvePriority(tc.priority),
            jiraKey,
            typeId,
            templateId,
          });
      const made = await client.addCase(section.sectionId, payload);
      const id = made && made.id;
      if (id != null) created.push({ id, title: tc.title });
      else errors.push(`${tc.title}: TestRail accepted the case but returned no id`);
    } catch (e) {
      errors.push(`${tc.title}: ${e.message}`);
    }
  }

  // Always an empty tally: this import makes no LLM calls. It is returned
  // anyway so the caller in agent-docs.js can fold it in without asking which
  // provider it got.
  return { created, errors, usage: createUsageTally() };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI args: [options] <path-to-approved.csv>
 * Options: --section-id / -s, --jira-key / -j, --help
 */
function parseTestrailSyncCliArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let sectionId = NaN;
  let jiraKey = process.env.TESTRAIL_SYNC_JIRA_KEY || "";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--section-id" || a === "-s") {
      sectionId = parseInt(args[++i], 10);
    } else if (a.startsWith("--section-id=")) {
      sectionId = parseInt(a.slice("--section-id=".length), 10);
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
  return { csvPath, sectionId, jiraKey, help };
}

function printTestrailSyncUsage() {
  console.log(`Usage:
  node testrail-sync-csv.js [options] <path-to-approved.csv>

Options:
  -s, --section-id <id>  Import into this section, skipping the Jira-key match
  -j, --jira-key <KEY>   Key to match the section on and write to refs
                         (default: read from the CSV file name)
  -h, --help             Show this help

Examples:
  node testrail-sync-csv.js "C:\\path\\approved-testcases-PROJ-123.csv"
  npm run testrail:sync-csv -- --section-id 42 ./export.csv

Instance URL, email, API key, project and suite come from the Setup page
(config.local.json), falling back to .env. There is no Section setting: the
section is the one whose name carries the ticket key, and
TESTRAIL_CREATE_MISSING_SECTION decides what happens when there is none.
`);
}

async function cliMain() {
  const parsed = parseTestrailSyncCliArgs(process.argv);
  if (parsed.help) {
    printTestrailSyncUsage();
    process.exit(0);
  }
  const filePath = parsed.csvPath;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("❌ CSV file not found. Pass a valid path as the last argument.");
    printTestrailSyncUsage();
    process.exit(1);
  }
  const hasSection = Number.isFinite(parsed.sectionId) && parsed.sectionId > 0;
  console.log(`📤 Syncing ${path.basename(filePath)} to TestRail...`);
  const result = await syncApprovedCsvToTestRail(filePath, {
    jiraIssueKey: parsed.jiraKey,
    sectionId: hasSection ? parsed.sectionId : undefined,
  });
  result.created.forEach((c) => console.log(`   ✅ C${c.id} ${c.title}`));
  if (result.errors.length) {
    result.errors.forEach((e) => console.warn(`   ⚠️  ${e}`));
    if (result.created.length === 0) process.exit(1);
  }
  console.log(`Done. Created ${result.created.length} case(s).`);
}

// No token tally to report: this import is pure REST, with no LLM call in it.
if (require.main === module) {
  cliMain().catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
}

module.exports = {
  syncApprovedCsvToTestRail,
  parseTestrailSyncCliArgs,
  flattenSections,
  splitPreconditionsFromSteps,
  formatPreconditions,
  buildStepsText,
  buildStepsSeparated,
  buildCasePayload,
  buildBddCasePayload,
  buildPriorityResolver,
  resolveStepsField,
  resolveBddTarget,
  featureNameFromCsv,
  resolveSectionForJiraKey,
  parsePriorityMapOverride,
};
