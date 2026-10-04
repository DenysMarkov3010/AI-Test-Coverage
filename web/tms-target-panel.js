/**
 * "Import into" picker for the Cover a bug page.
 *
 * Shared by the Cover a bug page and by the "Manual Import into …" step on Create and Update.
 * Two providers nest one container inside another, so one pair of selects serves both and only
 * the labels and the endpoints change; the third is one level shallower and collapses to a
 * single select:
 *
 *   Azure DevOps       Test Plan  →  Test Suite   (suite tree, `depth` drives the indentation)
 *   TestRail           Suite      →  Section      (section tree, same row shape on purpose)
 *   Zephyr Essential   Folder                     (the project is a Setup setting)
 *
 * All three answer with the same row keys — `suiteId`, `suiteName`, `path`, `depth` — which is
 * what lets one renderer serve them. Zephyr's id is a string where the other two are numeric,
 * so ids are compared as strings throughout and only coerced where a provider needs a number.
 *
 * Having a picker and having an importer are separate facts. Zephyr has the first and not yet
 * the second, so the panel lists its folders and says out loud that Import will report the gap
 * — see IMPORTERS. `unsupported` is the older, harder case: a provider with neither.
 *
 * Unlike AdoContextPanel this picks exactly one destination, so there are no checkboxes and no
 * server-side selection store: the chosen ids ride along with the import request.
 */
