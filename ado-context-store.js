/**
 * Accumulating store for "generation context picked straight out of the test management system".
 *
 * The QA engineer browses the TMS that is In use in the Web UI — Azure DevOps Test Plan → Test
 * Suite, TestRail suite → section, a Zephyr or Xray folder — ticks individual test cases, and
 * clicks Add. Each Add appends **one source** here — several Adds from different plans and suites
 * stack up instead of replacing each other, which is the whole point of the feature. Fetching the
 * cases is the caller's job (tms-context.js); this file only stores what came back.
 *
 * The folder is still `.ado-context/` because Azure DevOps was the first provider, and renaming
 * it would orphan every selection already made. A source without a `provider` is Azure DevOps.
 *
 * Why a dedicated folder and not the existing "Test cases" folder:
 *   - `Clear folder` on the Create page deletes everything in "Test cases";
 *   - `ado-export-tag-csv.js` calls `removeOtherCsvFilesInDir()` and wipes sibling CSVs on every run.
 * A picked selection living there would disappear at unpredictable moments. So it gets
 * `.ado-context/`, and `loadProjectTestCases()` merges both folders at generation time.
 *
 * Work item **ids** are what we persist, and the step text is resolved to a file the moment a
 * source is added. That keeps a later generation run reproducible and network-free, and it means
 * the UI can show a real case count and byte size before anyone spends tokens.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONTEXT_DIR_NAME = ".ado-context";
const INDEX_FILE_NAME = "selection.json";

/** Fields needed to render a full agent-format CSV row set (steps included). */
const STEP_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.WorkItemType",
  "System.AreaPath",
  "System.Tags",
  "System.AssignedTo",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.TCM.Steps",
];

/** Titles-only mode: no step XML, so the prompt cost stays tiny. */
const TITLE_FIELDS = ["System.Id", "System.Title", "System.State", "System.Tags", "System.AreaPath"];

/**
 * One Add can pull in a lot of work items; the browser is not a trusted source for that number.
 * Selecting a whole plan of a few thousand cases is a mistake, not an intent.
 */
const MAX_IDS_PER_SOURCE = Math.max(
  1,
  parseInt(process.env.ADO_CONTEXT_MAX_IDS_PER_SOURCE || "500", 10) || 500
);

const SOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function contextDir(projectDir) {
  return path.join(projectDir, CONTEXT_DIR_NAME);
}

function indexPath(projectDir) {
  return path.join(contextDir(projectDir), INDEX_FILE_NAME);
}

/** Source ids come back from the browser, so anything but a plain UUID is rejected outright. */
function assertValidSourceId(sourceId) {
  const id = String(sourceId || "");
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error("Invalid test management context source id");
  }
  return id;
}

/**
 * Read the index. Never throws: a missing or corrupt file means "no context picked yet", which is
 * a normal state, not an error the QA engineer should have to debug.
 * @param {string} projectDir
 * @returns {{ sources: Array<object> }}
 */
function readSelection(projectDir) {
  try {
    const raw = fs.readFileSync(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    const sources = Array.isArray(parsed && parsed.sources) ? parsed.sources : [];
    return { sources };
  } catch {
    return { sources: [] };
  }
}

function writeSelection(projectDir, selection) {
  const dir = contextDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    indexPath(projectDir),
    JSON.stringify({ updatedAt: new Date().toISOString(), sources: selection.sources || [] }, null, 2),
    "utf8"
  );
}

/** Positive integers only, deduplicated, order preserved. */
function normalizeWorkItemIds(raw) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Case ids as non-empty strings, deduplicated, order preserved. Azure DevOps ids are numbers,
 * TestRail's are "C123", Zephyr's and Xray's are keys — strings are the one shape all four fit.
 */
