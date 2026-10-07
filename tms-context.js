/**
 * Existing test cases from whichever test management system is In use, as generation context.
 *
 * Two callers:
 *   - the "Add context from …" panel on the Create and Update pages (browse → tick → Add), through
 *     web-ui-server.js — what it adds is persisted by ado-context-store.js;
 *   - Regenerate, which reads the reviewer's free-text guidance for suite / section / folder names
 *     and pulls those cases in for that one call (resolveGuidanceContext). Nothing is persisted:
 *     the guidance is the selection.
 *
 * Every provider is reduced to the same three levels, so the panel renders one tree for all four:
 *   top       — the level above the tree: an Azure DevOps Test Plan, or a TestRail suite in a
 *               multi-suite project. Zephyr and Xray have none — their project is a Setup setting.
 *   container — a node of the tree: an ADO suite, a TestRail section, a Zephyr or Xray folder.
 *   case      — one test case filed directly in a container.
 * Ids are strings throughout; each adapter converts back to whatever its API takes.
 *
 * Read-only by construction: nothing here writes to any TMS.
 */
const configStore = require("./config-store.js");
const { workItemsToCsvLines } = require("./ado-export-tag-csv.js");
const adoContextStore = require("./ado-context-store.js");

/** Cases pulled in by one Regenerate's guidance, across every container it names. */
const GUIDANCE_MAX_CASES = Math.max(1, parseInt(process.env.TMS_GUIDANCE_MAX_CASES || "60", 10) || 60);
/** Containers one guidance text may pull from — more than this is a sentence matching by accident. */
const GUIDANCE_MAX_CONTAINERS = Math.max(1, parseInt(process.env.TMS_GUIDANCE_MAX_CONTAINERS || "8", 10) || 8);
/** Multi-suite TestRail projects cost one sections call per suite; past this, only named suites count. */
const TESTRAIL_MAX_SUITES_SCANNED = 15;
/** Zephyr steps are one call per case; this many run at once. */
const ZEPHYR_STEP_CONCURRENCY = 5;

function providerTitle(provider) {
  return configStore.activeProviderInfo({ [configStore.ACTIVE_PROVIDER_KEY]: provider }).title;
}

const message = (e) => String((e && e.message) || e).slice(0, 300);

