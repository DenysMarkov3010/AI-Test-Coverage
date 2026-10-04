/**
 * Update test design flow — UPDATED_CSV_FLOW.md (agent-update-csv.js)
 */

const $ = (id) => document.getElementById(id);

const PATH_PLACEHOLDER = "PATH_TO_PROJECT";

const FIGMA_URL_RE = /^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i;
function isFigmaUrlOk(s) {
  const v = String(s || "").trim();
  return v === "" || FIGMA_URL_RE.test(v);
}

/** Any http(s) link: a prototype can be hosted anywhere. See web/app.js for the same pair. */
const PROTOTYPE_URL_RE = /^https?:\/\/\S+$/i;
function isPrototypeUrlOk(s) {
  const v = String(s || "").trim();
  return v === "" || PROTOTYPE_URL_RE.test(v);
}

/** Setup → Azure DevOps → "Read prototype"; read once on load, never written from this page. */
let prototypeReadEnabled = false;

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

/** null = not checked yet; 'found' | 'notfound' after Add */
let csvLookupResult = null;
let csvLookupErrorText = "";
/** What the success line says; empty = its default "CSV added to Updated test cases". */
let csvLookupOkText = "";
/** Providers whose picked cases "Use selected as CSV" can read back (tms-export-csv.js). */
const CSV_LOADABLE_PROVIDERS = new Set(["zephyr", "xray"]);

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
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraKey: rawJira || "PROJ-123",
    generateMode: $("generateMode").value,
    updatedFlowInputFile: ($("updatedFlowInputFile").value || "").trim(),
    figmaUrl: (figmaEl && figmaEl.value || "").trim(),
    prototypeUrl: prototypeReadEnabled ? (prototypeEl && prototypeEl.value || "").trim() : "",
  };
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

function buildUpdateStep1(v) {
  const mode = v.generateMode;
  const file = v.updatedFlowInputFile;
  const fileBash = `UPDATED_FLOW_INPUT_FILE=${bashSq(file || "your-file.csv")} `;
  const filePs = `$env:UPDATED_FLOW_INPUT_FILE="${escPs(file || "your-file.csv")}"\n`;
  const figmaForCmd = isFigmaUrlOk(v.figmaUrl) ? v.figmaUrl : "";
  const figmaBash = figmaForCmd ? `FIGMA_URL=${bashSq(figmaForCmd)} ` : "";
  const figmaPs = figmaForCmd ? `$env:FIGMA_URL="${escPs(figmaForCmd)}"\n` : "";
  const protoForCmd = isPrototypeUrlOk(v.prototypeUrl) ? v.prototypeUrl : "";
  const protoBash = protoForCmd ? `PROTOTYPE_URL=${bashSq(protoForCmd)} ` : "";
  const protoPs = protoForCmd ? `$env:PROTOTYPE_URL="${escPs(protoForCmd)}"\n` : "";
  return {
    title: "Updated flow — Step 1 (post to Jira)",
    bash: `${cdBash(v)}\n${figmaBash}${protoBash}JIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=false ${fileBash}UPDATED_FLOW_MODE=${bashSq(mode)} node agent-update-csv.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="false"\n${filePs}$env:UPDATED_FLOW_MODE="${escPs(mode)}"\n${figmaPs}${protoPs}node agent-update-csv.js`,
    note: "CSV file name is required. Use Add to copy the file from Downloads into the project folder Updated test cases, then Run.",
  };
}

function buildUpdateStep2(v) {
  return {
    title: `Updated flow — Step 2 (approval CSV + optional ${TmsProvider.get().title})`,
    bash: `${cdBash(v)}\nJIRA_ISSUE_KEY=${bashSq(v.jiraKey)} CHECK_APPROVAL=true node agent-update-csv.js`,
    ps: `${cdPs(v)}\n$env:JIRA_ISSUE_KEY="${escPs(v.jiraKey)}"\n$env:CHECK_APPROVAL="true"\nnode agent-update-csv.js`,
    note: "Same approval rules as Create flow; extra copy may be named with parent summary. See UPDATED_CSV_FLOW.md.",
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
    // Only where the old cases can be read back into a CSV; elsewhere the panel stays context-only.
    useAsCsv: CSV_LOADABLE_PROVIDERS.has(provider.id) ? usePickedCasesAsCsv : undefined,
  });
  AdoContextPanel.wire();
  contextPanelReady = true;

  // The in-page import works for every provider — only the container it asks
  // for changes. Name it after whichever one is In use.
  const manualUiOpt = $("stepManualImportUiOpt");
  if (manualUiOpt) manualUiOpt.textContent = `Manual Import into ${provider.title}`;
  ManualImportPanel.configure({
    apiUrl,
    // Both read the raw fields rather than vals(): that one substitutes a placeholder for each
    // when it is empty, and posting "PATH_TO_PROJECT" or a sample ticket key is not a thing
    // to do quietly — the server can only answer that some path is not a directory.
    getProjectPath: () => ($("projectPath").value || "").trim(),
    getJiraKey: () => ($("jiraKey").value || "").trim(),
    toast: showToast,
  });
  ManualImportPanel.mount(provider);

  render();
}