function normalizeCaseIds(raw) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = String(value == null ? "" : value).trim();
    if (!id || id.length > 64 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sourceProvider(source) {
  return (source && source.provider) || "ado";
}

/** Every case already covered by an existing source, as "provider:id". */
function selectedIdSet(selection) {
  const set = new Set();
  for (const source of selection.sources || []) {
    const provider = sourceProvider(source);
    for (const id of source.caseIds || source.workItemIds || []) set.add(`${provider}:${id}`);
  }
  return set;
}

function providerTitle(provider) {
  const configStore = require("./config-store.js");
  return configStore.activeProviderInfo({ [configStore.ACTIVE_PROVIDER_KEY]: provider }).title;
}

/**
 * Human label that travels into the prompt as the "file name" of this context block, so the LLM
 * can see which suite a group of cases came from.
 */
function sourceLabel(source) {
  const where = [source.planName, source.suitePath].filter(Boolean).join(" / ") || `Suite ${source.suiteId}`;
  const mode = source.includeSteps ? "with steps" : "titles only";
  return `${providerTitle(sourceProvider(source))} — ${where} (${source.caseCount} test case(s), ${mode})`;
}

function titlesOnlyBody(workItems) {
  const sorted = [...workItems].sort((a, b) => (a.id || 0) - (b.id || 0));
  const lines = ["Existing Azure DevOps test case titles (no steps requested):"];
  for (const wi of sorted) {
    const f = wi.fields || {};
    const id = wi.id != null ? wi.id : f["System.Id"];
    const title = String(f["System.Title"] ?? "").trim();
    const state = String(f["System.State"] ?? "").trim();
    const area = String(f["System.AreaPath"] ?? "").trim();
    const suffix = [state, area].filter(Boolean).join(" · ");
    lines.push(`${id} — ${title}${suffix ? ` [${suffix}]` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Resolve ticked cases into a context file and append them as a new source.
 *
 * Cases already covered by an earlier source are skipped rather than duplicated — the same case
 * often sits in several suites, and paying for its steps twice in one prompt is pure waste.
 *
 * @param {string} projectDir
 * @param {{ provider?: string, planId?: string|number, planName?: string, suiteId?: string|number,
 *   suitePath?: string, caseIds: Array<string|number>, includeSteps?: boolean,
 *   fetch: (caseIds: string[], includeSteps: boolean) => Promise<{ ok: boolean, error?: string, caseIds?: string[], body?: string }> }} input
 *   `planId` / `suiteId` are the provider's top level and container (see tms-context.js);
 *   `fetch` turns the new ids into the file body.
 * @returns {Promise<{ ok: boolean, error?: string, source?: object, skippedDuplicates?: number }>}
 */
async function addSource(projectDir, input) {
  const provider = String(input.provider || "ado");
  const planId = String(input.planId == null ? "" : input.planId).trim();
  const suiteId = String(input.suiteId == null ? "" : input.suiteId).trim();
  if (provider === "ado") {
    if (!/^\d+$/.test(planId)) return { ok: false, error: "planId is required" };
    if (!/^\d+$/.test(suiteId)) return { ok: false, error: "suiteId is required" };
  } else if (!suiteId && !planId) {
    return { ok: false, error: "Pick a suite, section or folder first" };
  }

  const requested = normalizeCaseIds(input.caseIds);
  if (requested.length === 0) {
    return { ok: false, error: "Select at least one test case" };
  }
  if (requested.length > MAX_IDS_PER_SOURCE) {
    return {
      ok: false,
      error: `Too many test cases in one selection (${requested.length}). The limit is ${MAX_IDS_PER_SOURCE} — add them in smaller groups.`,
    };
  }

  const selection = readSelection(projectDir);
  const already = selectedIdSet(selection);
  const ids = requested.filter((id) => !already.has(`${provider}:${id}`));
  const skippedDuplicates = requested.length - ids.length;
  if (ids.length === 0) {
    return {
      ok: false,
      error: "All selected test cases are already in the generation context.",
    };
  }

  const includeSteps = input.includeSteps !== false;
  const fetched = await input.fetch(ids, includeSteps);
  if (!fetched || !fetched.ok) {
    return { ok: false, error: (fetched && fetched.error) || "The test management system returned nothing" };
  }
  const body = String(fetched.body || "");
  const caseIds = normalizeCaseIds(fetched.caseIds);

  const sourceId = crypto.randomUUID();
  // Azure DevOps with steps is the agent CSV the "Test cases" folder also holds; the rest is text.
  const fileName = provider === "ado" && includeSteps ? `${sourceId}.csv` : `${sourceId}.txt`;

  const dir = contextDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body, "utf8");

  const source = {
    id: sourceId,
    provider,
    planId,
    planName: String(input.planName || "").trim() || (provider === "ado" ? `Plan ${planId}` : ""),
    suiteId,
    suitePath: String(input.suitePath || "").trim() || `Suite ${suiteId}`,
    caseIds,
    ...(provider === "ado" ? { workItemIds: caseIds.map(Number).filter((n) => Number.isInteger(n)) } : {}),
    includeSteps,
    caseCount: caseIds.length,
    file: fileName,
    sizeBytes: Buffer.byteLength(body, "utf8"),
    addedAt: new Date().toISOString(),
  };

  selection.sources = [...(selection.sources || []), source];
  writeSelection(projectDir, selection);
  return { ok: true, source, skippedDuplicates };
}

/**
 * @param {string} projectDir
 * @param {string} sourceId
 */
function removeSource(projectDir, sourceId) {
  const id = assertValidSourceId(sourceId);
  const selection = readSelection(projectDir);
  const keep = [];
  let removed = null;
  for (const source of selection.sources || []) {
    if (source && source.id === id) {
      removed = source;
      continue;
    }
    keep.push(source);
  }
  if (!removed) return { ok: false, error: "Context source not found" };
  selection.sources = keep;
  writeSelection(projectDir, selection);
  if (removed.file) {
    try {
      fs.unlinkSync(path.join(contextDir(projectDir), removed.file));
    } catch {
      /* file already gone — the index is what matters */
    }
  }
  return { ok: true, removed };
}

/** Drop every picked source and its cached file. */
function clearSelection(projectDir) {
  const selection = readSelection(projectDir);
  const count = (selection.sources || []).length;
  for (const source of selection.sources || []) {
    if (!source || !source.file) continue;
    try {
      fs.unlinkSync(path.join(contextDir(projectDir), source.file));
    } catch {
      /* ignore */
    }
  }
  writeSelection(projectDir, { sources: [] });
  return { ok: true, removed: count };
}

/**
 * What the Web UI panel renders: one row per Add, plus totals.
 * @param {string} projectDir
 */
function summary(projectDir) {
  const selection = readSelection(projectDir);
  const sources = (selection.sources || []).map((source) => ({
    id: source.id,
    provider: sourceProvider(source),
    providerTitle: providerTitle(sourceProvider(source)),
    planId: source.planId,
    planName: source.planName,
    suiteId: source.suiteId,
    suitePath: source.suitePath,
    caseCount: source.caseCount || (source.caseIds || source.workItemIds || []).length,
    includeSteps: source.includeSteps !== false,
    sizeBytes: source.sizeBytes || 0,
    addedAt: source.addedAt || null,
  }));
  return {
    dir: contextDir(projectDir),
    sources,
    totalCases: sources.reduce((sum, s) => sum + (s.caseCount || 0), 0),
    totalBytes: sources.reduce((sum, s) => sum + (s.sizeBytes || 0), 0),
  };
}

/**
 * Picked context in the exact `{ filename, content }` shape the prompt builders already consume
 * for the "Test cases" folder — which is why no prompt template had to change for this feature.
 *
 * Called from the agents (a child process), so it must never throw: a half-deleted source should
 * degrade to "less context", not a failed generation run.
 *
 * @param {string} projectDir
 * @returns {Array<{ filename: string, content: string }>}
 */
function loadContextFiles(projectDir) {
  const out = [];
  const selection = readSelection(projectDir);
  const dir = contextDir(projectDir);
  for (const source of selection.sources || []) {
    if (!source || !source.file) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, source.file), "utf8").trim();
    } catch (err) {
      console.warn(`⚠️  Could not read picked context file ${source.file}: ${err.message}`);
      continue;
    }
    if (!content) continue;
    out.push({ filename: sourceLabel(source), content });
  }
  return out;
}

module.exports = {
  CONTEXT_DIR_NAME,
  MAX_IDS_PER_SOURCE,
  STEP_FIELDS,
  TITLE_FIELDS,
  contextDir,
  readSelection,
  writeSelection,
  normalizeWorkItemIds,
  normalizeCaseIds,
  selectedIdSet,
  titlesOnlyBody,
  sourceLabel,
  addSource,
  removeSource,
  clearSelection,
  summary,
  loadContextFiles,
};
