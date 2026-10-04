#!/usr/bin/env node
/**
 * Serves ./web + API: native folder picker (same class of UI as system "Open Folder"),
 * Day 1 run (spawn agent). Binds 0.0.0.0 for localhost/Cursor compatibility.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync, execFile } = require("child_process");
const { wantsRawMarkdown, buildGuideHtml } = require("./markdown-preview.js");
// Required before anything reads process.env: applies config.local.json (the Setup
// page), then .env for whatever is still unset. Also snapshots the pristine shell env.
const configStore = require("./config-store.js");
configStore.loadEnv();

const adoContextStore = require("./ado-context-store.js");
const tmsContext = require("./tms-context.js");
const tmsExportCsv = require("./tms-export-csv.js");
const { splitTags } = require("./ado-export-tag-csv.js");
const examplesStore = require("./examples-store.js");

const WEB_ROOT = path.join(__dirname, "web");
/** PNG: ai-test-coverage.ico is multi‑MB; browsers often ignore huge favicons and show the default globe. */
const FAVICON_PNG_PATH = path.join(__dirname, "assets", "ai-test-coverage.png");
const PORT = Number(process.env.WEB_UI_PORT || 3847);
const INDEX_PLACEHOLDER = "__AI_TEST_COVERAGE_API_ORIGIN__";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * Normalizes request path. Cursor / some embedded browsers send absolute-form targets:
 *   GET http://127.0.0.1:3847/api/pick-folder HTTP/1.1
 * so req.url is the full URL, not "/api/pick-folder". Plain path.posix.normalize() breaks that.
 */
