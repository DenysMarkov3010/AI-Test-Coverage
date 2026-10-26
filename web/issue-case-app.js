/**
 * Cover a bug — generate one regression case from a pasted bug, review it, import it into the TMS.
 *
 * The gap-closing flow next to Create and Update: a defect got through because nothing covered
 * that edge case, so this writes the single test that would have caught it. No Jira comment, no
 * approval round-trip through Jira, no CSV to hand around. The review panel is the same one the other two
 * pages use; only the submit action differs, and ReviewPanel takes that as a `submit` descriptor.
 */

const $ = (id) => document.getElementById(id);

const PATH_PLACEHOLDER = "PATH_TO_PROJECT";

/** API lives on the same machine as web-ui-server.js; a webview may use a different page origin. */
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
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Issue key out of whatever was pasted — the same three link shapes the server accepts, so the
 * page can echo the key it is about to use instead of failing after the request.
 *
 * @returns {string} upper-cased key, or "" when there is none
 */
function jiraKeyFromLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const KEY = "([A-Za-z][A-Za-z0-9_]*-\\d+)";
  for (const re of [
    new RegExp(`/browse/${KEY}`),
    new RegExp(`[?&]selectedIssue=${KEY}`, "i"),
    new RegExp(`/issues/${KEY}`),
  ]) {
    const m = s.match(re);
    if (m) return m[1].toUpperCase();
  }
  const all = s.match(new RegExp(KEY, "g"));
  return all && all.length ? all[all.length - 1].toUpperCase() : "";
}

let testFormat = "standard";

/**
 * Which step the page is on: "1" generate, "2" import.
 *
 * Step 2 is not a mode the user can talk themselves into — importing needs a generated case, so
 * the option stays disabled until one exists and goes back to disabled once it has been imported.
 */
function section() {
  return $("mainSection").value === "2" && hasDraft && !SetupStatus.tmsReason() ? "2" : "1";
}

/** Is there a reviewed draft to import? Owned here because ReviewPanel does not expose its state. */
let hasDraft = false;

/**
 * Enable / disable step 2 and name it after the provider in use. It needs both a generated case
 * and a provider In use; the second one says why on hover, with a link into Setup.
 */
function applyDraftState(next) {
  hasDraft = Boolean(next);
  const opt = $("stepImportOpt");
  if (opt) {
    opt.textContent = `2 — Import to ${TmsProvider.title()}`;
    const tms = SetupStatus.tmsReason();
    StepSelect.setOptionBlocked(
      opt,
      tms || (hasDraft ? null : { text: "Step 2 unlocks once a test case has been generated." })
    );
  }
  if ((!hasDraft || SetupStatus.tmsReason()) && $("mainSection").value === "2") $("mainSection").value = "1";
}

function vals() {
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraLink: ($("jiraLink").value || "").trim(),
    jiraKey: jiraKeyFromLink($("jiraLink").value),
    testFormat,
  };
}

function projectPathOk(v) {
  return v.projectPath !== PATH_PLACEHOLDER && v.projectPath.length > 2;
}

/** Paint the segmented control and re-render. */
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

  UiTips.set(
    $("testFormatInfo"),
    isBdd
      ? `One Gherkin Scenario (Given / When / Then) covering the ticket — imported into ${TmsProvider.title()} like any other test design.`
      : "One case with Step Action and Step Expected — the current format."
  );

  render();
}

