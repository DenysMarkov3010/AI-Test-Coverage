/**
 * Review-before-posting panel, shared by the Create and Update pages.
 *
 * "Run" no longer posts straight to Jira: it generates, shows the result here for editing, and
 * only /review/submit writes to the ticket. The browser owns the editable payload; the heavy
 * generation context (Confluence bodies, Figma text, the source CSV rows) stays in a server-side
 * session keyed by `sessionId`.
 *
 * This panel is also where the design is *approved*. Every checklist item and every test case
 * carries its own APPROVED mark, off by default; Submit writes the marked rows as the CSV and
 * attaches that to the ticket. Unmarked rows are left out — reviewed and not approved is an
 * answer. That replaced the old round-trip, where the whole design was posted to Jira and the QA
 * engineer replied "APPROVED: 1,2,3" for a second run to parse.
 *
 * Both flows are modelled as a list of blocks so there is one renderer instead of two:
 *   - Create produces exactly one block (a checklist or a test-case suite);
 *   - Update produces one block per parent row in the CSV, and blocks are never reordered here —
 *     only their contents are edited, and each becomes a section of the one CSV.
 */

const ReviewPanel = (() => {
  const RV_CATEGORIES = ["Functional", "Negative", "Boundary", "Integration"];

  /**
   * Row action icons on one 16x16 grid.
   * Drawn rather than taken from a font: the Unicode refresh glyph renders far smaller than the
   * arrows in the same face (6.9px of ink against 11.1px at 16px) and is not guaranteed to exist
   * in Segoe UI on Windows, so icon sizes would not match.
   */
  const ICONS = {
    regen:
      '<path d="M5.4 3.5A5.2 5.2 0 1 0 10.98 3.74"/>' +
      '<path d="M10.98 3.74l1.18 3.08M10.98 3.74l3.3 0.06"/>',
    up: '<path d="M8 13V3"/><path d="M3.6 7.4 8 3l4.4 4.4"/>',
    down: '<path d="M8 3v10"/><path d="M3.6 8.6 8 13l4.4-4.4"/>',
    del: '<path d="M3.6 3.6l8.8 8.8"/><path d="M12.4 3.6l-8.8 8.8"/>',
    grip:
      '<circle cx="6" cy="3.5" r="0.9"/><circle cx="10" cy="3.5" r="0.9"/>' +
      '<circle cx="6" cy="8" r="0.9"/><circle cx="10" cy="8" r="0.9"/>' +
      '<circle cx="6" cy="12.5" r="0.9"/><circle cx="10" cy="12.5" r="0.9"/>',
  };

  let cfg = null;
  let review = null;
  let usage = null;

  /** Block-level regenerations in flight (block indices). */
  const busyBlocks = new Set();
  /**
   * Blocks an Update "Regenerate all" has lined up but not started yet. They are in busyBlocks too
   * (nothing in them may be edited: the result replaces the whole block), and are only told apart
   * so the spinner can say "waiting" instead of claiming every block is being worked on at once.
   */
  const queuedBlocks = new Set();
  /** Row-level regenerations in flight, keyed "block:index". */
  const busyRows = new Set();
  let submitting = false;

  const rowKey = (b, i) => `${b}:${i}`;
  const anythingBusy = () => busyBlocks.size > 0 || busyRows.size > 0 || submitting;

  /**
   * What the footer button does, for the page that owns the panel.
   *
   * Create and Update attach the approved CSV to the ticket; "Cover a bug" imports what was
   * reviewed straight into the test management system. Everything above the footer is identical,
   * so the difference is one descriptor rather than a second renderer. A page overrides it by
   * passing `submit` to configure().
   */
  const JIRA_SUBMIT = {
    url: "/__da/review/submit",
    subNote: () => "nothing attached to Jira yet",
    hint: (r) => {
      const n = approvedCount();
      if (!n) return `Mark what you approve, then Submit writes those rows as the CSV on ${r.postTargetKey}.`;
      return (
        `Writes the ${n} approved row(s) as the CSV and attaches it to ${r.postTargetKey}. ` +
        "Unapproved rows are left out. The import step then takes that CSV — no APPROVED comment is needed."
      );
    },
    busy: (r) => `Attaching the approved CSV to ${r.postTargetKey}…`,
    done: (data) =>
      `CSV attached to ${data.postTargetKey}${data.submittedCount ? ` · ${data.submittedCount} row(s)` : ""}`,
    // Submit writes to Jira, so it waits for Jira to be set up (web/ui-common.js).
    blocked: () => (typeof SetupStatus !== "undefined" ? SetupStatus.jiraReason() : null),
  };

  const submitCfg = () => (cfg && cfg.submit) || JIRA_SUBMIT;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function icon(name) {
    return (
      '<svg class="rv-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      `${ICONS[name] || ""}</svg>`
    );
  }

  function iconBtn(action, tip, name, extra = "") {
    return (
      `<button type="button" class="rv-icon-btn" data-rv-action="${action}" ${extra} ` +
      `data-rv-tip="${esc(tip)}" aria-label="${esc(tip)}">${icon(name)}</button>`
    );
  }

  /**
   * The row number doubles as its drag handle. Only the handle is draggable: a whole draggable
   * row would turn every text selection inside its textareas into a drag.
   */
  function dragHandleHtml(kind, number, label) {
    return (
      `<span class="rv-drag" draggable="true" data-rv-drag="${kind}" title="${esc(`Drag to move ${label}`)}">` +
      `<svg class="rv-drag-grip" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">${ICONS.grip}</svg>` +
      `<span>${number}</span></span>`
    );
  }

  function guideHtml(placeholder) {
    return (
      '<div class="rv-guide rv-guide-inline" data-rv-guide hidden>' +
      `<textarea data-rv-guide-input rows="2" placeholder="${esc(placeholder)}"></textarea>` +
      '<div class="rv-guide-actions">' +
      '<button type="button" class="btn" data-rv-action="regen-run">Regenerate</button>' +
      '<button type="button" class="btn btn-secondary" data-rv-action="regen-cancel">Cancel</button>' +
      "</div></div>"
    );
  }

  function spinnerHtml(label) {
    return (
      '<p class="rv-working" role="status">' +
      '<span class="rv-spinner" aria-hidden="true"></span>' +
      `<span>${esc(label)}</span></p>`
    );
  }

  /** The (i) next to a label; its text shows on hover (web/ui-common.js). */
  function infoHtml(text) {
    return `<span class="info-tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}"></span>`;
  }

  function badgeHtml() {
    return '<span class="rv-badge" title="Regenerated by the AI after the first draft">Regenerated</span>';
  }

  function categorySelect(selected, label, field = "category") {
    const opts = RV_CATEGORIES.map(
      (c) => `<option value="${esc(c)}"${c === selected ? " selected" : ""}>${esc(c)}</option>`
    ).join("");
    return `<select class="rv-cat"${field ? ` data-rv-field="${field}"` : ""} aria-label="${esc(label)}">${opts}</select>`;
  }

  /* ---------------------------- rendering ---------------------------- */
  /**
   * Change annotations only mean something in the Update flow, where rows are compared against an
   * existing CSV. In Create every row is new by definition, so a "New" marker would say nothing —
   * and a model that volunteers the field anyway must not make the panel claim otherwise.
   */
  function annotationsApply() {
    return !!review && review.flow === "update";
  }

  /**
   * Approval lives here now, per row.
   *
   * It used to be a Jira round-trip: the whole design was posted as a comment and the QA engineer
   * replied "APPROVED: 1,2,3". The reviewer is already reading every row in this panel, so the
   * decision is made where the reading happens — and Submit writes only the marked rows into the
   * CSV. Nothing starts approved: an unread row must never reach a test management system because
   * someone pressed Submit quickly.
   *
   * "Cover a bug" is not part of this: it has no CSV to approve into and no Jira round-trip to
   * replace — it imports what was reviewed, straight into the chosen container.
   */
  function approvalApplies() {
    return !!review && review.flow !== "issue";
  }

  function rowsOf(block) {
    return (block.type === "testcase" ? block.payload.testCases : block.payload.checklistItems) || [];
  }

  /** The APPROVED mark itself: a toggle that reads as a label once it is on. */
  function approveBtnHtml(row, label) {
    if (!approvalApplies()) return "";
    const on = !!row.approved;
    return (
      `<button type="button" class="rv-approve${on ? " is-approved" : ""}" data-rv-action="approve"` +
      ` aria-pressed="${on}" title="${esc(on ? `${label} is approved — click to exclude it from the CSV` : `Mark ${label} APPROVED so it goes into the CSV`)}">` +
      `${on ? "APPROVED" : "Approve"}</button>`
    );
  }

  /** Per-row change marker: green for new, amber for edited, nothing for untouched. */
  function changeChipHtml(changeType) {
    if (!annotationsApply()) return "";
    if (changeType === "added") return '<span class="rv-chip rv-chip-added">New</span>';
    if (changeType === "changed") return '<span class="rv-chip rv-chip-changed">Changed</span>';
    return "";
  }

  /**
   * The step-level chip, on its own line above the action.
   *
   * It used to sit beside the step number, which is a 2.4rem column under `table-layout: fixed`
   * — and a chip that says "CHANGED" and may not wrap simply drew itself across the step text in
   * the next column. The action cell is the wide one, and the "Changed: …" reason already lives
   * there, so the two now read as one block.
   */
  function stepChipHtml(changeType) {
    const chip = changeChipHtml(changeType);
    return chip ? `<div class="rv-step-chip">${chip}</div>` : "";
  }

  function changeReasonHtml(row) {
    if (!annotationsApply()) return "";
    const reason = String(row.changeReason || "").trim();
    if (!reason || row.changeType === "unchanged") return "";
    const word = row.changeType === "added" ? "Added" : "Changed";
    return `<p class="rv-reason rv-reason-${esc(row.changeType)}"><strong>${word}:</strong> ${esc(reason)}</p>`;
  }

  /** Class that tints the row by what happened to it. */
  function changeClass(changeType) {
    if (!annotationsApply()) return "";
    return changeType === "added" ? " rv-added" : changeType === "changed" ? " rv-changed" : "";
  }

  /**
   * What the model dropped from the CSV. Shown above the block rather than in it: the rows are
   * gone, so the only place the information can live is next to the block they came from.
   */
  function removedHtml(block) {
    if (!annotationsApply()) return "";
    const removed = (block.payload && block.payload.removed) || [];
    if (!removed.length) return "";
    const rows = removed
      .map((r) => `<li><span class="rv-removed-item">${esc(r.item)}</span>${r.why ? ` — ${esc(r.why)}` : ""}</li>`)
      .join("");
    return `
      <div class="rv-removed">
        <p class="rv-removed-head">Removed from this block (${removed.length}) — no longer in the CSV output:</p>
        <ul class="rv-removed-list">${rows}</ul>
      </div>`;
  }


  function checklistHtml(block, b) {
    const items = block.payload.checklistItems || [];
    const rows = items
      .map(
        (it, i) => `
        <li class="rv-item${busyRows.has(rowKey(b, i)) ? " rv-busy-row" : ""}${changeClass(it.changeType)}" data-rv-index="${i}" data-rv-scope="item">
          <div class="rv-item-head">
            <span class="rv-num rv-num-drag">${dragHandleHtml("item", i + 1, `item ${i + 1}`)}</span>
            ${categorySelect(it.category, `Category for item ${i + 1}`)}
            ${changeChipHtml(it.changeType)}
            ${it.regenerated ? badgeHtml() : ""}
            ${approveBtnHtml(it, `item ${i + 1}`)}
            <span class="rv-item-actions">
              ${iconBtn("regen", `Regenerate item ${i + 1} with the AI`, "regen")}
              ${iconBtn("move-up", `Move item ${i + 1} up`, "up")}
              ${iconBtn("move-down", `Move item ${i + 1} down`, "down")}
              ${iconBtn("delete", `Delete item ${i + 1}`, "del", 'data-rv-danger="1"')}
            </span>
          </div>
          <textarea class="rv-desc" data-rv-field="description" rows="2"
            aria-label="Description for item ${i + 1}">${esc(it.description)}</textarea>
          ${changeReasonHtml(it)}
          ${guideHtml("What should change in this item? (optional)")}
          ${busyRows.has(rowKey(b, i)) ? spinnerHtml(`Regenerating item ${i + 1}…`) : ""}
        </li>`
      )
      .join("");

    return `
      <ol class="rv-list">${rows || `<li class="rv-empty">${esc(emptyBlockNote("items", { canAdd: true }))}</li>`}</ol>
      <div class="rv-add">
        ${categorySelect("Functional", "Category for the new item", "")}
        <button type="button" class="btn btn-secondary" data-rv-action="add-item">+ Add checklist item</button>
      </div>`;
  }

  function stepsHtml(tc, b, caseIndex) {
    // A brand-new test case is new in every one of its steps, so per-step "New" chips repeat what
    // the chip on the case title already said — twenty times over on a long case, which buries the
    // one marker that carries information. The case keeps its chip; the steps stay plain. An
    // *edited* case is the opposite: there the per-step chips are the whole point, because they
    // are what says which steps moved.
    const caseIsNew = annotationsApply() && tc.changeType === "added";
    const rows = (tc.steps || [])
      .map(
        (st, j) => `
        <tr data-rv-step="${j}" class="${caseIsNew ? "" : changeClass(st.changeType).trim()}">
          <td class="rv-step-num">${dragHandleHtml("step", j + 1, `step ${j + 1}`)}</td>
          <td>${caseIsNew ? "" : stepChipHtml(st.changeType)}<textarea data-rv-scope="step" data-rv-field="action" rows="2"
            aria-label="Action for step ${j + 1} of test case ${caseIndex + 1}">${esc(st.action)}</textarea>${caseIsNew ? "" : changeReasonHtml(st)}</td>
          <td><textarea data-rv-scope="step" data-rv-field="expected" rows="2"
            aria-label="Expected result for step ${j + 1} of test case ${caseIndex + 1}">${esc(st.expected)}</textarea></td>
          <td class="rv-step-actions">
            ${iconBtn("step-up", `Move step ${j + 1} up`, "up")}
            ${iconBtn("step-down", `Move step ${j + 1} down`, "down")}
            ${iconBtn("step-delete", `Delete step ${j + 1}`, "del", 'data-rv-danger="1"')}
          </td>
        </tr>`
      )
      .join("");

    return `
      <table class="rv-steps">
        <thead>
          <tr><th class="rv-step-num">#</th><th>Step Action</th><th>Step Expected</th><th class="rv-step-actions">Row</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="btn btn-secondary rv-add-step" data-rv-action="add-step">+ Add step</button>`;
  }

  /**
   * Is this block a Gherkin one? The server says so; the content is the fallback.
   *
   * Requires bdd-format.js: without the converter a Gherkin view would render an
   * empty textarea and quietly swallow the scenario on submit. Falling back to
   * the steps table instead loses nothing — the rows are the canonical form.
   */
  function blockIsBdd(block) {
    if (!block || !window.BddFormat) return false;
    if (block.format) return block.format === "bdd";
    return BddFormat.anyBddTestCase((block.payload || {}).testCases);
  }

  /**
   * A scenario is edited as one block of Gherkin rather than as an action/expected
   * grid: that grid is the CSV encoding, not the artifact the QA engineer wrote.
   * The rows are rebuilt from this text on every keystroke, so what gets approved,
   * exported and imported is exactly what is on screen.
   */
  function scenarioHtml(tc, caseIndex) {
    const text = window.BddFormat ? BddFormat.stepsToGherkinText(tc.steps) : "";
    const pre = window.BddFormat ? BddFormat.splitPreconditionsRow(tc.steps).preconditions : "";
    // Preconditions get their own box because they are a different layer from
    // the scenario: what a run needs before it can start (environment, access,
    // seeded data), not the business context the Given lines carry. Editing
    // either box rebuilds the rows from both.
    const preLines = BddFormat ? BddFormat.splitCellLines(pre).join("\n") : pre;
    return `
      <label class="rv-pre-label" for="rvPre${caseIndex}">Preconditions${infoHtml("Environment, access, test data — not the Given lines.")}</label>
      <textarea class="rv-pre" id="rvPre${caseIndex}" data-rv-field="preconditions" rows="2"
        placeholder="Leave empty when the scenario needs no setup beyond a normal environment">${esc(preLines)}</textarea>
      <label class="rv-pre-label" for="rvGherkin${caseIndex}">Scenario${infoHtml("One Gherkin line per row — Given / When / Then / And / But.")}</label>
      <textarea class="rv-gherkin" id="rvGherkin${caseIndex}" data-rv-field="gherkin" rows="${Math.max(3, (text.match(/\n/g) || []).length + 1)}"
        spellcheck="false"
        aria-label="Gherkin steps of scenario ${caseIndex + 1}"
        placeholder="Given …&#10;When …&#10;Then …">${esc(text)}</textarea>`;
  }

  /** The Feature name the scenarios in this block belong to. */
  function featureHtml(block, b) {
    const feature = String((block.payload && block.payload.feature) || "");
    return `
      <div class="rv-feature">
        <label for="rvFeature${b}">Feature</label>
        <input type="text" id="rvFeature${b}" class="rv-feature-input" data-rv-block-field="feature"
          value="${esc(feature)}" placeholder="The capability under test" />
      </div>`;
  }

  function testCasesHtml(block, b) {
    const cases = block.payload.testCases || [];
    const isBdd = blockIsBdd(block);
    const noun = isBdd ? "scenario" : "test case";
    if (!cases.length) {
      return `<p class="rv-empty">${esc(emptyBlockNote(`${noun}s`, { canAdd: false }))}</p>`;
    }
    const body = cases
      .map(
        (tc, i) => `
        <article class="rv-case${isBdd ? " rv-case-bdd" : ""}${busyRows.has(rowKey(b, i)) ? " rv-busy-row" : ""}${changeClass(tc.changeType)}" data-rv-index="${i}" data-rv-scope="case">
          <header class="rv-case-head">
            <span class="rv-num">${i + 1}</span>
            ${changeChipHtml(tc.changeType)}
            <textarea class="rv-case-title" data-rv-field="title" rows="1"
              aria-label="Title of ${noun} ${i + 1}">${esc(tc.title)}</textarea>
            ${approveBtnHtml(tc, `${noun} ${i + 1}`)}
            <span class="rv-item-actions">
              ${iconBtn("regen", `Regenerate ${noun} ${i + 1} with the AI`, "regen")}
              ${iconBtn("move-up", `Move ${noun} ${i + 1} up`, "up")}
              ${iconBtn("move-down", `Move ${noun} ${i + 1} down`, "down")}
              ${iconBtn("delete", `Delete ${noun} ${i + 1}`, "del", 'data-rv-danger="1"')}
            </span>
          </header>
          <div class="rv-case-meta">
            <label>Priority
              <select data-rv-field="priority" aria-label="Priority of ${noun} ${i + 1}">
                <option value="1"${String(tc.priority) === "1" ? " selected" : ""}>1</option>
                <option value="2"${String(tc.priority) !== "1" ? " selected" : ""}>2</option>
              </select>
            </label>
            <label>Area Path
              <input type="text" data-rv-field="areaPath" value="${esc(tc.areaPath)}"
                aria-label="Area path of ${noun} ${i + 1}" />
            </label>
            <span class="rv-case-count">${
              isBdd
                ? `${(window.BddFormat ? BddFormat.stepsToGherkinLines(tc.steps) : []).length} line(s)`
                : `${(tc.steps || []).length} step(s)`
            }</span>
            ${tc.regenerated ? badgeHtml() : ""}
          </div>
          ${changeReasonHtml(tc)}
          ${guideHtml(`What should change in this ${noun}? (optional)`)}
          ${
            busyRows.has(rowKey(b, i))
              ? spinnerHtml(`Regenerating ${noun} ${i + 1}…`)
              : isBdd
              ? scenarioHtml(tc, i)
              : stepsHtml(tc, b, i)
          }
        </article>`
      )
      .join("");
    return isBdd ? featureHtml(block, b) + body : body;
  }

  /** Update blocks get their own header + Regenerate control; Create's single block does not. */
  function blockHeaderHtml(block, b) {
    if (review.flow !== "update") return "";
    const kind =
      block.type === "testcase" ? (blockIsBdd(block) ? "BDD scenarios" : "Test cases") : "Checklist";
    const pos = block.placement ? `Block ${block.placement.blockIndex}/${block.placement.totalBlocks}` : `Block ${b + 1}`;
    return `
      <div class="rv-block-head">
        <span class="rv-block-pos">${esc(pos)}</span>
        <span class="rv-block-kind${blockIsBdd(block) ? " rv-block-kind-bdd" : ""}">${esc(kind)}</span>
        ${block.title ? `<span class="rv-block-title">${esc(block.title)}</span>` : ""}
        <span class="rv-item-actions">
          ${iconBtn("regen-block", `Regenerate the whole of ${pos}`, "regen")}
        </span>
      </div>
      ${guideHtml("What should change in this whole block? (optional)")}`;
  }

  /**
   * The block's approval state, and the two bulk moves.
   *
   * Marking twenty rows one by one is not review, it is clicking — but the default stays "nothing
   * approved", so pressing "Approve all" is itself a deliberate act the reviewer takes after
   * reading. The count is the honest summary of what Submit will write.
   */
  function approveBarHtml(block, b) {
    if (!approvalApplies()) return "";
    const rows = rowsOf(block);
    if (!rows.length) return "";
    const approved = rows.filter((r) => r.approved).length;
    const noun = block.type === "testcase" ? (blockIsBdd(block) ? "scenario" : "test case") : "item";
    return `
      <div class="rv-approve-bar">
        <span class="rv-approve-count${approved ? " is-some" : ""}">${approved} of ${rows.length} ${esc(noun)}${
          rows.length === 1 ? "" : "s"
        } approved</span>
        <button type="button" class="btn btn-secondary rv-approve-bulk" data-rv-action="approve-all"${
          approved === rows.length ? " disabled" : ""
        }>Approve all</button>
        <button type="button" class="btn btn-secondary rv-approve-bulk" data-rv-action="approve-none"${
          approved === 0 ? " disabled" : ""
        }>Clear</button>
      </div>`;
  }

  function blockHtml(block, b) {
    const inner = busyBlocks.has(b)
      ? spinnerHtml(
          queuedBlocks.has(b)
            ? "Waiting for the blocks above to finish regenerating…"
            : block.type === "testcase"
            ? "Regenerating all test cases in this block…"
            : "Regenerating the whole checklist…"
        )
      : block.type === "testcase"
      ? testCasesHtml(block, b)
      : checklistHtml(block, b);
    return `
      <section class="rv-block${busyBlocks.has(b) ? " rv-busy-block" : ""}" data-rv-block="${b}">
        ${blockHeaderHtml(block, b)}
        ${busyBlocks.has(b) ? "" : removedHtml(block)}
        ${busyBlocks.has(b) ? "" : approveBarHtml(block, b)}
        <div class="rv-block-body">${inner}</div>
      </section>`;
  }

  function autoGrow(el) {
    if (!el || el.tagName !== "TEXTAREA") return;
    el.style.height = "auto";
    // `scrollHeight` is content + padding only, but `box-sizing: border-box` makes the height we
    // set carry the borders too — without adding them back a bordered box lands a line short and
    // clips the text it was grown to show.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.max(el.scrollHeight + borders, 38)}px`;
  }

  /**
   * What an emptied block says about itself.
   *
   * On Update a block is one CSV segment, and emptying it is a decision — that
   * segment needs no update. Submit skips it and posts the rest, so the line
   * must not read like a dead end the reviewer has to undo.
   */
  function emptyBlockNote(what, { canAdd }) {
    if (review.flow === "update") {
      return `No ${what} left — this block will be skipped; the other blocks still post.`;
    }
    // Only a checklist has an "+ Add" button; a test case can only come back from a regenerate.
    return canAdd
      ? `No ${what} left — add one below or regenerate.`
      : `No ${what} left — regenerate to get a new set.`;
  }

  function rowCount() {
    return (review.blocks || []).reduce((n, blk) => n + rowsOf(blk).length, 0);
  }

  /** How many rows Submit would write into the CSV. */
  function approvedCount() {
    return (review.blocks || []).reduce((n, blk) => n + rowsOf(blk).filter((r) => r.approved).length, 0);
  }

  function usageText() {
    if (!usage || !usage.calls) return "";
    const n = (v) => Number(v || 0).toLocaleString("en-US");
    const cost = usage.hasCost ? ` · $${usage.costUsd.toFixed(4)}` : "";
    return (
      `${n(usage.totalTokens)} tokens this run ` +
      `(${n(usage.promptTokens)} in + ${n(usage.completionTokens)} out, ` +
      `${usage.calls} AI call${usage.calls === 1 ? "" : "s"})${cost}`
    );
  }

  /** Tell the page the draft moved, so it can keep a copy (PageDraft). */
  function notifyChange() {
    if (cfg && cfg.onChange) cfg.onChange();
  }

  function render() {
    paint();
    notifyChange();
  }

  function paint() {
    const panel = document.getElementById("reviewPanel");
    if (!panel) return;
    if (!review) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    const isUpdate = review.flow === "update";
    const blocks = review.blocks || [];
    const onlyChecklist = blocks.every((b) => b.type !== "testcase");
    const anyBdd = blocks.some(blockIsBdd);

    // Counted rather than hard-coded: the Cover a bug flow always produces exactly one, and
    // "Review generated test cases" above a single case reads like something went missing.
    const one = rowCount() === 1;
    document.getElementById("reviewTitle").textContent = isUpdate
      ? "Review updated test design"
      : onlyChecklist
      ? "Review generated checklist"
      : anyBdd
      ? `Review generated BDD ${one ? "scenario" : "scenarios"} (Gherkin)`
      : `Review generated test ${one ? "case" : "cases"}`;

    const scope = isUpdate
      ? `${blocks.length} block(s) from ${review.csvFile || "the CSV"}${anyBdd ? " · BDD block(s) update in Gherkin" : ""}`
      : `${rowCount()} ${onlyChecklist ? (one ? "item" : "items") : anyBdd ? (one ? "scenario" : "scenarios") : one ? "test case" : "test cases"}`;
    const submitDesc = submitCfg();
    document.getElementById("reviewSub").textContent =
      `${scope} · ${review.issueKey}${review.issueSummary ? ` — ${review.issueSummary}` : ""}` +
      ` · ${submitDesc.subNote(review)}`;

    document.getElementById("reviewSubmitHint").textContent = submitDesc.hint(review);

    // "Regenerate all" is the whole draft in both flows: Create's one block, or every block of the
    // Update — redone from the stored context, so unlike pressing Run again nothing is re-read
    // (no Jira, no Figma, no prototype crawl) and the run log is left alone.
    const regenAll = document.getElementById("reviewRegenAllBtn");
    if (regenAll) {
      regenAll.setAttribute(
        "data-rv-tip",
        isUpdate
          ? `Regenerate every block (${blocks.length}) from its original CSV rows`
          : "Discard this draft and generate a new one"
      );
      regenAll.hidden = isUpdate && blocks.length === 0;
    }
    const regenAllCtx = document.getElementById("reviewRegenAllContext");
    if (regenAllCtx) {
      regenAllCtx.placeholder = isUpdate
        ? "Applies to every block, e.g. add the new error message to every case that saves the form"
        : "e.g. cover the refund path for already-shipped orders in more depth";
    }

    const body = document.getElementById("reviewBody");
    body.innerHTML = blocks.map(blockHtml).join("");
    body.querySelectorAll("textarea").forEach(autoGrow);

    panel.classList.toggle("rv-all-busy", busyBlocks.size > 0);
    panel.classList.toggle("rv-rows-busy", busyRows.size > 0);

    const usageEl = document.getElementById("reviewUsage");
    if (usageEl) {
      const text = usageText();
      usageEl.textContent = text;
      usageEl.hidden = !text;
    }
    // `ready` lets the owning page gate the button on state the panel cannot see — the Test case
    // from issue flow needs a chosen import container. The hint above says what is missing.
    // Where the button *sits* is the page's business: that flow moves it out of this footer
    // entirely, and getElementById finds it wherever the markup puts it.
    const submitReady = !submitDesc.ready || submitDesc.ready(review);
    // Nothing approved means nothing would be written, so the button says so by being off.
    const nothingApproved = approvalApplies() && approvedCount() === 0;
    // Something the page knows is missing outright (Jira not set up): off, with the reason on hover.
    const blocked = (submitDesc.blocked && submitDesc.blocked(review)) || null;
    const submitBtn = document.getElementById("reviewSubmitBtn");
    submitBtn.disabled = rowCount() === 0 || nothingApproved || anythingBusy() || !submitReady || !!blocked;
    if (typeof UiTips !== "undefined") UiTips.gate(submitBtn, blocked);
    if (blocked) document.getElementById("reviewSubmitHint").textContent = blocked.text;
  }

  function showError(msg) {
    const el = document.getElementById("reviewErr");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function setBusyNote(text) {
    const el = document.getElementById("reviewBusy");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  }

  /* ---------------------------- editing ---------------------------- */

  function move(arr, from, to) {
    if (to < 0 || to >= arr.length) return false;
    const [el] = arr.splice(from, 1);
    arr.splice(to, 0, el);
    return true;
  }

  function renumberSteps(tc) {
    (tc.steps || []).forEach((st, i) => {
      st.stepNumber = i + 1;
    });
  }

  function blockOf(el) {
    const holder = el.closest("[data-rv-block]");
    if (!holder) return { b: -1, block: null };
    const b = Number(holder.getAttribute("data-rv-block"));
    return { b, block: (review.blocks || [])[b] || null };
  }

  /** Resolve the payload object a control edits, from its data-rv-* ancestors. */
  function targetFor(el) {
    const { block } = blockOf(el);
    if (!block) return null;
    const scope = el.getAttribute("data-rv-scope") || el.closest("[data-rv-scope]")?.getAttribute("data-rv-scope");
    const holder = el.closest("[data-rv-index]");
    if (!holder) return null;
    const index = Number(holder.getAttribute("data-rv-index"));
    if (scope === "item") return (block.payload.checklistItems || [])[index] || null;
    const tc = (block.payload.testCases || [])[index] || null;
    if (!tc) return null;
    if (scope === "step") {
      const row = el.closest("[data-rv-step]");
      if (!row) return null;
      return (tc.steps || [])[Number(row.getAttribute("data-rv-step"))] || null;
    }
    return tc;
  }

  /**
   * The title box is a textarea so a long title wraps and is readable in full, but a title is
   * still ONE line of CSV — Enter must not be able to break it in two.
   */
  function onBodyKeydown(e) {
    if (e.key !== "Enter") return;
    const el = e.target;
    if (el && el.classList && el.classList.contains("rv-case-title")) e.preventDefault();
  }

  /** Same rule for text arriving by paste or drop, which no keydown sees. */
  function foldNewlines(el) {
    if (!/[\r\n]/.test(el.value)) return;
    const at = el.selectionStart;
    el.value = el.value.replace(/\s*[\r\n]+\s*/g, " ");
    const to = Math.min(at, el.value.length);
    el.setSelectionRange(to, to);
  }

  function onFieldInput(e) {
    const el = e.target;
    if (!review) return;

    // Block-level fields (the Feature name) live outside any row.
    const blockField = el.getAttribute && el.getAttribute("data-rv-block-field");
    if (blockField) {
      const { block } = blockOf(el);
      if (block) block.payload[blockField] = el.value;
      notifyChange();
      return;
    }

    const field = el.getAttribute && el.getAttribute("data-rv-field");
    if (!field) return;
    const target = targetFor(el);
    if (!target) return;
    // The scenario is edited as two boxes — preconditions and Gherkin — but the
    // payload keeps one representation, `steps`. So either edit rebuilds the rows
    // from both boxes, and nothing downstream ever sees the raw text.
    if (field === "gherkin" || field === "preconditions") {
      if (window.BddFormat) {
        const holder = el.closest("[data-rv-index]");
        const gherkinEl = holder && holder.querySelector('[data-rv-field="gherkin"]');
        const preEl = holder && holder.querySelector('[data-rv-field="preconditions"]');
        target.steps = BddFormat.gherkinTextToSteps(gherkinEl ? gherkinEl.value : "", {
          preconditions: preEl ? preEl.value : "",
        });
      }
      autoGrow(el);
      notifyChange();
      return;
    }
    if (field === "title") foldNewlines(el);
    // Write straight into the payload instead of re-rendering: a re-render on every keystroke
    // would steal focus from the field being typed into.
    target[field] = field === "priority" ? Number(el.value) : el.value;
    autoGrow(el);
    notifyChange();
  }

  function onBodyClick(e) {
    const btn = e.target.closest("[data-rv-action]");
    if (!btn || !review) return;
    const action = btn.getAttribute("data-rv-action");
    const { b, block } = blockOf(btn);
    if (!block) return;
    const holder = btn.closest("[data-rv-index]");
    const index = holder ? Number(holder.getAttribute("data-rv-index")) : null;
    const isChecklist = block.type !== "testcase";

    if (action === "regen" || action === "regen-block" || action === "regen-cancel") {
      // The block-level box lives in the block header; a row's box lives in that row.
      const owner = action === "regen-block" ? btn.closest(".rv-block") : holder;
      const guide = owner && owner.querySelector("[data-rv-guide]");
      if (!guide) return;
      const opening = action !== "regen-cancel" ? guide.hidden : false;
      guide.hidden = !opening;
      if (opening) guide.querySelector("[data-rv-guide-input]").focus();
      return;
    }

    if (action === "regen-run") {
      const guide = btn.closest("[data-rv-guide]");
      const text = guide ? guide.querySelector("[data-rv-guide-input]").value : "";
      // A box that is not inside a row belongs to the block header.
      const inRow = guide && guide.closest("[data-rv-index]");
      if (inRow) {
        regenerate(b, isChecklist ? "item" : "testcase", index, text);
      } else {
        regenerate(b, review.flow === "update" ? "block" : "all", null, text);
      }
      return;
    }

    if (action === "add-item") {
      const select = btn.parentElement.querySelector("select");
      block.payload.checklistItems = block.payload.checklistItems || [];
      block.payload.checklistItems.push({
        id: `CL-${String(block.payload.checklistItems.length + 1).padStart(3, "0")}`,
        description: "",
        category: (select && select.value) || "Functional",
      });
      render();
      const last = document.querySelector(`[data-rv-block="${b}"] .rv-item:last-of-type .rv-desc`);
      if (last) last.focus();
      return;
    }

    if (action === "move-up" || action === "move-down") {
      const arr = isChecklist ? block.payload.checklistItems : block.payload.testCases;
      if (move(arr, index, index + (action === "move-up" ? -1 : 1))) render();
      return;
    }

    if (action === "approve" || action === "approve-all" || action === "approve-none") {
      const rows = rowsOf(block);
      if (action === "approve") {
        const row = rows[index];
        if (!row) return;
        row.approved = !row.approved;
      } else {
        const on = action === "approve-all";
        rows.forEach((r) => {
          r.approved = on;
        });
      }
      render();
      return;
    }

    if (action === "delete") {
      const arr = isChecklist ? block.payload.checklistItems : block.payload.testCases;
      arr.splice(index, 1);
      render();
      return;
    }

    const tc = (block.payload.testCases || [])[index];
    if (!tc) return;

    if (action === "add-step") {
      tc.steps = tc.steps || [];
      tc.steps.push({ stepNumber: tc.steps.length + 1, action: "", expected: "" });
      render();
      const rows = document.querySelectorAll(`[data-rv-block="${b}"] .rv-case[data-rv-index="${index}"] tbody tr`);
      const lastRow = rows[rows.length - 1];
      if (lastRow) lastRow.querySelector("textarea").focus();
      return;
    }

    const row = btn.closest("[data-rv-step]");
    if (!row) return;
    const stepIndex = Number(row.getAttribute("data-rv-step"));

    if (action === "step-up" || action === "step-down") {
      if (move(tc.steps, stepIndex, stepIndex + (action === "step-up" ? -1 : 1))) {
        renumberSteps(tc);
        render();
      }
      return;
    }

    if (action === "step-delete") {
      tc.steps.splice(stepIndex, 1);
      renumberSteps(tc);
      render();
    }
  }

  /* ---------------------------- drag and drop ---------------------------- */
  /**
   * Checklist items and test-case steps reorder by dragging their number. A row only moves within
   * its own list — a step never lands in another case, an item never in another block — and the
   * numbers are rewritten on drop, exactly as the up/down arrows do.
   */
  let drag = null;

  /** The draggable row an element sits in, and the list it belongs to. */
  function dragRowOf(el, kind) {
    const row = el && el.closest(kind === "step" ? "tr[data-rv-step]" : '.rv-item[data-rv-scope="item"]');
    if (!row) return null;
    const { b } = blockOf(row);
    const caseEl = kind === "step" ? row.closest("[data-rv-index]") : null;
    return {
      row,
      b,
      caseIndex: caseEl ? Number(caseEl.getAttribute("data-rv-index")) : null,
      index: Number(row.getAttribute(kind === "step" ? "data-rv-step" : "data-rv-index")),
    };
  }

  function clearDropMarks() {
    document
      .querySelectorAll("#reviewBody .rv-drop-before, #reviewBody .rv-drop-after")
      .forEach((el) => el.classList.remove("rv-drop-before", "rv-drop-after"));
  }

  function onDragStart(e) {
    const handle = e.target.closest && e.target.closest("[data-rv-drag]");
    if (!handle || !review) return;
    const kind = handle.getAttribute("data-rv-drag");
    const src = dragRowOf(handle, kind);
    // A row being regenerated is written back by index, so nothing moves while anything is busy.
    if (!src || anythingBusy()) {
      e.preventDefault();
      return;
    }
    drag = { kind, ...src };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    // The whole row as the ghost image, not just the little number.
    const r = src.row.getBoundingClientRect();
    e.dataTransfer.setDragImage(src.row, Math.min(e.clientX - r.left, r.width), Math.min(e.clientY - r.top, r.height));
    src.row.classList.add("rv-dragging");
  }

  /** Where the dragged row would land: the row under the pointer and which half of it. */
  function dropTargetFor(e) {
    if (!drag) return null;
    const over = dragRowOf(e.target, drag.kind);
    if (!over || over.b !== drag.b || over.caseIndex !== drag.caseIndex) return null;
    const r = over.row.getBoundingClientRect();
    return { ...over, after: e.clientY > r.top + r.height / 2 };
  }

  function onDragOver(e) {
    const t = dropTargetFor(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    if (t.index !== drag.index) t.row.classList.add(t.after ? "rv-drop-after" : "rv-drop-before");
  }

  function onDrop(e) {
    const t = dropTargetFor(e);
    if (!t) return;
    // Also stops a textarea under the pointer from receiving the (empty) dragged text.
    e.preventDefault();
    const block = review.blocks[drag.b];
    let to = t.index + (t.after ? 1 : 0);
    if (drag.index < to) to -= 1;
    const from = drag.index;
    const kind = drag.kind;
    const tc = kind === "step" ? (block.payload.testCases || [])[drag.caseIndex] : null;
    onDragEnd();
    if (to === from) return;
    if (kind === "step") {
      if (tc && move(tc.steps, from, to)) {
        renumberSteps(tc);
        render();
      }
    } else if (move(block.payload.checklistItems, from, to)) {
      render();
    }
  }

  function onDragEnd() {
    if (drag && drag.row) drag.row.classList.remove("rv-dragging");
    drag = null;
    clearDropMarks();
  }

  /* ---------------------------- server calls ---------------------------- */

  /**
   * A 405 on an API path means the running server process predates this page's JavaScript:
   * static files are re-read from disk on every request, but Node never reloads its own code.
   */
  function staleServerHint(status) {
    return status === 405
      ? "This page is newer than the running server. Stop `npm run web` and start it again, then retry."
      : "";
  }

  async function post(url, body) {
    const res = await fetch(cfg.apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok || data.ok === false) {
      const hint = staleServerHint(res.status);
      throw new Error(`${data.error || res.statusText || "Request failed"}${hint ? ` — ${hint}` : ""}`);
    }
    return data;
  }

  function addUsage(u) {
    if (!u || !u.calls) return;
    if (!usage) usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, hasCost: false };
    usage.calls += u.calls || 0;
    usage.promptTokens += u.promptTokens || 0;
    usage.completionTokens += u.completionTokens || 0;
    usage.totalTokens += u.totalTokens || 0;
    if (u.hasCost) {
      usage.costUsd += u.costUsd || 0;
      usage.hasCost = true;
    }
  }

  /**
   * Drop panel-only bookkeeping before anything leaves the browser: `regenerated` drives the
   * badge, and `changeType`/`changeReason` drive the colouring and the reason lines. The Jira
   * comment already carries the model's own changeSummary section, so none of this belongs in the
   * posted content or in the JSON attachment the approval step reads back.
   */
  function cleanPayload(payload) {
    const cleanRow = ({ regenerated, changeType, changeReason, steps, ...rest }) => {
      const row = { ...rest };
      if (Array.isArray(steps)) {
        row.steps = steps.map(({ changeType: _t, changeReason: _r, ...step }) => step);
      }
      return row;
    };
    const out = { ...payload };
    delete out.removed;
    if (Array.isArray(out.checklistItems)) out.checklistItems = out.checklistItems.map(cleanRow);
    if (Array.isArray(out.testCases)) out.testCases = out.testCases.map(cleanRow);
    return out;
  }

  function editsForApi() {
    return review.flow === "update"
      ? { blocks: (review.blocks || []).map((b) => ({ payload: cleanPayload(b.payload) })) }
      : { payload: cleanPayload(review.blocks[0].payload) };
  }

  /**
   * Say which suites / sections / folders the guidance pulled in from the TMS — or that a name the
   * reviewer quoted does not exist there, which would otherwise look exactly like being ignored.
   * Held longer than a normal toast: it is a sentence worth reading, not a confirmation.
   */
  function reportGuidanceContext(g) {
    if (!g || !cfg.toast) return;
    const parts = [];
    if (g.matched && g.matched.length) {
      parts.push(
        `Context from ${g.providerTitle}: ${g.matched.map((m) => `${m.path} (${m.caseCount} case(s))`).join(", ")}`
      );
    }
    if (g.unmatchedQuotes && g.unmatchedQuotes.length) {
      parts.push(`Not found in ${g.providerTitle}: ${g.unmatchedQuotes.map((q) => `"${q}"`).join(", ")}`);
    }
    if (!parts.length && g.notes && g.notes.length) parts.push(g.notes[0]);
    if (parts.length) cfg.toast(parts.join(" · "), 7000);
  }

  /**
   * @param {number} b - block index
   * @param {"all"|"block"|"item"|"testcase"} kind
   * @param {number|null} index - row index, for row-level kinds
   *
   * The loader is scoped to what is being redone: the whole block for "all"/"block", that single
   * row otherwise. Rows that come back get a "Regenerated" marker; a whole-block regeneration
   * deliberately gets none, because then every row is new and the marker would distinguish nothing.
   */
  async function regenerate(b, kind, index, userGuidance) {
    if (!review) return;
    const wholeBlock = kind === "all" || kind === "block";
    if (!wholeBlock && busyRows.has(rowKey(b, index))) return;
    if (wholeBlock && busyBlocks.has(b)) return;
    showError("");

    if (wholeBlock) busyBlocks.add(b);
    else busyRows.add(rowKey(b, index));
    render();

    try {
      await regenerateOnce(b, kind, index, userGuidance);
    } catch (e) {
      showError(e.message || "Regeneration failed");
    } finally {
      if (wholeBlock) busyBlocks.delete(b);
      else busyRows.delete(rowKey(b, index));
      render();
    }
  }

  /**
   * "Regenerate all" on Update: every block, one after another, with the same guidance.
   *
   * One at a time rather than all at once: each call rewrites the shared server-side session, and
   * parallel writes would race and drop each other's results; it also keeps the request rate to
   * the model and the TMS (when the guidance names a suite) where a single regenerate has it.
   * A block that fails does not stop the rest — the errors are listed together at the end, and
   * the failed block keeps the content it had.
   */
  async function regenerateAllBlocks(userGuidance) {
    if (!review || anythingBusy()) return;
    const total = (review.blocks || []).length;
    if (!total) return;
    const session = review.sessionId;
    showError("");
    for (let b = 0; b < total; b += 1) {
      busyBlocks.add(b);
      queuedBlocks.add(b);
    }
    render();

    const failed = [];
    for (let b = 0; b < total; b += 1) {
      // A new Run (or a restored draft) replaced the review while this loop waited on the server.
      if (!review || review.sessionId !== session) break;
      queuedBlocks.delete(b);
      setBusyNote(`Regenerating block ${b + 1} of ${total}…`);
      paint();
      try {
        await regenerateOnce(b, "block", null, userGuidance);
      } catch (e) {
        failed.push(`Block ${b + 1}: ${e.message || "Regeneration failed"}`);
      } finally {
        busyBlocks.delete(b);
        render();
      }
    }
    setBusyNote("");
    if (!review || review.sessionId !== session) return;
    if (failed.length) showError(`${failed.length} of ${total} block(s) not regenerated — ${failed.join(" · ")}`);
    else cfg.toast(`All ${total} block(s) regenerated`);
  }

  /** One /review/regenerate round-trip; the caller owns the busy marks and shows the error. */
  async function regenerateOnce(b, kind, index, userGuidance) {
    const wholeBlock = kind === "all" || kind === "block";
    const session = review.sessionId;
    const data = await post("/__da/review/regenerate", {
      projectPath: cfg.getProjectPath(),
      sessionId: session,
      blockIndex: b,
      kind,
      index,
      userGuidance: userGuidance || "",
      ...editsForApi(),
    });
    // The panel was reset or replaced by a new Run while the model was working.
    if (!review || review.sessionId !== session) return;
    addUsage(data.usage);
    reportGuidanceContext(data.guidanceContext);
    const block = review.blocks[b];
    // A regenerated row arrives without its APPROVED mark, and that is the point: what the
    // reviewer approved is not what is on screen any more, so it has to be read again.
    if (wholeBlock && data.payload) {
      block.payload = data.payload;
    } else if (kind === "item" && data.item) {
      block.payload.checklistItems[data.index] = { ...data.item, regenerated: true };
    } else if (kind === "testcase" && data.testCase) {
      renumberSteps(data.testCase);
      block.payload.testCases[data.index] = { ...data.testCase, regenerated: true };
    }
  }

  async function submit() {
    if (!review) return;
    const desc = submitCfg();
    // `body()` is also where a page validates what it is about to add to the request — an
    // unpicked import target throws here, before anything is marked busy.
    let extra = {};
    try {
      extra = (desc.body && desc.body(review)) || {};
    } catch (e) {
      showError(e.message || "Nothing to submit");
      return;
    }
    showError("");
    submitting = true;
    const busyNote = desc.busy(review);
    setBusyNote(busyNote);
    // The Cover a bug flow puts its button outside this panel, so the panel's own
    // "Working…" line is nowhere near it — `onBusy` lets that page show its own indicator.
    if (desc.onBusy) desc.onBusy(true, busyNote);
    render();
    try {
      const data = await post(desc.url, {
        projectPath: cfg.getProjectPath(),
        sessionId: review.sessionId,
        ...editsForApi(),
        ...extra,
      });
      if (data.log) cfg.appendLog(`\n${data.log}`);
      // Posting to Jira happens once, so Create and Update drop the draft. An import can
      // legitimately repeat — the same case into a second suite — so that flow keeps it.
      if (!desc.keepAfterSubmit) review = null;
      render();
      cfg.toast(desc.done(data));
      if (desc.after) desc.after(data);
    } catch (e) {
      showError(e.message || "Submit failed");
    } finally {
      submitting = false;
      setBusyNote("");
      if (desc.onBusy) desc.onBusy(false, "");
      render();
    }
  }

  /* ---------------------------- public API ---------------------------- */

  return {
    /**
     * @param {{
     *   apiUrl: Function,
     *   getProjectPath: Function,
     *   appendLog: Function,
     *   toast: Function,
     *   onChange?: Function,
     *   submit?: { url: string, subNote: Function, hint: Function, busy: Function, done: Function,
     *              body?: Function, after?: Function, ready?: Function, onBusy?: Function,
     *              blocked?: Function, keepAfterSubmit?: boolean }
     * }} options `submit` replaces the default "post to Jira" footer behaviour; see JIRA_SUBMIT.
     *   `onChange` fires whenever the draft changes, for the page to keep a copy.
     */
    configure(options) {
      cfg = options;
    },

    wire() {
      const body = document.getElementById("reviewBody");
      if (!body) return;
      body.addEventListener("click", onBodyClick);
      body.addEventListener("keydown", onBodyKeydown);
      body.addEventListener("input", onFieldInput);
      body.addEventListener("change", onFieldInput);
      body.addEventListener("dragstart", onDragStart);
      body.addEventListener("dragover", onDragOver);
      body.addEventListener("drop", onDrop);
      body.addEventListener("dragend", onDragEnd);

      // An auto-grown height is only correct for the width it was measured at: narrow the window
      // and a title wraps onto a line the box no longer has room for. Re-measure on resize.
      let regrowTimer = null;
      window.addEventListener("resize", () => {
        clearTimeout(regrowTimer);
        regrowTimer = setTimeout(() => body.querySelectorAll("textarea").forEach(autoGrow), 120);
      });

      const regenAllBtn = document.getElementById("reviewRegenAllBtn");
      if (regenAllBtn) {
        regenAllBtn.addEventListener("click", () => {
          const guide = document.getElementById("reviewRegenAllGuide");
          guide.hidden = !guide.hidden;
          if (!guide.hidden) document.getElementById("reviewRegenAllContext").focus();
        });
        document.getElementById("reviewRegenAllCancelBtn").addEventListener("click", () => {
          document.getElementById("reviewRegenAllGuide").hidden = true;
        });
        document.getElementById("reviewRegenAllRunBtn").addEventListener("click", () => {
          const text = document.getElementById("reviewRegenAllContext").value;
          document.getElementById("reviewRegenAllGuide").hidden = true;
          if (review && review.flow === "update") regenerateAllBlocks(text);
          else regenerate(0, "all", null, text);
        });
      }
      document.getElementById("reviewSubmitBtn").addEventListener("click", submit);
    },

    /**
     * Repaint with the content unchanged. For a page whose submit hint depends on state the
     * panel does not own — the Cover a bug picker, which can move while a draft is
     * already on screen. A no-op when there is nothing to show.
     */
    refresh() {
      paint();
    },

    /** The draft as plain data, for PageDraft; null when there is nothing on screen. */
    snapshot() {
      return review ? JSON.parse(JSON.stringify({ review, usage })) : null;
    },

    /** Put back a snapshot() taken before the page was left. */
    restore(snap) {
      if (!snap || !snap.review) return;
      review = snap.review;
      usage = snap.usage || null;
      busyBlocks.clear();
      queuedBlocks.clear();
      busyRows.clear();
      submitting = false;
      showError("");
      paint();
    },

    /** Clear the panel before a new run. */
    reset() {
      review = null;
      usage = null;
      busyBlocks.clear();
      queuedBlocks.clear();
      busyRows.clear();
      submitting = false;
      showError("");
      render();
    },

    /** Handle the {event:"review"} line from a generate stream. */
    accept(msg) {
      const blocks =
        msg.flow === "update"
          ? (msg.blocks || []).map((b) => ({
              type: b.type,
              // Per block: a CSV can mix standard cases and Gherkin scenarios.
              format: b.format || "standard",
              title: b.title || "",
              placement: b.placement || null,
              payload: b.payload || {},
            }))
          : [
              {
                type: msg.mode === "testcases" ? "testcase" : "checklist",
                format: msg.format || "standard",
                title: "",
                placement: null,
                payload: msg.payload || {},
              },
            ];
      review = {
        // "issue" renders exactly like "create" — one block, one payload — and differs only in
        // what the footer button does, which configure({ submit }) owns.
        flow: msg.flow === "update" ? "update" : msg.flow === "issue" ? "issue" : "create",
        sessionId: msg.sessionId,
        issueKey: msg.issueKey,
        issueSummary: msg.issueSummary || "",
        postTargetKey: msg.postTargetKey,
        csvFile: msg.csvFile || "",
        blocks,
      };
      addUsage(msg.usage);
      showError("");
      render();
    },

    staleServerHint,
  };
})();
