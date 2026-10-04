/**
 * Local store for the format examples that teach the LLM what a test case /
 * checklist must look like.
 *
 * These examples used to live as `### Example N (ID …)` sections inside
 * TEST_CASE_FORMAT.md. They are the single most load-bearing part of the
 * generation prompt — the model copies their step granularity, wording and
 * expected-result depth — but they are also the most project-specific part of
 * that file, so hand-editing Markdown was the only way to change them.
 *
 * They now live here instead:
 *
 *   examples-seed.json            optional starting set (read-only, git-ignored:
 *                                 examples are project-specific)
 *     -> test-case-examples.local.json   what the user edits on the Setup page
 *                                        (git-ignored, chmod 600)
 *
 * `renderForPrompt()` turns the store back into the same Markdown shape the
 * examples had in TEST_CASE_FORMAT.md, and agent-docs.js splices that in where
 * the sections used to sit. So the prompt the LLM sees is unchanged in content —
 * only the place a human edits it moved from the .md to the web UI.
 *
 * Test cases, checklists and BDD scenarios live in one list. A test case and a
 * checklist differ only in whether the steps carry expected results, which is
 * exactly the convention the prompts already use ("> 50% of step rows have empty
 * Step Expected -> checklist"). A BDD scenario is stored in the same step rows
 * the approved CSV uses for one — Given/When lines as actions, Then lines in the
 * expected column (web/bdd-format.js) — so a scenario exported from any test
 * management system lands here unchanged. `kind` records the answer so the UI
 * can label it and the user can override a bad guess.
 *
 * The two formats feed two different prompts: test cases and checklists are
 * spliced into the standard format reference (renderForPrompt), BDD scenarios
 * into the Gherkin prompts (renderBddForPrompt). Each only ever sees its own.
 */
const fs = require("fs");
const path = require("path");
const bddFormat = require("./web/bdd-format.js");

const STORE_PATH = path.join(__dirname, "test-case-examples.local.json");
const SEED_PATH = path.join(__dirname, "examples-seed.json");
const SCHEMA_ID = "ai-test-coverage-examples/1";

const KINDS = ["test_case", "checklist", "bdd"];
/** Placeholder the .md carries where the example sections used to be. */
const PROMPT_MARKER = "<!-- FORMAT_EXAMPLES -->";

// ── helpers ────────────────────────────────────────────────────────────────

