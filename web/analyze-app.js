/**
 * "Analyze requirements" page (analyze.html).
 *
 * Only the Jira ticket is required. Everything else is optional context: growing lists of related
 * tickets, Confluence pages, Figma and prototype links, attachments (attachments-panel.js) and the
 * "Related test cases from <TMS>" picker (ado-context-panel.js). Analyze streams the run log from
 * POST /__da/analyze/run and ends with one {event:"analysis"} line, rendered below and exportable
 * as Markdown (analysis-format.js). Nothing is written to Jira.
 */

const $ = (id) => document.getElementById(id);
const PATH_PLACEHOLDER = "PATH_TO_PROJECT";

function apiOrigin() {
  const m = document.querySelector('meta[name="ai-test-coverage-api-origin"]');
  const raw = (m && m.getAttribute("content")) || "";
  if (raw && !raw.includes("__AI_TEST_COVERAGE_API_ORIGIN__")) return raw.replace(/\/$/, "");
  if (location.protocol === "http:" || location.protocol === "https:") return `${location.protocol}//${location.host}`;
  return "http://127.0.0.1:3847";
}

function apiUrl(path) {
  return `${apiOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Same link shapes the server accepts (see jiraKeyFromLink in web-ui-server.js). */
function jiraKeyFromLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const KEY = "([A-Za-z][A-Za-z0-9_]*-\\d+)";
  for (const re of [new RegExp(`/browse/${KEY}`), new RegExp(`[?&]selectedIssue=${KEY}`, "i"), new RegExp(`/issues/${KEY}`)]) {
    const m = s.match(re);
    if (m) return m[1].toUpperCase();
  }
  const all = s.match(new RegExp(KEY, "g"));
  return all && all.length ? all[all.length - 1].toUpperCase() : "";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function vals() {
  return {
    projectPath: ($("projectPath").value || "").trim() || PATH_PLACEHOLDER,
    jiraLink: ($("jiraLink").value || "").trim(),
    jiraKey: jiraKeyFromLink($("jiraLink").value),
  };
}

/* ── growing link lists ───────────────────────────────────────────────────── */

/**
 * A list of link inputs that always ends with one empty field: type into the last one and the
 * next appears; clear a field and it goes away. `validate(value)` returns "" or an error text.
 */
function LinkList(container, validate) {
  const label = container.getAttribute("data-label") || "";
  const placeholder = container.getAttribute("data-placeholder") || "";
  const tip = container.getAttribute("data-info") || "";
  container.textContent = "";
  const lab = document.createElement("label");
  lab.textContent = label;
  if (tip) lab.appendChild(UiTips.info(tip));
  container.appendChild(lab);
  const rows = document.createElement("div");
  rows.className = "an-list-rows";
  container.appendChild(rows);
  const err = document.createElement("span");
  err.className = "figma-url-err";
  err.hidden = true;
  container.appendChild(err);
  let onChange = () => {};

  function addRow(value = "") {
    const row = document.createElement("div");
    row.className = "an-list-row";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.value = value;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "att-remove";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove");
    rm.addEventListener("click", () => {
      row.remove();
      normalize();
      onChange();
    });
    input.addEventListener("input", () => {
      normalize();
      onChange();
    });
    row.appendChild(input);
    row.appendChild(rm);
    rows.appendChild(row);
    return input;
  }

  /** Exactly one trailing empty field; no empty fields in the middle (except the focused one). */
  function normalize() {
    const all = [...rows.querySelectorAll("input")];
    all.forEach((inp, i) => {
      const last = i === all.length - 1;
      if (!last && !inp.value.trim() && document.activeElement !== inp) inp.parentElement.remove();
    });
    const now = [...rows.querySelectorAll("input")];
    if (!now.length || now[now.length - 1].value.trim()) addRow("");
    [...rows.querySelectorAll(".an-list-row")].forEach((r) => {
      const inp = r.querySelector("input");
      r.querySelector("button").hidden = !inp.value.trim();
    });
  }

  function values() {
    return [...rows.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  }

  function error() {
    for (const v of values()) {
      const e = validate(v);
      if (e) return e;
    }
    return "";
  }

  function paintError() {
    const e = error();
    err.hidden = !e;
    err.textContent = e;
    return !e;
  }

  function set(list) {
    rows.textContent = "";
    for (const v of Array.isArray(list) ? list : []) if (String(v).trim()) addRow(String(v));
    normalize();
  }

  rows.addEventListener("focusout", () => setTimeout(normalize, 0));
  normalize();
  return { values, set, paintError, onChange: (fn) => (onChange = fn) };
}

const lists = {};

function setupLists() {
  lists.related = LinkList($("relatedLinks"), (v) => (jiraKeyFromLink(v) ? "" : `Not a Jira ticket link: ${v}`));
  lists.confluence = LinkList($("confluenceLinks"), (v) =>
    /^https?:\/\/[^\s/]+\/wiki\//i.test(v) ? "" : `Not a Confluence page link: ${v}`
  );
  lists.figma = LinkList($("figmaLinks"), (v) =>
    /^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i.test(v) ? "" : `Not a Figma link: ${v}`
  );
  lists.prototype = LinkList($("prototypeLinks"), (v) => (/^https?:\/\/\S+$/i.test(v) ? "" : `Not an http(s) link: ${v}`));
  for (const l of Object.values(lists)) {
    l.onChange(() => {
      render();
      PageDraft.changed();
    });
  }
}

/* ── run log ──────────────────────────────────────────────────────────────── */

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
  if (runClockTimer) clearInterval(runClockTimer);
  runClockTimer = null;
  const titleEl = $("runOutputTitle");
  if (titleEl && titleEl.dataset.baseTitle) titleEl.textContent = titleEl.dataset.baseTitle;
}

function showToast(text, ms = 2200) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/* ── state + render ───────────────────────────────────────────────────────── */

let running = false;
let lastResult = null;

function render() {
  const v = vals();
  const linkErr = $("jiraLinkErr");
  const bad = v.jiraLink !== "" && !v.jiraKey && !/^[A-Za-z][A-Za-z0-9_]*-$/.test(v.jiraLink);
  linkErr.hidden = !bad;
  linkErr.textContent = bad ? "No Jira issue key in that link — expected something like PROJ-123." : "";
  UiTips.set($("jiraLinkInfo"), v.jiraKey ? `Will analyze ${v.jiraKey}: summary, description and comments.` : "A browse link, a board link with ?selectedIssue=, or just the key.");

  let listsOk = true;
  for (const l of Object.values(lists)) listsOk = l.paintError() && listsOk;

  const block = SetupStatus.jiraReason() || SetupStatus.aiReason() || AttachmentsPanel.blockReason();
  // The reason sits in the hint next to the button — on this page hover tips live on info icons only.
  $("runStepBtn").disabled = running || !v.jiraKey || !listsOk || !!block;
  $("runHint").textContent = running
    ? "Analyzing…"
    : block
      ? block.text
      : !v.jiraKey
        ? "Paste the Jira ticket link to enable the analysis"
        : !listsOk
          ? "Fix the highlighted link first"
          : "Read-only: nothing is written to Jira.";
}

/* ── result ───────────────────────────────────────────────────────────────── */

const PRIORITY_LABEL = { blocker: "Blocker", high: "High", medium: "Medium" };

function chip(text, cls = "") {
  return text ? `<span class="an-chip ${cls}">${esc(text)}</span>` : "";
}

function renderAnalysis(result) {
  lastResult = result || null;
  const panel = $("analysisPanel");
  if (!result || !result.analysis) {
    panel.hidden = true;
    return;
  }
  const a = result.analysis;
  panel.hidden = false;
  $("analysisTitle").textContent = `Analysis — ${result.issueKey}${result.summary ? `: ${result.summary}` : ""}`;
  const qs = a.questions || [];
  const blockers = qs.filter((q) => q.priority === "blocker").length;
  $("analysisSub").textContent = `${qs.length} question(s)${blockers ? `, ${blockers} blocker(s)` : ""} · ${(a.differences || []).length} difference(s) · ${(a.gaps || []).length} gap(s) · ${(a.qualityIssues || []).length} quality issue(s)`;

  const parts = [];
  const verdictCls = a.verdict === "ready" ? "is-ok" : a.verdict === "not ready" ? "is-bad" : "is-warn";
  parts.push(`<div class="an-verdict ${verdictCls}"><strong>${esc(AnalysisFormat.VERDICT_TITLE[a.verdict] || a.verdict)}</strong>${a.verdictReason ? ` — ${esc(a.verdictReason)}` : ""}</div>`);
  if (a.understanding) parts.push(`<p class="an-understanding"><strong>Understanding.</strong> ${esc(a.understanding)}</p>`);
  if ((a.setAssessment || []).length) {
    parts.push(
      `<div class="an-iso">${a.setAssessment
        .map((c) => `<span class="an-iso-item is-${esc(c.rating)}">${esc(c.characteristic)}: ${esc(c.rating)}${c.note ? ` <span class="an-iso-note">— ${esc(c.note)}</span>` : ""}</span>`)
        .join("")}</div>`
    );
  }

  parts.push(`<h3>Questions for grooming (${qs.length})</h3>`);
  if (!qs.length) parts.push(`<p class="context-status">No open questions.</p>`);
  for (const p of ["blocker", "high", "medium"]) {
    const group = qs.filter((q) => q.priority === p);
    if (!group.length) continue;
    parts.push(`<h4 class="an-prio is-${p}">${esc(PRIORITY_LABEL[p])} (${group.length})</h4><ol class="an-questions">`);
    for (const q of group) {
      parts.push(`<li value="${esc(String(q.id || "").replace(/\D/g, ""))}">
        <div class="an-q">${esc(q.question)}</div>
        <div class="an-tags">${chip(q.category)}${chip(q.askWho && `→ ${q.askWho}`, "is-who")}${chip(q.isoCharacteristic && `ISO: ${q.isoCharacteristic}`, "is-iso")}${q.stillOpenFromComments ? chip("still open from comments", "is-open") : ""}</div>
        ${q.why ? `<div class="an-why"><span>Why:</span> ${esc(q.why)}</div>` : ""}
        ${q.trigger ? `<div class="an-why"><span>Trigger:</span> ${esc(q.trigger)}</div>` : ""}
        ${q.assumptionIfUnanswered ? `<div class="an-why"><span>If unanswered:</span> ${esc(q.assumptionIfUnanswered)}</div>` : ""}
      </li>`);
    }
    parts.push(`</ol>`);
  }

  if ((a.differences || []).length) {
    parts.push(`<h3>Differences between sources (${a.differences.length})</h3>`);
    for (const d of a.differences) {
      parts.push(`<div class="an-diff"><div class="an-diff-topic">${esc(d.topic)}</div><table class="an-diff-table"><tbody>${(d.statements || [])
        .map((st) => `<tr><th>${esc(st.source)}</th><td>${esc(st.says)}</td></tr>`)
        .join("")}</tbody></table>${d.impact ? `<div class="an-why"><span>Impact:</span> ${esc(d.impact)}</div>` : ""}${d.question ? `<div class="an-why"><span>Ask:</span> ${esc(d.question)}</div>` : ""}</div>`);
    }
  }

  if ((a.gaps || []).length) {
    parts.push(`<h3>Missing information (${a.gaps.length})</h3><ul class="an-list-out">${a.gaps
      .map((g) => `<li><strong>${esc(g.area)}:</strong> ${esc(g.missing)}${g.whyItMatters ? ` <span class="an-muted">— ${esc(g.whyItMatters)}</span>` : ""}</li>`)
      .join("")}</ul>`);
  }

  if ((a.qualityIssues || []).length) {
    parts.push(`<h3>Requirement quality — ISO/IEC/IEEE 29148 (${a.qualityIssues.length})</h3><ul class="an-list-out">${a.qualityIssues
      .map(
        (q) => `<li><span class="an-quote">“${esc(q.text)}”</span>${q.source ? ` <span class="an-muted">(${esc(q.source)})</span>` : ""} ${(q.characteristics || []).map((c) => chip(c, "is-iso")).join("")}
          ${q.problem ? `<div class="an-why"><span>Problem:</span> ${esc(q.problem)}</div>` : ""}
          ${q.suggestedRewrite ? `<div class="an-why"><span>Suggested:</span> ${esc(q.suggestedRewrite)}</div>` : ""}</li>`
      )
      .join("")}</ul>`);
  }

  const simple = (title, items) => {
    if (!(items || []).length) return;
    parts.push(`<h3>${esc(title)}</h3><ul class="an-list-out">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  };
  simple("Already decided (do not reopen)", a.alreadyDecided);
  simple("Assumptions made by the analysis", a.assumptions);
  simple("Context", a.contextNotes);

  $("analysisBody").innerHTML = parts.join("\n");
}

