/**
 * Command builder + Run (Day 1 / Day 2) — FULL_FLOW_GUIDE.md
 */

const $ = (id) => document.getElementById(id);

const PATH_PLACEHOLDER = "PATH_TO_PROJECT";

/** Optional UI-side guard. Real validation runs on the server too. */
const FIGMA_URL_RE = /^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i;
function isFigmaUrlOk(s) {
  const v = String(s || "").trim();
  return v === "" || FIGMA_URL_RE.test(v);
}

/**
 * The prototype link is any http(s) URL — unlike Figma there is no host to check, because the
 * whole point is that it can be Netlify, Vercel, a Lovable preview or a colleague's laptop.
 */
const PROTOTYPE_URL_RE = /^https?:\/\/\S+$/i;
function isPrototypeUrlOk(s) {
  const v = String(s || "").trim();
  return v === "" || PROTOTYPE_URL_RE.test(v);
}

/**
 * Setup → Azure DevOps → "Read prototype". The field below stays hidden (and its value unused)
 * until the server says the switch is Yes; Create only reads it, the way it only reads the
 * provider toggle.
 */
let prototypeReadEnabled = false;

/** API lives on the same machine as web-ui-server.js; Cursor / webview may use a different page origin than the API. */
function apiOrigin() {
  const m = document.querySelector('meta[name="ai-test-coverage-api-origin"]');
  const raw = (m && m.getAttribute("content")) || "";
  if (raw && !raw.includes("__AI_TEST_COVERAGE_API_ORIGIN__")) {
    return raw.replace(/\/$/, "");
  }
  if (location.protocol === "http:" || location.protocol === "https:") {
    return `${location.protocol}//${location.host}`;
  }
  return "http://127.0.0.1:3847";
}

