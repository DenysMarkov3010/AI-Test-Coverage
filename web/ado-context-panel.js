/**
 * "Add context from <TMS>" panel, shared by the Create and Update pages.
 *
 * Browse whichever test management system is In use, tick the cases worth showing the model, and
 * click Add. Each Add appends one *source* to a server-side store, so several picks from different
 * plans, suites and folders accumulate instead of replacing each other.
 *
 * Every provider arrives in the same three levels (see tms-context.js on the server):
 *   top       — Azure DevOps Test Plan, or TestRail suite in a multi-suite project; the dropdown row
 *               is hidden for everything else, and a single TestRail suite opens by itself;
 *   container — the tree: ADO suites, TestRail sections, Zephyr / Xray folders;
 *   case      — loaded when its container is expanded, titles only.
 * Ids are strings throughout — TestRail's are "C123", Zephyr's and Xray's are keys.
 *
 * Two deliberate cost decisions, mirrored on the server:
 *   - the container tree arrives in one request, so opening a plan is one call;
 *   - a container's cases are fetched only when its row is expanded, and carry titles only. Step
 *     text is resolved server-side at Add time, for the ticked ids alone.
 *
 * The file keeps its Azure DevOps name and `adoCtx*` element ids because both pages already load it
 * under them; nothing in it is Azure DevOps-specific any more.
 */