const str = (v) => (v === undefined || v === null ? "" : String(v));
const trimmed = (v) => str(v).trim();

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `ex_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * A checklist is a list of things to check; a test case pairs each action with
 * an observable result. So the deciding signal is how many steps carry an
 * expected result — the same rule the prompts state.
 */
function inferKind(steps) {
  // Checked first: a scenario's Given/When rows have no expected result, so the
  // checklist rule below would claim every one of them.
  if (bddFormat.looksLikeGherkinSteps(steps || [])) return "bdd";
  const real = (steps || []).filter((s) => trimmed(s.action));
  if (!real.length) return "test_case";
  const withoutExpected = real.filter((s) => !trimmed(s.expected)).length;
  return withoutExpected / real.length > 0.5 ? "checklist" : "test_case";
}

/** Accepts partial/untrusted input (UI, CSV) and returns a stored-shape example. */
function normalize(input, existing) {
  const base = existing || {};
  const steps = Array.isArray(input.steps)
    ? input.steps
        .map((s) => ({ action: str(s && s.action).trim(), expected: str(s && s.expected).trim() }))
        .filter((s) => s.action || s.expected)
    : base.steps || [];

  const kindRaw = trimmed(input.kind) || base.kind;
  const kind = KINDS.includes(kindRaw) ? kindRaw : inferKind(steps);

  const now = new Date().toISOString();
  return {
    // `input.id` first: normalize() also runs when hydrating stored records, and
    // dropping their ids there would hand the UI a new id on every read, so no
    // edit or delete could ever find its target again.
    id: trimmed(input.id) || base.id || newId(),
    kind,
    title: (input.title !== undefined ? trimmed(input.title) : str(base.title)) || "",
    // Original work item id, when the example was exported from a tracker.
    // Kept for traceability only; never sent anywhere.
    refId: input.refId !== undefined ? trimmed(input.refId) : str(base.refId),
    priority: (input.priority !== undefined ? trimmed(input.priority) : str(base.priority)) || "2",
    areaPath: input.areaPath !== undefined ? trimmed(input.areaPath) : str(base.areaPath),
    steps,
    // Disabled examples stay in the list but are left out of the prompt, so a
    // user can park one without losing it.
    enabled: input.enabled === undefined ? (base.enabled === undefined ? true : !!base.enabled) : !!input.enabled,
    source: trimmed(input.source) || str(base.source) || "manual",
    // Timestamps are carried through untouched here for the same reason as the
    // id. The mutating helpers below stamp updatedAt themselves.
    createdAt: str(input.createdAt) || str(base.createdAt) || now,
    updatedAt: str(input.updatedAt) || str(base.updatedAt) || now,
  };
}

/** Marks an example as changed now. Used by every write path, never by a read. */
function stamp(example) {
  return { ...example, updatedAt: new Date().toISOString() };
}

function validate(example) {
  const errors = [];
  if (!example.title) errors.push("Title is required");
  if (!example.steps.length) errors.push("At least one step is required");
  if (example.steps.some((s) => !s.action)) errors.push("Every step needs a Step Action");
  if (example.priority && !/^[1-4]$/.test(example.priority)) errors.push("Priority must be 1-4");
  if (example.kind === "bdd" && example.steps.length && !bddFormat.looksLikeGherkinSteps(example.steps)) {
    errors.push("A BDD example needs at least two Gherkin lines, every one starting with Given / When / Then / And / But");
  }
  return errors;
}

// ── persistence ────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn(`⚠️  Could not read ${path.basename(file)}: ${e.message}`);
    return null;
  }
}

function loadSeed() {
  const raw = readJson(SEED_PATH);
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.examples) ? raw.examples : [];
  // Seeded ids must be stable across reads: the list is served before anything
  // is persisted, so a random id here would make the first edit target an id
  // the next read no longer knows.
  return list.map((e, i) =>
    normalize({ ...e, id: e.id || `seed_${String(i + 1).padStart(2, "0")}`, source: e.source || "seed" })
  );
}

/**
 * Reads the local store, falling back to the bundled seed the first time. The
 * seed is NOT written to disk here — a read must not create files. It is
 * persisted on the first mutation, which is when the user actually takes
 * ownership of the list.
 */
function read() {
  const raw = readJson(STORE_PATH);
  if (raw && Array.isArray(raw.examples)) {
    return { examples: raw.examples.map((e) => normalize(e)), seeded: false };
  }
  return { examples: loadSeed(), seeded: true };
}

function write(examples) {
  const payload = {
    // Written by the Setup page in the web UI — edit it there, not by hand.
    $schema: SCHEMA_ID,
    updatedAt: new Date().toISOString(),
    examples,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* mode bits are largely cosmetic on Windows */
  }
  return examples;
}

// ── public API ─────────────────────────────────────────────────────────────

/** @returns {{ examples: object[], seeded: boolean, path: string }} */
function list() {
  const { examples, seeded } = read();
  return { examples, seeded, path: STORE_PATH };
}

function add(input) {
  // An incoming id is dropped: a new example always gets a fresh one, so a
  // replayed request cannot collide with something already stored.
  const example = stamp(normalize({ ...(input || {}), id: "" }));
  const errors = validate(example);
  if (errors.length) return { ok: false, errors };
  const { examples } = read();
  examples.push(example);
  write(examples);
  return { ok: true, example, examples };
}

/**
 * Bulk insert used by CSV import, so one file becomes one save.
 *
 * A file the user prepared is all-or-nothing: the first invalid case is reported and nothing is
 * saved. Cases picked from a test management system were written by many hands over years, so with
 * `skipInvalid` the ones that cannot be an example are left out and named in `skipped` instead.
 */
function addMany(inputs, opts = {}) {
  let prepared = (inputs || []).map((i) => stamp(normalize({ ...i, id: "" })));
  const skipped = [];
  if (opts.skipInvalid) {
    prepared = prepared.filter((e) => {
      const errs = validate(e);
      if (errs.length) skipped.push({ title: e.title || "(untitled)", reason: errs[0] });
      return !errs.length;
    });
  } else {
    const bad = prepared.map((e) => validate(e)).find((errs) => errs.length);
    if (bad) return { ok: false, errors: bad };
  }
  if (!prepared.length) {
    return { ok: false, errors: skipped.length ? skipped.map((x) => `${x.title}: ${x.reason}`) : ["Nothing to import"] };
  }
  const { examples } = read();
  const next = examples.concat(prepared);
  write(next);
  return { ok: true, added: prepared, skipped, examples: next };
}

function update(id, patch) {
  const { examples } = read();
  const idx = examples.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false, errors: ["Example not found"] };
  // The stored record wins on id, so a patch cannot rename an example's identity.
  const merged = stamp(normalize({ ...(patch || {}), id: examples[idx].id }, examples[idx]));
  const errors = validate(merged);
  if (errors.length) return { ok: false, errors };
  examples[idx] = merged;
  write(examples);
  return { ok: true, example: merged, examples };
}

function remove(id) {
  const { examples } = read();
  const next = examples.filter((e) => e.id !== id);
  if (next.length === examples.length) return { ok: false, errors: ["Example not found"] };
  write(next);
  return { ok: true, examples: next };
}

/** Reorders by the given id list; ids missing from it keep their relative order at the end. */
function reorder(ids) {
  const { examples } = read();
  const byId = new Map(examples.map((e) => [e.id, e]));
  const next = [];
  for (const id of ids || []) {
    const found = byId.get(id);
    if (found) {
      next.push(found);
      byId.delete(id);
    }
  }
  for (const leftover of byId.values()) next.push(leftover);
  write(next);
  return { ok: true, examples: next };
}

/** Drops the local file so the bundled seed applies again. */
function reset() {
  try {
    fs.unlinkSync(STORE_PATH);
  } catch {
    /* already absent */
  }
  return list();
}

// ── CSV import ─────────────────────────────────────────────────────────────

/**
 * Parses an agent test-case CSV (the Azure DevOps column layout every importer
 * reads) into examples, reusing the very parser the import path uses so a file
 * that imports cleanly also seeds cleanly. Gherkin cases come out as `bdd`.
 * @returns {{ ok: true, examples: object[] } | { ok: false, errors: string[] }}
 */
function parseCsvToExamples(text, opts) {
  const source = (opts && opts.source) || "csv";
  let cases;
  try {
    // Required lazily: ado-sync-csv pulls in the ADO client and its env, which
    // a plain "list my examples" request has no reason to load.
    const { parseCsvRows, csvRowsToTestCases } = require("./ado-sync-csv");
    cases = csvRowsToTestCases(parseCsvRows(str(text)));
  } catch (e) {
    return { ok: false, errors: [e.message || "Could not parse that CSV"] };
  }
  if (!cases.length) return { ok: false, errors: ["No test cases found in that CSV"] };

  const examples = cases.map((c) =>
    normalize({
      title: c.title,
      refId: c.refId,
      priority: c.priority,
      areaPath: c.areaPath,
      // The ADO parser emits "—" for an empty expected cell; normalize() keeps
      // text as-is, so strip the placeholder here.
      steps: (c.steps || []).map((s) => ({
        action: s.action,
        expected: trimmed(s.expected) === "—" ? "" : s.expected,
      })),
      source,
    })
  );
  return { ok: true, examples };
}

// ── prompt rendering ───────────────────────────────────────────────────────

/** Markdown tables are pipe-delimited, so a literal pipe has to be escaped. */
const cell = (v) => str(v).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");

function renderExample(example, index) {
  const heading = example.refId
    ? `### Example ${index} (ID ${example.refId})`
    : `### Example ${index}`;

  const meta = [
    "| Field     | Value |",
    "| --------- | ----- |",
    example.refId ? `| ID        | ${cell(example.refId)} |` : null,
    `| Title     | ${cell(example.title)} |`,
    `| Priority  | ${cell(example.priority)} |`,
    example.areaPath ? `| Area Path | ${cell(example.areaPath)} |` : null,
  ].filter(Boolean);

  const stepRows = example.steps.map(
    // "—" is what an empty expected result looked like in the .md, and the
    // prompts tell the model to expect exactly that for the Preconditions row.
    (s, i) => `| ${i + 1} | ${cell(s.action)} | ${cell(s.expected) || "—"} |`
  );

  return [
    heading,
    "",
    ...meta,
    "",
    "**Steps:**",
    "",
    "| Test Step | Step Action | Step Expected |",
    "| --------- | ----------- | ------------- |",
    ...stepRows,
  ].join("\n");
}

