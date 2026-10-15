/**
 * Requirement attachments — the picker shared by Create, Update and Cover a bug.
 *
 * Images (PNG, JPEG, WebP, GIF) and PDFs: picked with the button, dropped on the zone, or pasted
 * (a screenshot straight from the clipboard). Each file is uploaded the moment it is added
 * (POST /__da/attachments/upload) and the page's generate request only carries the ids, see
 * attachmentPathsFrom() in web-ui-server.js. The files are read by a vision model before
 * generation (attachment-analyzer.js) and land in the prompt as "REQUIREMENTS FROM ATTACHED FILES".
 *
 * Usage (from the page script, after ui-common.js):
 *   AttachmentsPanel.mount({ container, apiUrl, projectPath: () => string, onChange })
 *   AttachmentsPanel.ids()          → ["uuid", …] of the uploaded files, in order
 *   AttachmentsPanel.blockReason()  → { text } when the run must wait (uploading, not confirmed), else null
 *   AttachmentsPanel.snapshot() / restore(saved) — for PageDraft
 *   AttachmentsPanel.clear()
 */
const AttachmentsPanel = (() => {
  const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,image/png,image/jpeg,image/webp,image/gif,application/pdf";
  const EXT_RE = /\.(png|jpe?g|webp|gif|pdf)$/i;

  let cfg = null;
  let settings = { maxFiles: 10, maxFileMb: 20, visionModel: "" };
  /** @type {Array<{ key: number, id?: string, name: string, size: number, kind: string, status: "uploading"|"ready"|"error", error?: string }>} */
  let items = [];
  let confirmed = false;
  let seq = 0;
  let els = {};

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function changed() {
    paint();
    if (cfg && typeof cfg.onChange === "function") cfg.onChange();
  }

  function build(container) {
    container.textContent = "";
    container.classList.add("att-panel");

    const label = el("label", null, "Requirement attachments (optional)");
    const tip = UiTips.info(
      "Screenshots, mockups, specification pages, acceptance criteria — as images or PDF. " +
        "Before generation a vision model reads them and the requirements it finds are added to the prompt, " +
        "labelled [A1], [A2]… so each case can be traced to its file."
    );
    label.appendChild(tip);
    container.appendChild(label);

    const zone = el("div", "att-zone");
    zone.tabIndex = 0;
    zone.setAttribute("role", "button");
    zone.setAttribute("aria-label", "Add attachments: click, drop files, or paste a screenshot");
    const zoneText = el("span", "att-zone-text");
    zoneText.appendChild(el("strong", null, "Add files…"));
    zoneText.appendChild(document.createTextNode(" or drop them here · paste a screenshot with Ctrl/⌘+V"));
    zone.appendChild(zoneText);
    const input = el("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    input.hidden = true;
    zone.appendChild(input);
    container.appendChild(zone);

    const note = el("p", "att-note");
    container.appendChild(note);

    const list = el("ul", "att-list");
    container.appendChild(list);

    const warn = el("p", "att-warn");
    warn.textContent =
      "⚠ Files are sent to an external AI model via OpenRouter. Attach only synthetic or anonymized material — " +
      "no real patient names, MRNs, dates of birth, insurance numbers or other personal data.";
    container.appendChild(warn);

    const confirmWrap = el("label", "att-confirm");
    const confirmBox = el("input");
    confirmBox.type = "checkbox";
    confirmWrap.appendChild(confirmBox);
    confirmWrap.appendChild(document.createTextNode(" I checked: these files contain no real patient or personal data"));
    container.appendChild(confirmWrap);

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      addFiles([...input.files]);
      input.value = "";
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("is-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("is-over");
      addFiles([...((e.dataTransfer && e.dataTransfer.files) || [])]);
    });
    confirmBox.addEventListener("change", () => {
      confirmed = confirmBox.checked;
      changed();
    });

    els = { container, zone, note, list, warn, confirmWrap, confirmBox };
  }

  /** A pasted screenshot, wherever the cursor is — unless it is in a text field. */
  function onPaste(e) {
    if (!els.container || els.container.offsetParent === null) return; // panel not on screen
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing && t !== els.zone) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    addFiles(
      files.map((f, i) =>
        f.name && f.name !== "image.png"
          ? f
          : new File([f], `pasted-screenshot-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.png`, { type: f.type })
      )
    );
  }

  function paint() {
    if (!els.list) return;
    const { list, note, warn, confirmWrap, confirmBox } = els;
    list.textContent = "";
    for (const it of items) {
      const li = el("li", `att-item is-${it.status}`);
      li.appendChild(el("span", "att-kind", it.kind === "pdf" ? "PDF" : "IMG"));
      const name = el("span", "att-name", it.name);
      name.title = it.name;
      li.appendChild(name);
      const meta =
        it.status === "uploading"
          ? "uploading…"
          : it.status === "error"
            ? it.error || "failed"
            : fmtSize(it.size);
      li.appendChild(el("span", "att-meta", meta));
      const rm = el("button", "att-remove", "×");
      rm.type = "button";
      rm.title = "Remove";
      rm.setAttribute("aria-label", `Remove ${it.name}`);
      rm.addEventListener("click", () => {
        items = items.filter((x) => x !== it);
        if (!items.length) confirmed = false;
        changed();
      });
      li.appendChild(rm);
      list.appendChild(li);
    }
    const model = settings.visionModel ? ` · read by ${settings.visionModel}` : "";
    note.textContent = `Images (PNG, JPEG, WebP, GIF) or PDF · up to ${settings.maxFiles} files, ${settings.maxFileMb} MB each${model}`;
    const has = items.length > 0;
    warn.hidden = !has;
    confirmWrap.hidden = !has;
    confirmBox.checked = confirmed;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(r.error || new Error("Could not read the file"));
      r.readAsDataURL(file);
    });
  }

  async function upload(it, file) {
    try {
      const data = await readAsDataUrl(file);
      const res = await fetch(cfg.apiUrl("/__da/attachments/upload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: cfg.projectPath(), name: file.name, data }),
      });
      let body = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      Object.assign(it, { id: body.id, name: body.name, size: body.size, kind: body.kind, status: "ready" });
    } catch (err) {
      Object.assign(it, { status: "error", error: (err && err.message) || "upload failed" });
    }
    if (items.includes(it)) changed();
  }

  function addFiles(files) {
    if (!cfg || !files.length) return;
    const maxBytes = settings.maxFileMb * 1024 * 1024;
    for (const file of files) {
      const live = items.filter((x) => x.status !== "error").length;
      const it = {
        key: ++seq,
        name: file.name || "attachment",
        size: file.size,
        kind: /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? "pdf" : "image",
        status: "uploading",
      };
      if (live >= settings.maxFiles) {
        Object.assign(it, { status: "error", error: `limit is ${settings.maxFiles} files` });
      } else if (!EXT_RE.test(file.name || "") && !/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/i.test(file.type)) {
        Object.assign(it, { status: "error", error: "not an image or PDF" });
      } else if (file.size > maxBytes) {
        Object.assign(it, { status: "error", error: `larger than ${settings.maxFileMb} MB` });
      } else if (!file.size) {
        Object.assign(it, { status: "error", error: "empty file" });
      }
      items.push(it);
      if (it.status === "uploading") upload(it, file);
    }
    changed();
  }

  async function loadSettings() {
    try {
      const res = await fetch(cfg.apiUrl("/__da/attachments/settings"));
      const body = res.ok ? await res.json() : null;
      if (body && body.ok) settings = { ...settings, ...body };
    } catch {
      /* keep the defaults; the server enforces its own limits anyway */
    }
    paint();
  }

  return {
    mount(options) {
      cfg = options;
      if (!cfg || !cfg.container) return;
      build(cfg.container);
      document.addEventListener("paste", onPaste);
      paint();
      loadSettings();
    },
    /** Ids of the uploaded files, in the order they were added. Failed uploads are left out. */
    ids() {
      return items.filter((x) => x.status === "ready" && x.id).map((x) => x.id);
    },
    count() {
      return items.filter((x) => x.status === "ready").length;
    },
    /** Why the run button must wait, or null. Only meaningful while the panel is shown. */
    blockReason() {
      if (items.some((x) => x.status === "uploading")) return { text: "Wait until the attachments finish uploading" };
      if (items.some((x) => x.status === "ready") && !confirmed) {
        return { text: "Confirm that the attachments contain no real patient or personal data" };
      }
      return null;
    },
    snapshot() {
      return {
        items: items
          .filter((x) => x.status === "ready")
          .map(({ id, name, size, kind }) => ({ id, name, size, kind })),
        confirmed,
      };
    },
    restore(saved) {
      if (!saved || !Array.isArray(saved.items)) return;
      items = saved.items
        .filter((x) => x && x.id)
        .map((x) => ({ key: ++seq, id: x.id, name: x.name || "attachment", size: Number(x.size) || 0, kind: x.kind === "pdf" ? "pdf" : "image", status: "ready" }));
      confirmed = !!saved.confirmed && items.length > 0;
      paint();
    },
    clear() {
      items = [];
      confirmed = false;
      changed();
    },
  };
})();