function getPathname(req) {
  let raw = String(req.url || "/").split("?")[0].split("#")[0].trim();

  if (!raw.startsWith("/")) {
    try {
      if (/^https?:\/\//i.test(raw)) {
        raw = new URL(raw).pathname || "/";
      } else {
        const host = req.headers.host || `127.0.0.1:${PORT}`;
        raw = new URL(raw, `http://${host}`).pathname || "/";
      }
    } catch {
      raw = "/";
    }
  }

  let n = path.posix.normalize(raw).replace(/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n || "/";
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(root, normalized);
  if (!full.startsWith(root)) return null;
  return full;
}

const reviewSession = require("./review-session");

/**
 * Scratch file used to hand a JSON payload to (and read one back from) an agent-docs.js stage.
 * Kept outside the project so a crashed run never leaves anything in the user's folder.
 */
function withPipelineIoFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-pipeline-"));
  const file = path.join(dir, "io.json");
  return Promise.resolve(fn(file)).finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

/** Windows: create Desktop «AI Test Coverage» shortcut if missing (same as npm run shortcut). */
function maybeEnsureWindowsDesktopShortcut() {
  if (process.platform !== "win32") return;
  const ensureScript = path.join(__dirname, "scripts", "ensure-desktop-shortcut.ps1");
  if (!fs.existsSync(ensureScript)) return;
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const ps = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFile(
    ps,
    ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", ensureScript],
    { cwd: __dirname, windowsHide: true, timeout: 120000 },
    (err, stdout, stderr) => {
      if (err) {
        console.warn("AI Test Coverage: optional desktop shortcut step failed:", err.message || String(err));
        console.warn("AI Test Coverage: run `npm run shortcut` to create the Desktop shortcut manually.");
        if (stderr) process.stderr.write(String(stderr));
        return;
      }
      const out = String(stdout || "").trim();
      if (out) console.log(out);
    }
  );
}

/** macOS: create Desktop «AI Test Coverage.app» if missing (same as npm run shortcut). */
function maybeEnsureMacDesktopShortcut() {
  if (process.platform !== "darwin") return;
  const ensureScript = path.join(__dirname, "scripts", "ensure-desktop-shortcut.sh");
  if (!fs.existsSync(ensureScript)) return;
  execFile(
    "/bin/bash",
    [ensureScript],
    { cwd: __dirname, timeout: 120000 },
    (err, stdout, stderr) => {
      if (err) {
        console.warn("AI Test Coverage: optional desktop shortcut step failed:", err.message || String(err));
        console.warn("AI Test Coverage: run `npm run shortcut` to create the Desktop shortcut manually.");
        if (stderr) process.stderr.write(String(stderr));
        return;
      }
      const out = String(stdout || "").trim();
      if (out) console.log(out);
    }
  );
}

/** macOS: system folder sheet (same family of UI as Finder / Open Folder). */
function pickFolderDarwin() {
  const script = [
    "try",
    "\tset theFolder to choose folder with prompt \"Select the AI Test Coverage project folder:\"",
    "\treturn POSIX path of theFolder",
    "on error number -128",
    "\treturn \"\"",
    "end try",
    "",
  ].join("\n");

  const r = spawnSync("osascript", ["-"], {
    input: script,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
  });

  const p = (r.stdout || "").trim();
  if (!p) return null;
  const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
  return fs.existsSync(normalized) && fs.statSync(normalized).isDirectory() ? normalized : null;
}

/**
 * Windows folder picker.
 *
 * Backed by scripts/pick-folder.ps1, which wraps FolderBrowserDialog in a TopMost
 * owner Form + SetForegroundWindow. Required because the AI Test Coverage launcher
 * starts the tree with `-WindowStyle Hidden` and Node spawns PowerShell with
 * CREATE_NO_WINDOW; without an explicit owner the dialog opens behind the browser
 * and the front-end polls /folder-pick/status forever.
 *
 * Using `-File` (not `-Command`) avoids stripping the `"user32.dll"` quotes from
 * the inline P/Invoke signature.
 */
const PICK_FOLDER_PS1 = path.join(__dirname, "scripts", "pick-folder.ps1");

function pickFolderWindowsArgs() {
  return ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", PICK_FOLDER_PS1];
}

function pickFolderWindows() {
  try {
    const out = execFileSync("powershell.exe", pickFolderWindowsArgs(), {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    });
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    const p = lines[lines.length - 1];
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function pickFolderLinux() {
  try {
    const out = execFileSync(
      "zenity",
      ["--file-selection", "--directory", "--title=Select AI Test Coverage folder", "--modal"],
      { encoding: "utf8", timeout: 120000 }
    );
    const p = out.trim();
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    /* try KDE */
  }
  try {
    const out = execFileSync("kdialog", ["--getexistingdirectory", "."], {
      encoding: "utf8",
      timeout: 120000,
    });
    const p = out.trim();
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function pickFolderDialog() {
  if (process.platform === "win32") return pickFolderWindows();
  if (process.platform === "darwin") return pickFolderDarwin();
  if (process.platform === "linux") return pickFolderLinux();
  return pickFolderLinux();
}

/** Non-blocking folder dialog so the HTTP server can answer /status polls while the OS sheet is open. */
function pickFolderDarwinAsync() {
  return new Promise((resolve) => {
    const script = [
      "try",
      "\tset theFolder to choose folder with prompt \"Select the AI Test Coverage project folder:\"",
      "\treturn POSIX path of theFolder",
      "on error number -128",
      "\treturn \"\"",
      "end try",
      "",
    ].join("\n");
    const child = spawn("osascript", ["-"], { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(t);
      const p = out.trim();
      if (!p) return resolve(null);
      const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
      resolve(fs.existsSync(normalized) && fs.statSync(normalized).isDirectory() ? normalized : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function pickFolderWindowsAsync() {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", pickFolderWindowsArgs(), { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(t);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const p = lines[lines.length - 1];
      resolve(p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

function pickFolderLinuxAsync() {
  return new Promise((resolve) => {
    execFile(
      "zenity",
      ["--file-selection", "--directory", "--title=Select AI Test Coverage folder", "--modal"],
      { encoding: "utf8", timeout: 120000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          const p = stdout.trim();
          if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return resolve(p);
        }
        execFile("kdialog", ["--getexistingdirectory", "."], { encoding: "utf8", timeout: 120000 }, (e2, out2) => {
          if (e2 || !out2) return resolve(null);
          const p2 = out2.trim();
          resolve(p2 && fs.existsSync(p2) && fs.statSync(p2).isDirectory() ? p2 : null);
        });
      }
    );
  });
}

function pickFolderDialogAsync() {
  if (process.platform === "win32") return pickFolderWindowsAsync();
  if (process.platform === "darwin") return pickFolderDarwinAsync();
  return pickFolderLinuxAsync();
}

/** Same dialog family as the folder picker, but for a single CSV file. */
const PICK_FILE_PS1 = path.join(__dirname, "scripts", "pick-file.ps1");

function pickCsvFileWindowsAsync() {
  return new Promise((resolve) => {
    const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", PICK_FILE_PS1];
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(t);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const p = lines[lines.length - 1];
      resolve(p && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

function pickCsvFileDarwinAsync() {
  const script = [
    "try",
    "\tset theFile to choose file with prompt \"Select the CSV to update:\" of type {\"csv\", \"public.comma-separated-values-text\"}",
    "\treturn POSIX path of theFile",
    "on error number -128",
    "\treturn \"\"",
    "end try",
    "",
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn("osascript", ["-"], { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 120000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(t);
      const p = out.trim();
      resolve(p && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    child.stdin.end(script);
  });
}

function pickCsvFileLinuxAsync() {
  return new Promise((resolve) => {
    execFile(
      "zenity",
      ["--file-selection", "--title=Select the CSV to update", "--file-filter=CSV files | *.csv *.CSV", "--modal"],
      { encoding: "utf8", timeout: 120000, windowsHide: true },
      (err, stdout) => {
        if (!err && stdout) {
          const p = stdout.trim();
          if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return resolve(p);
        }
        execFile("kdialog", ["--getopenfilename", ".", "*.csv"], { encoding: "utf8", timeout: 120000 }, (e2, out2) => {
          if (e2 || !out2) return resolve(null);
          const p2 = out2.trim();
          resolve(p2 && fs.existsSync(p2) && fs.statSync(p2).isFile() ? p2 : null);
        });
      }
    );
  });
}

function pickCsvFileDialogAsync() {
  if (process.platform === "win32") return pickCsvFileWindowsAsync();
  if (process.platform === "darwin") return pickCsvFileDarwinAsync();
  return pickCsvFileLinuxAsync();
}

/**
 * Environment for a spawned tool. Re-reads the Setup config on every call, so
 * saving on the Setup page takes effect without restarting the server:
 * shell env > config.local.json > project `.env` > per-run overrides.
 */
function envForChild(abs, overrides = {}) {
  return configStore.childEnv(abs, overrides);
}

/**
 * The Setup page's "Read prototype" switch (Azure DevOps card). Read per request, not cached, for
 * the same reason envForChild() re-reads the config: a save on Setup must take effect right away.
 */
function prototypeReadEnabled() {
  try {
    return String(configStore.readConfig().PROTOTYPE_READ || "no").toLowerCase() === "yes";
  } catch {
    return false;
  }
}

/**
 * The prototype link off a Create / Update request.
 *
 * Returns "" — not an error — when the switch is off, so a stale tab that still shows the field
 * cannot smuggle a crawl into a run the Setup page has turned off. A malformed link *is* an error:
 * the QA engineer typed it on purpose and would otherwise get a silent no-op.
 *
 * @returns {{ url: string } | { error: string }}
 */
function prototypeUrlFrom(body) {
  const raw = String(body.prototypeUrl || "").trim();
  if (!raw) return { url: "" };
  if (!prototypeReadEnabled()) return { url: "" };
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
    return { error: "prototypeUrl must be an http(s) link, e.g. https://your-prototype.netlify.app/" };
  }
  return { url: raw };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 2_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function runSpawn(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cap = 600_000;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > cap) stderr = stderr.slice(-cap);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
  });
}

/**
 * Stream child output as it arrives (terminal-like). `onEvent` receives NDJSON-serializable objects.
 */
function runSpawnStreaming(command, args, options, onEvent) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cap = 600_000;
    const push = (ev) => {
      try {
        onEvent(ev);
      } catch (_) {
        /* client disconnected */
      }
    };
    child.stdout?.on("data", (d) => {
      const t = d.toString();
      stdout += t;
      if (stdout.length > cap) stdout = stdout.slice(-cap);
      push({ event: "stdout", text: t });
    });
    child.stderr?.on("data", (d) => {
      const t = d.toString();
      stderr += t;
      if (stderr.length > cap) stderr = stderr.slice(-cap);
      push({ event: "stderr", text: t });
    });
    child.on("close", (code) => {
      const c = code ?? 0;
      push({ event: "end", code: c, ok: c === 0 });
      resolve({ code: c, stdout, stderr });
    });
    child.on("error", (err) => {
      const msg = `${err && err.message ? err.message : err}\n`;
      stderr += msg;
      push({ event: "stderr", text: msg });
      push({ event: "end", code: -1, ok: false });
      resolve({ code: -1, stdout, stderr });
    });
  });
}

/**
 * Validate an "update test design" request and build the child env for agent-update-csv.js.
 * Shared by /run-update-csv (generate + post in one go) and /review/update/generate.
 * @returns {{error: string} | {abs: string, env: Object, jiraKey: string, updatedFlowMode: string, checkApproval: boolean}}
 */
function prepareUpdateRun(body) {
  const projectPath = String(body.projectPath || "").trim();
  const jiraKey = String(body.jiraKey || "").trim();
  const mainSection = String(body.mainSection || "2");
  let updatedFlowMode = String(body.updatedFlowMode || "auto").toLowerCase().trim();
  const updatedFlowInputFile = String(body.updatedFlowInputFile || "").trim();
  const figmaUrl = String(body.figmaUrl || "").trim();
  const prototype = prototypeUrlFrom(body);
  if (prototype.error) return { error: prototype.error };

  if (!jiraKey) return { error: "JIRA_ISSUE_KEY is required" };
  if (mainSection !== "2" && mainSection !== "4") return { error: "mainSection must be 2 or 4" };

  const checkApproval = mainSection === "4";
  if (!["auto", "checklist", "testcases"].includes(updatedFlowMode)) updatedFlowMode = "auto";
  if (!checkApproval && !updatedFlowInputFile) {
    return { error: "CSV file name is required for this step" };
  }
  if (figmaUrl && !/^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i.test(figmaUrl)) {
    return { error: "figmaUrl must be a https://www.figma.com/... URL" };
  }

  const abs = path.resolve(projectPath);
  const v = validateUpdateProjectDir(abs);
  if (!v.ok) return { error: v.error };

  const env = envForChild(abs, {
    JIRA_ISSUE_KEY: jiraKey,
    CHECK_APPROVAL: checkApproval ? "true" : "false",
  });
  if (!checkApproval) {
    env.UPDATED_FLOW_MODE = updatedFlowMode;
    env.UPDATED_FLOW_INPUT_FILE = updatedFlowInputFile;
  }
  if (figmaUrl) env.FIGMA_URL = figmaUrl;
  if (prototype.url) env.PROTOTYPE_URL = prototype.url;

  return { abs, env, jiraKey, updatedFlowMode, checkApproval };
}

/** Which agent script owns this review session. */
function reviewScriptFor(envelope) {
  return envelope && envelope.flow === "update" ? "agent-update-csv.js" : "agent-docs.js";
}

/**
 * Copy the reviewer's edits from the request into the session.
 * Create sends one `payload`; update sends `blocks`, each with its own payload, and the block
 * order is the APPROVED (n) numbering, so only the payloads are taken — never the ordering.
 */
function applyReviewedEdits(envelope, body) {
  if (envelope.flow === "update") {
    if (!Array.isArray(body.blocks)) return;
    body.blocks.forEach((edited, i) => {
      const target = (envelope.blocks || [])[i];
      if (target && edited && typeof edited.payload === "object") {
        target.payload = edited.payload;
      }
    });
    return;
  }
  if (body.payload && typeof body.payload === "object") {
    envelope.payload = body.payload;
  }
}

/** Pull the most useful single line out of a failed child run, for the UI toast. */
function firstErrorLine(stderr, stdout) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const marked = text.split(/\r?\n/).find((l) => /^\s*(❌|Error:)/.test(l));
  if (marked) return marked.replace(/^\s*❌\s*/, "").trim();
  const lastStderr = String(stderr || "").split(/\r?\n/).filter(Boolean).pop();
  return lastStderr ? lastStderr.trim() : "";
}

/**
 * Validate a "generate test design" request and build the child env for agent-docs.js.
 * Shared by /run-day1 (generate + post in one go) and /review/generate (generate for review),
 * so both flows read exactly the same switches off the Create page.
 * @returns {{error: string} | {abs: string, env: Object, jiraKey: string, generateMode: string}}
 */
function prepareGenerationRun(body) {
  const projectPath = String(body.projectPath || "").trim();
  const jiraKey = String(body.jiraKey || "").trim();
  const relatedKeywords = String(body.relatedKeywords || "").trim();
  // BDD output is a Feature made of Scenarios, i.e. the test-case shape. The
  // page already forces the selector, but a stale tab or a direct POST must not
  // be able to ask for a "BDD checklist" — agent-docs.js applies the same rule.
  const testFormat = String(body.testFormat || "standard").toLowerCase().trim() === "bdd" ? "bdd" : "standard";
  const generateMode = testFormat === "bdd" ? "testcases" : String(body.generateMode || "checklist");
  const relatedJiraSearch = String(body.relatedJiraSearch || "yes");
  // The create page owns this switch (default Yes); only an explicit "no" disables it.
  const analyzeTestCases = String(body.analyzeTestCases || "yes");
  const testCasesLimitRaw = String(body.testCasesLimit || "").trim().toLowerCase();
  const figmaUrl = String(body.figmaUrl || "").trim();
  const prototype = prototypeUrlFrom(body);
  if (prototype.error) {
    return { error: prototype.error };
  }

  if (!jiraKey) {
    return { error: "JIRA_ISSUE_KEY is required" };
  }
  if (figmaUrl && !/^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i.test(figmaUrl)) {
    return { error: "figmaUrl must be a https://www.figma.com/... URL" };
  }

  const abs = path.resolve(projectPath);
  const v = validateProjectDir(abs);
  if (!v.ok) {
    return { error: v.error };
  }

  const env = envForChild(abs, { CHECK_APPROVAL: "false" });
  env.JIRA_ISSUE_KEY = jiraKey;
  if (generateMode === "testcases") env.GENERATE_MODE = "testcases";
  if (testFormat === "bdd") env.TEST_DESIGN_FORMAT = "bdd";
  if (relatedKeywords) env.RELATED_ISSUES_KEYWORDS = relatedKeywords;
  if (relatedJiraSearch === "no") env.ENABLE_RELATED_ISSUES_SEARCH = "false";
  env.ENABLE_TEST_CASES_ANALYSIS = analyzeTestCases === "no" ? "false" : "true";
  if (generateMode === "testcases" && testCasesLimitRaw) {
    const isCustomPositiveInt = /^[1-9][0-9]*$/.test(testCasesLimitRaw);
    if (testCasesLimitRaw === "unlimited" || isCustomPositiveInt) {
      env.TEST_CASES_LIMIT = testCasesLimitRaw;
    }
  }
  if (figmaUrl) env.FIGMA_URL = figmaUrl;
  if (prototype.url) env.PROTOTYPE_URL = prototype.url;

  return { abs, env, jiraKey, generateMode, testFormat };
}

/**
 * Issue key out of whatever the QA engineer pasted.
 *
 * Covers the three shapes a Jira link actually takes — `/browse/KEY`, a board URL carrying
 * `?selectedIssue=KEY`, and the new-issue-view `/issues/KEY` — then falls back to the last
 * key-shaped token, which also makes a bare "PROJ-123" work.
 *
 * @param {string} raw
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

/**
 * Validate a "Cover a bug" request and build the child env for agent-docs.js.
 *
 * Deliberately narrower than prepareGenerationRun(): this flow always produces test cases (the
 * page's only choice is Standard vs BDD), and it sets DIRECT_TMS_IMPORT so agent-docs.js skips
 * the Test design sub-task it would otherwise demand.
 *
 * @returns {{error: string} | {abs: string, env: Object, jiraKey: string, testFormat: string}}
 */
function prepareIssueCaseRun(body) {
  const jiraKey = jiraKeyFromLink(body.jiraLink || body.jiraKey);
  if (!jiraKey) {
    return { error: "Paste a Jira issue link, e.g. https://your-site.atlassian.net/browse/PROJ-123" };
  }

  const abs = path.resolve(String(body.projectPath || "").trim());
  const v = validateProjectDir(abs);
  if (!v.ok) return { error: v.error };

  const testFormat = String(body.testFormat || "standard").toLowerCase().trim() === "bdd" ? "bdd" : "standard";

  const env = envForChild(abs, { CHECK_APPROVAL: "false" });
  env.JIRA_ISSUE_KEY = jiraKey;
  env.GENERATE_MODE = "testcases";
  env.DIRECT_TMS_IMPORT = "true";
  if (testFormat === "bdd") env.TEST_DESIGN_FORMAT = "bdd";
  // Same defaults the Create page ships with, minus the switches — this page has no Jira
  // round-trip to tune, so it keeps the richest context rather than growing two more selects.
  env.ENABLE_TEST_CASES_ANALYSIS = "true";
  // No linked context at all: the case must describe the ticket in the link and nothing else.
  // Neighbouring Jira issues would pull in their own QA scenarios and blur a single focused case,
  // and linked Confluence pages do the same — so both searches are off, not merely defaulted.
  env.ENABLE_RELATED_ISSUES_SEARCH = "false";
  env.ENABLE_CONFLUENCE_SEARCH = "false";
  // One issue in, one test case out — the whole point of this flow, so it is pinned here rather
  // than offered as a control. The prompt reads a cap of 1 as "this case IS the test design",
  // not as "at most one", so the result is one deep case instead of a thin sample.
  env.TEST_CASES_LIMIT = "1";

  return { abs, env, jiraKey, testFormat };
}

function validateProjectDir(abs) {
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    // Name the path. An empty field resolves to the server's own directory and a placeholder to a
    // folder next to it, so the bare sentence sent people looking at a path they never typed.
    return { ok: false, error: `Project path is not a directory: ${abs || "(empty)"}` };
  }
  const agentJs = path.join(abs, "agent-docs.js");
  if (!fs.existsSync(agentJs)) {
    return { ok: false, error: "Folder must contain agent-docs.js (AI Test Coverage root)" };
  }
  return { ok: true };
}

function validateUpdateProjectDir(abs) {
  const base = validateProjectDir(abs);
  if (!base.ok) return base;
  const updateJs = path.join(abs, "agent-update-csv.js");
  if (!fs.existsSync(updateJs)) {
    return { ok: false, error: "Folder must contain agent-update-csv.js (updated CSV flow)" };
  }
  return { ok: true };
}

function validateAdoExportTagProject(abs) {
  const base = validateProjectDir(abs);
  if (!base.ok) return base;
  const script = path.join(abs, "ado-export-tag-csv.js");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "Folder must contain ado-export-tag-csv.js" };
  }
  return { ok: true };
}

/**
 * What the "Analyze existing test cases first" step will feed to the prompt:
 * CSV/TXT files in the project's "Test cases" folder (same filter as
 * loadProjectTestCases in agent-docs.js), with size/age and a rough test case
 * count so the UI can show WHICH context a generation would use.
 */
function readTestCasesContext(abs) {
  const folder = path.join(abs, "Test cases");
  const out = { folder, exists: false, files: [] };
  if (!fs.existsSync(folder)) return out;
  out.exists = true;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (ext !== ".csv" && ext !== ".txt") continue;
    const filePath = path.join(folder, ent.name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const file = {
      name: ent.name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      caseCount: null,
    };
    if (ext === ".csv") {
      try {
        const text = fs.readFileSync(filePath, "utf8");
        // Test case header rows have "Test Case" in the Work Item Type column.
        file.caseCount = text
          .split(/\r?\n/)
          .filter((l) => /^[^,]*,\s*"?Test Case"?\s*,/i.test(l)).length;
      } catch {
        /* count stays null; the file is still listed */
      }
    }
    out.files.push(file);
  }
  out.files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return out;
}

/** Comma-separated tags are one OR-ed query; past this many it is a paste accident, not a filter. */
const ADO_EXPORT_MAX_TAGS = 20;

function sanitizeAdoExportTag(raw) {
  const tag = String(raw || "").trim();
  if (!tag) return { ok: false, error: "Tag is required" };
  if (tag.length > 500) return { ok: false, error: "Tag is too long" };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(tag)) return { ok: false, error: "Invalid characters in tag" };
  const tags = splitTags(tag);
  if (!tags.length) return { ok: false, error: "Tag is required" };
  if (tags.length > ADO_EXPORT_MAX_TAGS) {
    return { ok: false, error: `Too many tags (${tags.length}) — the limit is ${ADO_EXPORT_MAX_TAGS}` };
  }
  return { ok: true, tag: tags.join(", "), count: tags.length };
}

/** Single file name only (no path traversal) for Downloads lookup. */
function safeDownloadsFileName(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "File name is required" };
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.includes("/") || normalized.includes("..")) {
    return { ok: false, error: "Use a file name only, not a path" };
  }
  const base = path.basename(normalized);
  if (!base || base === "." || base === ".." || /[\x00-\x1f]/.test(base)) {
    return { ok: false, error: "Invalid file name" };
  }
  return { ok: true, base };
}

/** Same idea as copy-csv-from-downloads.js — env override + default + OneDrive Downloads on Windows. */
function getDownloadsLookupDirs() {
  const out = [];
  const seen = new Set();
  const push = (d) => {
    if (!d) return;
    const r = path.resolve(d);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  if (process.env.DOWNLOADS_DIR) push(process.env.DOWNLOADS_DIR);
  push(path.join(os.homedir(), "Downloads"));
  if (process.platform === "win32") {
    push(path.join(os.homedir(), "OneDrive", "Downloads"));
  }
  return out;
}

/**
 * Exact basename match in Downloads (any candidate dir). If missing .csv, tries name + ".csv".
 * @returns {{ found: boolean, fileName: string, sourcePath: string | null }}
 */
function locateCsvInDownloads(base) {
  const candidates = [base];
  if (!/\.csv$/i.test(base)) candidates.push(`${base}.csv`);
  for (const dir of getDownloadsLookupDirs()) {
    if (!fs.existsSync(dir)) continue;
    const resolvedDir = path.resolve(dir);
    for (const name of candidates) {
      const fullPath = path.resolve(path.join(dir, name));
      const rel = path.relative(resolvedDir, fullPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return { found: true, fileName: name, sourcePath: fullPath };
        }
      } catch {
        /* next */
      }
    }
  }
  return { found: false, fileName: base, sourcePath: null };
}

/**
 * Two-phase OS pick (folder or file): the request returns a job id immediately,
 * because embedded browsers time out if the dialog blocks the response.
 */
const pickJobs = new Map();
const PICK_JOB_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of pickJobs) {
    if (now - j.at > PICK_JOB_TTL_MS) pickJobs.delete(id);
  }
}, 60_000);

/** Answers with a job id, then runs `dialogFn` in the background. */
function startPickJob(dialogFn, res) {
  const jobId = crypto.randomUUID();
  pickJobs.set(jobId, { status: "pending", at: Date.now() });
  const sent = json(res, 200, { jobId, mode: "two-phase" });
  setImmediate(() => {
    dialogFn()
      .then((picked) => {
        const j = pickJobs.get(jobId);
        if (!j) return;
        if (picked) {
          j.status = "done";
          j.path = picked;
        } else {
          j.status = "cancelled";
        }
      })
      .catch((e) => {
        const j = pickJobs.get(jobId);
        if (j) {
          j.status = "error";
          j.error = String(e && e.message ? e.message : e);
        }
      });
  });
  return sent;
}

function requestUrl(req) {
  const raw = req.url || "/";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return new URL(raw);
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return new URL(raw, `http://${host}`);
  } catch {
    return new URL(`http://127.0.0.1:${PORT}/`);
  }
}

const FOLDER_PICK_START_PATHS = new Set([
  "/__da/folder-pick/start",
  "/web/folder-pick-start.json",
]);
const FILE_PICK_START_PATHS = new Set(["/__da/file-pick/start", "/api/file-pick/start"]);
/** Both pickers share one job store, so one status route serves both. */
const PICK_STATUS_PATHS = new Set([
  "/__da/folder-pick/status",
  "/web/folder-pick-status.json",
  "/__da/file-pick/status",
  "/api/file-pick/status",
]);

const PICK_FOLDER_SYNC_PATHS = new Set(["/__da/pick-folder", "/api/pick-folder"]);
const RUN_DAY1_PATHS = new Set(["/__da/run-day1", "/api/run-day1"]);
const REVIEW_GENERATE_PATHS = new Set(["/__da/review/generate", "/api/review/generate"]);
const REVIEW_UPDATE_GENERATE_PATHS = new Set(["/__da/review/update/generate", "/api/review/update/generate"]);
const REVIEW_REGENERATE_PATHS = new Set(["/__da/review/regenerate", "/api/review/regenerate"]);
const REVIEW_SUBMIT_PATHS = new Set(["/__da/review/submit", "/api/review/submit"]);
const RUN_DAY2_PATHS = new Set(["/__da/run-day2", "/api/run-day2"]);
const RUN_UPDATE_CSV_PATHS = new Set(["/__da/run-update-csv", "/api/run-update-csv"]);
const RUN_ADO_EXPORT_TAG_PATHS = new Set(["/__da/run-ado-export-tag-csv", "/api/run-ado-export-tag-csv"]);
const PREVIEW_RELATED_PATHS = new Set(["/__da/preview-related-issues", "/api/preview-related-issues"]);
const TEST_CASES_CONTEXT_PATHS = new Set(["/__da/test-cases-context", "/api/test-cases-context"]);
const CLEAR_TEST_CASES_PATHS = new Set(["/__da/clear-test-cases", "/api/clear-test-cases"]);
const DOWNLOADS_LOOKUP_PATHS = new Set(["/__da/downloads-lookup", "/api/downloads-lookup"]);
const ADD_CSV_TO_UPDATED_PATHS = new Set(["/__da/add-csv-to-updated", "/api/add-csv-to-updated"]);

/** Setup page (web/setup.html): read / save / verify the local config store. */
const CONFIG_PATHS = new Set(["/__da/config", "/api/config"]);
const CONFIG_TEST_PATHS = new Set(["/__da/config/test", "/api/config/test"]);
const CONFIG_IMPORT_DOTENV_PATHS = new Set(["/__da/config/import-dotenv", "/api/config/import-dotenv"]);
const CONFIG_EXPORT_PATHS = new Set(["/__da/config/export", "/api/config/export"]);
const CONFIG_IMPORT_JSON_PATHS = new Set(["/__da/config/import-json", "/api/config/import-json"]);
const CONFIG_RESET_PATHS = new Set(["/__da/config/reset", "/api/config/reset"]);

/** Setup page → Azure DevOps card: the stored format examples fed to the generation prompt. */
const EXAMPLES_PATHS = new Set(["/__da/examples", "/api/examples"]);
const EXAMPLES_ADD_PATHS = new Set(["/__da/examples/add", "/api/examples/add"]);
const EXAMPLES_UPDATE_PATHS = new Set(["/__da/examples/update", "/api/examples/update"]);
const EXAMPLES_DELETE_PATHS = new Set(["/__da/examples/delete", "/api/examples/delete"]);
const EXAMPLES_REORDER_PATHS = new Set(["/__da/examples/reorder", "/api/examples/reorder"]);
const EXAMPLES_IMPORT_CSV_PATHS = new Set(["/__da/examples/import-csv", "/api/examples/import-csv"]);
const EXAMPLES_RESET_PATHS = new Set(["/__da/examples/reset", "/api/examples/reset"]);
const EXAMPLES_PREVIEW_PATHS = new Set(["/__da/examples/preview", "/api/examples/preview"]);
const EXAMPLES_IMPORT_TMS_PATHS = new Set(["/__da/examples/import-tms", "/api/examples/import-tms"]);
/**
 * Every live dropdown on the Setup page, whichever provider it belongs to.
 * The bespoke ADO paths below stay: the Create page's context picker asks for
 * plans with its own `activeOnly` flag and suite/case shapes this cannot carry.
 */
const TMS_OPTIONS_PATHS = new Set(["/__da/tms/options", "/api/tms/options"]);
const TMS_ACTIVE_PATHS = new Set(["/__da/tms/active", "/api/tms/active"]);
/** Setup page → Azure DevOps card → "Read prototype", as the Create / Update pages see it. */
const PROTOTYPE_ENABLED_PATHS = new Set(["/__da/prototype/enabled", "/api/prototype/enabled"]);
const ADO_TEST_PLANS_PATHS = new Set(["/__da/ado/test-plans", "/api/ado/test-plans"]);

/** Create / Update pages: browse Test Plan → Suite → Test Case and pick generation context. */
const ADO_SUITE_TREE_PATHS = new Set(["/__da/ado/suite-tree", "/api/ado/suite-tree"]);
const ADO_SUITE_CASES_PATHS = new Set(["/__da/ado/suite-cases", "/api/ado/suite-cases"]);
// The store behind these is provider-neutral, so the generic tms-context names share the handlers.
const ADO_CONTEXT_LIST_PATHS = new Set(["/__da/ado/context", "/api/ado/context", "/__da/tms-context", "/api/tms-context"]);
const ADO_CONTEXT_ADD_PATHS = new Set(["/__da/ado/context/add", "/api/ado/context/add"]);
const ADO_CONTEXT_REMOVE_PATHS = new Set([
  "/__da/ado/context/remove",
  "/api/ado/context/remove",
  "/__da/tms-context/remove",
  "/api/tms-context/remove",
]);
const ADO_CONTEXT_CLEAR_PATHS = new Set([
  "/__da/ado/context/clear",
  "/api/ado/context/clear",
  "/__da/tms-context/clear",
  "/api/tms-context/clear",
]);

/**
 * Create / Update pages: the same picker for whichever TMS is In use — top level (ADO plan,
 * TestRail suite), the container tree, the cases of one container, and Add. See tms-context.js.
 */
const TMS_CONTEXT_TOPS_PATHS = new Set(["/__da/tms-context/tops", "/api/tms-context/tops"]);
const TMS_CONTEXT_TREE_PATHS = new Set(["/__da/tms-context/tree", "/api/tms-context/tree"]);
const TMS_CONTEXT_CASES_PATHS = new Set(["/__da/tms-context/cases", "/api/tms-context/cases"]);
const TMS_CONTEXT_ADD_PATHS = new Set(["/__da/tms-context/add", "/api/tms-context/add"]);

/** "Cover a bug" page: browse Suite → Section, the TestRail counterpart of the above. */
const TESTRAIL_SUITES_PATHS = new Set(["/__da/testrail/suites", "/api/testrail/suites"]);
const TESTRAIL_SECTIONS_PATHS = new Set(["/__da/testrail/sections", "/api/testrail/sections"]);
const ZEPHYR_FOLDERS_PATHS = new Set(["/__da/zephyr/folders", "/api/zephyr/folders"]);
const XRAY_FOLDERS_PATHS = new Set(["/__da/xray/folders", "/api/xray/folders"]);

/** "Manual Import into …" on the Create and Update pages: an on-disk CSV into a picked container. */
const TMS_IMPORT_CSV_PATHS = new Set(["/__da/tms/import-csv", "/api/tms/import-csv"]);

/** "Use selected as CSV" on the Update page: cases ticked in the Zephyr / Xray tree → the CSV the flow reads. */
const TMS_PICKED_TO_CSV_PATHS = new Set(["/__da/tms/picked-to-updated-csv", "/api/tms/picked-to-updated-csv"]);

/** "Cover a bug": generate from a pasted Jira link, then import into the picked container. */
const ISSUE_CASE_GENERATE_PATHS = new Set(["/__da/issue-case/generate", "/api/issue-case/generate"]);
const ISSUE_CASE_IMPORT_PATHS = new Set(["/__da/issue-case/import", "/api/issue-case/import"]);

/** Everything the Setup page needs in one response: schema + masked values + per-section state. */
function configPayload(extra = {}) {
  const values = configStore.readConfig();
  const dotenv = configStore.readDotenvValues();
  return {
    ok: true,
    schema: configStore.publicSchema(),
    values: configStore.maskValues(values),
    secrets: configStore.secretsPresent(values),
    status: configStore.sectionStatus(values),
    storePath: configStore.STORE_PATH,
    keepSecret: configStore.KEEP_SECRET,
    dotenv: {
      exists: dotenv.exists,
      path: dotenv.path,
      importable: Object.keys(dotenv.values).length,
      error: dotenv.error || null,
    },
    ...extra,
  };
}

async function handleApi(req, res) {
  const pathname = getPathname(req);
  const method = String(req.method || "GET").toUpperCase().trim();

  if (
    method === "OPTIONS" &&
    (pathname.startsWith("/__da/") ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/web/folder-pick") ||
      pathname.startsWith("/web/folder-pick-"))
  ) {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (method === "GET" && pathname === "/__da/health") {
    return json(res, 200, { ok: true, app: "web-ui", pid: process.pid });
  }

  if (method === "GET" && DOWNLOADS_LOOKUP_PATHS.has(pathname)) {
    const q = requestUrl(req).searchParams.get("name") || "";
    const parsed = safeDownloadsFileName(q);
    if (!parsed.ok) {
      return json(res, 400, { found: false, error: parsed.error });
    }
    const r = locateCsvInDownloads(parsed.base);
    return json(res, 200, { found: r.found, fileName: r.fileName });
  }

  if (method === "POST" && ADD_CSV_TO_UPDATED_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const projectPath = String(body.projectPath || "").trim();
    // Two ways in: a full path from the OS file picker, or a bare name to look
    // up in Downloads (the older flow, still used by the CLI docs).
    const sourcePath = String(body.sourcePath || "").trim();
    let located;

    if (sourcePath) {
      const resolvedSource = path.resolve(sourcePath);
      let stat;
      try {
        stat = fs.statSync(resolvedSource);
      } catch {
        return json(res, 404, { ok: false, error: "That file no longer exists" });
      }
      if (!stat.isFile()) {
        return json(res, 400, { ok: false, error: "Pick a file, not a folder" });
      }
      if (!/\.csv$/i.test(resolvedSource)) {
        return json(res, 400, { ok: false, error: "Only .csv files can be used for this flow" });
      }
      located = { found: true, fileName: path.basename(resolvedSource), sourcePath: resolvedSource };
    } else {
      const parsed = safeDownloadsFileName(String(body.name || "").trim());
      if (!parsed.ok) {
        return json(res, 400, { ok: false, error: parsed.error });
      }
      located = locateCsvInDownloads(parsed.base);
      if (!located.found || !located.sourcePath) {
        return json(res, 404, { ok: false, error: "CSV not found in Downloads" });
      }
    }

    const abs = path.resolve(projectPath);
    const v = validateUpdateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }
    const destDir = path.join(abs, "Updated test cases");
    const destPath = path.join(destDir, located.fileName);
    const resolvedDest = path.resolve(destPath);
    const resolvedDir = path.resolve(destDir);
    const relOut = path.relative(resolvedDir, resolvedDest);
    if (relOut.startsWith("..") || path.isAbsolute(relOut)) {
      return json(res, 400, { ok: false, error: "Invalid destination path" });
    }
    // The file picker can hand back a file that already lives in the destination
    // folder. Wiping the folder first would then delete the very file we are
    // about to copy, so that one entry is left alone and the copy is skipped.
    const sourceIsAlreadyInPlace = path.resolve(located.sourcePath) === resolvedDest;

    try {
      fs.mkdirSync(resolvedDir, { recursive: true });
      // Keep only the newest added CSV: remove every other .csv in "Updated test cases".
      let removed = 0;
      try {
        for (const entry of fs.readdirSync(resolvedDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!/\.csv$/i.test(entry.name)) continue;
          const entryPath = path.join(resolvedDir, entry.name);
          if (sourceIsAlreadyInPlace && path.resolve(entryPath) === resolvedDest) continue;
          try {
            fs.unlinkSync(entryPath);
            removed += 1;
          } catch (_) {
            /* ignore individual delete failures (e.g. file locked) */
          }
        }
      } catch (_) {
        /* folder may not exist yet — mkdirSync above handles creation */
      }
      if (!sourceIsAlreadyInPlace) {
        fs.copyFileSync(located.sourcePath, resolvedDest);
      }
      return json(res, 200, { ok: true, fileName: located.fileName, removedOldCsv: removed });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return json(res, 500, { ok: false, error: `Copy failed: ${msg}` });
    }
  }

  // The other way into "Updated test cases": instead of a file picked on disk, the cases ticked in
  // the Zephyr Essential / Xray tree — from any folders, old hand-written cases included.
  if (method === "POST" && TMS_PICKED_TO_CSV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateUpdateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    const picks = (Array.isArray(body.picks) ? body.picks : []).map((p) => ({
      containerId: String((p && p.containerId) || ""),
      containerPath: String((p && p.containerPath) || ""),
      caseIds: Array.isArray(p && p.caseIds) ? p.caseIds.map(String) : [],
    }));

    const exported = await tmsExportCsv.exportPickedCases({ picks });
    if (!exported.ok) return json(res, 200, exported);
    try {
      const { removed } = tmsExportCsv.writeAsOnlyCsv(path.join(abs, "Updated test cases"), exported.fileName, exported.csv);
      return json(res, 200, {
        ok: true,
        fileName: exported.fileName,
        removedOldCsv: removed,
        provider: exported.provider,
        stats: exported.stats,
        summary: tmsExportCsv.describeExport(exported),
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: `Could not write the CSV: ${e && e.message ? e.message : e}` });
    }
  }

  if (method === "GET" && FOLDER_PICK_START_PATHS.has(pathname)) {
    return startPickJob(pickFolderDialogAsync, res);
  }

  if (method === "GET" && FILE_PICK_START_PATHS.has(pathname)) {
    return startPickJob(pickCsvFileDialogAsync, res);
  }

  if (method === "GET" && PICK_STATUS_PATHS.has(pathname)) {
    const jobId = requestUrl(req).searchParams.get("jobId");
    if (!jobId) return json(res, 400, { error: "missing jobId" });
    const j = pickJobs.get(jobId);
    if (!j) return json(res, 404, { error: "unknown or expired jobId" });
    if (j.status === "pending") return json(res, 200, { pending: true });

    if (j.status === "done") {
      const pathVal = j.path;
      pickJobs.delete(jobId);
      return json(res, 200, { pending: false, path: pathVal });
    }
    if (j.status === "cancelled") {
      pickJobs.delete(jobId);
      return json(res, 200, { pending: false, cancelled: true });
    }
    const err = j.error || "error";
    pickJobs.delete(jobId);
    return json(res, 200, { pending: false, error: err });
  }

  if ((method === "GET" || method === "POST") && PICK_FOLDER_SYNC_PATHS.has(pathname)) {
    try {
      const picked = pickFolderDialog();
      if (picked) return json(res, 200, { path: picked });
      return json(res, 200, { cancelled: true });
    } catch (err) {
      return json(res, 500, { error: "pick-folder failed", detail: String(err && err.message ? err.message : err) });
    }
  }

  if (method === "POST" && RUN_DAY1_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const prepared = prepareGenerationRun(body);
    if (prepared.error) {
      return json(res, 400, { ok: false, error: prepared.error });
    }
    const { abs, env, jiraKey, generateMode, testFormat } = prepared;
    const wantStream = body.stream === true || body.stream === "true";

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        line({
          event: "stage",
          label: "Process",
          detail: `node agent-docs.js (JIRA_ISSUE_KEY=${jiraKey}${generateMode === "testcases" ? ", GENERATE_MODE=testcases" : ""}${testFormat === "bdd" ? ", TEST_DESIGN_FORMAT=bdd" : ""})`,
        });
        await runSpawnStreaming(process.execPath, ["agent-docs.js"], opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }


    const result = await runSpawn(process.execPath, ["agent-docs.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  // Generate content for in-UI review. Streams the same log lines as /run-day1 so the user still
  // sees progress, then ends with a single {event:"review"} line carrying the editable payload.
  // Nothing is posted to Jira here — that only happens on /review/submit.
  if (method === "POST" && REVIEW_GENERATE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const prepared = prepareGenerationRun(body);
    if (prepared.error) {
      return json(res, 400, { ok: false, error: prepared.error });
    }
    const { abs, env, jiraKey, generateMode, testFormat } = prepared;

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    const line = (obj) => {
      try {
        res.write(`${JSON.stringify(obj)}\n`);
      } catch (_) {
        /* ignore broken pipe */
      }
    };

    await withPipelineIoFile(async (ioFile) => {
      line({ event: "stage", label: "Environment", detail: abs });
      line({
        event: "stage",
        label: "Process",
        detail: `node agent-docs.js (review, JIRA_ISSUE_KEY=${jiraKey}, mode=${generateMode}, format=${testFormat})`,
      });
      // runSpawnStreaming emits its own "end" when the child closes; swallow it so the client
      // never sees "end" before the "review" line that carries the payload.
      const lineNoEnd = (obj) => {
        if (obj && obj.event === "end") return;
        line(obj);
      };
      try {
        const result = await runSpawnStreaming(
          process.execPath,
          ["agent-docs.js"],
          { cwd: abs, env: { ...env, PIPELINE_STAGE: "generate", PIPELINE_IO_FILE: ioFile } },
          lineNoEnd
        );
        if (result && result.code !== 0) {
          line({ event: "end", code: result.code, ok: false });
          return;
        }
        const envelope = JSON.parse(fs.readFileSync(ioFile, "utf8"));
        const sessionId = reviewSession.createSession(abs, envelope);
        line({
          event: "review",
          sessionId,
          mode: envelope.mode,
          // Tells the panel whether to render the rows as a steps table or as
          // one editable Gherkin scenario per test case.
          format: envelope.format || "standard",
          issueKey: envelope.issueKey,
          issueSummary: envelope.issueSummary || "",
          postTargetKey: envelope.postTargetKey,
          payload: envelope.payload,
          usage: envelope.usage || null,
        });
        line({ event: "end", code: 0, ok: true });
      } catch (err) {
        line({ event: "stderr", text: `${err && err.message ? err.message : err}\n` });
        line({ event: "end", code: -1, ok: false });
      }
    });
    res.end();
    return true;
  }

  // Same as /review/generate but for the Update flow: agent-update-csv.js emits every CSV block
  // for review instead of posting it. The block order is the APPROVED (n) numbering.
  if (method === "POST" && REVIEW_UPDATE_GENERATE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const prepared = prepareUpdateRun(body);
    if (prepared.error) {
      return json(res, 400, { ok: false, error: prepared.error });
    }
    const { abs, env, jiraKey, updatedFlowMode, checkApproval } = prepared;
    if (checkApproval) {
      return json(res, 400, { ok: false, error: "Review is only available for the generate step" });
    }

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    const line = (obj) => {
      try {
        res.write(`${JSON.stringify(obj)}\n`);
      } catch (_) {
        /* ignore broken pipe */
      }
    };

    await withPipelineIoFile(async (ioFile) => {
      line({ event: "stage", label: "Environment", detail: abs });
      line({
        event: "stage",
        label: "Process",
        detail: `node agent-update-csv.js (review, JIRA_ISSUE_KEY=${jiraKey}, mode=${updatedFlowMode})`,
      });
      // Swallow the child's own "end" so the client never sees it before the review payload.
      const lineNoEnd = (obj) => {
        if (obj && obj.event === "end") return;
        line(obj);
      };
      try {
        const result = await runSpawnStreaming(
          process.execPath,
          ["agent-update-csv.js"],
          { cwd: abs, env: { ...env, PIPELINE_STAGE: "generate", PIPELINE_IO_FILE: ioFile } },
          lineNoEnd
        );
        if (result && result.code !== 0) {
          line({ event: "end", code: result.code, ok: false });
          return;
        }
        const envelope = JSON.parse(fs.readFileSync(ioFile, "utf8"));
        const sessionId = reviewSession.createSession(abs, envelope);
        line({
          event: "review",
          flow: "update",
          sessionId,
          issueKey: envelope.issueKey,
          issueSummary: envelope.issueSummary || "",
          postTargetKey: envelope.testDesignKey,
          csvFile: envelope.csvFile || "",
          mode: envelope.mode,
          usage: envelope.usage || null,
          // Only what the panel needs to render and edit; the source rows and prompt context
          // stay server-side in the session.
          // payload carries the rows plus their change annotations and the block-level
          // "removed" list; the source CSV rows and prompt context stay server-side.
          blocks: (envelope.blocks || []).map((b) => ({
            type: b.type,
            // Per block, because one CSV can hold standard cases next to Gherkin
            // scenarios and the panel renders each in its own shape.
            format: b.format || "standard",
            placement: b.placement,
            title:
              b.type === "testcase"
                ? (b.source && b.source.title) || ""
                : (b.source && b.source.workItemTitle) || "",
            payload: b.payload,
          })),
        });
        line({ event: "end", code: 0, ok: true });
      } catch (err) {
        line({ event: "stderr", text: `${err && err.message ? err.message : err}\n` });
        line({ event: "end", code: -1, ok: false });
      }
    });
    res.end();
    return true;
  }

  // Regenerate the whole set, one checklist item, or one test case, optionally with extra
  // reviewer guidance. Reuses the stored generation context, so no Jira call and no re-gathering.
  if (method === "POST" && REVIEW_REGENERATE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });

    const kind = String(body.kind || "all");
    if (!["all", "block", "item", "testcase"].includes(kind)) {
      return json(res, 400, { ok: false, error: `Unknown regenerate kind "${kind}"` });
    }

    let envelope;
    try {
      envelope = reviewSession.readSession(abs, body.sessionId);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    const script = reviewScriptFor(envelope);

    // Keep the session in step with whatever the reviewer has edited so far, so a later
    // Submit posts the edits even if the browser tab is reloaded in between.
    applyReviewedEdits(envelope, body);
    reviewSession.writeSession(abs, body.sessionId, envelope);

    const result = await withPipelineIoFile(async (ioFile) => {
      // The update flow regenerates inside one block, so it needs that block, not a flat payload.
      const io =
        envelope.flow === "update"
          ? {
              kind,
              index: body.index,
              userGuidance: String(body.userGuidance || ""),
              promptContext: envelope.promptContext,
              block: (envelope.blocks || [])[Number(body.blockIndex)],
            }
          : {
              mode: envelope.mode,
              kind,
              index: body.index,
              userGuidance: String(body.userGuidance || ""),
              promptContext: envelope.promptContext,
              payload: envelope.payload,
            };
      fs.writeFileSync(ioFile, JSON.stringify(io), "utf8");
      const run = await runSpawn(
        process.execPath,
        [script],
        { cwd: abs, env: { ...envForChild(abs), PIPELINE_STAGE: "regenerate", PIPELINE_IO_FILE: ioFile } }
      );
      if (run.code !== 0) {
        return { ok: false, error: firstErrorLine(run.stderr, run.stdout) || "Regeneration failed", log: run.stdout };
      }
      return { ok: true, ...JSON.parse(fs.readFileSync(ioFile, "utf8")), log: run.stdout };
    });

    if (!result.ok) return json(res, 502, result);

    // Fold the regenerated piece back into the session so Submit picks it up as-is.
    const target =
      envelope.flow === "update"
        ? (envelope.blocks || [])[Number(body.blockIndex)]
        : envelope;
    if (target) {
      if ((kind === "all" || kind === "block") && result.payload) {
        target.payload = result.payload;
      } else if (kind === "item" && result.item) {
        target.payload.checklistItems[result.index] = result.item;
      } else if (kind === "testcase" && result.testCase) {
        target.payload.testCases[result.index] = result.testCase;
      }
    }
    reviewSession.writeSession(abs, body.sessionId, envelope);

    return json(res, 200, result);
  }

  // Submit the reviewed content: this is the only review endpoint that writes to Jira.
  if (method === "POST" && REVIEW_SUBMIT_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });

    let envelope;
    try {
      envelope = reviewSession.readSession(abs, body.sessionId);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    applyReviewedEdits(envelope, body);
    reviewSession.writeSession(abs, body.sessionId, envelope);

    const result = await withPipelineIoFile(async (ioFile) => {
      fs.writeFileSync(ioFile, JSON.stringify(envelope), "utf8");
      const run = await runSpawn(
        process.execPath,
        [reviewScriptFor(envelope)],
        {
          cwd: abs,
          env: {
            ...envForChild(abs, { CHECK_APPROVAL: "false" }),
            JIRA_ISSUE_KEY: envelope.issueKey,
            PIPELINE_STAGE: "submit",
            PIPELINE_IO_FILE: ioFile,
          },
        }
      );
      // The stage writes what it did back over the envelope: how many rows were approved, and
      // where the CSV landed. A run that failed leaves the envelope there, hence the guard.
      let wrote = {};
      if (run.code === 0) {
        try {
          const back = JSON.parse(fs.readFileSync(ioFile, "utf8"));
          if (back && back.ok) wrote = back;
        } catch {
          /* the stage said nothing back — the exit code is still the answer */
        }
      }
      return { ...run, wrote };
    });

    if (result.code !== 0) {
      return json(res, 502, {
        ok: false,
        error: firstErrorLine(result.stderr, result.stdout) || "Submit failed",
        log: result.stdout,
      });
    }

    // Submitted successfully — the session has served its purpose.
    reviewSession.deleteSession(abs, body.sessionId);
    return json(res, 200, {
      ok: true,
      postTargetKey: envelope.postTargetKey || envelope.testDesignKey,
      mode: envelope.mode,
      flow: envelope.flow || "create",
      submittedCount: result.wrote.submittedCount,
      reviewedCount: result.wrote.reviewedCount,
      csvPath: result.wrote.csvPath,
      log: result.stdout,
    });
  }

  if (method === "POST" && RUN_DAY2_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const jiraKey = String(body.jiraKey || "").trim();
    const figmaUrl = String(body.figmaUrl || "").trim();
    const wantStream = body.stream === true || body.stream === "true";

    if (!jiraKey) {
      return json(res, 400, { ok: false, error: "JIRA_ISSUE_KEY is required" });
    }

    if (figmaUrl && !/^https?:\/\/(www\.)?figma\.com\/(design|file|board|proto)\/[A-Za-z0-9]+/i.test(figmaUrl)) {
      return json(res, 400, { ok: false, error: "figmaUrl must be a https://www.figma.com/... URL" });
    }

    const abs = path.resolve(projectPath);
    const v = validateProjectDir(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const env = envForChild(abs, { CHECK_APPROVAL: "true" });
    if (jiraKey) env.JIRA_ISSUE_KEY = jiraKey;
    if (figmaUrl) env.FIGMA_URL = figmaUrl;

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        line({
          event: "stage",
          label: "Process",
          detail: `node agent-docs.js (CHECK_APPROVAL=true, JIRA_ISSUE_KEY=${jiraKey})`,
        });
        await runSpawnStreaming(process.execPath, ["agent-docs.js"], opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    const result = await runSpawn(process.execPath, ["agent-docs.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && RUN_UPDATE_CSV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const wantStream = body.stream === true || body.stream === "true";

    const prepared = prepareUpdateRun(body);
    if (prepared.error) {
      return json(res, 400, { ok: false, error: prepared.error });
    }
    const { abs, env, updatedFlowMode, checkApproval } = prepared;

    const opts = { cwd: abs, env };

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        const detail = checkApproval
          ? "node agent-update-csv.js (CHECK_APPROVAL=true)"
          : `node agent-update-csv.js (CHECK_APPROVAL=false, UPDATED_FLOW_MODE=${updatedFlowMode})`;
        line({ event: "stage", label: "Process", detail });
        await runSpawnStreaming(process.execPath, ["agent-update-csv.js"], opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    const result = await runSpawn(process.execPath, ["agent-update-csv.js"], opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && RUN_ADO_EXPORT_TAG_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const projectPath = String(body.projectPath || "").trim();
    const wantStream = body.stream === true || body.stream === "true";
    const tagParsed = sanitizeAdoExportTag(body.tag);
    if (!tagParsed.ok) {
      return json(res, 400, { ok: false, error: tagParsed.error });
    }

    const abs = path.resolve(projectPath);
    const v = validateAdoExportTagProject(abs);
    if (!v.ok) {
      return json(res, 400, { ok: false, error: v.error });
    }

    const opts = { cwd: abs, env: envForChild(abs) };
    const args = ["ado-export-tag-csv.js", "--tag", tagParsed.tag, "--fail-on-empty"];

    if (wantStream) {
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      const line = (obj) => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch (_) {
          /* ignore broken pipe */
        }
      };
      line({ event: "stage", label: "Environment", detail: abs });
      try {
        line({
          event: "stage",
          label: "Export",
          detail: `ado-export-tag-csv.js --tag ${JSON.stringify(tagParsed.tag)} --fail-on-empty`,
        });
        await runSpawnStreaming(process.execPath, args, opts, line);
      } catch (err) {
        line({
          event: "stderr",
          text: `${err && err.message ? err.message : err}\n`,
        });
        line({ event: "end", code: -1, ok: false });
      }
      res.end();
      return true;
    }

    const result = await runSpawn(process.execPath, args, opts);
    return json(res, 200, { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  if (method === "POST" && PREVIEW_RELATED_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const projectPath = String(body.projectPath || "").trim();
    const abs = path.resolve(projectPath);
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    if (!fs.existsSync(path.join(abs, "preview-related-issues.js"))) {
      return json(res, 400, { ok: false, error: "Folder must contain preview-related-issues.js" });
    }

    const overrides = {};
    const jiraKey = String(body.jiraKey || "").trim();
    const relatedKeywords = String(body.relatedKeywords || "").trim();
    if (jiraKey) overrides.JIRA_ISSUE_KEY = jiraKey;
    if (relatedKeywords) overrides.RELATED_ISSUES_KEYWORDS = relatedKeywords;

    const result = await runSpawn(
      process.execPath,
      ["preview-related-issues.js"],
      { cwd: abs, env: envForChild(abs, overrides) }
    );
    // The script prints one JSON line; take the last parseable line of stdout.
    const lines = String(result.stdout || "").split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && "ok" in parsed) {
          return json(res, 200, parsed);
        }
      } catch {
        /* not this line */
      }
    }
    return json(res, 200, {
      ok: false,
      error: (result.stderr || "Preview failed — no JSON output").trim().slice(0, 480),
    });
  }

  if (method === "POST" && TEST_CASES_CONTEXT_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    const context = readTestCasesContext(abs);
    return json(res, 200, { ok: true, ...context });
  }

  if (method === "POST" && CLEAR_TEST_CASES_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    const context = readTestCasesContext(abs);
    let removed = 0;
    const errors = [];
    for (const file of context.files) {
      try {
        fs.unlinkSync(path.join(context.folder, file.name));
        removed += 1;
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    return json(res, 200, { ok: errors.length === 0, removed, errors });
  }

  if (method === "GET" && CONFIG_PATHS.has(pathname)) {
    return json(res, 200, configPayload());
  }

  if (method === "POST" && CONFIG_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const values = body && typeof body.values === "object" && body.values ? body.values : null;
    if (!values) {
      return json(res, 400, { ok: false, error: "Body must be { values: { KEY: value, ... } }" });
    }
    try {
      configStore.writeConfig(values);
    } catch (e) {
      return json(res, 500, { ok: false, error: `Could not write config: ${e.message || e}` });
    }
    return json(res, 200, configPayload({ saved: true }));
  }

  if (method === "POST" && CONFIG_TEST_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const provider = String((body && body.provider) || "").trim();
    if (!provider) return json(res, 400, { ok: false, error: "provider is required" });
    const result = await configStore.testConnection(provider);
    return json(res, 200, { ok: result.ok, detail: result.detail, provider });
  }

  if (method === "POST" && CONFIG_IMPORT_DOTENV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const overwrite = body && (body.overwrite === true || body.overwrite === "true");
    const dotenv = configStore.readDotenvValues();
    if (!dotenv.exists) return json(res, 400, { ok: false, error: "No .env file next to web-ui-server.js" });
    if (dotenv.error) return json(res, 400, { ok: false, error: `Could not parse .env: ${dotenv.error}` });

    const current = configStore.readConfig();
    const merged = { ...current };
    const imported = [];
    const kept = [];
    for (const [key, value] of Object.entries(dotenv.values)) {
      if (current[key] && !overwrite) {
        kept.push(key);
        continue;
      }
      if (current[key] === value) continue;
      merged[key] = value;
      imported.push(key);
    }
    try {
      configStore.writeConfig(merged);
    } catch (e) {
      return json(res, 500, { ok: false, error: `Could not write config: ${e.message || e}` });
    }
    return json(res, 200, configPayload({ imported, kept }));
  }

  // The other half of Export JSON: load a config a teammate shared. Only keys the
  // Setup page knows are taken, and anything missing from the file keeps its
  // current value, so an export without secrets cannot wipe local tokens.
  if (method === "POST" && CONFIG_IMPORT_JSON_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "That file is not valid JSON" });
    }
    const incoming = body && typeof body.values === "object" && body.values ? body.values : null;
    if (!incoming) {
      return json(res, 400, { ok: false, error: "No settings found in the file (expected a \"values\" object)" });
    }

    const current = configStore.readConfig();
    const merged = { ...current };
    const imported = [];
    const unchanged = [];
    const ignored = [];
    for (const [key, raw] of Object.entries(incoming)) {
      if (!configStore.isKnownKey(key)) {
        ignored.push(key);
        continue;
      }
      const value = raw == null ? "" : String(raw).trim();
      if (!value) continue;
      if (current[key] === value) {
        unchanged.push(key);
        continue;
      }
      merged[key] = value;
      imported.push(key);
    }

    try {
      configStore.writeConfig(merged);
    } catch (e) {
      return json(res, 500, { ok: false, error: `Could not write config: ${e.message || e}` });
    }
    return json(res, 200, configPayload({ imported, unchanged, ignored }));
  }

  if (method === "GET" && CONFIG_EXPORT_PATHS.has(pathname)) {
    // Secrets are stripped: this file is meant to be shared with the team.
    const payload = {
      $schema: "ai-test-coverage-config/1",
      exportedAt: new Date().toISOString(),
      note: "Secrets are not exported. Fill them in on the Setup page after importing.",
      values: configStore.exportableValues(),
    };
    const bodyText = `${JSON.stringify(payload, null, 2)}
`;
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ai-test-coverage-config.json"',
      "Content-Length": Buffer.byteLength(bodyText),
    });
    res.end(bodyText);
    return true;
  }

  // Which provider a run imports into, and what to call it. The Create and
  // Update pages ask on load so they can name the destination and hide the
  // blocks that only make sense for Azure DevOps. Carries no credentials, so
  // it stays a plain GET.
  if (method === "GET" && TMS_ACTIVE_PATHS.has(pathname)) {
    return json(res, 200, { ok: true, ...configStore.activeProviderInfo() });
  }

  // Create / Update ask this on load to decide whether to show the Prototype link field.
  if (method === "GET" && PROTOTYPE_ENABLED_PATHS.has(pathname)) {
    return json(res, 200, { ok: true, enabled: prototypeReadEnabled() });
  }

  // Feeds the Test Plan pickers on the Setup page. Credentials may be passed in
  // so the list appears as soon as a PAT is pasted, before anything is saved.
  if (method === "POST" && TMS_OPTIONS_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    // `values` carries what the user has typed but not saved yet; config-store
    // drops everything outside the requested list's own whitelist.
    const values = body && typeof body.values === "object" && body.values ? body.values : {};
    const result = await configStore.listRemoteOptions(String((body && body.list) || ""), values);
    return json(res, 200, result);
  }

  if (method === "POST" && ADO_TEST_PLANS_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const overrides = {};
    for (const key of ["ADO_ORG", "ADO_PROJECT", "ADO_PAT", "ADO_SERVER_URL"]) {
      const value = body && body[key];
      if (typeof value === "string" && value.trim()) overrides[key] = value.trim();
    }
    // The context picker asks for active plans only; the Setup page sends no flag and gets all.
    const result = await configStore.listAdoTestPlans(overrides, {
      activeOnly: body && body.activeOnly === true,
    });
    return json(res, 200, result);
  }

  if (method === "POST" && ADO_SUITE_TREE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const result = await configStore.listAdoSuiteTree(body.planId);
    return json(res, 200, result);
  }

  if (method === "POST" && ADO_SUITE_CASES_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const result = await configStore.listAdoSuiteCases(body.planId, body.suiteId, {
      isRecursive: body.isRecursive === true,
    });
    return json(res, 200, result);
  }

  if (method === "POST" && ADO_CONTEXT_LIST_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    return json(res, 200, { ok: true, ...adoContextStore.summary(abs) });
  }

  // Add: the Azure DevOps route is kept for older pages, and always adds from Azure DevOps; the
  // tms-context one adds from whichever provider is In use. Both land in the same store.
  if (method === "POST" && (ADO_CONTEXT_ADD_PATHS.has(pathname) || TMS_CONTEXT_ADD_PATHS.has(pathname))) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });

    const legacyAdo = ADO_CONTEXT_ADD_PATHS.has(pathname);
    const result = await tmsContext.addPickedSource(
      abs,
      {
        topId: legacyAdo ? body.planId : body.topId,
        topName: legacyAdo ? body.planName : body.topName,
        containerId: legacyAdo ? body.suiteId : body.containerId,
        containerPath: legacyAdo ? body.suitePath : body.containerPath,
        caseIds: legacyAdo ? body.workItemIds : body.caseIds,
        includeSteps: body.includeSteps !== false,
      },
      legacyAdo ? "ado" : undefined
    );
    if (!result.ok) return json(res, 200, result);
    return json(res, 200, {
      ok: true,
      skippedDuplicates: result.skippedDuplicates || 0,
      ...adoContextStore.summary(abs),
    });
  }

  if (method === "POST" && TMS_CONTEXT_TOPS_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    return json(res, 200, await tmsContext.listTops({ includeInactive: !!(body && body.includeInactive) }));
  }

  if (method === "POST" && TMS_CONTEXT_TREE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    return json(res, 200, await tmsContext.listContainers(body.topId));
  }

  if (method === "POST" && TMS_CONTEXT_CASES_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    return json(res, 200, await tmsContext.listCases(body.topId, body.containerId));
  }

  if (method === "POST" && ADO_CONTEXT_REMOVE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    let removed;
    try {
      removed = adoContextStore.removeSource(abs, body.sourceId);
    } catch (e) {
      return json(res, 400, { ok: false, error: (e && e.message) || "Invalid source id" });
    }
    if (!removed.ok) return json(res, 200, removed);
    return json(res, 200, { ok: true, ...adoContextStore.summary(abs) });
  }

  if (method === "POST" && ADO_CONTEXT_CLEAR_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });
    const cleared = adoContextStore.clearSelection(abs);
    return json(res, 200, { ok: true, removed: cleared.removed, ...adoContextStore.summary(abs) });
  }

  // ── TestRail destination picker ("Cover a bug") ─────────────────
  // Suites and sections of the project saved on the Setup page. No credentials travel over
  // these, unlike the Setup page's option lists: the target is chosen, not configured.

  if (method === "POST" && TESTRAIL_SUITES_PATHS.has(pathname)) {
    return json(res, 200, await configStore.listTestrailSuites());
  }

  if (method === "POST" && TESTRAIL_SECTIONS_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    return json(res, 200, await configStore.listTestrailSections(body.suiteId));
  }

  // Zephyr nests one level shallower — the project is a Setup setting, so the folder tree is
  // the whole picker and there is nothing to scope this call by.
  if (method === "POST" && ZEPHYR_FOLDERS_PATHS.has(pathname)) {
    return json(res, 200, await configStore.listZephyrFolders());
  }

  if (method === "POST" && XRAY_FOLDERS_PATHS.has(pathname)) {
    // Same shape as the Zephyr folders route: the project is a Setup setting, so the body carries
    // nothing and the list is whatever that project's Test Repository holds.
    return json(res, 200, await configStore.listXrayFolders());
  }

  // The "Manual Import into …" step: take the approved CSV already attached to the ticket and
  // write it into the container picked on the page. Unlike /issue-case/import it starts from
  // Jira rather than from a review session — by this point the CSV is what Jira approved, so
  // the ticket is the only thing worth asking for.
  if (method === "POST" && TMS_IMPORT_CSV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });

    const jiraIssueKey = String(body.jiraIssueKey || "").trim();
    if (!jiraIssueKey) {
      return json(res, 400, { ok: false, error: "Set the Jira key — the approved CSV is built from that ticket" });
    }

    const target = body.target && typeof body.target === "object" ? body.target : {};

    const result = await withPipelineIoFile(async (ioFile) => {
      fs.writeFileSync(ioFile, JSON.stringify({ target, jiraIssueKey }), "utf8");
      const run = await runSpawn(process.execPath, ["agent-docs.js"], {
        cwd: abs,
        env: {
          ...envForChild(abs, { CHECK_APPROVAL: "false" }),
          PIPELINE_STAGE: "import-csv",
          PIPELINE_IO_FILE: ioFile,
        },
      });
      if (run.code !== 0) {
        return { ok: false, error: firstErrorLine(run.stderr, run.stdout) || "Import failed", log: run.stdout };
      }
      return { ...JSON.parse(fs.readFileSync(ioFile, "utf8")), log: run.stdout };
    });

    if (!result.ok) return json(res, 502, result);
    return json(res, 200, result);
  }

  // ── Cover a bug ─────────────────────────────────────────────────

  // Generate test cases from the ticket behind a pasted Jira link, for in-UI review. Streams the
  // same log lines as /review/generate and ends with the {event:"review"} payload. Nothing is
  // written anywhere — the import happens on /issue-case/import.
  if (method === "POST" && ISSUE_CASE_GENERATE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const prepared = prepareIssueCaseRun(body);
    if (prepared.error) {
      return json(res, 400, { ok: false, error: prepared.error });
    }
    const { abs, env, jiraKey, testFormat } = prepared;

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    const line = (obj) => {
      try {
        res.write(`${JSON.stringify(obj)}\n`);
      } catch (_) {
        /* ignore broken pipe */
      }
    };

    await withPipelineIoFile(async (ioFile) => {
      line({ event: "stage", label: "Environment", detail: abs });
      line({
        event: "stage",
        label: "Process",
        detail: `node agent-docs.js (from issue, JIRA_ISSUE_KEY=${jiraKey}, format=${testFormat})`,
      });
      const lineNoEnd = (obj) => {
        if (obj && obj.event === "end") return;
        line(obj);
      };
      try {
        const result = await runSpawnStreaming(
          process.execPath,
          ["agent-docs.js"],
          { cwd: abs, env: { ...env, PIPELINE_STAGE: "generate", PIPELINE_IO_FILE: ioFile } },
          lineNoEnd
        );
        if (result && result.code !== 0) {
          line({ event: "end", code: result.code, ok: false });
          return;
        }
        const envelope = JSON.parse(fs.readFileSync(ioFile, "utf8"));
        const sessionId = reviewSession.createSession(abs, envelope);
        line({
          event: "review",
          flow: "issue",
          sessionId,
          mode: envelope.mode,
          format: envelope.format || "standard",
          issueKey: envelope.issueKey,
          issueSummary: envelope.issueSummary || "",
          payload: envelope.payload,
          usage: envelope.usage || null,
        });
        line({ event: "end", code: 0, ok: true });
      } catch (err) {
        line({ event: "stderr", text: `${err && err.message ? err.message : err}\n` });
        line({ event: "end", code: -1, ok: false });
      }
    });
    res.end();
    return true;
  }

  // Import the reviewed test cases into the picked container. The Create flow's counterpart is
  // /review/submit, which writes to Jira instead; this one never touches the ticket.
  if (method === "POST" && ISSUE_CASE_IMPORT_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const abs = path.resolve(String(body.projectPath || "").trim());
    const v = validateProjectDir(abs);
    if (!v.ok) return json(res, 400, { ok: false, error: v.error });

    let envelope;
    try {
      envelope = reviewSession.readSession(abs, body.sessionId);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    // A Create-flow session is meant for a Jira comment and the APPROVED round-trip after it;
    // importing it here would skip the approval nobody gave.
    if (envelope.flow !== "issue") {
      return json(res, 400, { ok: false, error: "This review session does not belong to the Cover a bug flow" });
    }
    applyReviewedEdits(envelope, body);
    reviewSession.writeSession(abs, body.sessionId, envelope);

    const target = body.target && typeof body.target === "object" ? body.target : {};

    const result = await withPipelineIoFile(async (ioFile) => {
      fs.writeFileSync(ioFile, JSON.stringify({ envelope, target }), "utf8");
      const run = await runSpawn(
        process.execPath,
        ["agent-docs.js"],
        {
          cwd: abs,
          env: {
            ...envForChild(abs, { CHECK_APPROVAL: "false" }),
            PIPELINE_STAGE: "import-tms",
            PIPELINE_IO_FILE: ioFile,
          },
        }
      );
      if (run.code !== 0) {
        return { ok: false, error: firstErrorLine(run.stderr, run.stdout) || "Import failed", log: run.stdout };
      }
      return { ...JSON.parse(fs.readFileSync(ioFile, "utf8")), log: run.stdout };
    });

    if (!result.ok) return json(res, 502, result);

    // Unlike /review/submit, the session is NOT deleted: the same case is often wanted in a
    // second suite, and the page keeps it on screen for exactly that. Abandoned sessions are
    // still cleaned up by the age-based prune in review-session.js.
    return json(res, 200, result);
  }

  if (method === "POST" && CONFIG_RESET_PATHS.has(pathname)) {
    configStore.deleteConfig();
    return json(res, 200, configPayload({ reset: true }));
  }

  // ── Format examples (Setup → Format examples card) ───────────────────────
  // These teach the generation prompt what a test case / checklist looks like.
  // Every mutation persists immediately: there is no "Save all changes" for
  // them, so a half-finished edit can never end up in the next generation run.

  if (method === "GET" && EXAMPLES_PATHS.has(pathname)) {
    return json(res, 200, { ok: true, ...examplesStore.list() });
  }

  if (method === "GET" && EXAMPLES_PREVIEW_PATHS.has(pathname)) {
    // Exactly what is spliced into each prompt, so the user can see what the
    // model will actually be shown: the standard block and the Gherkin one.
    return json(res, 200, {
      ok: true,
      markdown: examplesStore.renderForPrompt(),
      bdd: examplesStore.renderBddForPrompt(),
    });
  }

  if (method === "POST" && EXAMPLES_ADD_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const result = examplesStore.add(body || {});
    if (!result.ok) return json(res, 400, { ok: false, error: result.errors.join("; ") });
    return json(res, 200, { ok: true, example: result.example, examples: result.examples });
  }

  if (method === "POST" && EXAMPLES_UPDATE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const id = String((body && body.id) || "").trim();
    if (!id) return json(res, 400, { ok: false, error: "id is required" });
    const result = examplesStore.update(id, body);
    if (!result.ok) return json(res, 400, { ok: false, error: result.errors.join("; ") });
    return json(res, 200, { ok: true, example: result.example, examples: result.examples });
  }

  if (method === "POST" && EXAMPLES_DELETE_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const id = String((body && body.id) || "").trim();
    if (!id) return json(res, 400, { ok: false, error: "id is required" });
    const result = examplesStore.remove(id);
    if (!result.ok) return json(res, 404, { ok: false, error: result.errors.join("; ") });
    return json(res, 200, { ok: true, examples: result.examples });
  }

  if (method === "POST" && EXAMPLES_REORDER_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const ids = Array.isArray(body && body.ids) ? body.ids.map((i) => String(i)) : [];
    const result = examplesStore.reorder(ids);
    return json(res, 200, { ok: true, examples: result.examples });
  }

  if (method === "POST" && EXAMPLES_IMPORT_CSV_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    // Two ways in, mirroring the Update-flow CSV step: a path from the native
    // file picker, or CSV text pasted straight into the page.
    let csvText = String((body && body.csv) || "");
    const sourcePath = String((body && body.sourcePath) || "").trim();
    if (!csvText && sourcePath) {
      const resolved = path.resolve(sourcePath);
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return json(res, 404, { ok: false, error: "That file no longer exists" });
      }
      if (!stat.isFile()) return json(res, 400, { ok: false, error: "Pick a file, not a folder" });
      if (!/\.csv$/i.test(resolved)) {
        return json(res, 400, { ok: false, error: "Only .csv files can be imported" });
      }
      try {
        csvText = fs.readFileSync(resolved, "utf8");
      } catch (e) {
        return json(res, 500, { ok: false, error: `Could not read that file: ${e.message}` });
      }
    }
    if (!csvText.trim()) return json(res, 400, { ok: false, error: "No CSV content provided" });

    const parsed = examplesStore.parseCsvToExamples(csvText, {
      source: sourcePath ? "csv" : "paste",
    });
    if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.errors.join("; ") });
    const saved = examplesStore.addMany(parsed.examples);
    if (!saved.ok) return json(res, 400, { ok: false, error: saved.errors.join("; ") });
    return json(res, 200, { ok: true, added: saved.added.length, examples: saved.examples });
  }

  // Cases ticked in the test management system In use become examples, through the same CSV
  // parser a file import uses.
  if (method === "POST" && EXAMPLES_IMPORT_TMS_PATHS.has(pathname)) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON body" });
    }
    const picked = await tmsContext.pickedCasesAsCsv({
      topId: body.topId,
      containerId: body.containerId,
      containerPath: body.containerPath,
      caseIds: Array.isArray(body.caseIds) ? body.caseIds : [],
    });
    if (!picked.ok) return json(res, 400, { ok: false, error: picked.error });
    const parsed = examplesStore.parseCsvToExamples(picked.csv, { source: picked.providerTitle });
    if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.errors.join("; ") });
    const saved = examplesStore.addMany(parsed.examples, { skipInvalid: true });
    if (!saved.ok) return json(res, 400, { ok: false, error: saved.errors.join("; ") });
    return json(res, 200, {
      ok: true,
      added: saved.added.length,
      skipped: saved.skipped,
      providerTitle: picked.providerTitle,
      examples: saved.examples,
    });
  }

  if (method === "POST" && EXAMPLES_RESET_PATHS.has(pathname)) {
    return json(res, 200, { ok: true, ...examplesStore.reset() });
  }

  return false;
}