/** Zephyr and TestRail keep rich text as HTML; the prompt wants the words. */
function plainText(raw) {
  return String(raw == null ? "" : raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The one text shape every non-ADO provider is written in. Azure DevOps keeps the agent CSV it
 * always had, because the "Test cases" folder holds the same CSV and the prompt reads both.
 *
 * @param {string} title provider title
 * @param {Array<{ id: string, title: string, preconditions?: string, steps?: Array<{ action: string, expected?: string, data?: string }>, gherkin?: string, meta?: string }>} cases
 * @param {boolean} includeSteps
 */
function casesToText(title, cases, includeSteps) {
  const lines = [
    includeSteps
      ? `Existing ${title} test cases:`
      : `Existing ${title} test case titles (no steps requested):`,
  ];
  for (const tc of cases) {
    lines.push("");
    lines.push(`${tc.id} — ${tc.title}${tc.meta ? ` [${tc.meta}]` : ""}`);
    if (!includeSteps) continue;
    if (tc.preconditions) lines.push(`Preconditions: ${tc.preconditions}`);
    if (tc.gherkin) {
      lines.push(tc.gherkin);
      continue;
    }
    (tc.steps || []).forEach((s, i) => {
      const data = s.data ? ` (data: ${s.data})` : "";
      const expected = s.expected ? ` → Expected: ${s.expected}` : "";
      lines.push(`${i + 1}. ${s.action}${data}${expected}`);
    });
  }
  return lines.join("\n").trim() + "\n";
}

// ── Azure DevOps ──────────────────────────────────────────────────────────

const ado = {
  async tops({ includeInactive = false } = {}) {
    const res = await configStore.listAdoTestPlans({}, { activeOnly: !includeInactive });
    if (!res.ok) return res;
    return {
      ok: true,
      needsTop: true,
      topLabel: "Test Plan",
      tops: res.plans.map((p) => ({ id: String(p.id), name: p.name, state: p.state })),
    };
  },

  async containers(topId) {
    const res = await configStore.listAdoSuiteTree(Number(topId));
    if (!res.ok) return res;
    return {
      ok: true,
      containers: res.suites.map((s) => ({
        id: String(s.suiteId),
        name: s.suiteName,
        path: s.path,
        depth: s.depth,
        badge:
          s.suiteType && s.suiteType !== "staticTestSuite"
            ? s.suiteType === "dynamicTestSuite"
              ? "query-based"
              : "requirement-based"
            : "",
      })),
    };
  },

  async cases(topId, containerId) {
    const res = await configStore.listAdoSuiteCases(Number(topId), Number(containerId));
    if (!res.ok) return res;
    return {
      ok: true,
      cases: res.cases.map((c) => ({
        id: String(c.id),
        title: c.title,
        meta: [c.state, c.tags].filter(Boolean).join(" · "),
      })),
    };
  },

  async fetch({ caseIds, includeSteps }) {
    const built = configStore.adoClientFrom({});
    if (!built.ok) return built;
    const ids = caseIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    try {
      const workItems = await built.client.getWorkItemsByIds(
        ids,
        includeSteps ? adoContextStore.STEP_FIELDS : adoContextStore.TITLE_FIELDS
      );
      if (!Array.isArray(workItems) || workItems.length === 0) {
        return { ok: false, error: "Azure DevOps returned no work item details for the selected ids" };
      }
      const body = includeSteps
        ? workItemsToCsvLines(workItems).join("\r\n") + "\r\n"
        : adoContextStore.titlesOnlyBody(workItems);
      return { ok: true, caseIds: workItems.map((wi) => String(wi.id)), body };
    } catch (e) {
      return { ok: false, error: configStore.readableAdoError(message(e)) };
    }
  },

  /** Plans worth scanning for names: the Setup page's active plan, and every plan already picked from. */
  async guidanceContainers(projectDir) {
    const planIds = new Set();
    const active = String(configStore.configEnv().ADO_ACTIVE_TEST_PLAN_ID || process.env.ADO_ACTIVE_TEST_PLAN_ID || "").trim();
    if (/^\d+$/.test(active)) planIds.add(active);
    for (const s of adoContextStore.readSelection(projectDir).sources) {
      if ((s.provider || "ado") === "ado" && s.planId) planIds.add(String(s.planId));
    }
    if (planIds.size === 0) {
      return { ok: false, error: "no Test Plan to search — set the active Test Plan on the Setup page" };
    }
    const out = [];
    for (const planId of planIds) {
      const res = await ado.containers(planId);
      if (!res.ok) return res;
      for (const c of res.containers) out.push({ ...c, topId: planId });
    }
    return { ok: true, containers: out };
  },
};

// ── TestRail ──────────────────────────────────────────────────────────────

/**
 * TestRail's BDD field (`custom_testrail_bdd_scenario`) comes back from get_cases as a JSON array
 * of scenario blocks, `[{"content":"Scenario: …"}]` — encoded as a string on some instances, already
 * parsed on others. Read as plain text it reached the prompt as raw JSON, so the blocks are unpacked
 * here; anything that is not that shape is taken as the text it is.
 */
function testrailBddText(raw) {
  if (raw == null || raw === "") return "";
  let value = raw;
  if (typeof value === "string" && /^\s*\[/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      return plainText(raw);
    }
  }
  if (Array.isArray(value)) {
    return value
      .map((block) => plainText(block && typeof block === "object" ? block.content : block))
      .filter(Boolean)
      .join("\n\n");
  }
  return plainText(value);
}

function testrailCase(c) {
  const separated = Array.isArray(c.custom_steps_separated) ? c.custom_steps_separated : null;
  const steps = separated
    ? separated.map((s) => ({ action: plainText(s.content), expected: plainText(s.expected) }))
    : c.custom_steps
      ? [{ action: plainText(c.custom_steps), expected: plainText(c.custom_expected) }]
      : [];
  return {
    id: `C${c.id}`,
    title: String(c.title || `Case ${c.id}`),
    preconditions: plainText(c.custom_preconds),
    steps,
    gherkin: testrailBddText(c.custom_testrail_bdd_scenario),
    meta: c.refs ? String(c.refs) : "",
  };
}

/** `C123` or `123` → `123`, the number get_cases rows carry. */
const testrailNumericId = (id) => String(id).replace(/^C/i, "");

const testrail = {
  async tops() {
    const res = await configStore.listTestrailSuites();
    if (!res.ok) return res;
    return {
      ok: true,
      needsTop: res.multiSuite,
      topLabel: "Suite",
      // A single-suite project still has its one suite; the panel opens it without asking.
      defaultTopId: res.suites[0] ? String(res.suites[0].id) : "",
      tops: res.suites.map((s) => ({ id: String(s.id), name: s.name, state: "" })),
    };
  },

  async containers(topId) {
    const res = await configStore.listTestrailSections(topId);
    if (!res.ok) return res;
    return {
      ok: true,
      containers: res.sections.map((s) => ({
        id: String(s.suiteId),
        name: s.suiteName,
        path: s.path,
        depth: s.depth,
        badge: "",
      })),
    };
  },

  async rawCases(topId, containerId) {
    const built = configStore.testrailClientFrom({});
    if (!built.ok) return built;
    const projectId = String(configStore.configEnv().TESTRAIL_PROJECT_ID || process.env.TESTRAIL_PROJECT_ID || "").trim();
    if (!projectId) return { ok: false, error: "TestRail project is not set — pick one on the Setup page" };
    try {
      const rows = await built.client.listCases(projectId, { suiteId: topId, sectionId: containerId });
      return { ok: true, rows: rows.filter((c) => c && c.id != null) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },

  async cases(topId, containerId) {
    const res = await testrail.rawCases(topId, containerId);
    if (!res.ok) return res;
    return {
      ok: true,
      cases: res.rows.map((c) => ({ id: `C${c.id}`, title: String(c.title || `Case ${c.id}`), meta: c.refs ? String(c.refs) : "" })),
    };
  },

  async fetch({ topId, containerId, caseIds, includeSteps }) {
    const res = await testrail.rawCases(topId, containerId);
    if (!res.ok) return res;
    const wanted = new Set(caseIds.map(testrailNumericId));
    const cases = res.rows.filter((c) => wanted.has(String(c.id))).map(testrailCase);
    if (!cases.length) return { ok: false, error: "TestRail returned none of the selected cases" };
    return { ok: true, caseIds: cases.map((c) => c.id), body: casesToText("TestRail", cases, includeSteps) };
  },

  async guidanceContainers() {
    const tops = await testrail.tops();
    if (!tops.ok) return tops;
    const out = [];
    const suites = tops.tops.slice(0, TESTRAIL_MAX_SUITES_SCANNED);
    for (const suite of suites) {
      // In a multi-suite project the suite itself is a thing people name ("the Payments suite").
      if (tops.needsTop) {
        out.push({ id: "", name: suite.name, path: suite.name, depth: 0, topId: suite.id, wholeSuite: true });
      }
      const res = await testrail.containers(suite.id);
      if (!res.ok) return res;
      for (const c of res.containers) {
        out.push({ ...c, topId: suite.id, path: tops.needsTop ? `${suite.name} / ${c.path}` : c.path });
      }
    }
    return { ok: true, containers: out };
  },
};

// ── Zephyr Essential ──────────────────────────────────────────────────────

const zephyr = {
  async tops() {
    return { ok: true, needsTop: false, topLabel: "", defaultTopId: "", tops: [] };
  },

  async containers() {
    const res = await configStore.listZephyrFolders();
    if (!res.ok) return res;
    return {
      ok: true,
      containers: res.folders.map((f) => ({ id: String(f.suiteId), name: f.suiteName, path: f.path, depth: f.depth, badge: "" })),
    };
  },

  async rawCases(containerId) {
    const built = configStore.zephyrClientFrom({});
    if (!built.ok) return built;
    const projectKey = String(configStore.configEnv().ZEPHYR_PROJECT_KEY || process.env.ZEPHYR_PROJECT_KEY || "").trim();
    if (!projectKey) return { ok: false, error: "Zephyr project is not set — pick one on the Setup page" };
    try {
      const rows = await built.client.listTestCases(projectKey, containerId);
      return { ok: true, client: built.client, rows: rows.filter((c) => c && c.key) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },

  async cases(_topId, containerId) {
    const res = await zephyr.rawCases(containerId);
    if (!res.ok) return res;
    return {
      ok: true,
      cases: res.rows.map((c) => ({ id: String(c.key), title: String(c.name || c.key), meta: "" })),
    };
  },

  async fetch({ containerId, caseIds, includeSteps }) {
    const res = await zephyr.rawCases(containerId);
    if (!res.ok) return res;
    const wanted = new Set(caseIds.map(String));
    const rows = res.rows.filter((c) => wanted.has(String(c.key)));
    if (!rows.length) return { ok: false, error: "Zephyr returned none of the selected cases" };
    try {
      const cases = await mapLimit(rows, ZEPHYR_STEP_CONCURRENCY, async (c) => {
        const tc = {
          id: String(c.key),
          title: String(c.name || c.key),
          preconditions: plainText(c.precondition),
          steps: [],
          gherkin: "",
          meta: plainText(c.objective).slice(0, 200),
        };
        if (!includeSteps) return tc;
        const steps = await res.client.getTestSteps(c.key);
        tc.steps = steps
          .map((s) => (s && s.inline) || {})
          .map((s) => ({ action: plainText(s.description), data: plainText(s.testData), expected: plainText(s.expectedResult) }))
          .filter((s) => s.action || s.expected);
        if (tc.steps.length === 0) {
          // A BDD case has a script instead of steps, and 404s the other way round.
          const script = await res.client.getTestScript(c.key).catch(() => null);
          tc.gherkin = script && script.text ? plainText(script.text) : "";
        }
        return tc;
      });
      return { ok: true, caseIds: cases.map((c) => c.id), body: casesToText("Zephyr Essential", cases, includeSteps) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },

  async guidanceContainers() {
    return zephyr.containers();
  },
};

// ── Xray ──────────────────────────────────────────────────────────────────

function xrayCase(t) {
  return {
    id: t.key,
    title: t.summary || t.key,
    preconditions: "",
    steps: t.steps.map((s) => ({ action: plainText(s.action), data: plainText(s.data), expected: plainText(s.result) })),
    gherkin: t.gherkin ? plainText(t.gherkin) : "",
    meta: t.testType,
  };
}

const xray = {
  async tops() {
    return { ok: true, needsTop: false, topLabel: "", defaultTopId: "", tops: [] };
  },

  async containers() {
    const res = await configStore.listXrayFolders();
    if (!res.ok) return res;
    return {
      ok: true,
      containers: res.folders.map((f) => ({ id: String(f.suiteId), name: f.suiteName, path: f.path, depth: f.depth, badge: "" })),
    };
  },

  async rawTests(containerId) {
    const built = configStore.xrayClientFrom({});
    if (!built.ok) return built;
    const cfg = configStore.configEnv();
    const projectKey = String(cfg.XRAY_PROJECT_KEY || process.env.XRAY_PROJECT_KEY || cfg.PROJECT_KEY || "").trim();
    const resolved = await configStore.resolveXrayProjectId(projectKey);
    if (!resolved.id) return { ok: false, error: resolved.error || `No numeric project id for "${projectKey}"` };
    try {
      return { ok: true, tests: await built.client.listTestsInFolder(resolved.id, containerId || "/") };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  },

  async cases(_topId, containerId) {
    const res = await xray.rawTests(containerId);
    if (!res.ok) return res;
    return { ok: true, cases: res.tests.map((t) => ({ id: t.key, title: t.summary || t.key, meta: t.testType })) };
  },

  async fetch({ containerId, caseIds, includeSteps }) {
    const res = await xray.rawTests(containerId);
    if (!res.ok) return res;
    const wanted = new Set(caseIds.map(String));
    const cases = res.tests.filter((t) => wanted.has(t.key)).map(xrayCase);
    if (!cases.length) return { ok: false, error: "Xray returned none of the selected tests" };
    return { ok: true, caseIds: cases.map((c) => c.id), body: casesToText("Xray", cases, includeSteps) };
  },

  async guidanceContainers() {
    return xray.containers();
  },
};

const ADAPTERS = { ado, testrail, zephyr, xray };

/** The adapter for `provider`, defaulting to the one In use. */
function adapterFor(provider) {
  const id = provider || configStore.activeProvider();
  if (!id) throw new Error(configStore.NO_PROVIDER_MESSAGE);
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`No generation-context support for "${id}"`);
  return { id, adapter, title: providerTitle(id) };
}

// ── panel API (web-ui-server.js) ──────────────────────────────────────────

/** Never throws: every failure comes back as `{ ok: false, error }` for the panel to show. */
async function safely(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

function listTops(options = {}) {
  return safely(async () => {
    const { id, adapter, title } = adapterFor();
    return { provider: id, providerTitle: title, ...(await adapter.tops(options)) };
  });
}

function listContainers(topId) {
  return safely(async () => {
    const { id, adapter } = adapterFor();
    return { provider: id, topId: String(topId || ""), ...(await adapter.containers(String(topId || ""))) };
  });
}

function listCases(topId, containerId) {
  return safely(async () => {
    const { id, adapter } = adapterFor();
    const res = await adapter.cases(String(topId || ""), String(containerId || ""));
    return { provider: id, topId: String(topId || ""), containerId: String(containerId || ""), ...res };
  });
}

/**
 * Resolve the ticked cases and append them to the project's context store as one source.
 *
 * @param {string} projectDir
 * @param {{ topId?: string, topName?: string, containerId: string, containerPath?: string, caseIds: string[], includeSteps?: boolean }} input
 * @param {string} [provider] defaults to the one In use
 */
function addPickedSource(projectDir, input, provider) {
  return safely(async () => {
    const { id, adapter } = adapterFor(provider);
    return adoContextStore.addSource(projectDir, {
      provider: id,
      planId: input.topId,
      planName: input.topName,
      suiteId: input.containerId,
      suitePath: input.containerPath,
      caseIds: input.caseIds,
      includeSteps: input.includeSteps !== false,
      fetch: (caseIds, includeSteps) =>
        adapter.fetch({ topId: String(input.topId || ""), containerId: String(input.containerId || ""), caseIds, includeSteps }),
    });
  });
}

/**
 * The ticked cases as one agent CSV — the shape the Setup page's Format examples import, so a case
 * picked here becomes an example exactly as if it had been exported and added from a file.
 *
 * Azure DevOps already writes that CSV for the context store. Zephyr Essential and Xray go through
 * the Update flow's exporter, which also knows their older hand-written shapes (linked Precondition
 * issues, `#` comment preconditions on a Cucumber test). TestRail has no exporter, but its cases are
 * already read into the normalized shape that exporter writes from.
 *
 * @param {{ topId?: string, containerId: string, containerPath?: string, caseIds: string[] }} input
 * @returns {Promise<{ ok: true, provider: string, providerTitle: string, csv: string } | { ok: false, error: string }>}
 */
function pickedCasesAsCsv(input) {
  return safely(async () => {
    const { id, adapter, title } = adapterFor();
    const caseIds = (input.caseIds || []).map(String).filter(Boolean);
    if (!caseIds.length) return { ok: false, error: "Tick at least one test case first" };
    const topId = String(input.topId || "");
    const containerId = String(input.containerId || "");

    let csv;
    if (id === "ado") {
      const res = await adapter.fetch({ caseIds, includeSteps: true });
      if (!res.ok) return res;
      csv = res.body;
    } else if (id === "testrail") {
      const res = await testrail.rawCases(topId, containerId);
      if (!res.ok) return res;
      const wanted = new Set(caseIds.map(testrailNumericId));
      const cases = res.rows.filter((c) => wanted.has(String(c.id))).map(testrailCase);
      if (!cases.length) return { ok: false, error: "TestRail returned none of the selected cases" };
      csv = require("./tms-export-csv.js").casesToAgentCsv(cases).csv;
    } else {
      const res = await require("./tms-export-csv.js").exportPickedCases({
        provider: id,
        picks: [{ containerId, containerPath: input.containerPath, caseIds }],
      });
      if (!res.ok) return res;
      csv = res.csv;
    }
    return { ok: true, provider: id, providerTitle: title, csv };
  });
}

// ── Regenerate guidance ───────────────────────────────────────────────────

/**
 * Names too generic to count as a mention on their own. A folder called "Smoke" is real, but so
 * is the sentence "add a smoke check" — such names only match when quoted or right after a word
 * like "suite" / "сьют".
 */
const GENERIC_NAMES = new Set([
  "test", "tests", "case", "cases", "test cases", "suite", "suites", "folder", "section", "root",
  "all", "general", "misc", "other", "others", "new", "old", "main", "default", "common",
  "smoke", "regression", "sanity", "e2e", "ui", "api", "web", "mobile", "draft", "archive",
  "test repository (root)",
]);

/** Words that introduce a container name, in the languages reviewers actually type in. */
const INTRO_WORDS =
  "(?:suites?|sections?|folders?|plans?|сьют\\p{L}*|сюїт\\p{L}*|сют\\p{L}*|секці\\p{L}*|розділ\\p{L}*|папк\\p{L}*|фолдер\\p{L}*|план\\p{L}*)";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "A/B", "A > B" and "A / B" are the same path to a reader; make them the same string. */
const normalizePath = (s) =>
  String(s || "")
    .replace(/\s*[\/>›]\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    // Xray paths are rooted ("/Checkout/Refunds"); nobody types the leading slash.
    .replace(/^\/ ?/, "")
    .toLowerCase();

/** Phrases the reviewer put in quotes — the strongest signal that something is a name. */
function quotedPhrases(text) {
  const out = [];
  const re = /"([^"\n]{2,120})"|“([^”\n]{2,120})”|«([^»\n]{2,120})»|'([^'\n]{2,120})'|`([^`\n]{2,120})`/g;
  let m;
  while ((m = re.exec(text))) out.push((m[1] || m[2] || m[3] || m[4] || m[5]).trim());
  return out;
}

/**
 * Which containers the guidance names.
 *
 * Deterministic on purpose: a name either appears in the text or it does not, so the run log can
 * say exactly why a suite was pulled in, and nothing is spent on an extra model call. Three ways
 * in, strongest first — an explicit id ("suite 1234", "#1234"), a quoted name, a bare name — and a
 * match whose text sits inside a longer match is dropped ("Login" inside "Login errors").
 *
 * @param {string} guidance
 * @param {Array<{ id: string, name: string, path: string, topId?: string }>} containers
 * @returns {{ matched: Array<object>, unmatchedQuotes: string[] }}
 */
function matchContainers(guidance, containers) {
  const text = normalizePath(guidance);
  const hits = [];

  for (const m of text.matchAll(new RegExp(`(?:${INTRO_WORDS}\\s*#?|#)(\\d{1,9})\\b`, "giu"))) {
    for (const c of containers) {
      if (c.id && c.id === m[1]) hits.push({ c, start: m.index, end: m.index + m[0].length, how: `id ${m[1]}` });
    }
  }

  const unmatchedQuotes = [];
  for (const typed of quotedPhrases(String(guidance || ""))) {
    const q = normalizePath(typed);
    const found = containers.filter((c) => {
      const name = normalizePath(c.name);
      const p = normalizePath(c.path);
      return name === q || p === q || p.endsWith(` / ${q}`);
    });
    if (!found.length) unmatchedQuotes.push(typed);
    const at = text.indexOf(q);
    for (const c of found) hits.push({ c, start: at, end: at + q.length, how: `"${q}"`, strong: true });
  }

  for (const c of containers) {
    for (const candidate of new Set([normalizePath(c.path), normalizePath(c.name)])) {
      if (candidate.length < 3) continue;
      const bare = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(candidate)}(?![\\p{L}\\p{N}])`, "giu");
      const introduced = new RegExp(`${INTRO_WORDS}\\s+${escapeRe(candidate)}(?![\\p{L}\\p{N}])`, "giu");
      const re = GENERIC_NAMES.has(candidate) ? introduced : bare;
      for (const m of text.matchAll(re)) {
        hits.push({ c, start: m.index, end: m.index + m[0].length, how: candidate });
      }
    }
  }

  // Drop a hit that sits strictly inside a longer one: "Login errors" names one folder, not two.
  const kept = hits.filter(
    (h) => h.strong || !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start)
  );
  const seen = new Set();
  const matched = [];
  for (const h of kept) {
    const key = `${h.c.topId || ""}|${h.c.id}|${h.c.wholeSuite ? "suite" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push({ ...h.c, how: h.how });
  }
  return { matched, unmatchedQuotes };
}

/**
 * Pull the cases of every suite / section / folder the reviewer's guidance names, from the TMS
 * that is In use, as extra context for this one Regenerate.
 *
 * Never throws — a TMS that cannot be reached degrades to "no extra context" with a note, because
 * the reviewer's actual ask (regenerate this) must still happen.
 *
 * @param {string} guidance
 * @param {{ projectDir: string, log?: (line: string) => void }} options
 * @returns {Promise<{ provider: string, providerTitle: string, files: Array<{ filename: string, content: string }>,
 *   matched: Array<{ path: string, caseCount: number }>, unmatchedQuotes: string[], notes: string[] }>}
 */
async function resolveGuidanceContext(guidance, { projectDir, log = console.log } = {}) {
  const empty = (extra = {}) => ({ provider: "", providerTitle: "", files: [], matched: [], unmatchedQuotes: [], notes: [], ...extra });
  const text = String(guidance || "").trim();
  if (!text) return empty();

  let resolved;
  try {
    resolved = adapterFor();
  } catch (e) {
    return empty({ notes: [message(e)] });
  }
  const { id, adapter, title } = resolved;
  const base = { provider: id, providerTitle: title };

  const listed = await safely(() => adapter.guidanceContainers(projectDir));
  if (!listed.ok) {
    const note = `${title}: could not list suites to match against (${listed.error})`;
    log(`⚠️  ${note}`);
    return empty({ ...base, notes: [note] });
  }

  const { matched, unmatchedQuotes } = matchContainers(text, listed.containers);
  for (const q of unmatchedQuotes) log(`⚠️  Guidance names "${q}", but ${title} has no suite / section / folder by that name`);
  if (!matched.length) return empty({ ...base, unmatchedQuotes });

  const notes = [];
  if (matched.length > GUIDANCE_MAX_CONTAINERS) {
    notes.push(`${matched.length} containers matched; only the first ${GUIDANCE_MAX_CONTAINERS} are used`);
  }

  // Cases already in the picked context are in the prompt anyway — paying for them twice is waste.
  const alreadyPicked = adoContextStore.selectedIdSet(adoContextStore.readSelection(projectDir));
  const files = [];
  const summary = [];
  let budget = GUIDANCE_MAX_CASES;

  for (const c of matched.slice(0, GUIDANCE_MAX_CONTAINERS)) {
    if (budget <= 0) {
      notes.push(`case limit (${GUIDANCE_MAX_CASES}) reached — "${c.path}" skipped`);
      continue;
    }
    const listedCases = await safely(() => adapter.cases(c.topId || "", c.id));
    if (!listedCases.ok) {
      notes.push(`"${c.path}": ${listedCases.error}`);
      continue;
    }
    const ids = listedCases.cases.map((tc) => tc.id).filter((cid) => !alreadyPicked.has(`${id}:${cid}`));
    if (!ids.length) {
      summary.push({ path: c.path, caseCount: 0 });
      continue;
    }
    const take = ids.slice(0, budget);
    if (take.length < ids.length) notes.push(`"${c.path}": ${ids.length} cases, only ${take.length} used (case limit)`);
    const fetched = await safely(() => adapter.fetch({ topId: c.topId || "", containerId: c.id, caseIds: take, includeSteps: true }));
    if (!fetched.ok) {
      notes.push(`"${c.path}": ${fetched.error}`);
      continue;
    }
    budget -= fetched.caseIds.length;
    for (const cid of fetched.caseIds) alreadyPicked.add(`${id}:${cid}`);
    summary.push({ path: c.path, caseCount: fetched.caseIds.length });
    files.push({
      filename: `${title} — ${c.path} (${fetched.caseIds.length} test case(s), named in the reviewer guidance)`,
      content: fetched.body.trim(),
    });
    log(`📌 Guidance → ${title} "${c.path}" (matched ${c.how}): ${fetched.caseIds.length} test case(s) added as context`);
  }
  for (const n of notes) log(`ℹ️  ${n}`);
  return { ...base, files, matched: summary, unmatchedQuotes, notes };
}

module.exports = {
  GUIDANCE_MAX_CASES,
  providerTitle,
  casesToText,
  listTops,
  listContainers,
  listCases,
  addPickedSource,
  pickedCasesAsCsv,
  matchContainers,
  resolveGuidanceContext,
};