function render() {
  const v = vals();
  const step = section();
  // Keep the select honest when step 2 was dropped underneath it (a fresh Generate, an import).
  if ($("mainSection").value !== step) $("mainSection").value = step;

  // Each step shows its own fields and its own single action: Generate under the generation
  // fields, Import under the destination picker it acts on.
  $("generateFields").hidden = step !== "1";
  $("runRow").hidden = step !== "1";
  $("tmsTargetPanel").hidden = step !== "2";
  $("importRow").hidden = step !== "2";

  UiTips.set(
    $("mainSectionInfo"),
    step === "2"
      ? `Pick the container, then press Import below the generated case.`
      : hasDraft
        ? `A test case is ready — switch to step 2 to import it into ${TmsProvider.title()}.`
        : `Step 2 unlocks once a test case has been generated.`
  );

  UiTips.set(
    $("jiraLinkInfo"),
    v.jiraKey
      ? `Will generate from ${v.jiraKey}. A browse link, a board link with ?selectedIssue=, or just the key.`
      : "A browse link, a board link with ?selectedIssue=, or just the key."
  );
  const linkErr = $("jiraLinkErr");
  if (linkErr) {
    // "PROJ-" on its own is the pre-filled prefix still waiting for its number, not a bad link.
    const bad = v.jiraLink !== "" && !v.jiraKey && !/^[A-Za-z][A-Za-z0-9_]*-$/.test(v.jiraLink);
    linkErr.hidden = !bad;
    linkErr.textContent = bad ? "No Jira issue key in that link — expected something like PROJ-123." : "";
  }

  const pathOk = projectPathOk(v);
  const aiBlock = SetupStatus.aiReason();
  // Attachments still uploading, or not yet confirmed free of personal data.
  const attBlock = AttachmentsPanel.blockReason();
  $("runStepBtn").disabled = !pathOk || !v.jiraKey || !!aiBlock || !!attBlock;
  UiTips.gate($("runStepBtn"), aiBlock || attBlock);
  $("runHint").textContent = aiBlock
    ? aiBlock.text
    : attBlock
      ? attBlock.text
      : v.jiraKey
      ? "Generation only — the import target is picked before you press Import."
      : "Paste a Jira issue link to enable generation";

  // The review footer names the current step and the chosen container, so it is repainted with
  // the rest of the page. Safe to call unconditionally — it is a no-op while there is no draft,
  // and the panel never calls back into here, so there is no render loop.
  ReviewPanel.refresh();
}

/* ── run log ─────────────────────────────────────────────────────────────── */

function clearRunOutput() {
  const pre = $("runOutputStep1");
  if (pre) pre.innerHTML = "";
}

function appendRunChunk(stream, text) {
  const pre = $("runOutputStep1");
  if (!pre) return;
  if (stream === "stderr") {
    const span = document.createElement("span");
    span.className = "run-chunk-stderr";
    span.textContent = text;
    pre.appendChild(span);
  } else {
    pre.appendChild(document.createTextNode(text));
  }
  pre.scrollTop = pre.scrollHeight;
}

function appendRunStage(label, detail) {
  const pre = $("runOutputStep1");
  if (!pre) return;
  const s = document.createElement("span");
  s.className = "run-stage";
  s.textContent = detail ? `${label} — ${detail}` : label;
  pre.appendChild(s);
  pre.appendChild(document.createTextNode("\n"));
  pre.scrollTop = pre.scrollHeight;
}

let runClockTimer = null;
function startRunClock(label) {
  stopRunClock();
  const titleEl = $("runOutputTitle");
  if (!titleEl) return;
  const base = titleEl.dataset.baseTitle || titleEl.textContent;
  titleEl.dataset.baseTitle = base;
  const startedAt = Date.now();
  const tick = () => {
    titleEl.textContent = `${base} — ${label} ${Math.round((Date.now() - startedAt) / 1000)}s`;
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

function showToast(text, ms = 2400) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, ms);
}

async function readNdjsonStream(res) {
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
        appendRunStage(msg.label || "Stage", msg.detail || "");
      } else if (msg.event === "stdout") {
        appendRunChunk("stdout", msg.text || "");
      } else if (msg.event === "stderr") {
        appendRunChunk("stderr", msg.text || "");
      } else if (msg.event === "review") {
        ReviewPanel.accept(msg);
        // The case exists — step 2 is now a real option, and the page moves to it so the
        // destination picker is in front of the user rather than one dropdown away.
        applyDraftState(true);
        $("mainSection").value = "2";
        render();
      } else if (msg.event === "end") {
        lastOk = !!msg.ok;
        appendRunChunk("stdout", `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`);
      }
    }
  }
  return lastOk;
}

/* ── generate ────────────────────────────────────────────────────────────── */