const FULL_FLOW_GUIDE_PATH = path.join(__dirname, "FULL_FLOW_GUIDE.md");
const UPDATED_CSV_FLOW_PATH = path.join(__dirname, "UPDATED_CSV_FLOW.md");
const ADO_TEST_PLANS_PATH = path.join(__dirname, "ADO_TEST_PLANS.md");
const TESTRAIL_PATH = path.join(__dirname, "TESTRAIL.md");
const ZEPHYR_PATH = path.join(__dirname, "ZEPHYR.md");

/** Guide lives in repo root; web UI is under ./web — serve so footer link works. Default: HTML preview (like editor Markdown preview); `?raw=1` or Accept: text/markdown → source. */
function sendMarkdownGuide(req, res, absPath, pageTitle) {
  fs.readFile(absPath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    const md = data.toString("utf8");
    if (wantsRawMarkdown(req)) {
      const body = req.method === "HEAD" ? undefined : md;
      res.writeHead(200, { "Content-Type": MIME[".md"], "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    const html = buildGuideHtml(pageTitle, md);
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": buf.length,
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

function sendFaviconPng(req, res) {
  if (req.method === "HEAD") {
    fs.stat(FAVICON_PNG_PATH, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=86400",
      });
      res.end();
    });
    return;
  }
  fs.readFile(FAVICON_PNG_PATH, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(data);
  });
}

function sendIndexHtml(req, res) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const origin = `http://${host}`;
  const indexPath = path.join(WEB_ROOT, "index.html");
  fs.readFile(indexPath, "utf8", (err, html) => {
    if (err) {
      res.writeHead(500);
      res.end("Server error");
      return;
    }
    if (html.includes(INDEX_PLACEHOLDER)) {
      html = html.split(INDEX_PLACEHOLDER).join(origin);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : html);
  });
}

