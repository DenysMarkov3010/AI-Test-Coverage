/**
 * Setup page — renders itself from the schema served by config-store.js, so a
 * new setting appears here as soon as it is added there.
 *
 * Secrets are never sent to the browser. A stored token is shown as "stored"
 * next to an empty input; leaving that input untouched sends the KEEP sentinel
 * back, so saving unrelated fields cannot wipe it.
 */

const $ = (id) => document.getElementById(id);

/** API lives on the same machine as web-ui-server.js; an embedded browser may use a different page origin. */
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

// ── state ──────────────────────────────────────────────────────────────────

/** Whole payload of the last GET/POST /__da/config. */
let config = null;
/** key -> input element, for collect() and live badge updates. */
const inputs = new Map();
/**
 * Per-secret UI state:
 *   "stored"  — a token is on disk; the field shows a mask and saving keeps it
 *   "editing" — user chose Replace; an empty field still keeps the stored one
 *   "cleared" — user chose Remove; saving sends "" and deletes it
 *   "unset"   — nothing on disk
 */
const secretState = new Map();
/** key -> the buttons and note belonging to one secret field. */
const secretControls = new Map();
let dirty = false;

/** Field keys of every live dropdown on the page (see `remote` in the schema). */
let remoteFields = [];
/**
 * Per-picker load state, keyed by field key:
 *   options — rows from the server; null until one load has succeeded
 *   detail  — the server's one-line summary ("12 sections")
 *   error   — message from the last failed load
 *   loading — a request is in flight
 *
 * @type {Map<string, { options: Array<object>|null, detail: string, error: string, loading: boolean }>}
 */
const remoteState = new Map();
/** Reload debounce timers, keyed by the picker they belong to. */
const remoteTimers = new Map();
/**
 * Request counter per picker. Switching project twice in a row leaves two
 * requests in flight, and they can answer out of order — only the newest
 * sequence is allowed to write its result.
 */
const remoteSeq = new Map();

/** Provider marked "In use". Local until Save, like every other edited value. */
let activeProviderId = "";

/** What a stored secret looks like in its field. Fixed width — the real length is in the note. */
const SECRET_MASK = "•".repeat(20);

// ── small DOM helpers ──────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ── field values ───────────────────────────────────────────────────────────

/** Was a secret already on disk when this page loaded? */
function secretOnDisk(key) {
  const meta = config.secrets && config.secrets[key];
  return !!(meta && meta.set);
}

/** Text the user actually typed into a field (never the mask). */
function typedValue(field) {
  if (field.secret && secretState.get(field.key) === "stored") return "";
  const input = inputs.get(field.key);
  return input ? String(input.value || "").trim() : "";
}

/** True when this field counts as filled for the section badge. */
function isFilled(field) {
  if (!field.secret) return !!typedValue(field);
  const state = secretState.get(field.key);
  if (state === "cleared") return false;
  // While replacing, the stored value still counts: an empty box keeps it.
  return !!typedValue(field) || secretOnDisk(field.key);
}

/** What Save should persist for this field. */
function valueForSave(field) {
  const typed = typedValue(field);
  if (!field.secret) return typed;
  if (secretState.get(field.key) === "cleared") return "";
  if (typed) return typed;
  // Nothing typed: keep whatever is stored rather than risk wiping a credential.
  return secretOnDisk(field.key) ? config.keepSecret : "";
}

function collectValues() {
  const out = {};
  for (const section of config.schema.sections) {
    for (const field of section.fields) out[field.key] = valueForSave(field);
  }
  // The provider toggle is not a field, so it is collected from its own state.
  const provider = providerSchema();
  if (provider) out[provider.key] = activeProviderId || provider.default;
  return out;
}

// ── status badges ──────────────────────────────────────────────────────────

/** Mirrors sectionStatus() in config-store.js. */
const BADGE_TEXT = {
  configured: "Configured",
  partial: "Incomplete",
  empty: "Not configured",
  off: "Off",
  defaults: "Defaults",
  custom: "Customized",
  planned: "Planned",
};

/** Only these states count as "this integration is ready". */
const READY_STATES = new Set(["configured"]);

/**
 * Recomputed from the live form, not from the server, so the badge turns green
 * the moment the last required field is filled in — before saving.
 */
function sectionState(section) {
  if (section.planned) return "planned";
  const filled = section.fields.filter((f) => isFilled(f));
  if (section.enabledBy) {
    const input = inputs.get(section.enabledBy);
    if (String((input && input.value) || "") !== "true") return "off";
  }
  const required = section.fields.filter((f) => f.required);
  if (!required.length) return filled.length ? "custom" : "defaults";
  if (required.every((f) => isFilled(f))) return "configured";
  return filled.length ? "partial" : "empty";
}

function refreshBadges() {
  let coreReady = true;
  let coreTotal = 0;
  const configuredNames = [];

  for (const section of config.schema.sections) {
    // A card with no settings, only a panel, paints its own badge (see paintExamplesBadge).
    if (section.panel && !section.fields.length) continue;
    const state = sectionState(section);
    const badge = $(`badge-${section.id}`);
    if (badge) {
      badge.className = `setup-badge is-${state}`;
      const count = state === "custom" ? ` (${section.fields.filter((f) => isFilled(f)).length})` : "";
      badge.textContent = READY_STATES.has(state) ? `✓ ${BADGE_TEXT[state]}` : `${BADGE_TEXT[state]}${count}`;
    }
    const card = $(`card-${section.id}`);
    if (card) card.classList.toggle("is-configured", READY_STATES.has(state));

    if (section.planned) continue;
    if (READY_STATES.has(state)) configuredNames.push(section.title);
    if (section.group === "core") {
      coreTotal += 1;
      if (state !== "configured") coreReady = false;
    }
  }

  const title = $("summaryTitle");
  const sub = $("summarySub");
  if (coreReady && coreTotal) {
    title.textContent = "✓ Ready to run";
    title.className = "setup-summary-title is-ok";
    sub.textContent = `Configured: ${configuredNames.join(" · ")}`;
  } else {
    title.textContent = "Required settings missing";
    title.className = "setup-summary-title is-warn";
    const missing = config.schema.sections
      .filter((s) => s.group === "core" && sectionState(s) !== "configured")
      .map((s) => s.title);
    sub.textContent = `Fill in ${missing.join(" and ")} to run the agent.`;
  }
  $("summaryPanel").hidden = false;
  // "In use" carries a warning while that provider is incomplete, so it is
  // recomputed from the same live form state as the badges.
  refreshProviderToggles();
}

function markDirty() {
  dirty = true;
  $("saveBtn").disabled = false;
  setSaveState("Unsaved changes", "warn");
  refreshBadges();
}

