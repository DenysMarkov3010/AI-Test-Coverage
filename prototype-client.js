/**
 * Live prototype crawler.
 *
 * The Figma path (figma-client.js) reads a *design file*. This reads a *running build* — the
 * clickable prototype a designer deploys to Netlify / Vercel / Lovable and pastes into the ticket.
 * Same contract on purpose: `analyzePrototypeUrl()` returns `{ summary, error, stats }`, where
 * `summary` is a plain-text block ready to concatenate into the generation prompt, and a failure
 * degrades to `summary: ""` plus a short `error` rather than killing the run.
 *
 * Why a real browser and not `fetch`: these prototypes are SPAs. The served HTML is an empty
 * `<div id="root">`; every screen, label and state exists only after the bundle executes. A plain
 * HTTP GET would hand the LLM a blank page and invite it to invent UI.
 *
 * Why no npm dependency: Chrome speaks the DevTools Protocol over a WebSocket, Node has had a
 * global `WebSocket` since v22, and macOS/Windows dev machines already have Chrome or Edge. So the
 * whole thing is `spawn(chrome, ["--headless=new", ...])` plus ~80 lines of JSON-over-WS. No
 * Playwright download, no postinstall step, nothing to keep in sync with a browser release.
 *
 * "Deep investigate" means three discovery passes, because link-following alone is not enough for
 * a client-side router — a prototype's home screen often links to exactly one other screen:
 *   1) Route mining — every same-origin `<script>` bundle is fetched as text and scanned for
 *      quoted path literals ("/m/match-found", "/pal/apply/story", ...). That is where a React
 *      Router / TanStack route table lives after minification, so it finds screens no visible
 *      link points at.
 *   2) Link harvesting — every `<a href>` seen on a rendered page feeds back into the queue.
 *   3) A 404 probe — one navigation to a deliberately nonsense path records what this app's
 *      not-found screen looks like, so mined candidates that are not real routes are dropped
 *      instead of being described to the model as if they were screens.
 * Each surviving screen is then snapshotted twice: structurally (a DOM inventory of headings,
 * copy, controls, fields, tables, dialogs, error text) and visually (a full-page JPEG sent to a
 * multimodal model, same OpenRouter call shape the Figma analyzer uses).
 *
 * Activated only when PROTOTYPE_URL is non-empty, which the Web UI only sets when the Setup page's
 * "Read prototype" switch is Yes.
 *
 * Env knobs (all optional; defaults in DEFAULTS below):
 *   PROTOTYPE_MAX_PAGES, PROTOTYPE_INCLUDE_VISION, PROTOTYPE_VISION_MODEL,
 *   PROTOTYPE_VISION_MAX_PAGES, PROTOTYPE_VIEWPORT, PROTOTYPE_NAV_TIMEOUT_MS,
 *   PROTOTYPE_BROWSER_PATH
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fetchFn = globalThis.fetch || require("node-fetch");

const DEFAULTS = {
  maxPages: 30,
  visionMaxPages: 6,
  visionModel: "google/gemini-2.5-flash",
  viewport: { width: 1440, height: 900 },
  navTimeoutMs: 25_000,
  /** Quiet window with no in-flight requests that counts as "the screen settled". */
  networkIdleMs: 700,
  /** Hard cap on one screen, however chatty its polling is. */
  pageBudgetMs: 30_000,
  /** Bundles are read for route literals only; a huge one is truncated, not skipped. */
  maxBundleBytes: 4_000_000,
  maxBundles: 8,
};

/** Paths that are assets or endpoints rather than screens. */
const NON_ROUTE_EXT = /\.(js|mjs|cjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|txt|xml|wasm)$/i;
const NON_ROUTE_PREFIX = /^\/(api|assets|static|_next|__|\.netlify|cdn-cgi|favicon)/i;

function isHttpUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function envInt(name, fallback) {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseViewport(raw, fallback) {
  const m = String(raw || "").match(/^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i);
  if (!m) return fallback;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Chrome discovery / launch ───────────────────────────────────────────────

/**
 * Locate an installed Chromium-family browser. PROTOTYPE_BROWSER_PATH wins; otherwise the usual
 * install locations per platform, Chrome first because it is the one people actually have.
 * @returns {string|null} absolute path to the executable
 */
function findBrowserExecutable() {
  const explicit = String(process.env.PROTOTYPE_BROWSER_PATH || "").trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : process.platform === "win32"
        ? [
            `${process.env["PROGRAMFILES"] || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env["PROGRAMFILES"] || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/snap/bin/chromium",
          ];

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* unreadable path — try the next one */
    }
  }
  return null;
}

/**
 * Start headless Chrome on an ephemeral debugging port and wait for the WebSocket URL it prints
 * on stderr. `--user-data-dir` points at a throwaway temp profile so the crawl can never touch
 * the QA engineer's real browser session (cookies, logins, extensions).
 * @returns {Promise<{ wsUrl: string, close: () => void }>}
 */
async function launchBrowser(exePath, viewport, log) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitc-proto-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ];

  const child = spawn(exePath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const close = () => {
    try {
      if (!exited) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
  };

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`browser did not report a DevTools endpoint in 20s. ${stderr.slice(-300)}`));
    }, 20_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-5_000);
      const m = stderr.match(/ws:\/\/[^\s]+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${code}. ${stderr.slice(-300)}`));
    });
  }).catch((err) => {
    close();
    throw err;
  });

  log.log?.(`🧭 Prototype: headless browser ready (${path.basename(exePath)})`);
  return { wsUrl, close };
}

// ── Minimal DevTools Protocol client ────────────────────────────────────────

/**
 * Just enough CDP for this job: request/response correlation by id, one flat session per page
 * target, and an event bus the crawl uses to know when a navigation finished.
 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || "CDP error"}`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("DevTools connection closed"));
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DevTools WebSocket did not open in 10s")), 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("DevTools WebSocket failed to open"));
      });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}, sessionId = null) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* socket already down */
    }
  }
}

// ── In-page snapshot ────────────────────────────────────────────────────────

/**
 * Runs inside the page. Returns the tester-relevant inventory of one rendered screen as JSON.
 *
 * Kept as a source string (not a function reference) because it is evaluated in the browser realm,
 * and deliberately defensive: a prototype is throwaway code, so any single selector may explode,
 * and one bad screen must not abort the crawl.
 */