async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(note);
  } catch {
    showToast("Copy failed — select the text and copy it manually");
  }
}

function downloadMarkdown() {
  if (!lastResult) return;
  const blob = new Blob([AnalysisFormat.toMarkdown(lastResult)], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `requirements-analysis-${lastResult.issueKey || "ticket"}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

/* ── run ──────────────────────────────────────────────────────────────────── */

async function readNdjsonStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ok = false;
  for (;;) {
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
      if (msg.event === "stage") appendRunStage(msg.label || "Stage", msg.detail || "");
      else if (msg.event === "stdout") appendRunChunk("stdout", msg.text || "");
      else if (msg.event === "stderr") appendRunChunk("stderr", msg.text || "");
      else if (msg.event === "analysis") renderAnalysis(msg.result);
      else if (msg.event === "end") {
        ok = !!msg.ok;
        appendRunChunk("stdout", `\n── Finished (exit ${msg.code}) ${msg.ok ? "OK" : "with errors"} ──\n`);
      }
    }
  }
  return ok;
}

async function analyze() {
  const v = vals();
  if (!v.jiraKey) return;
  running = true;
  render();
  const hint = $("runOutputHint");
  if (hint) hint.hidden = true;
  clearRunOutput();
  appendRunChunk("stdout", "Connecting to local API…\n");
  startRunClock("analyzing");
  try {
    const res = await fetch(apiUrl("/__da/analyze/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: v.projectPath,
        jiraLink: v.jiraLink,
        relatedLinks: lists.related.values(),
        confluenceLinks: lists.confluence.values(),
        figmaLinks: lists.figma.values(),
        prototypeLinks: lists.prototype.values(),
        attachments: AttachmentsPanel.ids(),
        useRelatedTestCases: true,
      }),
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && ct.includes("application/x-ndjson")) {
      clearRunOutput();
      const ok = await readNdjsonStream(res);
      showToast(ok ? "Analysis ready" : "Finished with errors");
    } else {
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      clearRunOutput();
      appendRunChunk("stderr", `Error: ${data.error || res.statusText}\n`);
    }
  } catch (e) {
    appendRunChunk("stderr", `Network / server: ${e.message}\n`);
  }
  stopRunClock();
  running = false;
  render();
  PageDraft.changed();
  if (lastResult) $("analysisPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── draft ────────────────────────────────────────────────────────────────── */

function collectDraft() {
  return {
    jiraLink: $("jiraLink").value,
    related: lists.related.values(),
    confluence: lists.confluence.values(),
    figma: lists.figma.values(),
    prototype: lists.prototype.values(),
    attachments: AttachmentsPanel.snapshot(),
    result: lastResult,
    log: snapshotLog($("runOutputStep1")),
  };
}

function restoreDraft(d) {
  if (!d) return;
  $("jiraLink").value = d.jiraLink || "";
  lists.related.set(d.related);
  lists.confluence.set(d.confluence);
  lists.figma.set(d.figma);
  lists.prototype.set(d.prototype);
  if (d.attachments) AttachmentsPanel.restore(d.attachments);
  if (d.log) {
    restoreLog($("runOutputStep1"), d.log);
    const hint = $("runOutputHint");
    if (hint) hint.hidden = true;
  }
  if (d.result) renderAnalysis(d.result);
  render();
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

/**
 * On this page hover hints belong to the (i) info icons only. The shared pieces it reuses
 * (attachments panel, the TMS picker) put native `title` tooltips and `data-tip` hints on buttons
 * and rows for the other pages; here they are stripped as they appear, keeping the text as an
 * aria-label so screen readers lose nothing.
 */
function onlyInfoIconTips(root) {
  const clean = (n) => {
    if (!n || n.nodeType !== 1) return;
    if (n.hasAttribute("title")) {
      if (!n.getAttribute("aria-label")) n.setAttribute("aria-label", n.getAttribute("title"));
      n.removeAttribute("title");
    }
    if (n.hasAttribute("data-tip") && !n.classList.contains("info-tip")) n.removeAttribute("data-tip");
  };
  const sweep = (el) => {
    if (!el || el.nodeType !== 1) return;
    clean(el);
    el.querySelectorAll("[title],[data-tip]").forEach(clean);
  };
  sweep(root);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") clean(m.target);
      else m.addedNodes.forEach(sweep);
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "data-tip"] });
}

function wire() {
  onlyInfoIconTips(document.querySelector(".wrap"));
  setupLists();
  $("jiraLink").addEventListener("input", render);
  $("runStepBtn").addEventListener("click", analyze);
  $("copyMdBtn").addEventListener("click", () => lastResult && copyText(AnalysisFormat.toMarkdown(lastResult), "Markdown copied"));
  $("copyQuestionsBtn").addEventListener("click", () => lastResult && copyText(AnalysisFormat.questionsToMarkdown(lastResult), "Questions copied"));
  $("downloadMdBtn").addEventListener("click", downloadMarkdown);

  AttachmentsPanel.mount({
    container: $("attachmentsRow"),
    apiUrl,
    projectPath: () => vals().projectPath,
    onChange: () => {
      render();
      PageDraft.changed();
    },
  });

  // "Related test cases from <TMS>" — only with a test management system In use.
  TmsProvider.load(apiUrl).then((provider) => {
    if (!provider || !provider.id) return;
    $("adoCtxTitle").textContent = `Related test cases from ${provider.title} (optional)`;
    $("adoCtxPanel").hidden = false;
    AdoContextPanel.configure({ apiUrl, getProjectPath: () => vals().projectPath, toast: showToast, provider });
    AdoContextPanel.wire();
    $("adoCtxIntro").textContent =
      `Pick the existing ${provider.title} test cases of this area. They show the analysis how the product behaves today, ` +
      "so a ticket that changes that behaviour shows up as a difference. The picks are shared with the Create and Update pages.";
  });

  SetupStatus.load(apiUrl).then(render);
  const draftReady = PageDraft.init({ apiUrl, flow: "analyze", collect: collectDraft }).then(restoreDraft);
  Promise.all([draftReady, SetupStatus.load(apiUrl)]).then(() => {
    SetupStatus.prefillJiraKey($("jiraLink"));
    render();
  });
  const page = document.querySelector(".wrap");
  page.addEventListener("input", PageDraft.changed);
  page.addEventListener("change", PageDraft.changed);

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      $("cursorBrowserBanner").hidden = false;
    });
  const extBtn = $("openExternalBrowserBtn");
  if (extBtn) extBtn.addEventListener("click", () => window.open(location.href, "_blank", "noopener,noreferrer"));

  render();
}

document.addEventListener("DOMContentLoaded", wire);