function render() {
  const v = vals();
  const section = $("mainSection").value;

  const block = section === "4" ? buildUpdateStep2(v) : buildUpdateStep1(v);
  $("outTitle").textContent = block.title;
  $("bashOut").textContent = block.bash;
  $("psOut").textContent = block.ps;
  $("extraNote").textContent = block.note || "";
  $("extraNote").hidden = !block.note;

  // Context feeds generation and nothing else, so it belongs to that one step —
  // on an import step it is a panel that changes nothing about what runs.
  const ctxPanel = $("adoCtxPanel");
  if (ctxPanel) ctxPanel.hidden = !(contextPanelReady && section === "2");

  // Step 6 does the import on this page instead of printing a command to paste. The CSV row
  // above goes with it: this step takes the approved CSV off the ticket, so a file field would be
  // a second answer to a question that has one.
  const isManualImport = section === "6";
  ManualImportPanel.setVisible(isManualImport);
  // The whole command card goes, not just the two code blocks: this step runs the import itself,
  // so a card holding nothing but a heading is an empty promise of output that never arrives.
  const commandPanel = $("commandPanel");
  if (commandPanel) commandPanel.hidden = isManualImport;

  $("genModeRow").hidden = section === "4" || isManualImport;
  $("csvFileRow").hidden = section === "4" || isManualImport;
  $("figmaUrlRow").hidden = section !== "2";
  $("prototypeUrlRow").hidden = !prototypeReadEnabled || section !== "2";

  const okEl = $("csvDownloadsOk");
  const errEl = $("csvDownloadsErr");
  if (okEl && errEl) {
    // Both report on the CSV row, so they follow it out of sight on the steps that hide it.
    if (section === "4" || isManualImport) {
      okEl.hidden = true;
      errEl.hidden = true;
    } else {
      okEl.hidden = csvLookupResult !== "found";
      errEl.hidden = csvLookupResult !== "notfound";
      const okText = okEl.querySelector(".csv-lookup-ok-text");
      if (okText) okText.textContent = csvLookupOkText || "CSV added to Updated test cases";
      if (!errEl.hidden) {
        errEl.textContent = csvLookupErrorText || "Not found";
      }
    }
  }

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
          : 'Click "Run" to execute Step 1 on this PC. Logs stream here (stdout / stderr), same order as in the terminal.';
    }
  }

  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  const jiraOk = ($("jiraKey").value || "").trim().length > 0;
  const csvName = ($("updatedFlowInputFile").value || "").trim();
  const csvOk =
    section === "4" || (csvName.length > 0 && csvLookupResult === "found");
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
  $("runStepBtn").disabled = !pathOk || !jiraOk || !csvOk || !figmaOk || !protoOk;
  $("runHint").style.opacity = pathOk ? "0.65" : "1";

}

function resetCsvLookup() {
  csvLookupResult = null;
  csvLookupErrorText = "";
  csvLookupOkText = "";
}

/**
 * The other way to fill the CSV field: the cases ticked in the Zephyr Essential / Xray tree of the
 * context panel are written into "Updated test cases" as the CSV this flow reads — replacing
 * whatever CSV was there, like Browse. The Jira key above is the ticket with the *new*
 * requirements; the old cases can come from any folder, which is why they are picked, not matched.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>} for the panel to show next to its buttons
 */
async function usePickedCasesAsCsv(picks) {
  const projectPath = ($("projectPath").value || "").trim();
  resetCsvLookup();
  render();

  let result;
  try {
    const res = await fetch(apiUrl("/__da/tms/picked-to-updated-csv"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, picks }),
    });
    const data = await res.json().catch(() => ({}));
    result = res.ok && data.ok ? data : { ok: false, error: data.error || "Could not build the CSV" };
  } catch {
    result = { ok: false, error: "Network or server error" };
  }

  if (result.ok) {
    $("updatedFlowInputFile").value = result.fileName || "";
    csvLookupResult = "found";
    csvLookupOkText = result.summary || "";
    showToast("Picked cases are now the CSV to update");
  } else {
    csvLookupResult = "notfound";
    csvLookupErrorText = result.error;
  }
  render();
  return result;
}

/**
 * Opens the OS file dialog, then copies the chosen CSV into the project's
 * "Updated test cases" folder — the same copy step the old "Add" button did,
 * except the file can now live anywhere, not just in Downloads.
 */