const AdoContextPanel = (() => {
  /** Above this many picked cases the prompt starts getting genuinely expensive. */
  const CASE_WARN_THRESHOLD = 40;

  let cfg = null;
  let wired = false;

  const state = {
    tops: [],
    /**
     * "idle"    — never requested (the dropdown invites a click)
     * "loading" — a request is in flight
     * "ready"   — `tops` is authoritative (possibly empty)
     * Kept separate from `tops.length` on purpose: an empty list after a successful call and a
     * list nobody has asked for yet must not render the same way.
     */
    topsStatus: "idle",
    /** false for Zephyr / Xray / single-suite TestRail: the tree opens without a choice. */
    needsTop: true,
    topLabel: "Test Plan",
    /**
     * Only active Test Plans by default (Azure DevOps). A long-lived project accumulates dozens of
     * archived sprint plans, and they bury the handful anyone actually picks context from.
     */
    includeInactive: false,
    /** null = nothing open; "" = the provider's only tree (no top level). */
    topId: null,
    treeStatus: "idle",
    /** Flat rows: { id, name, path, depth, badge }. */
    containers: [],
    expanded: new Set(),
    /** containerId -> [{ id, title, meta }] */
    cases: new Map(),
    /** containerId -> Set<caseId> */
    checked: new Map(),
    loadingContainers: new Set(),
    sources: [],
    totalCases: 0,
    totalBytes: 0,
    busy: false,
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const $ = (id) => document.getElementById(id);

  const provider = () => (cfg && cfg.provider) || { id: "ado", title: "Azure DevOps" };
  const isAdo = () => provider().id === "ado";

  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  function projectPathOk() {
    const p = cfg && cfg.getProjectPath ? String(cfg.getProjectPath() || "") : "";
    return p && p !== "PATH_TO_PROJECT" && p.length > 2;
  }

  function showError(msg) {
    const el = $("adoCtxErr");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  async function post(path, body) {
    let data = {};
    try {
      const res = await fetch(cfg.apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok && !data.error) {
        data.error = res.statusText || `Request failed (${res.status})`;
      }
    } catch (e) {
      data = { ok: false, error: (e && e.message) || "Request failed" };
    }
    return data;
  }

  /** Total ticked cases across every container, and how many containers they span. */
  function checkedTotals() {
    let cases = 0;
    let containers = 0;
    for (const set of state.checked.values()) {
      if (set.size === 0) continue;
      containers += 1;
      cases += set.size;
    }
    return { cases, containers };
  }

  function containerCheckState(containerId) {
    const loaded = state.cases.get(containerId);
    const set = state.checked.get(containerId);
    if (!loaded || loaded.length === 0) return "none";
    const n = set ? set.size : 0;
    if (n === 0) return "none";
    if (n >= loaded.length) return "all";
    return "some";
  }

  /** What the tree's nodes are called for this provider, for status lines. */
  function containerNoun() {
    return { ado: "suite", testrail: "section", zephyr: "folder", xray: "folder" }[provider().id] || "suite";
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function renderTops() {
    const row = $("adoCtxPlanRow");
    const label = $("adoCtxPlanLabel");
    const inactive = $("adoCtxIncludeInactiveRow");
    const reloadBtn = $("adoCtxReloadPlansBtn");
    const sel = $("adoCtxPlan");
    // The row shows until the server says there is no top level — the idle dropdown is what the
    // lazy load hangs off for the providers that have one.
    if (row) row.hidden = state.topsStatus === "ready" && !state.needsTop;
    if (label) label.textContent = state.topLabel || "Test Plan";
    if (inactive) inactive.hidden = !isAdo();
    if (reloadBtn) reloadBtn.title = `Re-read the ${state.topLabel || "list"} from ${provider().title}`;
    if (!sel) return;
    const noun = state.topLabel || "Test Plan";
    if (state.topsStatus === "loading") {
      sel.innerHTML = `<option value="">Loading ${esc(noun)}s…</option>`;
      sel.disabled = true;
      return;
    }
    if (state.topsStatus === "idle") {
      // Must stay ENABLED: this is what the lazy load hangs off, and a disabled <select>
      // receives no pointer, focus or key events, so the panel would never load anything.
      sel.innerHTML = `<option value="">Click to load from ${esc(provider().title)}…</option>`;
      sel.disabled = false;
      return;
    }
    if (state.tops.length === 0) {
      sel.innerHTML =
        isAdo() && !state.includeInactive
          ? '<option value="">No active Test Plans — tick “Include inactive”</option>'
          : `<option value="">No ${esc(noun)}s found</option>`;
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const opts = [`<option value="">Select a ${esc(noun)}…</option>`];
    for (const p of state.tops) {
      const stateSuffix = p.state && !/^active$/i.test(p.state) ? ` — ${p.state}` : "";
      const selected = String(state.topId) === String(p.id) ? " selected" : "";
      opts.push(`<option value="${esc(p.id)}"${selected}>${esc(p.name)} (#${esc(p.id)})${esc(stateSuffix)}</option>`);
    }
    sel.innerHTML = opts.join("");
  }

  function caseRowHtml(containerId, tc) {
    const set = state.checked.get(containerId);
    const isChecked = set ? set.has(tc.id) : false;
    return (
      `<li class="adoctx-case">` +
      `<label>` +
      `<input type="checkbox" data-adoctx-case="${esc(tc.id)}" data-adoctx-suite="${esc(containerId)}"${
        isChecked ? " checked" : ""
      } />` +
      `<span class="adoctx-case-id">${esc(tc.id)}</span>` +
      `<span class="adoctx-case-title">${esc(tc.title)}</span>` +
      (tc.meta ? `<span class="adoctx-case-meta">${esc(tc.meta)}</span>` : "") +
      `</label></li>`
    );
  }

  function containerRowHtml(c) {
    const isExpanded = state.expanded.has(c.id);
    const loaded = state.cases.get(c.id);
    const isLoading = state.loadingContainers.has(c.id);
    const check = containerCheckState(c.id);

    const countBadge = isLoading
      ? '<span class="adoctx-suite-count">loading…</span>'
      : loaded
        ? `<span class="adoctx-suite-count">${loaded.length} case(s)</span>`
        : "";
    const typeBadge = c.badge ? `<span class="adoctx-suite-type">${esc(c.badge)}</span>` : "";

    // Depth lands in an inline style, so coerce it to a number rather than trusting the payload.
    const depth = Number.isFinite(Number(c.depth)) ? Math.max(0, Math.floor(Number(c.depth))) : 0;

    let html =
      `<li class="adoctx-suite" style="--adoctx-depth:${depth}">` +
      `<div class="adoctx-suite-row">` +
      `<button type="button" class="adoctx-caret${isExpanded ? " is-open" : ""}" ` +
      `data-adoctx-toggle="${esc(c.id)}" aria-expanded="${isExpanded ? "true" : "false"}" ` +
      `title="${isExpanded ? "Collapse" : "Expand"} — load the test cases of this ${containerNoun()}">&#9656;</button>` +
      `<input type="checkbox" class="adoctx-suite-check" data-adoctx-suite-all="${esc(c.id)}" ` +
      `${check === "all" ? "checked " : ""}${check === "some" ? 'data-indeterminate="1" ' : ""}` +
      `${loaded ? "" : "disabled "}title="${
        loaded ? `Select every case in this ${containerNoun()}` : `Expand the ${containerNoun()} first`
      }" />` +
      `<span class="adoctx-suite-name">${esc(c.name)}</span>` +
      typeBadge +
      countBadge +
      `</div>`;

    if (isExpanded && loaded) {
      html +=
        loaded.length === 0
          ? `<p class="adoctx-empty">This ${containerNoun()} has no test cases of its own.</p>`
          : `<ul class="adoctx-cases">${loaded.map((tc) => caseRowHtml(c.id, tc)).join("")}</ul>`;
    }
    html += "</li>";
    return html;
  }

  function renderTreeStatus() {
    const statusEl = $("adoCtxTreeStatus");
    if (!statusEl) return;
    const noun = containerNoun();
    if (state.topId === null) {
      statusEl.textContent =
        state.topsStatus === "ready" && !state.needsTop
          ? `Loading ${noun}s…`
          : state.topsStatus === "ready"
            ? `Pick a ${state.topLabel} to browse its ${noun}s.`
            : `Point at this panel to load ${provider().title}.`;
      return;
    }
    if (state.treeStatus === "loading") {
      statusEl.textContent = `Loading ${noun}s…`;
      return;
    }
    if (state.containers.length === 0) {
      statusEl.textContent = state.treeStatus === "ready" ? `No ${noun}s found.` : "";
      return;
    }
    const totals = checkedTotals();
    statusEl.textContent = totals.cases
      ? `${totals.cases} case(s) ticked across ${totals.containers} ${noun}(s). Expand a ${noun} to load its cases.`
      : `${state.containers.length} ${noun}(s). Expand a ${noun} to load its cases.`;
  }

  /**
   * Push the tick state onto the existing checkboxes without rebuilding the tree.
   * A plan can have hundreds of rows, and re-rendering all of them on every tick both
   * costs a reflow and throws away the tree's scroll position and keyboard focus.
   */
  function syncTreeChecks() {
    const treeEl = $("adoCtxTree");
    if (!treeEl) return;
    treeEl.querySelectorAll("[data-adoctx-case]").forEach((el) => {
      const set = state.checked.get(el.getAttribute("data-adoctx-suite"));
      el.checked = Boolean(set && set.has(el.getAttribute("data-adoctx-case")));
    });
    treeEl.querySelectorAll("[data-adoctx-suite-all]").forEach((el) => {
      const check = containerCheckState(el.getAttribute("data-adoctx-suite-all"));
      el.checked = check === "all";
      el.indeterminate = check === "some";
    });
  }

  /** Full rebuild — only for structural changes (top switch, expand/collapse, cases arriving). */
  function renderTree() {
    const treeEl = $("adoCtxTree");
    if (!treeEl) return;
    renderTreeStatus();

    if (state.topId === null || state.containers.length === 0) {
      treeEl.innerHTML = "";
      treeEl.hidden = true;
      return;
    }
    // innerHTML resets scrollTop; keep the row the QA engineer was looking at in place.
    const scrollTop = treeEl.scrollTop;
    treeEl.hidden = false;
    treeEl.innerHTML = `<ul class="adoctx-suites">${state.containers.map(containerRowHtml).join("")}</ul>`;
    // Tri-state boxes cannot be expressed in markup — set the DOM property after paint.
    treeEl.querySelectorAll('input[data-indeterminate="1"]').forEach((el) => {
      el.indeterminate = true;
    });
    treeEl.scrollTop = scrollTop;
  }

  function renderSources() {
    const listEl = $("adoCtxSources");
    const summaryEl = $("adoCtxSummary");
    const clearBtn = $("adoCtxClearBtn");
    if (!listEl || !summaryEl) return;

    listEl.innerHTML = state.sources
      .map((s) => {
        const mode = s.includeSteps ? "with steps" : "titles only";
        // Picks from another TMS still feed the prompt, so say where they came from.
        const from = s.provider && s.provider !== provider().id ? `${s.providerTitle || s.provider} — ` : "";
        const where = [s.planName, s.suitePath].filter(Boolean).join(" / ");
        return (
          `<li class="adoctx-source">` +
          `<span class="adoctx-source-label">${esc(from)}${esc(where)}</span>` +
          `<span class="adoctx-source-meta">${esc(s.caseCount)} case(s) · ${esc(mode)} · ${esc(
            formatBytes(s.sizeBytes)
          )}</span>` +
          `<button type="button" class="adoctx-source-remove" data-adoctx-remove="${esc(s.id)}" ` +
          `title="Remove this source from the generation context" aria-label="Remove source">&#10005;</button>` +
          `</li>`
        );
      })
      .join("");

    if (state.sources.length === 0) {
      summaryEl.textContent = `No ${provider().title} context added yet.`;
      summaryEl.classList.remove("is-warn");
    } else {
      const warn =
        state.totalCases > CASE_WARN_THRESHOLD
          ? ` — that is a lot of prompt text; consider removing a source or re-adding it as “titles only”.`
          : "";
      summaryEl.textContent = `${state.sources.length} source(s), ${state.totalCases} test case(s), ${formatBytes(
        state.totalBytes
      )} of context${warn}`;
      summaryEl.classList.toggle("is-warn", state.totalCases > CASE_WARN_THRESHOLD);
    }
    if (clearBtn) clearBtn.hidden = state.sources.length === 0;
  }

  function renderAddButton() {
    const btn = $("adoCtxAddBtn");
    if (!btn) return;
    const totals = checkedTotals();
    btn.disabled = state.busy || totals.cases === 0;
    btn.textContent = totals.cases === 0 ? "Add selected to context" : `Add ${totals.cases} selected to context`;

    const csvBtn = $("adoCtxUseCsvBtn");
    if (csvBtn) {
      csvBtn.hidden = !canUseAsCsv();
      csvBtn.disabled = state.busy || totals.cases === 0;
      csvBtn.textContent = totals.cases === 0 ? "Use selected as CSV" : `Use ${totals.cases} selected as CSV`;
    }
  }

  /** The Update page passes `useAsCsv` for the providers it can export; Create never does. */
  const canUseAsCsv = () => !!(cfg && typeof cfg.useAsCsv === "function");

  function render() {
    renderTops();
    renderTree();
    renderSources();
    renderAddButton();
    renderAnalyzeWarning();
  }

  /**
   * Picked context reaches the create-flow prompt through the same
   * `ENABLE_TEST_CASES_ANALYSIS` switch as the "Test cases" folder. Turning that switch off
   * silently drops the whole selection, so say so instead of letting it look applied.
   */
  function renderAnalyzeWarning() {
    const el = $("adoCtxAnalyzeWarn");
    if (!el) return;
    const analyzeSel = $("analyzeTestCases");
    const off = analyzeSel && analyzeSel.value === "no";
    const show = Boolean(off) && state.sources.length > 0;
    el.hidden = !show;
    if (show) {
      el.textContent = `“Analyze existing test cases” is set to No for this run — the ${
        provider().title
      } context below will NOT be used. Switch it to Yes to apply it.`;
    }
  }

  // ── data loading ─────────────────────────────────────────────────────────

  /**
   * @param {boolean} force re-read even when the list is already loaded (the Reload button)
   */
  async function loadTops(force = false) {
    if (state.topsStatus === "loading") return;
    if (state.topsStatus === "ready" && !force) return;
    state.topsStatus = "loading";
    renderTops();
    const data = await post("/__da/tms-context/tops", { includeInactive: state.includeInactive });
    if (!data.ok) {
      // Back to idle, not "ready": the dropdown stays clickable so fixed credentials can be
      // retried without reloading the page.
      state.tops = [];
      state.topsStatus = "idle";
      showError(data.error || `Could not reach ${provider().title}. Check its card on the Setup page.`);
      render();
      return;
    }
    state.tops = data.tops || [];
    state.needsTop = data.needsTop !== false;
    state.topLabel = data.topLabel || state.topLabel;
    state.topsStatus = "ready";
    showError("");
    if (!state.needsTop) {
      // No choice to make: open the provider's one tree straight away.
      if (state.topId === null || force) selectTop(data.defaultTopId || "");
      else render();
      return;
    }
    // Narrowing the list (inactive → active only) can hide the plan that is currently open;
    // drop the stale selection and its tree rather than leaving a tree with nothing behind it.
    if (state.topId && !state.tops.some((p) => String(p.id) === String(state.topId))) {
      selectTop(null);
      return;
    }
    render();
  }

  /** Re-read the plan list under the new active/inactive scope. */
  function setIncludeInactive(include) {
    const next = Boolean(include);
    if (next === state.includeInactive) return;
    state.includeInactive = next;
    loadTops(true);
  }

  /** @param {string|null} topId null closes the tree; "" opens a provider's only tree */
  async function selectTop(topId) {
    state.topId = topId === null || topId === undefined ? null : String(topId);
    if (state.needsTop && state.topId === "") state.topId = null;
    state.containers = [];
    state.expanded = new Set();
    state.cases = new Map();
    state.checked = new Map();
    state.loadingContainers = new Set();
    state.treeStatus = state.topId === null ? "idle" : "loading";
    render();
    if (state.topId === null) return;

    const requested = state.topId;
    const data = await post("/__da/tms-context/tree", { topId: requested });
    // A slow plan can resolve after the user has already switched to another one.
    if (state.topId !== requested) return;
    state.treeStatus = "ready";
    if (!data.ok) {
      showError(data.error || `Could not load the ${containerNoun()}s.`);
      state.containers = [];
      render();
      return;
    }
    showError("");
    state.containers = data.containers || [];
    render();
  }

  async function toggleContainer(containerId) {
    const id = String(containerId);
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
      render();
      return;
    }
    state.expanded.add(id);
    if (state.cases.has(id)) {
      render();
      return;
    }
    state.loadingContainers.add(id);
    render();
    const data = await post("/__da/tms-context/cases", { topId: state.topId, containerId: id });
    state.loadingContainers.delete(id);
    if (!data.ok) {
      showError(data.error || `Could not load the test cases of this ${containerNoun()}.`);
      state.expanded.delete(id);
      render();
      return;
    }
    showError("");
    state.cases.set(id, data.cases || []);
    render();
  }

  /** Tick changes update in place — see `syncTreeChecks` for why the tree is not rebuilt. */
  function afterCheckChange() {
    syncTreeChecks();
    renderTreeStatus();
    renderAddButton();
  }

  function toggleCase(containerId, caseId, checked) {
    const cid = String(containerId);
    if (!state.checked.has(cid)) state.checked.set(cid, new Set());
    const set = state.checked.get(cid);
    if (checked) set.add(String(caseId));
    else set.delete(String(caseId));
    afterCheckChange();
  }

  function toggleContainerAll(containerId, checked) {
    const cid = String(containerId);
    const loaded = state.cases.get(cid) || [];
    state.checked.set(cid, checked ? new Set(loaded.map((tc) => tc.id)) : new Set());
    afterCheckChange();
  }

  async function refreshSources() {
    if (!projectPathOk()) {
      state.sources = [];
      state.totalCases = 0;
      state.totalBytes = 0;
      render();
      return;
    }
    const data = await post("/__da/tms-context", { projectPath: cfg.getProjectPath() });
    if (!data.ok) {
      state.sources = [];
      state.totalCases = 0;
      state.totalBytes = 0;
      render();
      return;
    }
    applySummary(data);
  }

  function applySummary(data) {
    state.sources = data.sources || [];
    state.totalCases = data.totalCases || 0;
    state.totalBytes = data.totalBytes || 0;
    render();
  }

  /**
   * One Add per container that has ticks — the store keys a source by (top, container), which is
   * what makes the sources list readable and individually removable.
   */
  async function addSelected() {
    if (!projectPathOk()) {
      showError("Set a valid project path first.");
      return;
    }
    const totals = checkedTotals();
    if (totals.cases === 0) return;

    const includeSteps = !($("adoCtxIncludeSteps") && $("adoCtxIncludeSteps").checked === false);
    const top = state.tops.find((p) => String(p.id) === String(state.topId));
    // A provider without a top level labels its sources by the container path alone.
    const topName = state.needsTop ? (top ? top.name : `${state.topLabel} ${state.topId}`) : "";

    state.busy = true;
    showError("");
    renderAddButton();

    const failures = [];
    const succeeded = [];
    let skippedDuplicates = 0;
    let lastSummary = null;

    for (const [containerId, set] of state.checked.entries()) {
      if (set.size === 0) continue;
      const container = state.containers.find((c) => c.id === containerId);
      const data = await post("/__da/tms-context/add", {
        projectPath: cfg.getProjectPath(),
        topId: state.topId,
        topName,
        containerId,
        containerPath: container ? container.path : containerId,
        caseIds: [...set],
        includeSteps,
      });
      if (!data.ok) {
        failures.push(`${container ? container.name : containerId}: ${data.error || "failed"}`);
        continue;
      }
      succeeded.push(containerId);
      skippedDuplicates += data.skippedDuplicates || 0;
      lastSummary = data;
    }

    state.busy = false;
    // A successful Add consumes its ticks; a container that failed keeps them, so the QA engineer
    // can read the error and retry that one without re-finding the cases.
    for (const containerId of succeeded) state.checked.delete(containerId);
    if (lastSummary) applySummary(lastSummary);
    else render();

    if (failures.length > 0) {
      showError(failures.join(" · "));
    } else if (cfg.toast) {
      const dupNote = skippedDuplicates > 0 ? ` (${skippedDuplicates} already in context, skipped)` : "";
      cfg.toast(`Added to generation context${dupNote}`);
    }
  }

  /**
   * The ticked cases become the CSV the Update flow rewrites, instead of context beside it — how
   * the old cases get picked when they sit in folders that have nothing to do with the ticket.
   * The page does the writing (cfg.useAsCsv); the ticks stay, since nothing was consumed.
   */
  async function useSelectedAsCsv() {
    if (!canUseAsCsv()) return;
    if (!projectPathOk()) {
      showError("Set a valid project path first.");
      return;
    }
    const picks = [];
    for (const [containerId, set] of state.checked.entries()) {
      if (set.size === 0) continue;
      const container = state.containers.find((c) => c.id === containerId);
      // Tree order, not tick order: the CSV should read the way the folder does.
      const order = (state.cases.get(containerId) || []).map((tc) => tc.id);
      const caseIds = [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      picks.push({ containerId, containerPath: container ? container.path : containerId, caseIds });
    }
    if (!picks.length) return;

    state.busy = true;
    showError("");
    renderAddButton();
    let result = { ok: false, error: "Failed" };
    try {
      result = (await cfg.useAsCsv(picks)) || result;
    } catch (e) {
      result = { ok: false, error: (e && e.message) || "Failed" };
    }
    state.busy = false;
    renderAddButton();
    if (!result.ok) showError(result.error || "Could not build the CSV from the picked cases.");
  }

  async function removeSource(sourceId) {
    if (!projectPathOk()) return;
    const data = await post("/__da/tms-context/remove", {
      projectPath: cfg.getProjectPath(),
      sourceId,
    });
    if (!data.ok) {
      showError(data.error || "Could not remove this source.");
      return;
    }
    showError("");
    applySummary(data);
  }

  async function clearAll() {
    if (!projectPathOk() || state.sources.length === 0) return;
    const ok = window.confirm(
      `Remove all ${state.sources.length} context source(s)? Generation will stop using them.`
    );
    if (!ok) return;
    const data = await post("/__da/tms-context/clear", { projectPath: cfg.getProjectPath() });
    if (!data.ok) {
      showError(data.error || "Could not clear the context.");
      return;
    }
    showError("");
    applySummary(data);
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  function wire() {
    const panel = $("adoCtxPanel");
    if (!panel || wired) return;
    wired = true;

    const intro = $("adoCtxIntro");
    if (intro) {
      intro.textContent = canUseAsCsv()
        ? `Pick existing ${provider().title} test cases. Use selected as CSV makes them the cases to update (from any ${containerNoun()}s, old ones included); Add selected to context only shows them to the model.`
        : `Pick existing ${provider().title} test cases to show the model. Add as many times as you like — selections from different ${containerNoun()}s stack up.`;
    }

    // Everything here costs a round trip to the TMS, so nothing is fetched on page load — but the
    // trigger has to be something a real pointer or keyboard can actually deliver. Hovering the
    // panel pre-warms the list (and, for a provider without a top level, the tree itself);
    // mousedown / focus / keydown on the dropdown are the fallbacks. `loadTops` de-duplicates.
    const prewarm = () => loadTops(false);
    panel.addEventListener("pointerenter", prewarm);
    panel.addEventListener("focusin", prewarm);

    const topSel = $("adoCtxPlan");
    if (topSel) {
      topSel.addEventListener("change", () => selectTop(topSel.value || null));
      topSel.addEventListener("mousedown", prewarm);
      topSel.addEventListener("focus", prewarm);
      topSel.addEventListener("keydown", prewarm);
    }
    const reloadBtn = $("adoCtxReloadPlansBtn");
    if (reloadBtn) reloadBtn.addEventListener("click", () => loadTops(true));

    const inactiveBox = $("adoCtxIncludeInactive");
    if (inactiveBox) {
      inactiveBox.checked = state.includeInactive;
      inactiveBox.addEventListener("change", () => setIncludeInactive(inactiveBox.checked));
    }

    const treeEl = $("adoCtxTree");
    if (treeEl) {
      treeEl.addEventListener("click", (ev) => {
        const toggle = ev.target.closest("[data-adoctx-toggle]");
        if (toggle) {
          ev.preventDefault();
          toggleContainer(toggle.getAttribute("data-adoctx-toggle"));
        }
      });
      treeEl.addEventListener("change", (ev) => {
        const caseBox = ev.target.closest("[data-adoctx-case]");
        if (caseBox) {
          toggleCase(
            caseBox.getAttribute("data-adoctx-suite"),
            caseBox.getAttribute("data-adoctx-case"),
            caseBox.checked
          );
          return;
        }
        const allBox = ev.target.closest("[data-adoctx-suite-all]");
        if (allBox) {
          toggleContainerAll(allBox.getAttribute("data-adoctx-suite-all"), allBox.checked);
        }
      });
    }

    const addBtn = $("adoCtxAddBtn");
    if (addBtn) addBtn.addEventListener("click", addSelected);
    const csvBtn = $("adoCtxUseCsvBtn");
    if (csvBtn) csvBtn.addEventListener("click", useSelectedAsCsv);

    const sourcesEl = $("adoCtxSources");
    if (sourcesEl) {
      sourcesEl.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-adoctx-remove]");
        if (!btn) return;
        ev.preventDefault();
        removeSource(btn.getAttribute("data-adoctx-remove"));
      });
    }

    const clearBtn = $("adoCtxClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearAll);

    const projectPathEl = $("projectPath");
    if (projectPathEl) projectPathEl.addEventListener("change", refreshSources);

    const analyzeSel = $("analyzeTestCases");
    if (analyzeSel) analyzeSel.addEventListener("change", renderAnalyzeWarning);

    render();
    refreshSources();
  }

  return {
    /**
     * @param {{ apiUrl: Function, getProjectPath: Function, toast?: Function, provider?: { id: string, title: string },
     *   useAsCsv?: (picks: Array<{ containerId: string, containerPath: string, caseIds: string[] }>) => Promise<{ ok: boolean, error?: string }> }} next
     */
    configure(next) {
      cfg = next;
    },
    wire,
    refreshSources,
  };
})();