function serveStatic(req, res) {
  const pathname = getPathname(req);
  let rel = pathname === "/" ? "/index.html" : pathname;
  let filePath = safeJoin(WEB_ROOT, rel);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  const ext = path.extname(filePath);
  if (ext === ".html") {
    fs.readFile(filePath, "utf8", (err, html) => {
      if (err) {
        if (err.code === "ENOENT") {
          res.writeHead(404);
          res.end("Not found");
        } else {
          res.writeHead(500);
          res.end("Server error");
        }
        return;
      }
      if (html.includes(INDEX_PLACEHOLDER)) {
        const host = req.headers.host || `127.0.0.1:${PORT}`;
        html = html.split(INDEX_PLACEHOLDER).join(`http://${host}`);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : html);
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = getPathname(req);

  const handled = await handleApi(req, res);
  if (handled) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    sendIndexHtml(req, res);
    return;
  }

  if (pathname === "/favicon.png") {
    sendFaviconPng(req, res);
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(302, { Location: "/favicon.png", "Cache-Control": "no-cache" });
    res.end();
    return;
  }

  if (pathname === "/FULL_FLOW_GUIDE.md") {
    sendMarkdownGuide(req, res, FULL_FLOW_GUIDE_PATH, "FULL_FLOW_GUIDE.md");
    return;
  }

  if (pathname === "/UPDATED_CSV_FLOW.md") {
    sendMarkdownGuide(req, res, UPDATED_CSV_FLOW_PATH, "UPDATED_CSV_FLOW.md");
    return;
  }

  if (pathname === "/ADO_TEST_PLANS.md") {
    sendMarkdownGuide(req, res, ADO_TEST_PLANS_PATH, "ADO_TEST_PLANS.md");
    return;
  }

  if (pathname === "/TESTRAIL.md") {
    sendMarkdownGuide(req, res, TESTRAIL_PATH, "TESTRAIL.md");
    return;
  }

  if (pathname === "/ZEPHYR.md") {
    sendMarkdownGuide(req, res, ZEPHYR_PATH, "ZEPHYR.md");
    return;
  }

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/__da/") ||
    pathname.startsWith("/web/folder-pick")
  ) {
    return json(res, 404, { error: "Unknown API route", path: pathname });
  }

  serveStatic(req, res);
});