async function generate() {
  const v = vals();
  if (!projectPathOk(v) || !v.jiraKey) return;

  $("runStepBtn").disabled = true;
  const hintEl = $("runOutputHint");
  if (hintEl) hintEl.hidden = true;
  const resultPanel = $("importResultPanel");
  if (resultPanel) resultPanel.hidden = true;
  importRuns = [];
  clearRunOutput();
  appendRunChunk("stdout", "Connecting to local API…\n");
  startRunClock("running");
  ReviewPanel.reset();
  applyDraftState(false);

  try {
    const res = await fetch(apiUrl("/__da/issue-case/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: v.projectPath,
        jiraLink: v.jiraLink,
        testFormat: v.testFormat,
        attachments: AttachmentsPanel.ids(),
        helpingPrompt: ($("helpingPrompt").value || "").trim(),
        stream: true,
      }),
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput();
      const ok = await readNdjsonStream(res);
      showToast(ok ? "Generated" : "Finished with errors", 2000);
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      clearRunOutput();
      const stale = ReviewPanel.staleServerHint(res.status);
      appendRunChunk("stdout", `Error: ${data.error || res.statusText}\n${stale ? `${stale}\n` : ""}`);
    }
  } catch (e) {
    clearRunOutput();
    appendRunChunk("stdout", `Network / server: ${e.message}\n`);
  }

  stopRunClock();
  render();
  PageDraft.changed();
}

/* ── import result ───────────────────────────────────────────────────────── */

/**
 * Imports performed on the current draft.
 *
 * The draft and the picker deliberately survive an import: the same case often belongs in more
 * than one suite, and re-generating it to send it somewhere else would be both slower and a
 * different case. So each import appends here instead of replacing what came before.
 */
let importRuns = [];

function showImportResult(data) {
  importRuns.push({
    where: TmsTargetPanel.describe() || data.providerTitle,
    created: data.created || [],
    errors: data.errors || [],
  });
  importProviderTitle = data.providerTitle || importProviderTitle;

  paintImportRuns(data.providerTitle);
  PageDraft.changed();
}

/** The import result panel, from importRuns — also how a restored draft puts it back. */
function paintImportRuns(providerTitle) {
  const panel = $("importResultPanel");
  const summary = $("importResultSummary");
  const list = $("importResultList");
  const errors = $("importResultErrors");
  if (!panel || !summary || !list || !errors) return;
  if (!importRuns.length) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  list.innerHTML = "";

  const total = importRuns.reduce((n, r) => n + r.created.length, 0);
  summary.textContent =
    `${total} case(s) created in ${providerTitle}` +
    (importRuns.length > 1 ? ` across ${importRuns.length} imports` : "");

  for (const run of importRuns) {
    const li = document.createElement("li");
    const ids = run.created.map((c) => `#${c.id}`).join(", ");
    li.textContent = `${run.where} — ${ids || "nothing created"}`;
    list.appendChild(li);
  }

  const errs = importRuns.flatMap((r) => r.errors);
  errors.hidden = errs.length === 0;
  errors.textContent = errs.length ? `${errs.length} problem(s): ${errs.join("; ")}` : "";
}

/* ── draft kept across page changes (web/ui-common.js) ──────────────────── */

let importProviderTitle = "";

function collectDraft() {
  return {
    jiraLink: $("jiraLink").value,
    helpingPrompt: $("helpingPrompt").value,
    testFormat,
    hasDraft,
    step: $("mainSection").value,
    importRuns,
    importProviderTitle,
    attachments: AttachmentsPanel.snapshot(),
    review: ReviewPanel.snapshot(),
    log: snapshotLog($("runOutputStep1")),
  };
}

function restoreDraft(d) {
  if (!d) return;
  $("jiraLink").value = d.jiraLink || "";
  $("helpingPrompt").value = d.helpingPrompt || "";
  importRuns = Array.isArray(d.importRuns) ? d.importRuns : [];
  importProviderTitle = d.importProviderTitle || "";
  paintImportRuns(importProviderTitle);
  if (d.log) {
    restoreLog($("runOutputStep1"), d.log);
    const hintEl = $("runOutputHint");
    if (hintEl) hintEl.hidden = true;
  }
  if (d.review) ReviewPanel.restore(d.review);
  if (d.attachments) AttachmentsPanel.restore(d.attachments);
  applyDraftState(!!(d.review && d.hasDraft));
  if (d.step === "2" && hasDraft && !SetupStatus.tmsReason()) $("mainSection").value = "2";
  applyTestFormat(d.testFormat || testFormat);
}