const SNAPSHOT_JS = String.raw`(() => {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
    } catch { return false; }
  };
  const all = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } };
  const labelFor = (el) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return clean(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return clean(ref.textContent);
    }
    return "";
  };

  const out = {};
  out.title = clean(document.title);
  out.route = location.pathname + location.search + location.hash;

  out.headings = uniq(all("h1,h2,h3,[role=heading]").filter(visible).map((h) => clean(h.textContent))).slice(0, 25);

  out.text = cut(clean(document.body ? document.body.innerText : ""), 1800);

  out.buttons = uniq(
    all("button,[role=button],input[type=submit],input[type=button]")
      .filter(visible)
      .map((b) => {
        const name = clean(b.innerText || b.value || labelFor(b) || b.getAttribute("title"));
        if (!name) return "";
        const state = [];
        if (b.disabled || b.getAttribute("aria-disabled") === "true") state.push("disabled");
        if (b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-expanded") === "true") state.push("active");
        return cut(name, 70) + (state.length ? " [" + state.join(", ") + "]" : "");
      }),
  ).slice(0, 40);

  out.links = all("a[href]")
    .filter(visible)
    .map((a) => ({ text: cut(clean(a.innerText), 60), href: a.getAttribute("href") || "" }))
    .filter((l) => l.href)
    .slice(0, 60);

  out.fields = all("input,textarea,select")
    .filter((el) => visible(el) && !/^(submit|button|image|hidden)$/i.test(el.type || ""))
    .map((el) => {
      const tag = el.tagName.toLowerCase();
      const f = {
        control: tag === "input" ? (el.type || "text").toLowerCase() : tag,
        label: cut(labelFor(el), 70),
        name: clean(el.getAttribute("name") || el.getAttribute("id")),
        placeholder: cut(clean(el.getAttribute("placeholder")), 60),
      };
      if (el.required || el.getAttribute("aria-required") === "true") f.required = true;
      if (el.disabled) f.disabled = true;
      if (el.readOnly) f.readonly = true;
      const limits = ["maxlength", "minlength", "min", "max", "step", "pattern"]
        .map((a) => (el.getAttribute(a) ? a + "=" + el.getAttribute(a) : ""))
        .filter(Boolean);
      if (limits.length) f.constraints = limits.join(" ");
      if (tag === "select") f.options = [...el.options].map((o) => cut(clean(o.textContent), 40)).slice(0, 15);
      if (/^(checkbox|radio)$/i.test(el.type || "") && el.checked) f.checked = true;
      return f;
    })
    .slice(0, 40);

  out.tabs = uniq(all("[role=tab],[role=menuitem]").filter(visible).map((t) => cut(clean(t.textContent), 40))).slice(0, 20);

  out.dialogs = all("[role=dialog],[role=alertdialog],dialog")
    .filter(visible)
    .map((d) => cut(clean(d.getAttribute("aria-label") || d.textContent), 160))
    .slice(0, 5);

  out.tables = all("table")
    .filter(visible)
    .map((t) => ({
      columns: [...t.querySelectorAll("th")].map((th) => cut(clean(th.textContent), 40)).slice(0, 12),
      rows: t.querySelectorAll("tbody tr").length || Math.max(0, t.querySelectorAll("tr").length - 1),
    }))
    .slice(0, 5);

  out.messages = uniq(
    all("[role=alert],[role=status],[aria-live],[aria-invalid=true],.error,.invalid,.warning,.toast,.empty-state")
      .filter(visible)
      .map((n) => cut(clean(n.textContent), 140)),
  ).slice(0, 12);

  out.images = uniq(all("img[alt]").filter(visible).map((i) => cut(clean(i.getAttribute("alt")), 50)))
    .filter(Boolean)
    .slice(0, 15);

  out.counts = {
    buttons: all("button,[role=button]").filter(visible).length,
    links: all("a[href]").filter(visible).length,
    fields: all("input,textarea,select").filter(visible).length,
  };

  return JSON.stringify(out);
})()`;

// ── Route discovery ─────────────────────────────────────────────────────────

/**
 * Mine candidate routes out of the app's own JavaScript.
 *
 * A client-side router keeps its route table in the bundle as quoted string literals, and survives
 * minification unchanged — so scanning for them finds the screens that nothing on the home page
 * links to. Everything found here is only a *candidate*: the crawl verifies each one renders
 * something other than the not-found screen before it is described to the model.
 *
 * @returns {Promise<string[]>} same-origin absolute URLs
 */
async function mineRoutesFromBundles(entryUrl, log) {
  const origin = new URL(entryUrl).origin;
  let html = "";
  try {
    const res = await fetchFn(entryUrl, { redirect: "follow" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    html = await res.text();
  } catch (err) {
    log.warn?.(`⚠️  Prototype: could not read the entry HTML for route mining: ${err.message}`);
    return [];
  }

  const scriptSrcs = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], entryUrl);
      if (abs.origin === origin && /\.m?js($|\?)/i.test(abs.pathname)) scriptSrcs.push(abs.href);
    } catch {
      /* skip malformed src */
    }
  }

  const found = new Set();
  for (const src of scriptSrcs.slice(0, DEFAULTS.maxBundles)) {
    let code = "";
    try {
      const res = await fetchFn(src);
      if (!res.ok) continue;
      code = (await res.text()).slice(0, DEFAULTS.maxBundleBytes);
    } catch {
      continue;
    }
    const lit = /["'`](\/[A-Za-z0-9_\-./]{0,60})["'`]/g;
    let hit;
    while ((hit = lit.exec(code)) !== null) {
      const p = hit[1];
      if (p === "/" || p.startsWith("//")) continue;
      if (NON_ROUTE_EXT.test(p) || NON_ROUTE_PREFIX.test(p)) continue;
      if (p.includes(":") || p.includes("*")) continue; // parameterised pattern, not a visitable URL
      if (p.length > 60) continue;
      found.add(origin + p.replace(/\/+$/, ""));
    }
  }

  const routes = [...found].sort();
  if (routes.length) log.log?.(`🧭 Prototype: mined ${routes.length} candidate route(s) from the app bundle.`);
  return routes;
}