/**
 * The enabled test-case and checklist examples as Markdown, in the shape
 * TEST_CASE_FORMAT.md used to carry inline. BDD examples are left out: the
 * standard prompt is told to write steps with expected results, and a scenario
 * in that block would argue with it. Returns "" when nothing is enabled, so the
 * caller can drop the whole block rather than emit an empty heading.
 */
function renderForPrompt() {
  const { examples } = read();
  const active = examples.filter((e) => e.enabled && e.kind !== "bdd" && e.steps.length);
  if (!active.length) return "";
  return active.map((e, i) => renderExample(e, i + 1)).join("\n\n");
}

/**
 * One BDD example in the JSON shape the Gherkin prompts ask the model to return,
 * so the example and the output contract read as the same thing.
 */
function renderBddExample(example) {
  const { preconditions } = bddFormat.splitPreconditionsRow(example.steps);
  return JSON.stringify(
    {
      title: example.title,
      priority: Number(example.priority) || 2,
      preconditions: preconditions.replace(/^- /gm, ""),
      steps: bddFormat.stepsToGherkinLines(example.steps),
    },
    null,
    2
  );
}

/** The enabled BDD examples, ready for the Gherkin prompts; "" when there are none. */
function renderBddForPrompt() {
  const { examples } = read();
  const active = examples.filter((e) => e.enabled && e.kind === "bdd" && e.steps.length);
  if (!active.length) return "";
  return active.map((e, i) => `Example ${i + 1}:\n${renderBddExample(e)}`).join("\n\n");
}

/**
 * Splices renderForPrompt() into a document at PROMPT_MARKER. If the marker is
 * absent the document is returned untouched — an older TEST_CASE_FORMAT.md that
 * still has its examples inline keeps working.
 */
function injectIntoDoc(doc) {
  const text = str(doc);
  if (!text.includes(PROMPT_MARKER)) return text;
  const rendered = renderForPrompt();
  return text.replace(PROMPT_MARKER, rendered);
}

module.exports = {
  KINDS,
  PROMPT_MARKER,
  STORE_PATH,
  SEED_PATH,
  list,
  add,
  addMany,
  update,
  remove,
  reorder,
  reset,
  parseCsvToExamples,
  renderForPrompt,
  renderBddForPrompt,
  injectIntoDoc,
  inferKind,
};
