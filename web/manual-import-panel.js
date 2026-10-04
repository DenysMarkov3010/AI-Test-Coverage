/**
 * "Manual Import into <provider>" — the step the Create and Update pages share.
 *
 * Everything else in the Steps list prints a command to run in a terminal. This one does the
 * work: pick the container, press Import.
 *
 * It is the Automate import step with one thing changed. Both take the approved CSV the review
 * panel produced — the newest one attached to the ticket in Jira Key; automate then files the
 * cases into the container matched from the Jira key, and this one files them into the container
 * picked below. So there is no file to browse for — the ticket says which CSV is current.
 *
 * The container picker is TmsTargetPanel, unchanged — it already knows all three providers:
 *
 *   Azure DevOps       Test Plan → Test Suite
 *   TestRail           Suite     → Section
 *   Zephyr Essential   Folder                  (one level: the project is a Setup setting)
 *
 * Both pages mount this against the same element ids, so the markup block is duplicated in
 * create.html and update.html and the behaviour lives here once.
 */
const ManualImportPanel = (() => {
  const $ = (id) => document.getElementById(id);

  let cfg = null;
  let provider = { id: "ado", title: "Azure DevOps" };
  let busy = false;
  let message = "";
  let messageKind = "";

  function setMessage(text, kind) {
    message = text || "";
    messageKind = kind || "";
    render();
  }

  function render() {
    const btn = $("manualImportBtn");
    const spinner = $("manualImportBusy");
    if (spinner) spinner.hidden = !busy;

    const target = TmsTargetPanel.value();
    const ready = !!projectPath() && !!jiraKey() && target !== null && !busy;
    if (btn) {
      // The label stays put while the spinner next to it does the talking. Swapping it too gave
      // two progress indicators saying different words for the same wait.
      btn.disabled = !ready;
    }

    const hint = $("manualImportHint");
    if (!hint) return;
    if (message) {
      hint.textContent = message;
      // Red for a failure, green for a finished import, muted for the standing hint — the three
      // things this one line has to say, told apart by colour rather than by reading it.
      hint.className = `run-hint${messageKind ? ` is-${messageKind}` : ""}`;
      return;
    }
    hint.className = "run-hint";
    if (!projectPath()) {
      hint.textContent = "Set the project path above — the import runs from that folder";
      return;
    }
    if (!jiraKey()) {
      hint.textContent = "Set the Jira key above — the approved CSV is built from that ticket";
      return;
    }
    const where = TmsTargetPanel.describe();
    hint.textContent = where
      ? `Builds the approved CSV for ${jiraKey()} and imports it into ${provider.title} → ${where}.`
      : TmsTargetPanel.missingMessage();
  }

  /** The ticket the approved CSV hangs off. Empty means there is nothing to import yet. */
  function jiraKey() {
    return (cfg.getJiraKey ? cfg.getJiraKey() : "") || "";
  }

  /** The AI Test Coverage folder the import runs in. Empty is asked for here, not posted. */
  function projectPath() {
    return (cfg.getProjectPath ? cfg.getProjectPath() : "") || "";
  }

  async function runImport() {
    const target = TmsTargetPanel.value();
    if (!projectPath() || !jiraKey() || !target || busy) return;

    busy = true;
    setMessage("", "");
    if (cfg.onBusy) cfg.onBusy(true);

    try {
      const res = await fetch(cfg.apiUrl("/__da/tms/import-csv"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectPath(),
          jiraIssueKey: jiraKey(),
          target,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setMessage(data.error || `Import failed (HTTP ${res.status})`, "err");
      } else {
        const n = (data.created || []).length;
        const problems = data.errors || [];
        const where = TmsTargetPanel.describe();
        // A count alone is not actionable: "9 failed" sent someone to the provider to guess
        // why. The first reason is quoted, because they are nearly always the same reason.
        const why = problems.length ? ` · ${problems.length} problem(s): ${problems[0]}` : "";
        setMessage(
          `${data.approvedCount || n} approved case(s) → ${n} created in ${data.providerTitle}${
            where ? ` → ${where}` : ""
          }${why}`,
          problems.length ? "err" : "ok"
        );
        if (cfg.toast) cfg.toast(`${n} case(s) imported into ${data.providerTitle}`);
      }
    } catch (e) {
      setMessage(e.message || "Network or server error", "err");
    }

    busy = false;
    if (cfg.onBusy) cfg.onBusy(false);
    render();
  }

  return {
    /**
     * @param {{ apiUrl: Function, getProjectPath: Function, getJiraKey?: Function,
     *           toast?: Function, onBusy?: Function }} options
     */
    configure(options) {
      cfg = options;
    },

    /** Call once the In use toggle is known — the picker's labels and endpoints depend on it. */
    mount(activeProvider) {
      provider = activeProvider || provider;
      TmsTargetPanel.configure({
        apiUrl: cfg.apiUrl,
        titlePrefix: "Manual Import into",
        // The hint names the chosen container, so it is repainted whenever that changes.
        onChange: render,
      });
      TmsTargetPanel.mount(provider);

      const btn = $("manualImportBtn");
      if (btn) btn.addEventListener("click", runImport);
      render();
    },

    /** Visibility belongs to the page: this is one entry in the Steps list, not a fixed panel. */
    setVisible(on) {
      const panel = $("manualImportPanel");
      if (panel) panel.hidden = !on;
      if (on) render();
    },

    /** The label for this provider's entry in the Steps list. */
    stepLabel() {
      return `Manual Import into ${provider.title}`;
    },
  };
})();