/** Spinner next to the Import button — the panel's own busy line is in another section. */
function setImportBusy(busy, note) {
  const el = $("importBusy");
  if (el) el.hidden = !busy;
  const text = $("importBusyText");
  if (text && note) text.textContent = note;
  // One message at a time: the hint explains what Import will do, which is moot while it runs.
  const hint = $("reviewSubmitHint");
  if (hint) hint.hidden = busy;
}

/* ── wiring ──────────────────────────────────────────────────────────────── */

function wire() {
  StepSelect.enhance($("mainSection"));
  for (const id of ["projectPath", "jiraLink", "mainSection"]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  }
  for (const id of ["testFormatStandard", "testFormatBdd"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", () => applyTestFormat(btn.getAttribute("data-format")));
  }

  $("runStepBtn").addEventListener("click", generate);

  ReviewPanel.configure({
    apiUrl,
    getProjectPath: () => vals().projectPath,
    appendLog: (text) => appendRunChunk("stdout", text),
    toast: showToast,
    onChange: PageDraft.changed,
    // The footer imports instead of posting to Jira. Everything else about the panel — editing,
    // per-row regeneration, "Regenerate all" — is shared with the Create page unchanged.
    submit: {
      url: "/__da/issue-case/import",
      // The draft outlives an import now, so this line has to stop claiming otherwise.
      subNote: () =>
        importRuns.length === 0
          ? "nothing imported yet"
          : `already imported into ${importRuns.length} container(s) — still editable`,
      hint: () => {
        const where = TmsTargetPanel.describe();
        return where
          ? `Creates the test case in ${TmsProvider.title()} → ${where}. Jira is not touched.`
          : TmsTargetPanel.missingMessage();
      },
      busy: () => `Importing into ${TmsProvider.title()}…`,
      blocked: () => SetupStatus.tmsReason(),
      ready: () => TmsTargetPanel.value() !== null,
      body: () => {
        const target = TmsTargetPanel.value();
        if (!target) throw new Error(TmsTargetPanel.missingMessage());
        return { target };
      },
      done: (data) => {
        const n = (data.created || []).length;
        const bad = (data.errors || []).length;
        return `${n} case(s) imported into ${data.providerTitle}${bad ? ` · ${bad} failed` : ""}`;
      },
      after: showImportResult,
      onBusy: setImportBusy,
      // Step 2 stays open with the case still on screen, ready for another container.
      keepAfterSubmit: true,
    },
  });
  ReviewPanel.wire();

  TmsTargetPanel.configure({
    apiUrl,
    // The submit hint names the chosen container, so it has to be repainted when that changes.
    onChange: () => ReviewPanel.refresh(),
  });

  // Labels and endpoints both depend on the In use toggle, so the picker waits for it — and is
  // not mounted at all while nothing is In use, since step 2 cannot be reached then.
  Promise.all([TmsProvider.load(apiUrl), SetupStatus.load(apiUrl)]).then(([provider]) => {
    if (provider.id) TmsTargetPanel.mount(provider);
    applyDraftState(hasDraft);
    applyTestFormat(testFormat);
  });

  AttachmentsPanel.mount({
    container: $("attachmentsRow"),
    apiUrl,
    projectPath: () => vals().projectPath,
    onChange: () => {
      render();
      PageDraft.changed();
    },
  });

  // The page's work survives leaving it: put back what was here, then keep a copy on every change.
  // "PROJ-" from Setup goes in only after the draft is back, so it never overwrites a link.
  const draftReady = PageDraft.init({ apiUrl, flow: "issue", collect: collectDraft }).then(restoreDraft);
  Promise.all([draftReady, SetupStatus.load(apiUrl)]).then(() => SetupStatus.prefillJiraKey($("jiraLink")));
  const page = document.querySelector(".wrap");
  page.addEventListener("input", PageDraft.changed);
  page.addEventListener("change", PageDraft.changed);
  for (const id of ["testFormatStandard", "testFormatBdd"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", PageDraft.changed);
  }

  const extBtn = $("openExternalBrowserBtn");
  if (extBtn) {
    extBtn.addEventListener("click", () => window.open(location.href, "_blank", "noopener,noreferrer"));
  }

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok && $("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      if ($("cursorBrowserBanner")) $("cursorBrowserBanner").hidden = false;
    });

  applyTestFormat(testFormat);
}

document.addEventListener("DOMContentLoaded", wire);
