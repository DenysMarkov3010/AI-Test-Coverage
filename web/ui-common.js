/**
 * Pieces every page shares, loaded before the page's own script:
 *
 *   UiTips      — hover tooltips for `[data-tip]`: the info icons next to field labels, and the
 *                 reason a button or a Steps entry is disabled. A tip can carry a link into the
 *                 Setup section that fixes it (`data-tip-setup="jira" | "ai" | "tms"`).
 *   StepSelect  — the Steps dropdown, drawn instead of the native one so a disabled entry can say
 *                 why on hover. The native <select> stays in the page as the source of truth.
 *   SetupStatus — is Jira / the AI model / a test management system set up? The flow pages gate
 *                 their buttons on it.
 *   PageDraft   — a page's work in progress (form, run log, generated draft) kept on the server
 *                 while it runs, so moving between pages does not throw it away.
 */

/** Where each "go fix it" link lands; setup-app.js opens and scrolls to the hash. */
const SETUP_TARGETS = {
  jira: { href: "setup.html#card-jira", label: "Open Setup → Jira" },
  ai: { href: "setup.html#card-ai", label: "Open Setup → AI model" },
  tms: { href: "setup.html#group-testmgmt", label: "Open Setup → Test management" },
};

const UiTips = (() => {
  let tip = null;
  let owner = null;
  let hideTimer = null;

  function node() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "ui-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    // The tip is a separate element so the mouse can travel into it and reach the Setup link.
    tip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    tip.addEventListener("mouseleave", scheduleHide);
    document.body.appendChild(tip);
    return tip;
  }

  function position(target) {
    const t = node();
    const r = target.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const gap = 8;
    let top = r.top - h - gap;
    if (top < gap) top = r.bottom + gap;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
    t.style.top = `${Math.round(top)}px`;
    t.style.left = `${Math.round(left)}px`;
  }

  function show(target) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    clearTimeout(hideTimer);
    const t = node();
    t.textContent = "";
    t.appendChild(document.createTextNode(text));
    const setup = SETUP_TARGETS[target.getAttribute("data-tip-setup") || ""];
    if (setup) {
      const a = document.createElement("a");
      a.className = "ui-tip-link";
      a.href = setup.href;
      a.textContent = setup.label;
      t.appendChild(a);
    }
    owner = target;
    t.hidden = false;
    position(target);
  }

  function hide() {
    clearTimeout(hideTimer);
    owner = null;
    if (tip) tip.hidden = true;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 220);
  }

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest && e.target.closest("[data-tip]");
    if (target && target.getAttribute("data-tip")) {
      if (target !== owner) show(target);
      else clearTimeout(hideTimer);
    }
  });
  document.addEventListener("mouseout", (e) => {
    if (!owner) return;
    const to = e.relatedTarget;
    if (to && (owner.contains(to) || (tip && tip.contains(to)))) return;
    if (e.target.closest && e.target.closest("[data-tip]") === owner) scheduleHide();
  });
  document.addEventListener("focusin", (e) => {
    const target = e.target.closest && e.target.closest("[data-tip]");
    if (target && target.getAttribute("data-tip")) show(target);
  });
  document.addEventListener("focusout", (e) => {
    if (owner && e.target === owner && !(tip && tip.contains(e.relatedTarget))) scheduleHide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("scroll", () => owner && hide(), true);

  /** Give `el` a tip (or take it away with an empty text). */
  function set(el, text, setupKey) {
    if (!el) return;
    if (text) {
      el.setAttribute("data-tip", text);
      if (el.classList.contains("info-tip")) el.setAttribute("aria-label", text);
      if (setupKey) el.setAttribute("data-tip-setup", setupKey);
      else el.removeAttribute("data-tip-setup");
      if (owner === el) show(el);
    } else {
      el.removeAttribute("data-tip");
      el.removeAttribute("data-tip-setup");
      if (owner === el) hide();
    }
  }

  /** The (i) next to a label. */
  function info(text, setupKey) {
    const span = document.createElement("span");
    span.className = "info-tip";
    span.tabIndex = 0;
    span.setAttribute("role", "img");
    set(span, text, setupKey);
    return span;
  }

  /**
   * Say why `btn` is disabled. A disabled button swallows mouse events, so the tip sits on a
   * wrapper that is put around the button the first time it is gated.
   *
   * @param {HTMLElement} btn
   * @param {{ text: string, setup?: string } | null} reason null = nothing to explain
   */
  function gate(btn, reason) {
    if (!btn) return;
    let wrap = btn.parentElement;
    if (!wrap || !wrap.classList.contains("tip-gate")) {
      if (!reason) return;
      wrap = document.createElement("span");
      wrap.className = "tip-gate";
      btn.parentNode.insertBefore(wrap, btn);
      wrap.appendChild(btn);
    }
    set(wrap, reason ? reason.text : "", reason ? reason.setup : "");
  }

  return { set, info, gate, hide };
})();