const TmsTargetPanel = (() => {
  const $ = (id) => document.getElementById(id);

  const PROVIDERS = {
    ado: {
      primaryLabel: "Test Plan",
      secondaryLabel: "Test Suite",
      primaryEmpty: "Click to load Test Plans…",
      secondaryEmpty: "Pick a Test Plan first",
      secondaryNone: "This plan has no suites",
      reloadTip: "Re-read the Test Plan list from Azure DevOps",
    },
    testrail: {
      primaryLabel: "Suite",
      secondaryLabel: "Section",
      primaryEmpty: "Click to load suites…",
      secondaryEmpty: "Pick a suite first",
      // A brand-new suite genuinely has none, and TestRail cannot create a case outside one.
      secondaryNone: "This suite has no sections — create one in TestRail first",
      reloadTip: "Re-read the suite list from TestRail",
    },
    // Zephyr Essential nests one level shallower than the other two: the project is a Setup
    // setting, and a folder hangs straight off it. Rather than leave a second select showing a
    // permanent "—", `singleLevel` collapses the panel to the one list that exists — the folder
    // tree lands in the primary select, which is also the one wearing the Reload button.
    zephyr: {
      singleLevel: true,
      // What the chosen row is called when it leaves this panel. Zephyr addresses a folder by id,
      // Xray by path, and the importer on the other side takes one or the other by name.
      flatKey: "folderId",
      primaryLabel: "Folder",
      primaryEmpty: "Click to load folders…",
      primaryNone: "This project has no test-case folders — create one in Zephyr first",
      reloadTip: "Re-read the folder tree from Zephyr",
    },
    // Xray nests the same one level: the Jira project is a Setup setting, and a Test Repository
    // folder hangs straight off it. The root is always offered, so this list is never empty.
    xray: {
      singleLevel: true,
      flatKey: "folderPath",
      primaryLabel: "Folder",
      primaryEmpty: "Click to load folders…",
      primaryNone: "This project's Test Repository has no folders — tests go to the root",
      reloadTip: "Re-read the Test Repository from Xray",
    },
  };

  /** Is this provider's destination a single list rather than a container inside a container? */
  const isFlat = () => !!(PROVIDERS[provider] || {}).singleLevel;

  /**
   * Providers that can actually be written to. Zephyr has a picker but no writer yet, and those
   * are separate facts: the folder list is real and worth browsing, while pressing Import gets
   * the gap reported by name. Saying so up front beats letting the panel imply otherwise.
   */
  const IMPORTERS = new Set(["ado", "testrail", "zephyr", "xray"]);

  let cfg = null;
  let provider = "ado";
  /** Display name of the provider in use, for messages that name it. */
  let providerTitle = "Azure DevOps";
  /** Title of the provider in use when it has no picker here — "" while one of the two is active. */
  let unsupported = "";
  let onChange = () => {};

  const state = {
    primary: [],
    primaryId: "",
    primaryStatus: "idle",
    secondary: [],
    secondaryId: "",
    secondaryStatus: "idle",
    includeInactive: false,
  };

  async function post(url, body) {
    try {
      const res = await fetch(cfg.apiUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || res.statusText || "Request failed" };
      return data;
    } catch (e) {
      return { ok: false, error: e.message || "Network error" };
    }
  }

  function showError(msg) {
    const el = $("tmsTargetErr");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function setStatus(text) {
    const el = $("tmsTargetStatus");
    if (!el) return;
    el.textContent = text || "";
  }

  /**
   * One `<option>` per row, labelled with its path instead of being indented by depth.
   *
   * Leading indentation is only half visible: a closed `<select>` renders the selected option's
   * text verbatim, so a third-level suite showed up as a wide blank followed by its name, which
   * reads as a rendering fault rather than as nesting. Nothing can style the collapsed value
   * differently from the list, so the hierarchy is spelled out instead — which also tells two
   * suites with the same name in different branches apart, something indentation never did.
   *
   * The first path segment is dropped: it is the plan's own root suite, already chosen above.
   * `fullPath` turns that off, for a list whose rows have no container above them to strip —
   * a Zephyr folder tree is the whole destination, so `Regression / Smoke` has to stay both words.
   */
  function fillTree(sel, rows, placeholder, selectedId, fullPath) {
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = placeholder;
    sel.appendChild(blank);
    for (const row of rows) {
      const opt = document.createElement("option");
      opt.value = String(row.suiteId);
      const segments = String(row.path || row.suiteName).split(" / ").filter(Boolean);
      opt.textContent = fullPath
        ? segments.join(" / ") || row.suiteName
        : segments.length > 1
          ? segments.slice(1).join(" / ")
          : segments[0] || row.suiteName;
      opt.title = row.path || row.suiteName;
      sel.appendChild(opt);
    }
    sel.value = selectedId || "";
  }

  /** Empties and locks both selects — there is nothing to pick for this provider. */
  function renderUnsupported() {
    for (const id of ["tmsTargetPrimary", "tmsTargetSecondary"]) {
      const sel = $(id);
      if (!sel) continue;
      sel.innerHTML = "";
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "—";
      sel.appendChild(blank);
      sel.value = "";
      sel.disabled = true;
    }
    const inactiveWrap = $("tmsTargetInactiveWrap");
    if (inactiveWrap) inactiveWrap.hidden = true;
    const reloadBtn = $("tmsTargetReloadBtn");
    if (reloadBtn) reloadBtn.disabled = true;
    showError(missingForUnsupported());
    setStatus("");
  }

  function missingForUnsupported() {
    return `${unsupported} has no CSV importer yet — switch the provider In use on the Setup page to import this case.`;
  }

  function render() {
    if (unsupported) return renderUnsupported();
    const labels = PROVIDERS[provider] || PROVIDERS.ado;

    const primaryLabelEl = $("tmsTargetPrimaryLabel");
    if (primaryLabelEl) primaryLabelEl.textContent = labels.primaryLabel;
    const secondaryLabelEl = $("tmsTargetSecondaryLabel");
    if (secondaryLabelEl) secondaryLabelEl.textContent = labels.secondaryLabel;
    const reloadBtn = $("tmsTargetReloadBtn");
    if (reloadBtn) {
      reloadBtn.title = labels.reloadTip;
      // Both are cleared explicitly rather than assumed: renderUnsupported() locks them, and
      // this is the path that has to be able to undo that.
      reloadBtn.disabled = false;
    }

    // Only Azure DevOps has an active/inactive distinction on the first level.
    const inactiveWrap = $("tmsTargetInactiveWrap");
    if (inactiveWrap) inactiveWrap.hidden = provider !== "ado";

    // A flat provider has nothing to put in the second row, so the row goes away rather than
    // sitting there disabled — an empty control reads as something still to do.
    const secondaryRow = $("tmsTargetSecondaryRow");
    if (secondaryRow) secondaryRow.hidden = isFlat();

    const primary = $("tmsTargetPrimary");
    if (primary) {
      primary.disabled = false;
      const loading = state.primaryStatus === "loading";
      if (isFlat()) {
        // The folder tree is the destination itself, so it is rendered like the other
        // providers' second level: full path, because two folders often share a name.
        const placeholder = loading
          ? "Loading…"
          : state.primaryStatus === "ready" && !state.primary.length
            ? labels.primaryNone
            : labels.primaryEmpty;
        fillTree(primary, state.primary, placeholder, state.primaryId, true);
      } else {
        primary.innerHTML = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = loading ? "Loading…" : labels.primaryEmpty;
        primary.appendChild(blank);
        for (const row of state.primary) {
          const opt = document.createElement("option");
          opt.value = String(row.id);
          opt.textContent = row.name;
          opt.title = `id ${row.id}`;
          primary.appendChild(opt);
        }
        primary.value = state.primaryId || "";
      }
    }

    const secondary = $("tmsTargetSecondary");
    if (secondary && !isFlat()) {
      const placeholder = !state.primaryId
        ? labels.secondaryEmpty
        : state.secondaryStatus === "loading"
          ? "Loading…"
          : state.secondary.length
            ? `Select a ${labels.secondaryLabel.toLowerCase()}`
            : labels.secondaryNone;
      fillTree(secondary, state.secondary, placeholder, state.secondaryId);
      secondary.disabled = !state.primaryId || state.secondaryStatus === "loading";
    }

    const chosen = chosenRow();
    const where = chosen ? `Importing into: ${chosen.path || chosen.suiteName}` : "";
    const gap = IMPORTERS.has(provider)
      ? ""
      : `${providerTitle || provider} has no CSV importer yet — a folder can be picked, but Import will say so.`;
    setStatus([where, gap].filter(Boolean).join(" · "));

    onChange();
  }

  /** The picked destination row, wherever this provider keeps it. */
  function chosenRow() {
    return isFlat()
      ? state.primary.find((f) => String(f.suiteId) === String(state.primaryId))
      : state.secondary.find((s) => String(s.suiteId) === String(state.secondaryId));
  }

  // ── loading ───────────────────────────────────────────────────────────────

  async function loadPrimary(force = false) {
    if (state.primaryStatus === "loading") return;
    if (state.primaryStatus === "ready" && !force) return;
    state.primaryStatus = "loading";
    render();

    const data =
      provider === "ado"
        ? await post("/__da/ado/test-plans", { activeOnly: !state.includeInactive })
        : provider === "zephyr"
          ? await post("/__da/zephyr/folders", {})
          : provider === "xray"
            ? await post("/__da/xray/folders", {})
            : await post("/__da/testrail/suites", {});

    if (!data.ok) {
      // Back to idle, not "ready": a fixed credential can be retried without a page reload.
      state.primary = [];
      state.primaryStatus = "idle";
      showError(data.error || "Could not load the import targets. Check the provider card on the Setup page.");
      render();
      return;
    }
    showError("");
    state.primary =
      provider === "ado"
        ? data.plans || []
        : provider === "zephyr" || provider === "xray"
          ? data.folders || []
          : data.suites || [];
    state.primaryStatus = "ready";

    // A flat provider's primary list IS the destination — there is no second level to load and
    // no id shape to reconcile, so the only thing left is to repaint.
    if (isFlat()) {
      if (state.primaryId && !state.primary.some((f) => String(f.suiteId) === String(state.primaryId))) {
        state.primaryId = "";
      }
      render();
      return;
    }

    // Narrowing the Azure DevOps list can hide the plan that is currently selected; drop the
    // stale selection rather than leave a suite tree with no plan behind it.
    if (state.primaryId && !state.primary.some((p) => String(p.id) === String(state.primaryId))) {
      await selectPrimary("");
      return;
    }
    // A single-suite TestRail project offers exactly one suite — choosing it by hand is busywork.
    if (!state.primaryId && provider === "testrail" && state.primary.length === 1) {
      await selectPrimary(String(state.primary[0].id));
      return;
    }
    render();
  }

  async function selectPrimary(id) {
    state.primaryId = String(id || "");
    // Flat providers stop here: the primary select already holds the destination.
    if (isFlat()) {
      render();
      return;
    }
    state.secondary = [];
    state.secondaryId = "";
    state.secondaryStatus = state.primaryId ? "loading" : "idle";
    render();
    if (!state.primaryId) return;

    const requestedFor = state.primaryId;
    const data =
      provider === "ado"
        ? await post("/__da/ado/suite-tree", { planId: Number(state.primaryId) })
        : await post("/__da/testrail/sections", { suiteId: state.primaryId });

    // A slow request can resolve after the user has already switched targets.
    if (state.primaryId !== requestedFor) return;

    if (!data.ok) {
      state.secondary = [];
      state.secondaryStatus = "idle";
      showError(data.error || "Could not load the containers for this selection.");
      render();
      return;
    }
    showError("");
    state.secondary = provider === "ado" ? data.suites || [] : data.sections || [];
    state.secondaryStatus = "ready";
    // One root suite and nothing else is not a choice; Azure DevOps always has that root.
    if (state.secondary.length === 1) state.secondaryId = String(state.secondary[0].suiteId);
    render();
  }

  return {
    /**
     * @param {{ apiUrl: Function, onChange?: Function }} options
     */
    configure(options) {
      cfg = options;
      if (options.onChange) onChange = options.onChange;
    },

    /** Name the fields for the provider in use and wire the controls. Call once per page load. */
    mount(activeProvider) {
      const id = (activeProvider && activeProvider.id) || "";
      // An unknown id (no provider loaded yet) is still Azure DevOps; a *known* provider with no
      // picker here is the case worth naming.
      unsupported = id && !PROVIDERS[id] ? (activeProvider && activeProvider.title) || id : "";
      provider = PROVIDERS[id] ? id : "ado";
      providerTitle = (activeProvider && activeProvider.title) || provider;
      // Cleared here rather than in render(), which must leave a load failure on screen.
      showError("");

      const title = $("tmsTargetTitle");
      // The Create and Update pages call this step "Manual Import into …" so that the heading
      // reads the same as the entry in the Steps list that opened it.
      const prefix = (cfg && cfg.titlePrefix) || "Import into";
      if (title) title.textContent = `${prefix} ${(activeProvider && activeProvider.title) || "Azure DevOps"}`;

      if (unsupported) {
        // Nothing to wire: every control is dead for this provider.
        render();
        return;
      }

      const primary = $("tmsTargetPrimary");
      if (primary) {
        // Populate on first interaction rather than on load: a cold provider call costs seconds
        // and the page is useful without it (the Jira link is what the user types first).
        const prewarm = () => loadPrimary(false);
        primary.addEventListener("mousedown", prewarm);
        primary.addEventListener("focus", prewarm);
        primary.addEventListener("keydown", prewarm);
        primary.addEventListener("change", () => selectPrimary(primary.value));
      }
      const secondary = $("tmsTargetSecondary");
      if (secondary) {
        secondary.addEventListener("change", () => {
          state.secondaryId = secondary.value;
          render();
        });
      }
      const reloadBtn = $("tmsTargetReloadBtn");
      if (reloadBtn) reloadBtn.addEventListener("click", () => loadPrimary(true));

      const inactive = $("tmsTargetIncludeInactive");
      if (inactive) {
        inactive.addEventListener("change", () => {
          state.includeInactive = inactive.checked;
          loadPrimary(true);
        });
      }

      // Visibility belongs to the page: the panel is step 2 and stays hidden on step 1.
      render();
    },

    /** @returns {{ planId: number, suiteId: number } | { sectionId: number } | { folderId: string } | { folderPath: string } | null} */
    value() {
      if (unsupported) return null;
      // A flat provider's id is a string — a Zephyr folder id, an Xray folder path — so it is
      // passed through as one rather than run through Number(), under the key that provider's
      // importer expects.
      if (isFlat()) {
        const key = (PROVIDERS[provider] || {}).flatKey || "folderId";
        return state.primaryId ? { [key]: String(state.primaryId) } : null;
      }
      if (!state.secondaryId) return null;
      return provider === "ado"
        ? { planId: Number(state.primaryId), suiteId: Number(state.secondaryId) }
        : { sectionId: Number(state.secondaryId) };
    },

    /** Human name of the chosen container, for the confirmation toast. */
    describe() {
      const chosen = chosenRow();
      return chosen ? chosen.path || chosen.suiteName : "";
    },

    /** What to tell the user when nothing is picked yet. */
    missingMessage() {
      if (unsupported) return missingForUnsupported();
      const labels = PROVIDERS[provider] || PROVIDERS.ado;
      return isFlat()
        ? `Pick a ${labels.primaryLabel} to import into`
        : `Pick a ${labels.primaryLabel} and a ${labels.secondaryLabel} to import into`;
    },
  };
})();