async function pickCsvFile() {
  const v = vals();
  const pathOk = v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
  if (!pathOk) {
    csvLookupResult = "notfound";
    csvLookupErrorText = "Set a valid AI Test Coverage project path first";
    render();
    return;
  }

  const btn = $("csvBrowseBtn");
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Choosing…";
  }
  resetCsvLookup();
  render();

  const restore = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  let sourcePath = "";
  try {
    const startRes = await fetch(apiUrl("/__da/file-pick/start"), { method: "GET" });
    if (!startRes.ok) throw new Error("picker unavailable");
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error("picker unavailable");

    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(280);
      let st = {};
      try {
        const stRes = await fetch(apiUrl(`/__da/file-pick/status?jobId=${encodeURIComponent(jobId)}`));
        st = await stRes.json();
      } catch {
        continue;
      }
      if (st.pending) continue;
      if (st.path) {
        sourcePath = st.path;
      } else if (st.error) {
        csvLookupResult = "notfound";
        csvLookupErrorText = `File picker failed: ${st.error}`;
      }
      break;
    }
  } catch {
    csvLookupResult = "notfound";
    csvLookupErrorText = "Could not open the file picker — is the local server still running?";
  }

  if (!sourcePath) {
    // Cancelled, or one of the errors above already set the message.
    restore();
    render();
    return;
  }

  try {
    const res = await fetch(apiUrl("/__da/add-csv-to-updated"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: v.projectPath, sourcePath }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      $("updatedFlowInputFile").value = data.fileName || "";
      csvLookupResult = "found";
      csvLookupErrorText = "";
    } else {
      csvLookupResult = "notfound";
      csvLookupErrorText = data.error || "Could not copy that file";
    }
  } catch {
    csvLookupResult = "notfound";
    csvLookupErrorText = "Network or server error";
  }

  restore();
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
    /* quiet */
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
        appendRunChunk(pre, "stderr", msg.text || "");
      } else if (msg.event === "review") {
        // Generation finished without touching Jira — hand the blocks to the review panel.
        ReviewPanel.accept(msg);
      } else if (msg.event === "end") {
        lastOk = !!msg.ok;
        appendRunChunk(pre, "stdout", `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`);
      }
    }
  }
  return lastOk;
}

async function runStep() {
  const v = vals();
  const section = $("mainSection").value;
  const isStep1 = section === "2";
  const isStep2 = section === "4";
  if (!isStep1 && !isStep2) return;

  $("runStepBtn").disabled = true;
  $("runOutputWrap").hidden = false;
  const hint = $("runOutputHint");
  if (hint) hint.hidden = true;
  const logPre = isStep1 ? $("runOutputStep1") : $("runOutputStep2");
  clearRunOutput(logPre);
  appendRunChunk(logPre, "stdout", "Connecting to local API…\n");
  startRunClock("running");

  const isUpdateDay1 = section === "2";
  const body = {
    projectPath: v.projectPath,
    jiraKey: ($("jiraKey").value || "").trim(),
    mainSection: section,
    updatedFlowMode: v.generateMode,
    updatedFlowInputFile: v.updatedFlowInputFile,
    figmaUrl: isUpdateDay1 && isFigmaUrlOk(v.figmaUrl) ? v.figmaUrl : "",
    prototypeUrl: isUpdateDay1 && isPrototypeUrlOk(v.prototypeUrl) ? v.prototypeUrl : "",
    stream: true,
  };

  // The generate step now shows its result here for editing; the comment is posted later by
  // Submit. The approval step (mainSection 4) still runs straight through.
  const url = isUpdateDay1 ? "/__da/review/update/generate" : "/__da/run-update-csv";
  if (isUpdateDay1) ReviewPanel.reset();

  try {
    const res = await fetch(apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput(logPre);
      const ok = await readNdjsonStream(res, logPre);
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
        appendRunChunk(logPre, "stdout", `Error: ${data.error || data.detail || res.statusText}\n`);
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
  ["mainSection", "generateMode", "projectPath", "jiraKey", "figmaUrl", "prototypeUrl"].forEach((id) => {
    const el = $(id);
    if (el) {
      const onParamChange = () => {
        if (id === "projectPath") resetCsvLookup();
        render();
      };
      el.addEventListener("input", onParamChange);
      el.addEventListener("change", onParamChange);
    }
  });

  $("pickProjectBtn").addEventListener("click", pickFolder);
  const csvBrowseBtn = $("csvBrowseBtn");
  if (csvBrowseBtn) {
    csvBrowseBtn.addEventListener("click", pickCsvFile);
  }  $("runStepBtn").addEventListener("click", runStep);

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
      // Unknown switch -> no field, no crawl.
    });

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok && $("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      if ($("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    });

  ReviewPanel.configure({
    apiUrl,
    getProjectPath: () => vals().projectPath,
    appendLog: (text) => appendRunChunk($("runOutputStep1"), "stdout", text),
    toast: showToast,
  });
  ReviewPanel.wire();

  // The step label and the context panel both name the import destination, so
  // they wait for the In use toggle instead of assuming Azure DevOps.
  TmsProvider.load(apiUrl).then(applyActiveProvider);

  render();
}

document.addEventListener("DOMContentLoaded", wire);