const StepSelect = (() => {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

  function enhance(select) {
    if (!select || select.dataset.enhanced) return;
    select.dataset.enhanced = "1";

    const root = document.createElement("div");
    root.className = "ss";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ss-button";
    button.id = `${select.id}Btn`;
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.className = "ss-label";
    const caret = document.createElement("span");
    caret.className = "ss-caret";
    caret.setAttribute("aria-hidden", "true");
    button.append(label, caret);
    const menu = document.createElement("div");
    menu.className = "ss-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    select.parentNode.insertBefore(root, select);
    root.append(button, menu, select);
    select.classList.add("ss-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    const fieldLabel = document.querySelector(`label[for="${select.id}"]`);
    if (fieldLabel) fieldLabel.htmlFor = button.id;

    let active = -1;

    function items() {
      return [...menu.querySelectorAll(".ss-option")];
    }

    function sync() {
      const opts = [...select.options];
      const chosen = opts[select.selectedIndex];
      label.textContent = chosen ? chosen.textContent : "";
      button.disabled = select.disabled;
      menu.textContent = "";
      opts.forEach((o, i) => {
        const item = document.createElement("div");
        item.className = `ss-option${o.disabled ? " is-disabled" : ""}${i === select.selectedIndex ? " is-selected" : ""}`;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", i === select.selectedIndex ? "true" : "false");
        if (o.disabled) item.setAttribute("aria-disabled", "true");
        item.dataset.index = String(i);
        item.textContent = o.textContent;
        if (o.disabled && o.dataset.tip) UiTips.set(item, o.dataset.tip, o.dataset.tipSetup || "");
        menu.appendChild(item);
      });
    }

    function paintActive() {
      items().forEach((it, i) => it.classList.toggle("is-active", i === active));
    }

    function open() {
      if (button.disabled) return;
      sync();
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      active = select.selectedIndex;
      paintActive();
    }

    function close() {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      UiTips.hide();
    }

    function choose(i) {
      const o = select.options[i];
      if (!o || o.disabled) return;
      close();
      if (select.selectedIndex === i) return;
      nativeValue.set.call(select, o.value);
      sync();
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      button.focus();
    }

    function step(delta) {
      const opts = [...select.options];
      let i = active;
      for (let n = 0; n < opts.length; n++) {
        i = (i + delta + opts.length) % opts.length;
        if (!opts[i].disabled) break;
      }
      active = i;
      paintActive();
    }

    button.addEventListener("click", () => (menu.hidden ? open() : close()));
    button.addEventListener("keydown", (e) => {
      if (menu.hidden) {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
          e.preventDefault();
          open();
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(active);
      } else if (e.key === "Escape" || e.key === "Tab") {
        close();
      }
    });
    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".ss-option");
      if (item) choose(Number(item.dataset.index));
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !root.contains(e.target)) close();
    });

    // Page code sets `select.value` directly (step 2 dropped underneath it, a restored draft), and
    // that fires no event — so the setter itself repaints the button.
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return nativeValue.get.call(this);
      },
      set(v) {
        nativeValue.set.call(this, v);
        sync();
      },
    });
    // Option labels and disabled flags change once the provider In use is known.
    new MutationObserver(sync).observe(select, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "data-tip", "data-tip-setup"],
    });
    sync();
  }

  /**
   * Disable or re-enable one entry, with the reason shown on hover. A disabled entry that is
   * currently selected falls back to the first enabled one.
   */
  function setOptionBlocked(option, reason) {
    if (!option) return;
    option.disabled = !!reason;
    if (reason) {
      option.dataset.tip = reason.text;
      option.dataset.tipSetup = reason.setup || "";
    } else {
      delete option.dataset.tip;
      delete option.dataset.tipSetup;
    }
    const select = option.parentElement && option.closest("select");
    if (reason && select && select.value === option.value) {
      const first = [...select.options].find((o) => !o.disabled);
      if (first) {
        select.value = first.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  return { enhance, setOptionBlocked };
})();

const SetupStatus = (() => {
  let current = null;
  let pending = null;

  function load(apiUrl) {
    if (!pending) {
      pending = fetch(apiUrl("/__da/setup/status"))
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          current = b && b.ok ? b : null;
          return current;
        })
        .catch(() => null);
    }
    return pending;
  }

  const list = (names) => (names && names.length ? names.join(", ") : "the required fields");

  return {
    load,
    get: () => current,
    /** Setup → Jira → Default project key, upper-cased; "" when unset or not loaded. */
    projectKey: () => (current && current.jira && current.jira.projectKey) || "",
    /**
     * Put "PROJ-" into an empty Jira key field, so only the number is left to type. A field that
     * already holds something — typed, or put back from the page's draft — is left alone.
     */
    prefillJiraKey(input) {
      const key = (current && current.jira && current.jira.projectKey) || "";
      if (!input || !key || String(input.value || "").trim()) return;
      input.value = `${key}-`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    /** Unknown (still loading, older server) never blocks — the run itself reports what is missing. */
    jiraReason() {
      if (!current || current.jira.ready) return null;
      return { text: `Jira is not set up yet — fill in ${list(current.jira.missing)} on the Setup page first.`, setup: "jira" };
    },
    aiReason() {
      if (!current || current.ai.ready) return null;
      return { text: `The AI model is not set up yet — fill in ${list(current.ai.missing)} on the Setup page first.`, setup: "ai" };
    },
    tmsReason() {
      if (!current || current.tms.id) return null;
      return {
        text: "No test management platform is In use — select one with “Use this” on the Setup page first.",
        setup: "tms",
      };
    },
  };
})();