/** A page's identity for duplicate detection: what a human would say is "the same screen". */
function screenFingerprint(snapshot) {
  return [snapshot.title, snapshot.headings.slice(0, 3).join("|"), (snapshot.text || "").slice(0, 200)].join("¦");
}

// ── Vision pass ─────────────────────────────────────────────────────────────

/**
 * Show the rendered screenshots to a multimodal model and ask for a tester's reading of them.
 * Same OpenRouter call shape as the Figma analyzer; a failure returns "" and the structural half
 * of the summary still ships.
 */
async function callVisionLLM({ apiKey, model, shots, log }) {
  if (!apiKey || !shots.length) return "";

  const content = [
    {
      type: "text",
      text:
        "You are a QA engineer walking through screenshots of a clickable product prototype. " +
        "The screens are given in crawl order and each is labelled with its route.\n" +
        "For EACH screen output a numbered block:\n" +
        "  1. <route> — <screen name as a user would call it>\n" +
        "     - Purpose of the screen in one sentence.\n" +
        "     - Key UI elements (forms, buttons, lists, cards, tables, modals, empty states).\n" +
        "     - Visible state cues (errors, loading, disabled, selected, counts, badges).\n" +
        "     - Navigation: where this screen can lead next, judging by its controls.\n" +
        "     - Testable scenarios specific to this screen (3-7 bullets: validation, edge cases, " +
        "empty/loaded/error states, role or permission impact, data boundaries).\n" +
        "Then a final block 'FLOW:' describing the end-to-end journeys these screens form.\n" +
        "Describe ONLY what you can see. Plain text, no markdown bold.",
    },
  ];
  for (const shot of shots) {
    content.push({ type: "text", text: `Screen route: ${shot.route}` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.base64}` } });
  }

  const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], temperature: 0, max_tokens: 4000 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vision LLM ${res.status} ${res.statusText}. ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("Vision LLM returned no choices");
  return String(data.choices[0].message?.content || "").trim();
}

// ── Crawl ───────────────────────────────────────────────────────────────────

/**
 * Drive one reusable page target through the queue of URLs.
 * @returns {Promise<{ screens: Array, shots: Array, visited: number, skipped: number }>}
 */
async function crawl({ cdp, entryUrl, queue, maxPages, viewport, navTimeoutMs, wantShots, log }) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);

  // Navigation readiness is tracked from CDP events rather than polled from the page: an SPA
  // finishes its first paint well after `load`, so what matters is the network going quiet.
  let inFlight = 0;
  let loaded = false;
  let lastActivity = Date.now();
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Network.requestWillBeSent") {
      inFlight += 1;
      lastActivity = Date.now();
    } else if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
      inFlight = Math.max(0, inFlight - 1);
      lastActivity = Date.now();
    } else if (msg.method === "Page.loadEventFired") {
      loaded = true;
      lastActivity = Date.now();
    }
  });

  const gotoUrl = async (url) => {
    inFlight = 0;
    loaded = false;
    lastActivity = Date.now();
    await cdp.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + navTimeoutMs;
    const hardStop = Date.now() + DEFAULTS.pageBudgetMs;
    while (Date.now() < deadline && Date.now() < hardStop) {
      await delay(120);
      const quietFor = Date.now() - lastActivity;
      if (loaded && inFlight === 0 && quietFor >= DEFAULTS.networkIdleMs) break;
    }
    // Client-side routing and entry animations land just after the network settles.
    await delay(500);
  };

  const snapshot = async () => {
    const res = await cdp.send(
      "Runtime.evaluate",
      { expression: SNAPSHOT_JS, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "snapshot script failed");
    return JSON.parse(String(res.result?.value || "{}"));
  };

  const shoot = async () => {
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
    const full = metrics.cssContentSize || metrics.contentSize || {};
    const height = Math.min(Math.max(Number(full.height) || viewport.height, viewport.height), 4200);
    const res = await cdp.send(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 70,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: viewport.width, height, scale: 0.55 },
      },
      sessionId,
    );
    return String(res.data || "");
  };

  // The not-found signature: mined candidates that render this are dropped rather than reported.
  let notFoundPrint = null;
  try {
    await gotoUrl(new URL(`/__aitc_probe_${Date.now().toString(36)}`, entryUrl).href);
    notFoundPrint = screenFingerprint(await snapshot());
  } catch {
    /* no probe, no filtering — every candidate is then reported on its own merits */
  }

  const screens = [];
  const shots = [];
  const seenUrls = new Set();
  const seenScreens = new Map();
  let skipped = 0;

  while (queue.length && screens.length < maxPages) {
    const url = queue.shift();
    const normalized = url.replace(/\/+$/, "") || url;
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    let snap;
    try {
      await gotoUrl(url);
      snap = await snapshot();
    } catch (err) {
      log.warn?.(`   ⚠️  ${new URL(url).pathname} — ${err.message}`);
      continue;
    }

    const print = screenFingerprint(snap);
    if (notFoundPrint && print === notFoundPrint) {
      skipped += 1;
      continue;
    }
    // Two routes rendering byte-identical content are one screen; keep the first, note the alias.
    if (seenScreens.has(print)) {
      const first = seenScreens.get(print);
      if (!first.aliases.includes(snap.route)) first.aliases.push(snap.route);
      skipped += 1;
      continue;
    }

    const screen = { url, aliases: [], ...snap };
    seenScreens.set(print, screen);
    screens.push(screen);
    log.log?.(`   ${screens.length}. ${snap.route} — ${snap.title || snap.headings[0] || "(untitled)"}`);

    if (wantShots > shots.length) {
      try {
        const base64 = await shoot();
        if (base64) shots.push({ route: snap.route, base64 });
      } catch (err) {
        log.warn?.(`   ⚠️  screenshot failed for ${snap.route}: ${err.message}`);
      }
    }

    // Harvest links for pass 2. Same-origin only; a prototype that links out to a real site must
    // not drag the crawler across the internet.
    for (const link of snap.links || []) {
      let abs;
      try {
        abs = new URL(link.href, url);
      } catch {
        continue;
      }
      if (abs.origin !== new URL(entryUrl).origin) continue;
      if (NON_ROUTE_EXT.test(abs.pathname) || NON_ROUTE_PREFIX.test(abs.pathname)) continue;
      const key = abs.href.replace(/\/+$/, "") || abs.href;
      if (seenUrls.has(key) || queue.includes(abs.href)) continue;
      queue.push(abs.href);
    }
  }

  off();
  try {
    await cdp.send("Target.closeTarget", { targetId });
  } catch {
    /* browser is about to be killed anyway */
  }

  return { screens, shots, visited: seenUrls.size, skipped };
}

// ── Summary ─────────────────────────────────────────────────────────────────

function formatScreen(screen, index) {
  const lines = [];
  const name = screen.title || screen.headings[0] || "(untitled)";
  lines.push(`  ${index}. ${screen.route}  —  ${name}`);
  if (screen.aliases.length) lines.push(`     Also reachable at: ${screen.aliases.join(", ")}`);
  if (screen.headings.length) lines.push(`     Headings: ${screen.headings.slice(0, 8).join(" | ")}`);
  if (screen.text) lines.push(`     Copy: ${screen.text}`);
  if (screen.tabs?.length) lines.push(`     Tabs / menu: ${screen.tabs.join(" | ")}`);
  if (screen.buttons.length) lines.push(`     Buttons: ${screen.buttons.join(" | ")}`);
  if (screen.fields.length) {
    lines.push("     Form fields:");
    for (const f of screen.fields) {
      const bits = [
        `type=${f.control}`,
        f.label ? `label="${f.label}"` : "",
        f.name ? `name=${f.name}` : "",
        f.placeholder ? `placeholder="${f.placeholder}"` : "",
        f.required ? "required" : "",
        f.disabled ? "disabled" : "",
        f.readonly ? "readonly" : "",
        f.constraints || "",
        f.options ? `options: ${f.options.join(", ")}` : "",
      ].filter(Boolean);
      lines.push(`       - ${bits.join(", ")}`);
    }
  }
  for (const t of screen.tables || []) {
    lines.push(`     Table: columns [${t.columns.join(", ")}], ${t.rows} row(s) rendered`);
  }
  if (screen.dialogs?.length) lines.push(`     Dialog visible: ${screen.dialogs.join(" || ")}`);
  if (screen.messages?.length) lines.push(`     Status / error / empty-state text: ${screen.messages.join(" || ")}`);
  if (screen.images?.length) lines.push(`     Images (alt): ${screen.images.join(", ")}`);
  const nav = (screen.links || [])
    .map((l) => `${l.text || "(no text)"} → ${l.href}`)
    .slice(0, 12);
  if (nav.length) lines.push(`     Links out: ${nav.join(" | ")}`);
  return lines.join("\n");
}

function buildSummary({ entryUrl, screens, visionText, visionCount, truncated }) {
  const lines = [];
  lines.push("LIVE PROTOTYPE CONTEXT (clickable build linked by the QA author for this ticket)");
  lines.push(`URL: ${entryUrl}`);
  lines.push(
    `Crawled ${screens.length} distinct screen(s) with a real browser; each one below was rendered and inspected.` +
      (truncated ? " The page budget was reached, so more screens may exist." : ""),
  );
  lines.push("");
  lines.push("Screen inventory (parsed from the rendered DOM):");
  screens.forEach((s, i) => lines.push(formatScreen(s, i + 1)));

  if (visionText) {
    lines.push("");
    lines.push(`Visual analysis (vision LLM looked at ${visionCount} full-page screenshot(s)):`);
    lines.push(visionText);
  }

  lines.push("");
  lines.push("How to use this context:");
  lines.push("  - This is the delivered UI, not a mock-up: treat the labels, button texts, field names and messages above as the EXACT wording for test steps and expected results.");
  lines.push("  - Cover the navigation between screens as flows, not only screens in isolation — the routes and the links out show which journeys exist.");
  lines.push("  - For every form field, use its listed constraints (required, maxlength, min/max, pattern, option list) to design the boundary and negative cases.");
  lines.push("  - For every empty-state, error or status message found above, write a scenario that reaches that state.");
  lines.push("  - Where the prototype and the ticket description disagree, follow the ticket and call the difference out in \"reasoning\" — a prototype can be ahead of or behind the requirement.");
  lines.push("  - Do NOT invent screens, fields or routes that are absent from this inventory.");
  return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Main entry, mirroring figma-client.analyzeFigmaUrl().
 *
 * @param {string} rawUrl the prototype's entry URL
 * @param {Object} [options] overrides for the env knobs; `log` takes a console-shaped object
 * @returns {Promise<{ summary: string, error: string|null, stats: Object|null }>}
 */
async function analyzePrototypeUrl(rawUrl, options = {}) {
  const log = options.log || console;
  const entry = String(rawUrl || "").trim();
  if (!entry) return { summary: "", error: null, stats: null };
  if (!isHttpUrl(entry)) return { summary: "", error: `Not an http(s) URL: ${entry}`, stats: null };

  const maxPages = options.maxPages ?? envInt("PROTOTYPE_MAX_PAGES", DEFAULTS.maxPages);
  const navTimeoutMs = options.navTimeoutMs ?? envInt("PROTOTYPE_NAV_TIMEOUT_MS", DEFAULTS.navTimeoutMs);
  const viewport = parseViewport(options.viewport ?? process.env.PROTOTYPE_VIEWPORT, DEFAULTS.viewport);
  const includeVision =
    options.includeVision !== undefined
      ? !!options.includeVision
      : String(process.env.PROTOTYPE_INCLUDE_VISION || "true").toLowerCase() !== "false";
  const visionMaxPages = options.visionMaxPages ?? envInt("PROTOTYPE_VISION_MAX_PAGES", DEFAULTS.visionMaxPages);
  const visionModel =
    options.visionModel || process.env.PROTOTYPE_VISION_MODEL || process.env.FIGMA_VISION_MODEL || DEFAULTS.visionModel;
  const openrouterApiKey = options.openrouterApiKey || process.env.OPENROUTER_API_KEY;

  const exePath = findBrowserExecutable();
  if (!exePath) {
    return {
      summary: "",
      error:
        "No Chrome / Edge / Chromium found to render the prototype. Install Google Chrome, or point PROTOTYPE_BROWSER_PATH at a browser executable.",
      stats: null,
    };
  }

  log.log?.(`🧭 Prototype: crawling ${entry} (up to ${maxPages} screen(s))`);

  // Route mining runs before the browser starts: it is plain HTTP, and its result seeds the queue.
  const mined = await mineRoutesFromBundles(entry, log);
  const queue = [entry, ...mined.filter((u) => u !== entry.replace(/\/+$/, ""))];

  let browser = null;
  let cdp = null;
  try {
    browser = await launchBrowser(exePath, viewport, log);
    cdp = await CdpSession.connect(browser.wsUrl);

    const wantShots = includeVision && openrouterApiKey ? visionMaxPages : 0;
    const startedWith = queue.length;
    const { screens, shots, skipped } = await crawl({
      cdp,
      entryUrl: entry,
      queue,
      maxPages,
      viewport,
      navTimeoutMs,
      wantShots,
      log,
    });

    if (screens.length === 0) {
      return {
        summary: "",
        error: `The prototype at ${entry} rendered no readable screen (is it reachable and public?).`,
        stats: null,
      };
    }

    let visionText = "";
    if (shots.length) {
      try {
        log.log?.(`🧭 Prototype: sending ${shots.length} screenshot(s) to the vision model…`);
        visionText = await callVisionLLM({ apiKey: openrouterApiKey, model: visionModel, shots, log });
      } catch (err) {
        log.warn?.(`⚠️  Prototype vision analysis failed (continuing with the DOM inventory): ${err.message}`);
      }
    } else if (includeVision && !openrouterApiKey) {
      log.warn?.("⚠️  OPENROUTER_API_KEY missing — prototype vision step skipped.");
    }

    const truncated = screens.length >= maxPages && queue.length > 0;
    const summary = buildSummary({
      entryUrl: entry,
      screens,
      visionText,
      visionCount: shots.length,
      truncated,
    });

    return {
      summary,
      error: null,
      stats: {
        entryUrl: entry,
        screens: screens.length,
        routesMined: mined.length,
        candidates: startedWith,
        duplicatesOrMissing: skipped,
        visionScreens: shots.length,
        visionModel: shots.length && visionText ? visionModel : null,
        truncated,
      },
    };
  } catch (err) {
    return { summary: "", error: `Prototype crawl failed: ${err.message}`, stats: null };
  } finally {
    if (cdp) cdp.close();
    if (browser) browser.close();
  }
}

module.exports = {
  isHttpUrl,
  analyzePrototypeUrl,
};

// Manual check: `node prototype-client.js https://example.netlify.app/`
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node prototype-client.js <prototype-url>");
    process.exit(1);
  }
  analyzePrototypeUrl(url, { includeVision: String(process.env.PROTOTYPE_INCLUDE_VISION || "false") === "true" })
    .then((r) => {
      if (r.error) console.error(`\n❌ ${r.error}`);
      if (r.summary) console.log(`\n${r.summary}`);
      if (r.stats) console.log(`\nstats: ${JSON.stringify(r.stats)}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