function setSaveState(text, kind) {
  const node = $("saveState");
  node.textContent = text || "";
  node.className = `setup-save-state${kind ? ` is-${kind}` : ""}`;
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderField(field) {
  const wrap = el("div", `setup-field${field.type === "textarea" ? " is-wide" : ""}`);

  const label = el("label", null);
  label.htmlFor = `f-${field.key}`;
  label.appendChild(document.createTextNode(field.label));
  if (field.required) label.appendChild(el("span", "setup-req", " *"));
  // The schema's hint is not printed under the field — a page you are filling
  // in should be a form, not a manual. It rides along as the label's tooltip
  // so the explanation is still one hover away, and the prose itself stays in
  // the schema, where the per-provider docs quote it from.
  if (field.hint) label.title = field.hint;
  wrap.appendChild(label);

  const row = el("div", "setup-input-row");
  let input;
  if (field.type === "remote-select") {
    // Options belong to renderRemoteField — it knows the live list.
    input = document.createElement("select");
  } else if (field.type === "select") {
    input = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = field.placeholder ? `default (${field.placeholder})` : "not set";
    input.appendChild(blank);
    for (const opt of field.options || []) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      input.appendChild(o);
    }
  } else if (field.type === "textarea") {
    input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = field.placeholder || "";
  } else {
    input = document.createElement("input");
    input.type = field.secret ? "password" : field.type === "number" ? "text" : field.type;
    input.placeholder = field.placeholder || "";
    input.autocomplete = field.secret ? "new-password" : "off";
    if (field.type === "number") input.inputMode = "numeric";
  }
  input.id = `f-${field.key}`;
  input.spellcheck = false;
  input.addEventListener("input", markDirty);
  input.addEventListener("change", markDirty);
  if (field.type === "remote-select") {
    // Choosing a value re-labels the status line, and any list scoped by this
    // field (TestRail sections live inside a suite) has to be read again.
    input.addEventListener("change", () => {
      renderRemoteStatus(field.key);
      reloadDependentsOf(field.key);
    });
  } else {
    // Typing a credential re-reads every list that posts it, so a dropdown
    // fills in as soon as the last character of the key is in place.
    const feeds = remoteFieldsSending(field.key);
    if (feeds.length) input.addEventListener("input", () => queueRemoteReload(feeds));
  }
  inputs.set(field.key, input);
  row.appendChild(input);

  if (field.secret) {
    // Replace: turn the masked, read-only field into an editable empty one.
    const replace = el("button", "setup-icon-btn", "Replace");
    replace.type = "button";
    replace.title = "Enter a new value in place of the stored one";
    replace.addEventListener("click", () => {
      secretState.set(field.key, "editing");
      renderSecret(field);
      input.focus();
    });

    // Cancel: go back to the stored value, undoing a Replace or a Remove.
    const cancel = el("button", "setup-icon-btn", "Cancel");
    cancel.type = "button";
    cancel.title = "Keep the stored value";
    cancel.addEventListener("click", () => {
      secretState.set(field.key, "stored");
      renderSecret(field);
      refreshBadges();
    });

    const reveal = el("button", "setup-icon-btn", "Show");
    reveal.type = "button";
    reveal.title = "Show / hide what you typed";
    reveal.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      reveal.textContent = showing ? "Show" : "Hide";
    });

    row.appendChild(reveal);
    row.appendChild(replace);
    row.appendChild(cancel);
    wrap.appendChild(row);

    // The value itself is never sent here, so the note carries the evidence.
    const note = el("p", "setup-secret-note");
    const text = el("span", "setup-secret-text", "");
    const remove = el("button", "setup-link-btn", "Remove");
    remove.type = "button";
    remove.title = "Delete the stored value when you save";
    remove.addEventListener("click", () => {
      secretState.set(field.key, "cleared");
      renderSecret(field);
      markDirty();
    });
    note.appendChild(text);
    note.appendChild(remove);
    wrap.appendChild(note);

    secretControls.set(field.key, { reveal, replace, cancel, note, text, remove });
  } else if (field.type === "remote-select") {
    const refresh = el("button", "setup-icon-btn", "Reload");
    refresh.type = "button";
    refresh.title = field.remote.reload;
    refresh.addEventListener("click", () => loadRemoteField(field, { force: true }));
    row.appendChild(refresh);
    wrap.appendChild(row);

    // Says which id the chosen name maps to, and carries load errors.
    const status = el("p", "setup-remote-status", "");
    status.id = `remote-status-${field.key}`;
    wrap.appendChild(status);
  } else {
    wrap.appendChild(row);
  }

  const keyTag = el("code", "setup-key", field.key);
  keyTag.title = `Environment variable: ${field.key}`;
  wrap.appendChild(keyTag);

  return wrap;
}

/**
 * Paints one secret field for its current state. A stored token shows as a
 * masked, read-only value so the field reads as filled at a glance — the real
 * characters never reach the browser, only the length does.
 */
function renderSecret(field) {
  const input = inputs.get(field.key);
  const ui = secretControls.get(field.key);
  if (!input || !ui) return;

  const state = secretState.get(field.key);

  if (state === "stored") {
    input.type = "text";
    input.value = SECRET_MASK;
    input.readOnly = true;
    input.classList.add("is-masked");
    input.placeholder = "";
    ui.reveal.hidden = true;
    ui.replace.hidden = false;
    ui.cancel.hidden = true;
    ui.remove.hidden = false;
    // The filled green field says "this is set"; no caption needed.
    ui.note.className = "setup-secret-note is-set";
    ui.text.textContent = "";
    return;
  }

  input.readOnly = false;
  input.classList.remove("is-masked");
  input.type = "password";
  input.value = "";
  ui.reveal.textContent = "Show";
  ui.reveal.hidden = false;
  ui.replace.hidden = true;
  ui.remove.hidden = true;

  if (state === "editing") {
    input.placeholder = "Paste the new value";
    ui.cancel.hidden = false;
    ui.note.className = "setup-secret-note is-editing";
    ui.text.textContent = "Replacing the saved value. Leave empty and the saved one is kept. ";
    return;
  }

  if (state === "cleared") {
    input.placeholder = field.placeholder || "";
    ui.cancel.hidden = false;
    ui.note.className = "setup-secret-note is-cleared";
    ui.text.textContent = "Will be deleted when you save. ";
    return;
  }

  input.placeholder = field.placeholder || "";
  ui.cancel.hidden = true;
  ui.note.className = "setup-secret-note";
  ui.text.textContent = "Not set yet. ";
}

// ── live dropdowns (ADO Test Plans, TestRail project/suite/section, …) ─────
//
// One mechanism for every provider: a field declares `remote.list` plus the
// keys that list needs, and the server answers with ready-made options. The
// page never learns what a "Test Plan" or a "section" is.

/** Current text of a plain field, by key. */
function formValue(key) {
  const input = inputs.get(key);
  return input ? String(input.value || "").trim() : "";
}

/** Pickers whose list is scoped by `key` — a new project means new sections. */
function remoteFieldsDependingOn(key) {
  return remoteFields.filter((k) => {
    const field = fieldByKey(k);
    return !!field && (field.remote.dependsOn || []).includes(key);
  });
}

/** Pickers that post `key` as part of their request. */
function remoteFieldsSending(key) {
  return remoteFields.filter((k) => {
    const field = fieldByKey(k);
    return !!field && (field.remote.sends || []).includes(key);
  });
}

/**
 * Request body for one picker, or null while something it needs is missing.
 *
 * A secret the user just typed is included, so the list appears before saving;
 * one that only exists on disk is left out and resolved server-side — the
 * browser is never handed a stored credential back.
 */
function remoteRequest(field) {
  const remote = field.remote;
  const values = {};
  for (const key of remote.sends || []) {
    const source = fieldByKey(key);
    const typed = source && source.secret ? typedValue(source) : formValue(key);
    if (typed) values[key] = typed;
  }
  for (const key of remote.needs || []) {
    const source = fieldByKey(key);
    const filled = values[key] || (source && source.secret && secretOnDisk(key));
    if (!filled) return null;
  }
  return { list: remote.list, values };
}

/** Debounced: typing a key character by character must not fire a request each time. */
function queueRemoteReload(keys) {
  for (const key of keys) {
    clearTimeout(remoteTimers.get(key));
    remoteTimers.set(
      key,
      setTimeout(() => loadRemoteField(key, { force: true }), 700)
    );
  }
}

/** Drops the cached list of everything scoped by `key` and reads it again. */
function reloadDependentsOf(key) {
  for (const dependent of remoteFieldsDependingOn(key)) {
    remoteState.delete(dependent);
    loadRemoteField(dependent, { force: true });
  }
}

/**
 * @param {object|string} fieldOrKey the picker, or its key
 * @param {{ force?: boolean }} [options] `force` re-reads an already loaded list
 */