const PageDraft = (() => {
  let cfg = null;
  let loaded = false;
  let dirty = false;
  let timer = null;
  let inflight = null;

  function post() {
    const body = JSON.stringify({ flow: cfg.flow, draft: cfg.collect() });
    const p = fetch(cfg.apiUrl("/__da/draft"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive lets a save outlive the page, but browsers cap it at 64 KB.
      keepalive: body.length < 60000,
    })
      .catch(() => {})
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!cfg || !loaded || !dirty) return inflight || Promise.resolve();
    dirty = false;
    return post();
  }

  /** Something on the page changed; save shortly. Ignored until the stored draft is back. */
  function changed() {
    if (!cfg || !loaded) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  // A same-tab link (breadcrumbs, a tooltip's Setup link) waits for the last save first.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || !cfg || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== "_self") return;
    if (!dirty && !inflight) return;
    e.preventDefault();
    flush().finally(() => {
      location.href = a.href;
    });
  });
  window.addEventListener("pagehide", () => {
    if (dirty) flush();
  });

  return {
    /**
     * @param {{ apiUrl: Function, flow: "create"|"update"|"issue", collect: () => object }} options
     * @returns {Promise<object|null>} the stored draft, for the page to restore
     */
    async init(options) {
      cfg = options;
      let draft = null;
      try {
        const res = await fetch(cfg.apiUrl(`/__da/draft?flow=${encodeURIComponent(cfg.flow)}`));
        const body = res.ok ? await res.json() : null;
        draft = (body && body.draft) || null;
      } catch {
        draft = null;
      }
      loaded = true;
      return draft;
    },
    changed,
    flush,
  };
})();

/** A complete Jira issue key (PROJ-123) — "PROJ-" alone, the pre-filled prefix, is not one. */
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Run-log contents for a draft: the markup when it is small enough, the text tail otherwise. */
function snapshotLog(pre) {
  if (!pre) return null;
  const html = pre.innerHTML;
  if (!html) return null;
  return html.length <= 400000 ? { html } : { text: pre.textContent.slice(-200000) };
}

function restoreLog(pre, saved) {
  if (!pre || !saved) return;
  if (saved.html) pre.innerHTML = saved.html;
  else pre.textContent = saved.text || "";
  pre.scrollTop = pre.scrollHeight;
}