function apiUrl(path) {
  const base = apiOrigin();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/** Resolves the effective TEST_CASES_LIMIT value, expanding the "custom" option into its number input. */
function testCasesLimitValue() {
  const limitEl = $("testCasesLimit");
  const raw = (limitEl && limitEl.value) || "10";
  if (raw !== "custom") return raw;
  const customEl = $("testCasesLimitCustom");
  const customRaw = (customEl && customEl.value || "").trim();
  const n = parseInt(customRaw, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : "10";
}

/**
 * Test design format — "standard" (steps and expected results) or "bdd" (Gherkin).
 *
 * Independent of which test management system is in use: a scenario reaches
 * Azure DevOps and TestRail through the same approved CSV as a standard case,
 * with the Given/When/Then keywords carried inside the step text. So the toggle
 * is offered for every provider, not just Azure DevOps.
 */
let testFormat = "standard";

/**
 * Has the context panel been wired for the provider In use? It waits for the In use toggle,
 * because what it browses (plans, suites, sections, folders) depends on it — and render() needs
 * to know per step, so the answer is kept rather than applied once.
 */
let contextPanelReady = false;

function vals() {
  const rawJira = ($("jiraKey").value || "").trim();
  const figmaEl = $("figmaUrl");
  const prototypeEl = $("prototypeUrl");
  const analyzeEl = $("analyzeTestCases");
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraKey: rawJira || "PROJ-123",
    relatedKeywords: ($("relatedKeywords").value || "").trim(),
    // BDD output is a Feature made of Scenarios, which is the test-case shape —
    // a "BDD checklist" is not a thing, so the format decides the mode.
    generateMode: testFormat === "bdd" ? "testcases" : $("generateMode").value,
    testFormat,
    relatedJiraSearch: $("relatedJiraSearch").value,
    analyzeTestCases: (analyzeEl && analyzeEl.value) || "yes",
    testCasesLimit: testCasesLimitValue(),
    figmaUrl: (figmaEl && figmaEl.value || "").trim(),
    prototypeUrl: prototypeReadEnabled ? (prototypeEl && prototypeEl.value || "").trim() : "",
  };
}

/** Paint the segmented control and keep Generation mode consistent with it. */
function applyTestFormat(next) {
  testFormat = next === "bdd" ? "bdd" : "standard";
  const isBdd = testFormat === "bdd";

  for (const id of ["testFormatStandard", "testFormatBdd"]) {
    const btn = $(id);
    if (!btn) continue;
    const active = btn.getAttribute("data-format") === testFormat;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }

  // Checklist has no BDD counterpart, so the select is pinned rather than left
  // showing a choice that the run would silently override.
  const modeSel = $("generateMode");
  if (modeSel) {
    if (isBdd) {
      if (modeSel.value !== "testcases") modeSel.dataset.preBddValue = modeSel.value;
      modeSel.value = "testcases";
      modeSel.disabled = true;
    } else {
      modeSel.disabled = false;
      if (modeSel.dataset.preBddValue) {
        modeSel.value = modeSel.dataset.preBddValue;
        delete modeSel.dataset.preBddValue;
      }
    }
  }

  const hint = $("testFormatHint");
  if (hint) {
    hint.textContent = isBdd
      ? `Gherkin scenarios (Given / When / Then), one Scenario per test case — imported into ${TmsProvider.get().title} like any other test design.`
      : "Steps with Step Action and Step Expected — the current format.";
  }

  // The cap counts scenarios in BDD; say so rather than leave "test cases".
  const limitLabel = $("testCasesLimitLabel");
  if (limitLabel) limitLabel.textContent = isBdd ? "Scenarios limit" : "Test cases limit";
  const limitCustom = $("testCasesLimitCustom");
  if (limitCustom) {
    limitCustom.placeholder = isBdd ? "Enter number of scenarios" : "Enter number of test cases";
  }

  render();
}

/** Jira key for POST /run-* — every run targets exactly one ticket. */
function jiraKeyForApi() {
  return ($("jiraKey").value || "").trim();
}

function escPs(s) {
  return String(s).replace(/`/g, "``").replace(/"/g, '`"');
}

function bashSq(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function cdBash(v) {
  return v.projectPath === PATH_PLACEHOLDER ? "cd /path/to/ai-test-coverage" : `cd ${bashSq(v.projectPath)}`;
}

function cdPs(v) {
  if (v.projectPath === PATH_PLACEHOLDER) return `cd ${PATH_PLACEHOLDER}`;
  const p = String(v.projectPath).replace(/'/g, "''");
  return `cd '${p}'`;
}

function buildDay1(v) {
  const figmaOk = isFigmaUrlOk(v.figmaUrl);
  const figmaForCmd = figmaOk ? v.figmaUrl : "";
  const protoForCmd = isPrototypeUrlOk(v.prototypeUrl) ? v.prototypeUrl : "";

  const disableRelated = v.relatedJiraSearch === "no";
  // The UI owns this switch (no Setup default any more), so it is always explicit.
  const analyzeEnv = v.analyzeTestCases === "no" ? "false" : "true";
  // Only include TEST_CASES_LIMIT in the printed command when it differs from the default ("10")
  // and only for testcases mode (the env var is ignored otherwise).
  const customLimit =
    v.generateMode === "testcases" && v.testCasesLimit && v.testCasesLimit !== "10"
      ? v.testCasesLimit
      : null;

  const envBash = [
    `JIRA_ISSUE_KEY=${bashSq(v.jiraKey)}`,
    "CHECK_APPROVAL=false",
    v.generateMode === "testcases" ? "GENERATE_MODE=testcases" : null,
    v.testFormat === "bdd" ? "TEST_DESIGN_FORMAT=bdd" : null,
    customLimit ? `TEST_CASES_LIMIT=${bashSq(customLimit)}` : null,
    v.relatedKeywords ? `RELATED_ISSUES_KEYWORDS=${bashSq(v.relatedKeywords)}` : null,
    disableRelated ? "ENABLE_RELATED_ISSUES_SEARCH=false" : null,
    `ENABLE_TEST_CASES_ANALYSIS=${analyzeEnv}`,
    figmaForCmd ? `FIGMA_URL=${bashSq(figmaForCmd)}` : null,
    protoForCmd ? `PROTOTYPE_URL=${bashSq(protoForCmd)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const kwPs = v.relatedKeywords ? `\n$env:RELATED_ISSUES_KEYWORDS="${escPs(v.relatedKeywords)}"` : "";
  const genPs = v.generateMode === "testcases" ? `\n$env:GENERATE_MODE="testcases"` : "";
  const fmtPs = v.testFormat === "bdd" ? `\n$env:TEST_DESIGN_FORMAT="bdd"` : "";
  const limitPs = customLimit ? `\n$env:TEST_CASES_LIMIT="${escPs(customLimit)}"` : "";
  const relatedPs = disableRelated ? `\n$env:ENABLE_RELATED_ISSUES_SEARCH="false"` : "";
  const analyzePs = `\n$env:ENABLE_TEST_CASES_ANALYSIS="${analyzeEnv}"`;
  const figmaPs = figmaForCmd ? `\n$env:FIGMA_URL="${escPs(figmaForCmd)}"` : "";
  const protoPs = protoForCmd ? `\n$env:PROTOTYPE_URL="${escPs(protoForCmd)}"` : "";

  return {
    title: "Step 1 — Single Jira ticket",
    bash: `${cdBash(v)}\n${envBash} node agent-docs.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="false"${genPs}${fmtPs}${limitPs}${kwPs}${relatedPs}${analyzePs}${figmaPs}${protoPs}\nnode agent-docs.js`,
  };
}

function buildDay2(v) {
  return {
    title: "Step 2 — Single Jira ticket",
    bash: `${cdBash(v)}\nJIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=true node agent-docs.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="true"\nnode agent-docs.js`,
    note: "Imports the approved CSV attached to the ticket. Output folder: CHECKLIST_OUTPUT_DIR.",
  };
}

/**
 * Name the import destination, and drop what does not apply to it.
 *
 * Runs once, after the In use toggle is known. Everything it touches ships
 * hidden or labelled for Azure DevOps, so a failed lookup leaves the page as it
 * was rather than blank.
 *
 * @param {{ id: string, title: string }} provider
 */
function applyActiveProvider(provider) {
  const isAdo = provider.id === "ado";

  const importOpt = $("stepImportOpt");
  if (importOpt) importOpt.textContent = `Automate import into ${provider.title}`;

  const ctxTitle = $("adoCtxTitle");
  if (ctxTitle) ctxTitle.textContent = `Add context from ${provider.title} (optional)`;

  // Every provider browses the same way — ADO plans and suites, TestRail suites and sections,
  // Zephyr and Xray folders — so the panel is wired for whichever one is In use. Which step it
  // belongs to is render()'s call — context is an input to generation and to nothing else.
  AdoContextPanel.configure({
    apiUrl,
    getProjectPath: () => vals().projectPath,
    toast: showToast,
    provider,
  });
  AdoContextPanel.wire();
  contextPanelReady = true;

  // Export by tag is a WIQL query. TestRail has no tags at all — `refs` is the
  // nearest thing — so the field would be a dead end there.
  const tagFields = $("adoExportTagFields");
  if (tagFields) tagFields.hidden = !isAdo;

  // The in-page import works for every provider — only the
  // container it asks for changes. Name it after whichever one is In use.
  const manualUiOpt = $("stepManualImportUiOpt");
  if (manualUiOpt) manualUiOpt.textContent = `Manual Import into ${provider.title}`;
  ManualImportPanel.configure({
    apiUrl,
    // Both read the raw fields rather than vals(): that one substitutes a placeholder for each
    // when it is empty, and posting "PATH_TO_PROJECT" or a sample ticket key is not a thing
    // to do quietly — the server can only answer that some path is not a directory.
    getProjectPath: () => ($("projectPath").value || "").trim(),
    getJiraKey: jiraKeyForApi,
    toast: showToast,
  });
  ManualImportPanel.mount(provider);

  // The BDD hint names the destination, so re-run it now that the title is known.
  // Re-applying the current value also renders, which is what this used to do.
  applyTestFormat(testFormat);
}

function render() {
  const v = vals();
  const section = $("mainSection").value;

  let block;
  switch (section) {
    case "2":
      block = buildDay1(v);
      break;
    case "4":
      block = buildDay2(v);
      break;
    default:
      block = buildDay1(v);
  }

  $("outTitle").textContent = block.title;
  $("bashOut").textContent = block.bash;
  $("psOut").textContent = block.ps;
  $("extraNote").textContent = block.note || "";
  $("extraNote").hidden = !block.note;

  $("bashBlock").hidden = false;
  $("psBlock").hidden = false;

  $("relatedJiraRow").hidden = section !== "2";
  const analyzeRow = $("analyzeRow");
  if (analyzeRow) analyzeRow.hidden = section !== "2";
  $("figmaUrlRow").hidden = section !== "2";
  $("prototypeUrlRow").hidden = !prototypeReadEnabled || section !== "2";
  $("pathRow").hidden = false;
  // Every run targets one ticket, so the Jira key is needed for both steps.
  // Step 6 stamps the key onto every imported case, so it needs the field too.
  $("jiraRow").hidden = !(section === "2" || section === "4" || section === "6");
  $("keywordsRow").hidden = section !== "2";
  $("genModeRow").hidden = section !== "2";
  const formatRow = $("testFormatRow");
  if (formatRow) formatRow.hidden = section !== "2";

  // Test cases limit only applies to "Create new test design" -> Test cases mode,
  // which BDD always is (it caps scenarios there).
  const limitRow = $("testCasesLimitRow");
  if (limitRow) {
    limitRow.hidden = section !== "2" || v.generateMode !== "testcases";
    const customLimitEl = $("testCasesLimitCustom");
    if (customLimitEl) {
      customLimitEl.hidden = limitRow.hidden || $("testCasesLimit").value !== "custom";
    }
  }

  const adoExportRow = $("adoExportTagRow");
  if (adoExportRow) {
    const hideAdoExport = section !== "2";
    adoExportRow.hidden = hideAdoExport;
    if (hideAdoExport) {
      setAdoExportProgressState("idle");
    }
  }

  // Context feeds generation and nothing else, so it belongs to that one step —
  // on an import step it is a panel that changes nothing about what runs.
  const ctxPanel = $("adoCtxPanel");
  if (ctxPanel) ctxPanel.hidden = !(contextPanelReady && section === "2");

  // Step 6 does the import on this page instead of printing a command to paste,
  // so it hides the command blocks and shows its own panel in their place.
  const isManualImport = section === "6";
  ManualImportPanel.setVisible(isManualImport);
  // The whole command card goes, not just the two code blocks: this step runs the import itself,
  // so a card holding nothing but a heading is an empty promise of output that never arrives.
  const commandPanel = $("commandPanel");
  if (commandPanel) commandPanel.hidden = isManualImport;

  const showRun = section === "2" || section === "4";
  $("runRow").hidden = !showRun;
  $("runOutputWrap").hidden = !showRun;
  const titleEl = $("runOutputTitle");
  if (titleEl) {
    titleEl.textContent =
      section === "4"
        ? "Run log — Step 2 (live, same order as terminal)"
        : "Run log — Step 1 (live, same order as terminal)";
  }
  const pre1 = $("runOutputStep1");
  const pre2 = $("runOutputStep2");
  if (pre1 && pre2) {
    pre1.hidden = section !== "2";
    pre2.hidden = section !== "4";
  }
  const hint = $("runOutputHint");
  if (hint) {
    const logForHint = section === "4" ? pre2 : pre1;
    const hasLog = logForHint && (logForHint.textContent || "").trim().length > 0;
    hint.hidden = !showRun || hasLog;
    if (!hint.hidden) {
      hint.textContent =
        section === "4"
          ? 'Click "Run" to execute Step 2 on this PC. Logs stream here (stdout / stderr), same order as in the terminal.'
          : 'Click "Run" to execute on this PC. Logs appear here in real time (stdout / stderr), same order as in the terminal.';
    }
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  const figmaShown = section === "2";
  const figmaOk = !figmaShown || isFigmaUrlOk(v.figmaUrl);
  const figmaErr = $("figmaUrlErr");
  if (figmaErr) {
    if (!figmaShown || figmaOk) {
      figmaErr.hidden = true;
      figmaErr.textContent = "";
    } else {
      figmaErr.hidden = false;
      figmaErr.textContent = "Not a Figma URL. Expected https://www.figma.com/design/... or /file/... or /board/...";
    }
  }
  const protoShown = prototypeReadEnabled && section === "2";
  const protoOk = !protoShown || isPrototypeUrlOk(v.prototypeUrl);
  const protoErr = $("prototypeUrlErr");
  if (protoErr) {
    if (!protoShown || protoOk) {
      protoErr.hidden = true;
      protoErr.textContent = "";
    } else {
      protoErr.hidden = false;
      protoErr.textContent = "Not a link. Expected something like https://your-prototype.netlify.app/";
    }
  }
  $("runStepBtn").disabled = !pathOk || !figmaOk || !protoOk;
  $("runHint").style.opacity = pathOk ? "0.65" : "1";

  const adoExportBtn = $("adoExportTagBtn");
  if (adoExportBtn) {
    adoExportBtn.disabled = !pathOk || section !== "2";
  }
}

/* ── Generation context (Test cases folder) ─────────────────────────────── */

let lastTestCasesContext = null;
// Cross icon on the panel: stays hidden until a new export (or page reload) brings it back.
let contextDismissed = false;

function formatAge(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Effective analyze state for THIS run — the UI select owns it (default Yes). */
function effectiveAnalyzeState() {
  const sel = ($("analyzeTestCases") && $("analyzeTestCases").value) || "yes";
  return sel !== "no";
}

function renderTestCasesContext(data) {
  const wrap = $("testCasesContextWrap");
  const statusEl = $("testCasesContextStatus");
  const listEl = $("testCasesContextList");
  if (!wrap || !statusEl || !listEl) return;
  if (!data || contextDismissed) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  listEl.innerHTML = "";

  const files = data.files || [];
  const analyzeOn = effectiveAnalyzeState();

  if (files.length === 0) {
    statusEl.textContent =
      "Folder is empty — generation will use the Jira ticket only (no existing test case context).";
    return;
  }

  for (const f of files) {
    const li = document.createElement("li");
    const count = f.caseCount != null ? ` — ${f.caseCount} test case(s)` : "";
    li.textContent = `${f.name}${count} · ${formatSize(f.sizeBytes)} · updated ${formatAge(f.modifiedAt)}`;
    listEl.appendChild(li);
  }

  statusEl.textContent = analyzeOn
    ? "These files WILL be analyzed during generation (style + coverage alignment)."
    : "Analysis is OFF for this run — these files will NOT be used. Switch “Analyze existing test cases” to Yes to use them.";
}

async function loadTestCasesContext() {
  const v = vals();
  const wrap = $("testCasesContextWrap");
  if (!wrap) return;
  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    lastTestCasesContext = null;
    wrap.hidden = true;
    return;
  }
  try {
    const res = await fetch(apiUrl("/__da/test-cases-context"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: v.projectPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      lastTestCasesContext = null;
      wrap.hidden = true;
      return;
    }
    lastTestCasesContext = data;
    renderTestCasesContext(data);
  } catch {
    lastTestCasesContext = null;
    wrap.hidden = true;
  }
}

async function clearTestCasesFolder() {
  const v = vals();
  const errEl = $("testCasesContextErr");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  const files = (lastTestCasesContext && lastTestCasesContext.files) || [];
  if (files.length === 0) return;
  const ok = window.confirm(
    `Delete ${files.length} file(s) from the "Test cases" folder? Generation will stop using them as context.`
  );
  if (!ok) return;
  try {
    const res = await fetch(apiUrl("/__da/clear-test-cases"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: v.projectPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (errEl) {
        errEl.textContent = (data.errors && data.errors.join("; ")) || data.error || "Clear failed";
        errEl.hidden = false;
      }
    }
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Network error";
      errEl.hidden = false;
    }
  }
  await loadTestCasesContext();
}

/* ── Related issues preview ─────────────────────────────────────────────── */

async function previewRelatedIssues() {
  const v = vals();
  const btn = $("previewRelatedBtn");
  const wrap = $("relatedPreviewWrap");
  const summaryEl = $("relatedPreviewSummary");
  const listEl = $("relatedPreviewList");
  const errEl = $("relatedPreviewErr");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    if (errEl) {
      errEl.textContent = "Set a valid AI Test Coverage project path first";
      errEl.hidden = false;
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Searching…";
  }
  try {
    const res = await fetch(apiUrl("/__da/preview-related-issues"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: v.projectPath,
        jiraKey: jiraKeyForApi(),
        relatedKeywords: v.relatedKeywords,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (wrap) wrap.hidden = true;
      if (errEl) {
        errEl.textContent = data.error || res.statusText || "Preview failed";
        errEl.hidden = false;
      }
      return;
    }
    if (wrap && summaryEl && listEl) {
      wrap.hidden = false;
      listEl.innerHTML = "";
      const issues = data.issues || [];
      summaryEl.textContent = issues.length
        ? `Search by ${data.mode} (${(data.queryWords || []).join(", ")}) — ${issues.length} issue(s) will be used as context:`
        : `Search by ${data.mode} (${(data.queryWords || []).join(", ")}) — nothing found. Try different keywords.`;
      for (const issue of issues) {
        const li = document.createElement("li");
        const status = issue.status ? ` [${issue.status}]` : "";
        li.textContent = `${issue.key} — ${issue.summary}${status}`;
        listEl.appendChild(li);
      }
    }
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Network error";
      errEl.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Preview";
    }
  }
}

function setAdoExportProgressState(state) {
  const wrap = $("adoExportTagProgress");
  const okMsg = $("adoExportTagOk");
  if (okMsg) {
    okMsg.hidden = state !== "success";
  }
  if (!wrap) return;
  wrap.classList.remove("is-running", "is-success", "is-error");
  if (state === "running") {
    wrap.hidden = false;
    wrap.classList.add("is-running");
  } else if (state === "success") {
    wrap.hidden = false;
    wrap.classList.add("is-success");
  } else if (state === "error") {
    wrap.hidden = false;
    wrap.classList.add("is-error");
  } else {
    wrap.hidden = true;
  }
}

async function exportAdoTagCsv() {
  const v = vals();
  const tag = ($("adoExportTag").value || "").trim();
  const errEl = $("adoExportTagErr");
  const exportBtn = $("adoExportTagBtn");

  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }

  if (!tag) {
    if (errEl) {
      errEl.textContent = "Azure DevOps tag required (several: separate with commas)";
      errEl.hidden = false;
    }
    return;
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    if (errEl) {
      errEl.textContent = "Set a valid AI Test Coverage project path first";
      errEl.hidden = false;
    }
    return;
  }

  setAdoExportProgressState("running");
  if (exportBtn) exportBtn.disabled = true;

  try {
    const res = await fetch(apiUrl("/__da/run-ado-export-tag-csv"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: v.projectPath,
        tag,
        stream: true,
      }),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      const { ok, code, stderrLog } = await readNdjsonStream(res, null);
      if (ok && code === 0) {
        setAdoExportProgressState("success");
        $("toast").textContent = "Test cases added in Test cases folder";
        $("toast").hidden = false;
        setTimeout(() => {
          $("toast").hidden = true;
        }, 2200);
        // A fresh export is new context — bring the panel back even if it was dismissed.
        contextDismissed = false;
        loadTestCasesContext();
      } else if (code === 2) {
        setAdoExportProgressState("error");
        if (errEl) {
          errEl.textContent = tag.includes(",")
            ? "No test cases found for any of these tags in Azure DevOps."
            : "No test cases found for this tag in Azure DevOps.";
          errEl.hidden = false;
        }
      } else {
        setAdoExportProgressState("error");
        if (errEl) {
          const fromLog = compactToolOutputForUi(stderrLog);
          errEl.textContent =
            fromLog ||
            "Export failed. Check .env in the AI Test Coverage folder (ADO_ORG, ADO_PROJECT, ADO_PAT, optional ADO_SERVER_URL) and PAT permissions.";
          errEl.hidden = false;
        }
      }
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      setAdoExportProgressState("error");
      if (errEl) {
        errEl.textContent = data.error || data.detail || res.statusText || "Request failed";
        errEl.hidden = false;
      }
    }
  } catch (e) {
    setAdoExportProgressState("error");
    if (errEl) {
      errEl.textContent = e.message || "Network error";
      errEl.hidden = false;
    }
  }

  render();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    $("toast").textContent = "Copied";
    $("toast").hidden = false;
    setTimeout(() => {
      $("toast").hidden = true;
    }, 1600);
  } catch {
    $("toast").textContent = "Copy failed";
    $("toast").hidden = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Two-phase pick + .json aliases — Cursor often 404s arbitrary paths; OS dialog runs async so /status can poll. */
const PICK_FOLDER_ROUTES = [
  {
    start: "/__da/folder-pick/start",
    status: (jobId) => `/__da/folder-pick/status?jobId=${encodeURIComponent(jobId)}`,
  },
  {
    start: "/web/folder-pick-start.json",
    status: (jobId) => `/web/folder-pick-status.json?jobId=${encodeURIComponent(jobId)}`,
  },
];

async function pickFolder() {
  $("toast").hidden = true;
  let routes = null;
  let startRes = null;
  try {
    for (const r of PICK_FOLDER_ROUTES) {
      try {
        const res = await fetch(apiUrl(r.start), { method: "GET" });
        if (res.ok) {
          routes = r;
          startRes = res;
          break;
        }
      } catch {
        /* try next alias */
      }
    }

    if (!routes || !startRes) {
      const b = $("cursorBrowserBanner");
      if (b) b.hidden = false;
      return;
    }

    const data = await startRes.json();
    const jobId = data.jobId;
    if (!jobId) {
      return;
    }

    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(280);
      let stRes;
      try {
        stRes = await fetch(apiUrl(routes.status(jobId)), { method: "GET" });
      } catch {
        continue;
      }
      let st = {};
      try {
        st = await stRes.json();
      } catch {
        continue;
      }
      if (st.pending) continue;
      if (st.path) {
        $("projectPath").value = st.path;
        render();
        loadTestCasesContext();
        return;
      }
      if (st.cancelled) {
        return;
      }
      if (st.error) {
        return;
      }
      break;
    }
  } catch {
    /* no toast — Browse folder stays quiet */
  }
}

function clearRunOutput(pre) {
  if (!pre) return;
  pre.textContent = "";
  pre.innerHTML = "";
}

function scrollRunOutputToBottom(pre) {
  if (!pre) return;
  pre.scrollTop = pre.scrollHeight;
}

/** Safe append: stderr gets a distinct style (terminal-like). */
function appendRunChunk(pre, stream, text) {
  if (!pre) return;
  if (stream === "stderr") {
    const span = document.createElement("span");
    span.className = "run-chunk-stderr";
    span.textContent = text;
    pre.appendChild(span);
  } else {
    pre.appendChild(document.createTextNode(text));
  }
  scrollRunOutputToBottom(pre);
}

function appendRunStage(pre, label, detail) {
  if (!pre) return;
  const s = document.createElement("span");
  s.className = "run-stage";
  s.textContent = detail ? `${label} — ${detail}` : label;
  pre.appendChild(s);
  pre.appendChild(document.createTextNode("\n"));
  scrollRunOutputToBottom(pre);
}

function compactToolOutputForUi(s) {
  if (!s || typeof s !== "string") return "";
  const t = s
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 480 ? `${t.slice(0, 477)}…` : t;
}

/**
 * Live "Running… 42s" next to the run log title.
 * The backend now ticks while the model is thinking, but a clock in the UI also covers the gaps
 * before the first line arrives (spawning node, fetching the Jira issue).
 */
let runClockTimer = null;
function startRunClock(label) {
  stopRunClock();
  const titleEl = $("runOutputTitle");
  if (!titleEl) return;
  const base = titleEl.dataset.baseTitle || titleEl.textContent;
  titleEl.dataset.baseTitle = base;
  const startedAt = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    titleEl.textContent = `${base} — ${label} ${s}s`;
  };
  tick();
  runClockTimer = setInterval(tick, 1000);
}

function stopRunClock() {
  if (runClockTimer) {
    clearInterval(runClockTimer);
    runClockTimer = null;
  }
  const titleEl = $("runOutputTitle");
  if (titleEl && titleEl.dataset.baseTitle) titleEl.textContent = titleEl.dataset.baseTitle;
}

/** Brief confirmation pill in the corner. */
function showToast(text, ms = 2400) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, ms);
}

async function readNdjsonStream(res, pre) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastOk = false;
  let lastCode = null;
  let stderrLog = "";
  const STDERR_CAP = 12000;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === "stage") {
        appendRunStage(pre, msg.label || "Stage", msg.detail || "");
      } else if (msg.event === "stdout") {
        appendRunChunk(pre, "stdout", msg.text || "");
      } else if (msg.event === "stderr") {
        const chunk = msg.text || "";
        appendRunChunk(pre, "stderr", chunk);
        stderrLog += chunk;
        if (stderrLog.length > STDERR_CAP) stderrLog = stderrLog.slice(-STDERR_CAP);
      } else if (msg.event === "review") {
        // Generation finished without touching Jira — hand the payload to the review panel.
        ReviewPanel.accept(msg);
      } else if (msg.event === "end") {
        lastOk = !!msg.ok;
        lastCode = typeof msg.code === "number" ? msg.code : lastOk ? 0 : 1;
        if (pre) {
          appendRunChunk(
            pre,
            "stdout",
            `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`
          );
        }
      }
    }
  }
  const code = lastCode !== null ? lastCode : lastOk ? 0 : -1;
  return { ok: lastOk, code, stderrLog: stderrLog.trim() };
}

async function runStep() {
  const v = vals();
  const section = $("mainSection").value;
  const isDay1 = section === "2";
  const isDay2 = section === "4";
  if (!isDay1 && !isDay2) return;

  $("runStepBtn").disabled = true;
  $("runOutputWrap").hidden = false;
  const hint = $("runOutputHint");
  if (hint) hint.hidden = true;
  const logPre = isDay1 ? $("runOutputStep1") : $("runOutputStep2");
  clearRunOutput(logPre);
  appendRunChunk(logPre, "stdout", "Connecting to local API…\n");
  startRunClock("running");

  // Day 1 generates for in-UI review; the comment is posted later by the Submit button.
  const url = isDay1 ? "/__da/review/generate" : "/__da/run-day2";
  if (isDay1) ReviewPanel.reset();
  // testCasesLimit only applies in testcases mode; the server ignores it otherwise.
  const limitForApi = v.generateMode === "testcases" ? v.testCasesLimit : "";
  const figmaForApi = isDay1 && isFigmaUrlOk(v.figmaUrl) ? v.figmaUrl : "";
  const protoForApi = isDay1 && isPrototypeUrlOk(v.prototypeUrl) ? v.prototypeUrl : "";
  const body = isDay1
    ? {
        projectPath: v.projectPath,
        jiraKey: jiraKeyForApi(),
        relatedKeywords: v.relatedKeywords,
        generateMode: v.generateMode,
        testFormat: v.testFormat,
        relatedJiraSearch: v.relatedJiraSearch,
        analyzeTestCases: v.analyzeTestCases,
        testCasesLimit: limitForApi,
        figmaUrl: figmaForApi,
        prototypeUrl: protoForApi,
        stream: true,
      }
    : {
        projectPath: v.projectPath,
        jiraKey: jiraKeyForApi(),
        stream: true,
      };

  try {
    const res = await fetch(apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput(logPre);
      const { ok } = await readNdjsonStream(res, logPre);
      $("toast").textContent = ok ? "Done" : "Finished with errors";
      $("toast").hidden = false;
      setTimeout(() => {
        $("toast").hidden = true;
      }, 2000);
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      clearRunOutput(logPre);
      if (!res.ok) {
        const hint = ReviewPanel.staleServerHint(res.status);
        appendRunChunk(
          logPre,
          "stdout",
          `Error: ${data.error || data.detail || res.statusText}\n${hint ? `${hint}\n` : ""}`
        );
      } else {
        const parts = [];
        parts.push(`Exit code: ${data.code}`);
        if (data.stdout) parts.push("--- stdout ---\n" + data.stdout);
        if (data.stderr) parts.push("--- stderr ---\n" + data.stderr);
        appendRunChunk(logPre, "stdout", parts.join("\n\n") || "(no output)\n");
        $("toast").textContent = data.ok ? "Done" : "Finished with errors";
        $("toast").hidden = false;
        setTimeout(() => {
          $("toast").hidden = true;
        }, 2000);
      }
    }
  } catch (e) {
    clearRunOutput(logPre);
    appendRunChunk(logPre, "stdout", `Network / server: ${e.message}\n`);
  }

  stopRunClock();
  render();
}

function wire() {
  [
    "mainSection",
    "generateMode",
    "testCasesLimit",
    "testCasesLimitCustom",
    "relatedJiraSearch",
    "analyzeTestCases",
    "projectPath",
    "jiraKey",
    "relatedKeywords",
    "figmaUrl",
    "prototypeUrl",
  ].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", render);
      el.addEventListener("change", render);
    }
  });

  for (const id of ["testFormatStandard", "testFormatBdd"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", () => applyTestFormat(btn.getAttribute("data-format")));
  }

  $("pickProjectBtn").addEventListener("click", pickFolder);
  $("runStepBtn").addEventListener("click", runStep);
  ReviewPanel.configure({
    apiUrl,
    getProjectPath: () => vals().projectPath,
    appendLog: (text) => appendRunChunk($("runOutputStep1"), "stdout", text),
    toast: showToast,
  });
  ReviewPanel.wire();

  // Several labels name the import destination and two blocks only apply to
  // Azure DevOps, so both wait for the In use toggle instead of assuming it.
  TmsProvider.load(apiUrl).then(applyActiveProvider);

  // The context banner reflects the per-run analyze choice without refetching.
  const analyzeSel = $("analyzeTestCases");
  if (analyzeSel) {
    analyzeSel.addEventListener("change", () => renderTestCasesContext(lastTestCasesContext));
  }
  const projectPathEl = $("projectPath");
  if (projectPathEl) {
    projectPathEl.addEventListener("change", loadTestCasesContext);
  }
  const previewBtn = $("previewRelatedBtn");
  if (previewBtn) previewBtn.addEventListener("click", previewRelatedIssues);
  const ctxRefreshBtn = $("contextRefreshBtn");
  if (ctxRefreshBtn) ctxRefreshBtn.addEventListener("click", loadTestCasesContext);
  const ctxClearBtn = $("contextClearBtn");
  if (ctxClearBtn) ctxClearBtn.addEventListener("click", clearTestCasesFolder);
  const ctxCloseBtn = $("contextCloseBtn");
  if (ctxCloseBtn) {
    ctxCloseBtn.addEventListener("click", () => {
      contextDismissed = true;
      const wrap = $("testCasesContextWrap");
      if (wrap) wrap.hidden = true;
    });
  }

  const adoTagInput = $("adoExportTag");
  if (adoTagInput) {
    adoTagInput.addEventListener("input", () => {
      const errEl = $("adoExportTagErr");
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
      setAdoExportProgressState("idle");
    });
  }
  const adoExportBtn = $("adoExportTagBtn");
  if (adoExportBtn) {
    adoExportBtn.addEventListener("click", () => {
      exportAdoTagCsv();
    });
  }

  $("copyBash").addEventListener("click", () => copyText($("bashOut").textContent));
  $("copyPs").addEventListener("click", () => copyText($("psOut").textContent));

  const extBtn = $("openExternalBrowserBtn");
  if (extBtn) {
    extBtn.addEventListener("click", () => {
      window.open(location.href, "_blank", "noopener,noreferrer");
    });
  }

  fetch(apiUrl("/__da/prototype/enabled"))
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      prototypeReadEnabled = !!(body && body.enabled);
      render();
    })
    .catch(() => {
      // Switch unknown -> field stays hidden, which is the safe default: no crawl, no surprise.
    });

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok && $("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      if ($("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    });

  applyTestFormat(testFormat);
  loadTestCasesContext();
}

document.addEventListener("DOMContentLoaded", wire);