/**
 * A busy port almost always means an older copy of this server is still running — usually after
 * pulling changes, since Node keeps serving its own start-up code while static files are re-read
 * from disk. The default crash is an unhandled 'error' event and a stack trace, which says nothing
 * about what to do, so print the fix (and who holds the port) instead.
 */
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use — another web UI is still running.\n`);
    let holder = "";
    try {
      holder = require("child_process")
        .execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
        .split(/\s+/)
        .join(" ");
    } catch {
      /* lsof is missing (or Windows) — fall back to the generic instructions below */
    }
    if (holder) {
      console.error(`   Held by PID ${holder}. Stop it and start again:`);
      console.error(`     kill ${holder} && npm run web\n`);
    } else if (process.platform === "win32") {
      console.error("   Find and stop it, then start again:");
      console.error(`     netstat -ano | findstr :${PORT}`);
      console.error("     taskkill /PID <pid> /F\n");
    } else {
      console.error("   Find and stop it, then start again:");
      console.error(`     lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n`);
    }
    console.error(`   Or run this one on a different port:  WEB_UI_PORT=3848 npm run web\n`);
    process.exit(1);
  }
  console.error(`❌ Web UI server error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Test Coverage web UI → http://127.0.0.1:${PORT}/`);
  console.log(`Listening on 0.0.0.0:${PORT} (local network). Press Ctrl+C to stop.`);
  maybeEnsureWindowsDesktopShortcut();
  maybeEnsureMacDesktopShortcut();
});
