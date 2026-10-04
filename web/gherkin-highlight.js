/**
 * Keyword highlighting for the Gherkin text boxes (review panel, Setup → Format examples).
 *
 * A <textarea> cannot style part of its text, so the box is given a twin: a <pre> laid exactly
 * underneath it, holding the same text with the keywords wrapped in spans. The textarea keeps
 * doing everything — typing, caret, selection, undo, the review panel's own input handlers — but
 * its glyphs are transparent, so what you read is the twin.
 *
 * Only the display changes. The keywords are shown bold and in capitals (`GIVEN`), but the text
 * itself keeps the canonical `Given` casing: Gherkin keywords are case-sensitive, and that text is
 * what reaches the CSV, Jira and every test management system. The capitals are CSS
 * (`text-transform`), which keeps the two layers aligned because both boxes use a monospace font —
 * `Given` and `GIVEN` are the same width there.
 *
 * Boxes are picked up on their own as they appear: any `textarea.rv-gherkin` (the review panel
 * renders them from HTML strings, again on every re-render) and any `textarea[data-gherkin-highlight]`.
 */
(function (root) {
  const SELECTOR = "textarea.rv-gherkin, textarea[data-gherkin-highlight]";
  const KEYWORD_RE = /^(\s*)(given|when|then|and|but)\b/i;
  const PRIMARY = { given: "given", when: "when", then: "then" };

  /** Layout properties the twin has to share with the textarea for the lines to sit on top of each other. */
  const MIRRORED = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing",
    "textIndent", "tabSize", "textAlign", "boxSizing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
  ];

  const attached = new WeakSet();
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /**
   * The text as highlighted HTML. `And` / `But` take the colour of the phase they continue, so the
   * Given / When / Then blocks read as blocks. A line with no keyword is underlined: the Update flow
   * only recognises a case as BDD when every line carries one.
   */
  function render(text) {
    let phase = "given";
    const lines = String(text).split("\n").map((line) => {
      const m = line.match(KEYWORD_RE);
      if (!m) return line.trim() ? `<span class="gh-bad">${esc(line)}</span>` : esc(line);
      const word = m[2].toLowerCase();
      if (PRIMARY[word]) phase = PRIMARY[word];
      const cls = PRIMARY[word] ? `gh-${word}` : `gh-${phase} gh-cont`;
      const rest = line.slice(m[0].length);
      return `${esc(m[1])}<span class="gh-kw ${cls}">${esc(m[2])}</span>${esc(rest)}`;
    });
    // A trailing newline still owns a line in the textarea; give it one in the twin too.
    return `${lines.join("\n")}\n `;
  }

  function attach(ta) {
    if (!ta || attached.has(ta) || !ta.parentNode) return;
    attached.add(ta);

    const before = getComputedStyle(ta);
    const wrap = document.createElement("div");
    wrap.className = "gh-wrap";
    const layer = document.createElement("pre");
    layer.className = "gh-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.style.backgroundColor = before.backgroundColor;
    layer.style.color = before.color;
    ta.style.caretColor = before.color;

    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(layer);
    wrap.appendChild(ta);
    ta.classList.add("gh-input");

    const sync = () => {
      if (!ta.isConnected) return;
      const cs = getComputedStyle(ta);
      for (const p of MIRRORED) layer.style[p] = cs[p];
      layer.style.top = `${ta.offsetTop}px`;
      layer.style.left = `${ta.offsetLeft}px`;
      // clientWidth leaves out a scrollbar, so the twin wraps where the textarea does. The twin is
      // border-box like the textarea, so its width carries the (transparent) borders as well.
      layer.style.width = `${ta.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
      layer.style.height = `${ta.offsetHeight}px`;
      layer.innerHTML = render(ta.value);
      layer.scrollTop = ta.scrollTop;
    };

    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        sync();
      });
    };

    // Pages also set the text from code (a regenerated scenario, the Setup editor switching kind),
    // which fires no input event — so a write to `value` repaints too.
    Object.defineProperty(ta, "value", {
      configurable: true,
      get() {
        return valueDescriptor.get.call(this);
      },
      set(v) {
        valueDescriptor.set.call(this, v);
        schedule();
      },
    });

    ta.addEventListener("input", sync);
    ta.addEventListener("scroll", () => {
      layer.scrollTop = ta.scrollTop;
    });
    if (typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(ta);
    sync();
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches(SELECTOR)) attach(node);
    if (node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(attach);
  }

  function start() {
    scan(document.body);
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(scan);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  root.GherkinHighlight = { attach, render };
})(typeof self !== "undefined" ? self : globalThis);