async function loadRemoteField(fieldOrKey, options = {}) {
  const field = typeof fieldOrKey === "string" ? fieldByKey(fieldOrKey) : fieldOrKey;
  if (!field || !field.remote) return;
  const key = field.key;

  const state = remoteState.get(key) || { options: null, detail: "", error: "", loading: false };
  // A Reload click, or a dependency that just changed, always goes through.
  if (!options.force && (state.loading || state.options)) return;

  const request = remoteRequest(field);
  if (!request) {
    // Not an error: the credentials or the parent choice simply are not in yet.
    remoteSeq.set(key, (remoteSeq.get(key) || 0) + 1);
    remoteState.set(key, { options: null, detail: "", error: "", loading: false });
    renderRemoteField(key, field.remote.missing);
    return;
  }

  const seq = (remoteSeq.get(key) || 0) + 1;
  remoteSeq.set(key, seq);
  remoteState.set(key, { ...state, loading: true });
  renderRemoteField(key, "Loading…");
  try {
    const body = await api("/__da/tms/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (remoteSeq.get(key) !== seq) return; // a newer load has taken over
    const failed = body && body.ok === false;
    remoteState.set(key, {
      options: failed ? null : (body && body.options) || [],
      detail: (body && body.detail) || "",
      // A list can fail two ways, and they do not read the same. "Incomplete" is a card still
      // being filled in — the server is saying which field is still needed, which is guidance, not
      // a fault. Anything else really did go wrong.
      incomplete: failed && body.incomplete ? String(body.error || "") : "",
      error: failed && !body.incomplete ? String(body.error || "the server could not read the list") : "",
      loading: false,
    });
  } catch (e) {
    if (remoteSeq.get(key) !== seq) return;
    remoteState.set(key, { options: null, detail: "", error: e.message, loading: false });
  }
  renderRemoteField(key);
  autoSelectSoleOption(key);
  applyRemoteDefault(key);
  // A target arriving (or disappearing) changes whether the card is complete.
  refreshBadges();
}

/**
 * Fills a picker that names a sensible default in its schema (`remote.preselect`), once its list
 * has actually arrived and the field is still empty.
 *
 * The one case so far is the Xray Test Repository root: "/" is where Xray files a test when
 * nothing else is said, so leaving the field blank and leaving it set to the root mean the same
 * thing — and the blank version makes the reader wonder which. This is the difference from
 * autoSelectSoleOption(): that one fills a *required* field that offers no choice at all, this one
 * fills an optional field whose default is worth stating out loud.
 *
 * Never overwrites a value: a stored or already-picked folder wins, and the default is only
 * offered when the option really is in the list the server returned.
 */
function applyRemoteDefault(key) {
  const field = fieldByKey(key);
  const select = inputs.get(key);
  const state = remoteState.get(key);
  if (!field || !field.remote || !field.remote.preselect || !select) return;
  if (!state || !state.options || !state.options.length) return;
  if (String(select.value || "")) return;

  const wanted = String(field.remote.preselect);
  if (!state.options.some((o) => String(o.value) === wanted)) return;

  select.value = wanted;
  if (String(select.value || "") !== wanted) return; // the option never made it into the DOM
  renderRemoteStatus(key);
  // Same reason autoSelectSoleOption() does it: setting `.value` fires no "change" event.
  reloadDependentsOf(key);
  markDirty();
}

/**
 * Fills a required picker whose list came back with exactly one entry — a
 * single-suite TestRail project offers no choice, and the card should not read
 * "Incomplete" over a value the user cannot influence.
 *
 * Deliberately narrow: only required pickers, only while nothing is selected.
 * An optional picker left empty means "use the provider's own default"
 * (project template, instance case type), which is not the same as pinning the
 * one id that exists today. The change is marked dirty rather than saved, so
 * it is visible before it is persisted.
 */
function autoSelectSoleOption(key) {
  const field = fieldByKey(key);
  const select = inputs.get(key);
  const state = remoteState.get(key);
  if (!field || !field.required || !select) return;
  if (!state || !state.options || state.options.length !== 1) return;
  if (String(select.value || "")) return;

  select.value = String(state.options[0].value);
  if (!String(select.value || "")) return; // the option never made it into the DOM
  renderRemoteStatus(key);
  // Setting `.value` fires no "change" event, so the cascade has to be run by
  // hand: an auto-picked suite still has to re-scope the section tree.
  reloadDependentsOf(key);
  markDirty();
}

/** Rebuilds one picker's options, keeping the current selection. */
function renderRemoteField(key, loadingText) {
  const select = inputs.get(key);
  const field = fieldByKey(key);
  if (!select || !field || !field.remote) return;
  const remote = field.remote;
  const state = remoteState.get(key) || { options: null, detail: "", error: "", loading: false };
  const rows = state.options;

  // A <select> silently drops a value it has no option for, so on the first
  // pass the stored id comes from the payload, not from the empty element.
  const selected = select.dataset.ready
    ? String(select.value || "")
    : String((config.values && config.values[key]) || "");
  select.dataset.ready = "1";

  clear(select);
  // Only offer an empty row while nothing is chosen — never auto-select a
  // value the user did not pick, but do not clutter the list once one is set.
  if (!selected) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = rows ? remote.empty : "";
    select.appendChild(blank);
  }

  if (rows) {
    // Rows may carry a `group` (Azure DevOps sends Active / Inactive); groups
    // are rendered in the order the server listed them.
    const buckets = [];
    for (const row of rows) {
      const name = row.group || "";
      let bucket = buckets.find((b) => b.name === name);
      if (!bucket) buckets.push((bucket = { name, rows: [] }));
      bucket.rows.push(row);
    }
    for (const bucket of buckets) {
      let parent = select;
      if (bucket.name) {
        parent = document.createElement("optgroup");
        parent.label = bucket.name;
        select.appendChild(parent);
      }
      for (const row of bucket.rows) {
        const option = document.createElement("option");
        option.value = String(row.value);
        // The name is what the user reads; the id lives in the tooltip.
        option.textContent = row.label;
        if (row.title) option.title = row.title;
        parent.appendChild(option);
      }
    }
  }

  // Keep a stored id selectable even when the list is missing or lacks it.
  if (selected && !Array.prototype.some.call(select.options, (o) => o.value === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    // With no list yet the id is all we can honestly show; once one has
    // arrived and still lacks this value, the field says so.
    option.textContent = rows ? remote.unknown.replace("{value}", selected) : `id ${selected}`;
    select.appendChild(option);
  }
  select.value = selected;

  renderRemoteStatus(key, loadingText);
}

function renderRemoteStatus(key, loadingText) {
  const node = $(`remote-status-${key}`);
  const field = fieldByKey(key);
  if (!node || !field || !field.remote) return;
  const state = remoteState.get(key) || { options: null, detail: "", error: "", loading: false };
  const select = inputs.get(key);
  const selected = select ? String(select.value || "") : "";

  if (loadingText) {
    node.className = "setup-remote-status";
    node.textContent = loadingText;
    return;
  }
  if (state.error) {
    node.className = "setup-remote-status is-err";
    node.textContent = `Could not load the list: ${state.error}`;
    return;
  }
  // Same neutral voice as `remote.missing`, because it is the same situation: something upstream
  // is not filled in yet. The server names the field, so its sentence wins over the static one.
  if (state.incomplete) {
    node.className = "setup-remote-status";
    node.textContent = state.incomplete;
    return;
  }
  if (!state.options) {
    node.className = "setup-remote-status";
    node.textContent = field.remote.missing;
    return;
  }
  node.className = "setup-remote-status";
  const detail = state.detail || `${state.options.length} available`;
  node.textContent = selected ? `id ${selected} · ${detail}` : detail;
}

/** Paints every picker from cache. Must run before the badges are counted. */
function renderRemoteFields() {
  for (const key of remoteFields) renderRemoteField(key);
}

/** Reads the lists of one card — a folded provider costs no round trips. */
function loadRemoteFieldsOf(section) {
  for (const field of section.fields) {
    if (field.type === "remote-select") loadRemoteField(field);
  }
}

// ── the "In use" provider toggle ───────────────────────────────────────────

function providerSchema() {
  return (config && config.schema && config.schema.activeProvider) || null;
}

/**
 * The toggle in a provider card's header. It sits next to the badge because
 * the two say different things: the badge is "these credentials are complete",
 * the toggle is "this is where a run imports". Every provider can be
 * configured; exactly one is in use.
 */
function renderProviderToggle(section) {
  const btn = el("button", "setup-provider-toggle", "");
  btn.type = "button";
  btn.id = `provider-${section.id}`;
  if (section.planned) {
    btn.disabled = true;
    btn.title = "Not implemented yet";
  } else {
    btn.title = `Import generated test cases into ${section.title}`;
  }
  btn.addEventListener("click", (event) => {
    // The header is a <summary>: without this the click also folds the card.
    event.preventDefault();
    event.stopPropagation();
    if (section.planned || activeProviderId === section.id) return;
    activeProviderId = section.id;
    markDirty();
  });
  return btn;
}

/** Repaints every toggle plus the one-line summary above the provider cards. */
function refreshProviderToggles() {
  const schema = providerSchema();
  if (!schema) return;

  let activeTitle = "";
  for (const provider of schema.providers) {
    const active = provider.id === activeProviderId;
    if (active) activeTitle = provider.title;
    const btn = $(`provider-${provider.id}`);
    if (btn) {
      btn.className = `setup-provider-toggle${active ? " is-active" : ""}`;
      btn.textContent = active ? "✓ In use" : "Use this";
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const card = $(`card-${provider.id}`);
    if (card) card.classList.toggle("is-active-provider", active);
  }

  const note = $("activeProviderNote");
  if (!note) return;
  const section = config.schema.sections.find((s) => s.id === activeProviderId);
  const ready = !!section && sectionState(section) === "configured";
  note.className = `setup-group-active${ready ? "" : " is-warn"}`;
  note.textContent = ready
    ? `In use: ${activeTitle} — generated test cases are imported there.`
    : `In use: ${activeTitle || "none"} — fill in its required fields before a run can import.`;
}

/** Field definition by key, across every section. */
function fieldByKey(key) {
  for (const section of config.schema.sections) {
    const found = section.fields.find((f) => f.key === key);
    if (found) return found;
  }
  return null;
}

/**
 * The card's leading mark: the service's own icon when the schema names one
 * (`iconSrc`, served from web/assets/), otherwise the emoji.
 *
 * The image is bundled, not hotlinked, so the page still works offline — and
 * `onerror` swaps the emoji back in if a file ever goes missing, so a card can
 * never end up with a broken-image glyph where its logo should be.
 */
function renderCardIcon(section) {
  const emoji = el("span", "setup-card-icon", section.icon || "");
  if (!section.iconSrc) return emoji;

  const img = document.createElement("img");
  img.className = "setup-card-icon is-logo";
  img.src = section.iconSrc;
  img.alt = "";
  img.width = 18;
  img.height = 18;
  img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(emoji), { once: true });
  return img;
}

function renderSection(section) {
  // Required credentials stay open; everything else folds away behind its badge.
  const collapsible = section.group !== "core";
  const card = collapsible ? document.createElement("details") : el("div");
  card.id = `card-${section.id}`;
  card.className = `panel setup-card${section.planned ? " is-planned" : ""}${collapsible ? " is-collapsible" : ""}`;

  const head = collapsible ? document.createElement("summary") : el("div");
  head.className = "setup-card-head";
  // Explicit disclosure arrow — it rotates via CSS when the card opens.
  if (collapsible) head.appendChild(el("span", "setup-arrow", "▸"));
  const heading = el("h2", "setup-card-title");
  heading.appendChild(renderCardIcon(section));
  heading.appendChild(document.createTextNode(section.title));
  head.appendChild(heading);
  const badge = el("span", "setup-badge", "");
  badge.id = `badge-${section.id}`;
  head.appendChild(badge);
  if (section.provider) head.appendChild(renderProviderToggle(section));
  card.appendChild(head);

  const body = el("div", "setup-card-body");
  if (section.hint) body.appendChild(el("p", "setup-card-hint", section.hint));

  if (section.planned) {
    body.appendChild(
      el("p", "setup-planned-note", "Not available yet — this card has nothing to fill in until the integration lands.")
    );
    card.appendChild(body);
    return card;
  }

  if (section.fields.length) {
    const grid = el("div", "setup-field-grid");
    for (const field of section.fields) grid.appendChild(renderField(field));
    body.appendChild(grid);
  }

  if (section.docs) {
    const docs = el("p", "setup-hint");
    const a = el("a", null, section.docs.label);
    a.href = section.docs.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    docs.appendChild(document.createTextNode("Reference: "));
    docs.appendChild(a);
    body.appendChild(docs);
  }

  if (section.test) {
    const footer = el("div", "setup-card-footer");
    const btn = el("button", "btn btn-secondary", "Test connection");
    btn.type = "button";
    btn.addEventListener("click", () => testConnection(section));
    footer.appendChild(btn);
    const result = el("span", "setup-test-result", "");
    result.id = `test-${section.id}`;
    footer.appendChild(result);
    body.appendChild(footer);
  }

  // Extra, non-config UI for this card (see `panel` in the config schema).
  if (section.panel === "examples") body.appendChild(renderExamplesPanel());

  card.appendChild(body);
  if (collapsible) {
    card.open = startsOpen(section);
    // Opening a card is the moment its live lists are needed — not worth
    // fetching for a folded one.
    card.addEventListener("toggle", () => {
      if (card.open) loadRemoteFieldsOf(section);
    });
  }
  // Examples load with the card, open or not: the count in its badge is what
  // tells you whether the folded card is worth opening. It is a local read.
  if (section.panel === "examples") loadExamples();
  return card;
}

/**
 * Which collapsible cards start open. Only "testmgmt" and "sources" are collapsible at all —
 * the required group is rendered as a plain div, never a <details>.
 *
 * The provider group is a list of alternatives, so it opens the one in use and leaves the rest
 * folded behind their badges. Extra context sources stay folded whatever they hold: they are
 * optional add-ons that are configured once and then left alone, and opening them because they
 * happen to be filled pushed the cards that do need attention below the fold.
 */
function startsOpen(section) {
  return section.group === "testmgmt" && !!section.provider && section.id === activeProviderId;
}

function render() {
  const root = $("groups");
  clear(root);
  inputs.clear();
  secretState.clear();
  secretControls.clear();

  const allFields = config.schema.sections.flatMap((s) => s.fields);
  // Known before the first card is built: renderField() wires a credential's
  // input to the pickers that post it, and those live further down the page.
  remoteFields = allFields.filter((f) => f.type === "remote-select" && f.remote).map((f) => f.key);

  const provider = providerSchema();
  activeProviderId = provider ? (config.values && config.values[provider.key]) || provider.default : "";

  for (const field of allFields) {
    if (field.secret) secretState.set(field.key, secretOnDisk(field.key) ? "stored" : "unset");
  }

  for (const group of config.schema.groups) {
    const sections = config.schema.sections.filter((s) => s.group === group.id);
    if (!sections.length) continue;

    const block = el("section", "setup-group");
    const head = el("div", "setup-group-head");
    head.appendChild(el("h2", "setup-group-title", group.title));
    if (group.hint) head.appendChild(el("p", "setup-group-hint", group.hint));
    // Which provider a run imports into, stated once above the cards.
    if (provider && group.id === provider.group) {
      const note = el("p", "setup-group-active", "");
      note.id = "activeProviderNote";
      head.appendChild(note);
    }
    block.appendChild(head);

    const cards = el("div", "setup-group-cards");
    for (const section of sections) cards.appendChild(renderSection(section));
    block.appendChild(cards);
    root.appendChild(block);
  }
  root.removeAttribute("aria-busy");

  // Fill values now that every input exists.
  for (const section of config.schema.sections) {
    for (const field of section.fields) {
      const input = inputs.get(field.key);
      if (!input) continue;
      if (field.secret) {
        renderSecret(field);
        continue;
      }
      // Pickers are filled by renderRemoteField, which knows their options.
      if (field.type === "remote-select") continue;
      input.value = (config.values && config.values[field.key]) || "";
    }
  }

  // Selects only accept values they have options for, so the pickers must be
  // populated BEFORE the badges are counted — otherwise a fully configured
  // provider card reads "Incomplete" until its lists arrive.
  renderRemoteFields();

  dirty = false;
  $("saveBtn").disabled = true;
  refreshBadges();
  renderDotenvBox();
  $("storePath").textContent = config.storePath || "config.local.json";
  $("exportBtn").href = apiUrl("/__da/config/export");

  // Then swap the stored ids for real names, for the cards that are open. The
  // lists are cached across re-renders, so saving does not re-query anything.
  for (const section of config.schema.sections) {
    const card = $(`card-${section.id}`);
    if (!card || (card.tagName === "DETAILS" && !card.open)) continue;
    loadRemoteFieldsOf(section);
  }
}

function renderDotenvBox() {
  const box = $("dotenvBox");
  const note = $("dotenvNote");
  const d = config.dotenv || {};
  if (!d.exists) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (d.error) {
    note.textContent = `.env found but could not be parsed: ${d.error}`;
    $("importDotenvBtn").disabled = true;
    return;
  }
  note.textContent = d.importable
    ? `A .env file with ${d.importable} known setting${d.importable === 1 ? "" : "s"} is still in the project.`
    : "A .env file is present but has no settings this page manages.";
  $("importDotenvBtn").disabled = !d.importable;
}

// ── server calls ───────────────────────────────────────────────────────────

async function api(path, options) {
  const res = await fetch(apiUrl(path), options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* fall through to a status-only error */
  }
  if (!res.ok || !body) {
    const detail = (body && body.error) || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  if (body.ok === false && body.error) throw new Error(body.error);
  return body;
}

async function load() {
  try {
    config = await api("/__da/config");
    render();
    setSaveState("", null);
  } catch (e) {
    const box = $("loadError");
    box.hidden = false;
    box.textContent = `Could not load the configuration: ${e.message}. Is "npm run web" still running?`;
    $("groups").textContent = "";
  }
}

async function save() {
  const btn = $("saveBtn");
  btn.disabled = true;
  setSaveState("Saving…", null);
  try {
    config = await api("/__da/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: collectValues() }),
    });
    render();
    setSaveState("✓ Saved", "ok");
    return true;
  } catch (e) {
    btn.disabled = false;
    setSaveState(`Save failed: ${e.message}`, "err");
    return false;
  }
}

async function testConnection(section) {
  // Saving re-renders the page, so never hold on to an element across it:
  // look both the result line and the button up by id every time.
  const setResult = (kind, text) => {
    const node = $(`test-${section.id}`);
    if (!node) return;
    node.className = `setup-test-result${kind ? ` is-${kind}` : ""}`;
    node.textContent = text;
  };
  const setBusy = (busy) => {
    const btn = document.querySelector(`#card-${section.id} .setup-card-footer .btn`);
    if (btn) btn.disabled = busy;
  };

  // The server tests what is on disk, so unsaved edits have to land first.
  if (dirty) {
    setResult(null, "Saving changes first…");
    if (!(await save())) {
      setResult("err", "Could not save — see the error in the bar below.");
      return;
    }
  }

  setBusy(true);
  setResult(null, "Testing…");
  try {
    const body = await api("/__da/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: section.test }),
    });
    setResult(body.ok ? "ok" : "err", `${body.ok ? "✓" : "✗"} ${body.detail}`);
  } catch (e) {
    setResult("err", `✗ ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function importDotenv(overwrite) {
  const btn = $("importDotenvBtn");
  btn.disabled = true;
  setSaveState("Importing from .env…", null);
  try {
    config = await api("/__da/config/import-dotenv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overwrite: !!overwrite }),
    });
    const imported = config.imported || [];
    const kept = config.kept || [];
    render();
    if (imported.length) {
      setSaveState(`✓ Imported ${imported.length} setting${imported.length === 1 ? "" : "s"} from .env`, "ok");
      return;
    }
    if (kept.length) {
      setSaveState("Nothing imported — every .env setting already has a value here", null);
      const ok = window.confirm(
        `All ${kept.length} setting(s) found in .env already have values on this page.\n\n` +
          "Overwrite them with the .env values?"
      );
      if (ok) await importDotenv(true);
      return;
    }
    setSaveState("Nothing to import from .env", null);
  } catch (e) {
    setSaveState(`Import failed: ${e.message}`, "err");
  } finally {
    renderDotenvBox();
  }
}

/**
 * Loads a config a teammate exported. Their file carries no secrets, so anything
 * it omits keeps the value already on this machine.
 */
async function importJsonFile(file) {
  if (!file) return;
  setSaveState(`Reading ${file.name}…`, null);
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    setSaveState(`${file.name} is not valid JSON`, "err");
    return;
  }
  // Accept both the exported shape ({ values: {...} }) and a bare map of keys.
  const values = parsed && typeof parsed.values === "object" && parsed.values ? parsed.values : parsed;
  if (!values || typeof values !== "object") {
    setSaveState("No settings found in that file", "err");
    return;
  }
  try {
    config = await api("/__da/config/import-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    const imported = config.imported || [];
    const ignored = config.ignored || [];
    render();
    const tail = ignored.length ? ` · ${ignored.length} unknown key${ignored.length === 1 ? "" : "s"} skipped` : "";
    setSaveState(
      imported.length
        ? `✓ Imported ${imported.length} setting${imported.length === 1 ? "" : "s"}${tail}`
        : `Nothing changed — every setting already matched${tail}`,
      imported.length ? "ok" : null
    );
  } catch (e) {
    setSaveState(`Import failed: ${e.message}`, "err");
  }
}

async function resetAll() {
  const ok = window.confirm(
    "Delete every value stored on this page?\n\n" +
      "config.local.json is removed. Any .env still in the project keeps working as a fallback."
  );
  if (!ok) return;
  setSaveState("Resetting…", null);
  try {
    config = await api("/__da/config/reset", { method: "POST" });
    render();
    setSaveState("Configuration cleared", null);
  } catch (e) {
    setSaveState(`Reset failed: ${e.message}`, "err");
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────

function wire() {
  $("saveBtn").addEventListener("click", save);
  $("resetBtn").addEventListener("click", resetAll);
  $("importDotenvBtn").addEventListener("click", () => importDotenv(false));

  const jsonFile = $("importJsonFile");
  $("importJsonBtn").addEventListener("click", () => jsonFile.click());
  jsonFile.addEventListener("change", async () => {
    const file = jsonFile.files && jsonFile.files[0];
    // Reset the input so picking the same file twice fires "change" again.
    jsonFile.value = "";
    await importJsonFile(file);
  });

  const extBtn = $("openExternalBrowserBtn");
  if (extBtn) {
    extBtn.addEventListener("click", () => window.open(location.href, "_blank", "noopener,noreferrer"));
  }

  // Ctrl/Cmd+S saves, like any settings screen.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty) save();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  fetch(apiUrl("/__da/health"))
    .then((r) => {
      if (!r.ok) $("cursorBrowserBanner").hidden = false;
    })
    .catch(() => {
      $("cursorBrowserBanner").hidden = false;
    });
}


// ── format examples panel (Format examples card) ───────────────────────────
//
// The worked examples that teach the generation prompt what a test case /
// checklist / BDD scenario looks like. They used to be Markdown sections inside
// TEST_CASE_FORMAT.md; they now live in a local store (examples-store.js) and
// are edited here. Every change saves immediately over its own endpoint, so
// they sit outside the page's dirty/Save-all cycle.
//
// A BDD example is stored in the same step rows the approved CSV uses for a
// scenario (Given/When as actions, Then in the expected column), and edited
// here as plain Gherkin text — web/bdd-format.js converts between the two.

/** @type {object[]} */
let examples = [];
let examplesLoaded = false;
let examplesLoading = false;
/** id of the example open in the inline editor, or "new" / "paste" / "tms", or null. */
let examplesEditing = null;
/**
 * The open TMS picker, kept across repaints: any change to the list repaints the
 * panel, and rebuilding the picker would drop the container and the ticks.
 */
let tmsPickerNode = null;
let examplesError = "";
let examplesNote = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KIND_LABEL = { test_case: "test case", checklist: "checklist", bdd: "BDD" };

function examplesApi(path, body) {
  return fetch(apiUrl(path), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  });
}

async function loadExamples(force) {
  if (examplesLoading) return;
  // A full page render rebuilds an empty panel, so an already-loaded list still
  // has to be repainted into the new DOM.
  if (examplesLoaded && !force) {
    paintExamples();
    return;
  }
  examplesLoading = true;
  try {
    const data = await examplesApi("/__da/examples");
    examples = data.examples || [];
    examplesLoaded = true;
    examplesError = "";
    // A seeded list only exists in memory until something is changed, and
    // "Reset to bundled set" reads differently before and after that point.
    examplesNote = data.seeded
      ? "Showing the bundled starter set — your first edit saves a local copy."
      : "";
  } catch (e) {
    examplesError = e.message;
  } finally {
    examplesLoading = false;
    paintExamples();
  }
}

async function examplesMutate(path, body, okNote) {
  examplesError = "";
  examplesNote = "";
  paintExamples();
  try {
    const data = await examplesApi(path, body);
    if (data.examples) examples = data.examples;
    examplesLoaded = true;
    examplesNote = typeof okNote === "function" ? okNote(data) : okNote || "";
    examplesEditing = null;
  } catch (e) {
    examplesError = e.message;
  }
  paintExamples();
}

/**
 * The provider the TMS picker reads from: the saved one, because the server
 * resolves it from config.local.json — an unsaved In use toggle is not live yet.
 */
function savedProvider() {
  const schema = providerSchema();
  if (!schema) return null;
  const id = (config.values && config.values[schema.key]) || schema.default;
  return schema.providers.find((p) => p.id === id) || null;
}

/** The card's badge carries the panel's headline: how many examples reach the prompt. */
function paintExamplesBadge() {
  const badge = $("badge-examples");
  if (!badge) return;
  const on = examples.filter((e) => e.enabled).length;
  badge.className = `setup-badge is-${on ? "configured" : "defaults"}`;
  badge.textContent = examplesLoading
    ? "loading…"
    : examples.length
      ? `${on ? "✓ " : ""}${on} of ${examples.length} in prompt`
      : "none stored";
}

/** Repaints just the panel, so editing an example never re-renders the whole page. */
function paintExamples() {
  paintExamplesBadge();
  const host = $("examples-body");
  if (!host) return;
  clear(host);

  const bar = el("div", "ex-toolbar");
  const provider = savedProvider();
  const addTms = el("button", "btn btn-secondary", `Add from ${provider ? provider.title : "test management"}…`);
  addTms.type = "button";
  addTms.title = "Tick existing test cases in the test management system In use and add them as examples";
  addTms.addEventListener("click", () => {
    examplesEditing = examplesEditing === "tms" ? null : "tms";
    tmsPickerNode = null;
    paintExamples();
  });
  bar.appendChild(addTms);

  const addCsv = el("button", "btn btn-secondary", "Add from CSV…");
  addCsv.type = "button";
  addCsv.id = "ex-browse";
  addCsv.title = "Pick a test-case CSV (the approved-CSV / Azure DevOps column layout) with the native file dialog";
  addCsv.addEventListener("click", importExamplesFromPickedCsv);
  bar.appendChild(addCsv);

  const paste = el("button", "btn btn-secondary", "Paste CSV");
  paste.type = "button";
  paste.addEventListener("click", () => {
    examplesEditing = examplesEditing === "paste" ? null : "paste";
    paintExamples();
  });
  bar.appendChild(paste);

  const addManual = el("button", "btn btn-secondary", "Add manually");
  addManual.type = "button";
  addManual.addEventListener("click", () => {
    examplesEditing = examplesEditing === "new" ? null : "new";
    paintExamples();
  });
  bar.appendChild(addManual);

  bar.appendChild(el("span", "ex-spacer"));
  const count = (kind) => examples.filter((e) => e.kind === kind).length;
  const tc = count("test_case");
  const cl = count("checklist");
  const bdd = count("bdd");
  const on = examples.filter((e) => e.enabled).length;
  bar.appendChild(
    el(
      "span",
      "ex-count",
      examples.length
        ? `${examples.length} stored · ${tc} test case${tc === 1 ? "" : "s"} · ${cl} checklist${
            cl === 1 ? "" : "s"
          } · ${bdd} BDD · ${on} in prompt`
        : "none stored"
    )
  );
  host.appendChild(bar);

  if (examplesError) host.appendChild(el("p", "ex-error", examplesError));
  if (examplesNote) host.appendChild(el("p", "ex-note", examplesNote));

  if (examplesEditing === "tms") {
    tmsPickerNode = tmsPickerNode || renderTmsPicker();
    host.appendChild(tmsPickerNode);
  }
  if (examplesEditing === "paste") host.appendChild(renderPasteCsvForm());
  if (examplesEditing === "new") host.appendChild(renderExampleEditor(null));

  if (!examples.length && !examplesLoading) {
    host.appendChild(
      el(
        "p",
        "ex-empty",
        "No examples stored. Generation still works from the written format rules, but style matching is weaker without at least one worked example."
      )
    );
  }

  const list = el("div", "ex-list");
  examples.forEach((ex, i) => list.appendChild(renderExampleRow(ex, i)));
  host.appendChild(list);

  const footer = el("div", "ex-footer");
  const preview = el("button", "setup-link-btn", "Preview what the model sees");
  preview.type = "button";
  preview.addEventListener("click", previewExamples);
  footer.appendChild(preview);

  const reset = el("button", "setup-link-btn ex-danger", "Reset to bundled set");
  reset.type = "button";
  reset.addEventListener("click", () => {
    if (!window.confirm("Discard your stored examples and go back to the bundled starter set?")) return;
    examplesMutate("/__da/examples/reset", {}, "Reset to the bundled set.");
  });
  footer.appendChild(reset);
  host.appendChild(footer);
}

/** Gherkin lines of a BDD example, without its preconditions row. */
function bddLines(ex) {
  return window.BddFormat ? window.BddFormat.stepsToGherkinLines(ex.steps) : ex.steps.map((s) => s.action);
}

function renderExampleRow(ex, index) {
  if (examplesEditing === ex.id) return renderExampleEditor(ex);

  const row = el("div", `ex-row${ex.enabled ? "" : " is-off"}`);

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "ex-toggle";
  toggle.checked = !!ex.enabled;
  toggle.title = ex.enabled ? "Included in the prompt" : "Stored but left out of the prompt";
  toggle.addEventListener("change", () =>
    examplesMutate("/__da/examples/update", { id: ex.id, enabled: toggle.checked })
  );
  row.appendChild(toggle);

  const main = el("div", "ex-main");
  const titleLine = el("div", "ex-title-line");
  titleLine.appendChild(el("span", `ex-kind ex-kind-${ex.kind}`, KIND_LABEL[ex.kind] || ex.kind));
  titleLine.appendChild(el("span", "ex-title", ex.title || "(untitled)"));
  main.appendChild(titleLine);

  const meta = [];
  if (ex.refId) meta.push(`ID ${ex.refId}`);
  if (ex.kind === "bdd") {
    const n = bddLines(ex).length;
    meta.push(`${n} Gherkin line${n === 1 ? "" : "s"}`);
  } else {
    meta.push(`${ex.steps.length} step${ex.steps.length === 1 ? "" : "s"}`);
  }
  if (ex.priority) meta.push(`Priority ${ex.priority}`);
  if (ex.areaPath) meta.push(ex.areaPath);
  if (ex.source && ex.source !== "manual") meta.push(`from ${ex.source}`);
  main.appendChild(el("div", "ex-meta", meta.join(" · ")));
  row.appendChild(main);

  const actions = el("div", "ex-actions");
  const up = el("button", "setup-icon-btn", "↑");
  up.type = "button";
  up.title = "Move up";
  up.disabled = index === 0;
  up.addEventListener("click", () => moveExample(index, -1));
  actions.appendChild(up);

  const down = el("button", "setup-icon-btn", "↓");
  down.type = "button";
  down.title = "Move down";
  down.disabled = index === examples.length - 1;
  down.addEventListener("click", () => moveExample(index, 1));
  actions.appendChild(down);

  const edit = el("button", "setup-icon-btn", "Edit");
  edit.type = "button";
  edit.addEventListener("click", () => {
    examplesEditing = ex.id;
    paintExamples();
  });
  actions.appendChild(edit);

  const del = el("button", "setup-icon-btn", "Delete");
  del.type = "button";
  del.addEventListener("click", () => {
    if (!window.confirm(`Delete "${ex.title || "(untitled)"}"?`)) return;
    examplesMutate("/__da/examples/delete", { id: ex.id });
  });
  actions.appendChild(del);
  row.appendChild(actions);

  return row;
}

function moveExample(index, delta) {
  const next = examples.slice();
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  examplesMutate("/__da/examples/reorder", { ids: next.map((e) => e.id) });
}

/** Inline editor for one example. `ex` is null when adding a new one. */
function renderExampleEditor(ex) {
  const isNew = !ex;
  const Bdd = window.BddFormat;
  // Both representations are kept while the editor is open, so flipping Kind
  // back and forth converts instead of throwing the typed text away.
  const draft = {
    steps: ex && ex.steps.length ? ex.steps.map((s) => ({ ...s })) : [{ action: "", expected: "" }],
    preconditions: "",
    gherkin: "",
  };
  if (ex && ex.kind === "bdd" && Bdd) {
    const split = Bdd.splitPreconditionsRow(ex.steps);
    draft.preconditions = split.preconditions.replace(/^- /gm, "");
    draft.gherkin = Bdd.stepsToGherkinText(ex.steps);
  }

  const box = el("div", "ex-editor");
  box.appendChild(el("h3", "ex-editor-title", isNew ? "New example" : "Edit example"));

  const grid = el("div", "ex-editor-grid");
  const field = (label, node, wide) => {
    const w = el("div", `ex-field${wide ? " is-wide" : ""}`);
    w.appendChild(el("label", null, label));
    w.appendChild(node);
    return w;
  };

  const title = document.createElement("input");
  title.type = "text";
  title.value = ex ? ex.title : "";
  title.placeholder = "What this example demonstrates";
  grid.appendChild(field("Title", title, true));

  const kind = document.createElement("select");
  for (const k of ["test_case", "checklist", "bdd"]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k === "bdd" ? "BDD scenario (Gherkin)" : KIND_LABEL[k];
    kind.appendChild(o);
  }
  kind.value = ex ? ex.kind : "test_case";
  grid.appendChild(field("Kind", kind));

  const priority = document.createElement("input");
  priority.type = "text";
  priority.inputMode = "numeric";
  priority.value = ex ? ex.priority : "2";
  priority.placeholder = "2";
  grid.appendChild(field("Priority", priority));

  const areaPath = document.createElement("input");
  areaPath.type = "text";
  areaPath.value = ex ? ex.areaPath : "";
  areaPath.placeholder = "optional";
  grid.appendChild(field("Area Path", areaPath));

  const refId = document.createElement("input");
  refId.type = "text";
  refId.value = ex ? ex.refId : "";
  refId.placeholder = "optional";
  grid.appendChild(field("Source ID", refId));
  box.appendChild(grid);

  // ── standard steps (test case / checklist) ──
  const stepsWrap = el("div", "ex-steps");
  const stepsHead = el("div", "ex-steps-head");
  stepsHead.appendChild(el("span", "ex-steps-label", "Steps"));
  stepsHead.appendChild(
    el("span", "ex-steps-hint", "Step 1 is the Preconditions row. Leave Step Expected empty for checklist-style rows.")
  );
  stepsWrap.appendChild(stepsHead);

  const rows = el("div", "ex-steps-rows");
  stepsWrap.appendChild(rows);

  function paintSteps() {
    clear(rows);
    draft.steps.forEach((step, i) => {
      const r = el("div", "ex-step");
      r.appendChild(el("span", "ex-step-n", String(i + 1)));

      const action = document.createElement("textarea");
      action.rows = 2;
      action.value = step.action;
      action.spellcheck = false;
      action.placeholder = i === 0 ? "Preconditions:\n- …" : "Step Action";
      action.addEventListener("input", () => {
        step.action = action.value;
      });
      r.appendChild(action);

      const expected = document.createElement("textarea");
      expected.rows = 2;
      expected.value = step.expected;
      expected.spellcheck = false;
      expected.placeholder = "Step Expected";
      expected.addEventListener("input", () => {
        step.expected = expected.value;
      });
      r.appendChild(expected);

      const rm = el("button", "setup-icon-btn", "✕");
      rm.type = "button";
      rm.title = "Remove this step";
      rm.disabled = draft.steps.length === 1;
      rm.addEventListener("click", () => {
        draft.steps.splice(i, 1);
        paintSteps();
      });
      r.appendChild(rm);
      rows.appendChild(r);
    });
  }
  paintSteps();

  const addStep = el("button", "setup-link-btn", "+ Add step");
  addStep.type = "button";
  addStep.addEventListener("click", () => {
    draft.steps.push({ action: "", expected: "" });
    paintSteps();
  });
  stepsWrap.appendChild(addStep);
  box.appendChild(stepsWrap);

  // ── BDD scenario ──
  const bddWrap = el("div", "ex-steps");
  const pre = document.createElement("textarea");
  pre.rows = 2;
  pre.className = "ex-paste";
  pre.spellcheck = false;
  pre.placeholder = "Environment / setup a run needs, one per line (optional)";
  pre.value = draft.preconditions;
  pre.addEventListener("input", () => {
    draft.preconditions = pre.value;
  });
  const preHead = el("div", "ex-steps-head");
  preHead.appendChild(el("span", "ex-steps-label", "Preconditions"));
  preHead.appendChild(el("span", "ex-steps-hint", "Not Gherkin: what a run needs before the scenario starts."));
  bddWrap.appendChild(preHead);
  bddWrap.appendChild(pre);

  const gherkin = document.createElement("textarea");
  gherkin.rows = 8;
  gherkin.className = "ex-paste";
  gherkin.dataset.gherkinHighlight = "";
  gherkin.spellcheck = false;
  gherkin.placeholder = 'Given the user is signed in as "Store Manager"\nWhen the user opens the "Orders" tab\nThen the "Latest order" card is displayed';
  gherkin.value = draft.gherkin;
  gherkin.addEventListener("input", () => {
    draft.gherkin = gherkin.value;
  });
  const gHead = el("div", "ex-steps-head");
  gHead.style.marginTop = "0.8rem";
  gHead.appendChild(el("span", "ex-steps-label", "Scenario"));
  gHead.appendChild(
    el("span", "ex-steps-hint", "One Gherkin line per row, each starting with Given / When / Then / And / But. No Scenario: header — the title is the scenario name.")
  );
  bddWrap.appendChild(gHead);
  bddWrap.appendChild(gherkin);
  box.appendChild(bddWrap);

  function paintKind() {
    const isBdd = kind.value === "bdd";
    stepsWrap.hidden = isBdd;
    bddWrap.hidden = !isBdd;
  }
  let lastKind = kind.value;
  kind.addEventListener("change", () => {
    if (Bdd && (kind.value === "bdd") !== (lastKind === "bdd")) {
      if (kind.value === "bdd") {
        // Standard → BDD: whatever the rows already say becomes the starting text.
        const split = Bdd.splitPreconditionsRow(draft.steps.filter((s) => s.action || s.expected));
        draft.preconditions = split.preconditions.replace(/^- /gm, "");
        draft.gherkin = split.steps
          .flatMap((s) => [s.action, s.expected])
          .flatMap((c) => String(c || "").split("\n"))
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n");
        pre.value = draft.preconditions;
        gherkin.value = draft.gherkin;
      } else {
        draft.steps = Bdd.gherkinTextToSteps(draft.gherkin, { preconditions: draft.preconditions });
        if (!draft.steps.length) draft.steps = [{ action: "", expected: "" }];
        paintSteps();
      }
    }
    lastKind = kind.value;
    paintKind();
  });
  paintKind();

  const footer = el("div", "ex-editor-footer");
  const save = el("button", "btn btn-run", isNew ? "Add example" : "Save example");
  save.type = "button";
  save.addEventListener("click", () => {
    const steps =
      kind.value === "bdd" && Bdd
        ? Bdd.gherkinTextToSteps(draft.gherkin, { preconditions: draft.preconditions })
        : draft.steps;
    const payload = {
      title: title.value,
      kind: kind.value,
      refId: refId.value,
      priority: priority.value,
      areaPath: areaPath.value,
      steps,
    };
    if (isNew) examplesMutate("/__da/examples/add", { ...payload, source: "manual" }, "Example added.");
    else examplesMutate("/__da/examples/update", { id: ex.id, ...payload }, "Example saved.");
  });
  footer.appendChild(save);

  const cancel = el("button", "btn btn-secondary", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    examplesEditing = null;
    paintExamples();
  });
  footer.appendChild(cancel);
  box.appendChild(footer);

  return box;
}

/**
 * Pick existing cases from the test management system In use and add them as
 * examples. Reuses the generation-context endpoints (tms-context.js) to browse,
 * so every provider that can be browsed there can be browsed here: Azure DevOps
 * plans and suites, TestRail suites and sections, Zephyr and Xray folders.
 * BDD cases come through as BDD examples.
 */
function renderTmsPicker() {
  const box = el("div", "ex-editor");
  const heading = el("h3", "ex-editor-title", "Add examples from test management");
  box.appendChild(heading);
  box.appendChild(
    el(
      "p",
      "setup-hint",
      "Uses the saved settings of the provider In use — save the page first if you just changed them. Pick a container, tick the cases that show your house style best, and add them. Scenarios stored as BDD become BDD examples."
    )
  );

  const grid = el("div", "ex-editor-grid");
  const field = (label, node, wide) => {
    const w = el("div", `ex-field${wide ? " is-wide" : ""}`);
    w.appendChild(el("label", null, label));
    w.appendChild(node);
    return w;
  };
  const topSel = document.createElement("select");
  const topField = field("Plan", topSel);
  topField.hidden = true;
  grid.appendChild(topField);
  const contSel = document.createElement("select");
  grid.appendChild(field("Container", contSel, true));
  box.appendChild(grid);

  const status = el("p", "ex-note", "Loading…");
  box.appendChild(status);
  const list = el("div", "ex-list");
  box.appendChild(list);

  const state = { topId: "", containers: [], cases: [], picked: new Set() };

  const post = (p, body) => examplesApi(p, body || {});
  const option = (value, text) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  };

  function paintCases() {
    clear(list);
    if (!state.cases.length) return;
    const all = el("label", "ex-row");
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.className = "ex-toggle";
    allBox.checked = state.picked.size === state.cases.length;
    allBox.addEventListener("change", () => {
      state.picked = new Set(allBox.checked ? state.cases.map((c) => c.id) : []);
      paintCases();
    });
    all.appendChild(allBox);
    all.appendChild(el("span", "ex-title", `All ${state.cases.length} case(s)`));
    list.appendChild(all);

    for (const c of state.cases) {
      const row = el("label", "ex-row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ex-toggle";
      cb.checked = state.picked.has(c.id);
      cb.addEventListener("change", () => {
        if (cb.checked) state.picked.add(c.id);
        else state.picked.delete(c.id);
        add.disabled = !state.picked.size;
        allBox.checked = state.picked.size === state.cases.length;
      });
      row.appendChild(cb);
      const main = el("div", "ex-main");
      main.appendChild(el("div", "ex-title", `${c.id} — ${c.title}`));
      if (c.meta) main.appendChild(el("div", "ex-meta", c.meta));
      row.appendChild(main);
      list.appendChild(row);
    }
    add.disabled = !state.picked.size;
  }

  async function loadCases() {
    state.cases = [];
    state.picked = new Set();
    paintCases();
    const containerId = contSel.value;
    if (!containerId) {
      status.textContent = "Pick a container.";
      return;
    }
    status.textContent = "Loading cases…";
    try {
      const data = await post("/__da/tms-context/cases", { topId: state.topId, containerId });
      state.cases = data.cases || [];
      status.textContent = state.cases.length ? "" : "No test cases in this container.";
    } catch (e) {
      status.textContent = e.message;
    }
    paintCases();
  }

  async function loadContainers() {
    clear(contSel);
    state.containers = [];
    status.textContent = "Loading…";
    try {
      const data = await post("/__da/tms-context/tree", { topId: state.topId });
      state.containers = data.containers || [];
      contSel.appendChild(option("", state.containers.length ? "Choose…" : "Nothing to pick"));
      for (const c of state.containers) {
        const indent = "  ".repeat(Math.max(0, c.depth || 0));
        contSel.appendChild(option(c.id, `${indent}${c.name}${c.badge ? ` (${c.badge})` : ""}`));
      }
      status.textContent = "Pick a container.";
    } catch (e) {
      status.textContent = e.message;
    }
  }

  (async () => {
    try {
      const data = await post("/__da/tms-context/tops", {});
      heading.textContent = `Add examples from ${data.providerTitle || "test management"}`;
      if (data.needsTop) {
        topField.hidden = false;
        topField.querySelector("label").textContent = data.topLabel || "Plan";
        topSel.appendChild(option("", "Choose…"));
        for (const t of data.tops || []) topSel.appendChild(option(t.id, t.name));
        status.textContent = `Pick a ${String(data.topLabel || "plan").toLowerCase()}.`;
      } else {
        state.topId = data.defaultTopId || "";
        await loadContainers();
      }
    } catch (e) {
      status.textContent = e.message;
    }
  })();

  topSel.addEventListener("change", () => {
    state.topId = topSel.value;
    state.cases = [];
    paintCases();
    if (state.topId) loadContainers();
  });
  contSel.addEventListener("change", loadCases);

  const footer = el("div", "ex-editor-footer");
  const add = el("button", "btn btn-run", "Add selected as examples");
  add.type = "button";
  add.disabled = true;
  add.addEventListener("click", () => {
    const container = state.containers.find((c) => c.id === contSel.value);
    examplesMutate(
      "/__da/examples/import-tms",
      {
        topId: state.topId,
        containerId: contSel.value,
        containerPath: container ? container.path || container.name : "",
        caseIds: [...state.picked],
      },
      (data) => {
        const skipped = data.skipped || [];
        const base = `Added ${data.added} example(s) from ${data.providerTitle || "test management"}.`;
        return skipped.length
          ? `${base} Skipped ${skipped.length}: ${skipped.map((x) => `${x.title} (${x.reason})`).join("; ")}`
          : base;
      }
    );
  });
  footer.appendChild(add);

  const cancel = el("button", "btn btn-secondary", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    examplesEditing = null;
    paintExamples();
  });
  footer.appendChild(cancel);
  box.appendChild(footer);
  return box;
}

function renderPasteCsvForm() {
  const box = el("div", "ex-editor");
  box.appendChild(el("h3", "ex-editor-title", "Paste a test-case CSV"));
  box.appendChild(
    el(
      "p",
      "setup-hint",
      "The approved-CSV layout (Azure DevOps columns): ID, Work Item Type, Title, Test Step, Step Action, Step Expected, Priority, Area Path, Assigned To, State. Every test case in the file becomes one example; Gherkin cases become BDD examples."
    )
  );
  const ta = document.createElement("textarea");
  ta.rows = 8;
  ta.className = "ex-paste";
  ta.placeholder = "Paste CSV content here, including its header row";
  ta.spellcheck = false;
  box.appendChild(ta);

  const footer = el("div", "ex-editor-footer");
  const imp = el("button", "btn btn-run", "Import");
  imp.type = "button";
  imp.addEventListener("click", () => {
    const csv = ta.value.trim();
    if (!csv) {
      examplesError = "Paste some CSV first";
      paintExamples();
      return;
    }
    examplesMutate("/__da/examples/import-csv", { csv }, "Imported from pasted CSV.");
  });
  footer.appendChild(imp);

  const cancel = el("button", "btn btn-secondary", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    examplesEditing = null;
    paintExamples();
  });
  footer.appendChild(cancel);
  box.appendChild(footer);
  return box;
}

/** Native file dialog → the server reads that CSV → its test cases are appended. */
async function importExamplesFromPickedCsv() {
  const btn = $("ex-browse");
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Choosing…";
  }
  const restore = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  examplesError = "";
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
      if (st.path) sourcePath = st.path;
      else if (st.error) examplesError = `File picker failed: ${st.error}`;
      break;
    }
  } catch {
    examplesError = "Could not open the file picker — is the local server still running?";
  }

  restore();
  if (!sourcePath) {
    // Cancelled, or the error above is already on screen.
    paintExamples();
    return;
  }
  await examplesMutate("/__da/examples/import-csv", { sourcePath }, "Imported from the picked CSV.");
}

/** Shows exactly what is spliced into each prompt, so there is no guessing. */
async function previewExamples() {
  try {
    const data = await examplesApi("/__da/examples/preview");
    const w = window.open("", "_blank");
    if (!w) {
      examplesError = "The preview opens in a new tab — allow pop-ups for this page.";
      paintExamples();
      return;
    }
    w.document.title = "Format examples — what the model sees";
    w.document.body.style.cssText = "margin:0;padding:20px;font:13px/1.5 system-ui,sans-serif";
    const section = (heading, text, empty) => {
      const h = w.document.createElement("h2");
      h.textContent = heading;
      h.style.cssText = "font-size:14px;margin:0 0 8px";
      const pre = w.document.createElement("pre");
      pre.style.cssText = "white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0 0 24px";
      pre.textContent = text || empty;
      w.document.body.appendChild(h);
      w.document.body.appendChild(pre);
    };
    section("Standard prompt — test cases and checklists", data.markdown, "(no test case or checklist examples enabled)");
    section("BDD prompt — Gherkin scenarios", data.bdd, "(no BDD examples enabled)");
  } catch (e) {
    examplesError = e.message;
    paintExamples();
  }
}

/** The panel shell, appended to any card whose schema says `panel: "examples"`. */
function renderExamplesPanel() {
  const body = el("div", "ex-panel");
  body.id = "examples-body";
  return body;
}

wire();
load();
