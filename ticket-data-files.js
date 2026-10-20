/**
 * CSV / JSON files attached to the analysed Jira issue, read as part of the requirement.
 *
 * Some tickets carry their requirements as data rather than prose: a CSV of fields and validation
 * rules, a JSON payload or config the feature must accept, a matrix of roles × permissions. The
 * description then says "see attached" — or nothing at all. This module downloads those files and
 * turns them into text that is appended to the ticket description, so every flow (Create, Update,
 * Cover a bug) and every Regenerate sees them exactly where the requirement lives: in <description>.
 *
 * What is read: `.csv`, `.tsv`, `.json` attachments (or a text/csv / application/json mime type).
 *
 * A CSV in the test-case shape ("ID,Work Item Type,Title,Test Step,…") is read like any other:
 * a QA engineer attaching e.g. "missing test cases" to a story is giving requirements.
 *
 * What is left out:
 *   - the agent's own artefacts — a CSV that Submit attached (recognised by the "📄 Approved …
 *     (CSV) <file name>" comment attachApprovedCsv() posts next to it, not by its content, which
 *     a human-attached test-case CSV shares) and `generated-testcases-<KEY>.json`;
 *   - files over ATTACHMENT_MAX_BYTES, and anything that cannot be downloaded (a warning, not a
 *     failed run).
 *
 * What is changed: obvious personal-data values are masked with the same heuristic the issue
 * comments use (issue-comments.js), and the run log says how many were masked.
 *
 * Settings (env / .env only — deliberately not on the Web UI, on by default):
 *   ENABLE_TICKET_DATA_FILES        default true; "false" turns the whole thing off
 *   TICKET_DATA_FILES_MAX           files read per ticket, default 10 (newest first)
 *   TICKET_DATA_FILES_MAX_CHARS     total budget for all files in the prompt, default 120000
 */

const path = require("path");
const { maskPersonalData } = require("./issue-comments");

const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

const OWN_JSON_RE = /^generated-testcases-.*\.json$/i;
/** The comment attachApprovedCsv() posts: "📄 Approved test cases (CSV) <file name>". */
const OWN_CSV_COMMENT_RE = /Approved\b[^\n]*\(CSV\)/i;

/**
 * File names the agent attached itself, read off its "Approved … (CSV)" comments. A failed read
 * means nothing is excluded: reading our own CSV back costs a little noise, dropping the QA
 * engineer's requirements costs the run.
 */
async function ownAttachmentNames(jiraClient, issueKey, log) {
  const names = new Set();
  try {
    for (const c of await jiraClient.getComments(issueKey)) {
      const text = String(c.bodyText || "");
      if (OWN_CSV_COMMENT_RE.test(text)) names.add(text);
    }
  } catch (err) {
    log.warn(`⚠️  Ticket data files: could not read comments of ${issueKey} to tell the agent's own CSVs apart: ${String(err.message).slice(0, 200)}`);
  }
  return names;
}

function isOwnAttachment(filename, ownCommentTexts) {
  if (OWN_JSON_RE.test(filename)) return true;
  for (const text of ownCommentTexts) if (text.includes(filename)) return true;
  return false;
}

function ticketDataFilesEnabled(env = process.env) {
  return String(env.ENABLE_TICKET_DATA_FILES || "true").trim().toLowerCase() !== "false";
}

function intSetting(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "csv" | "tsv" | "json" | "" for an attachment's metadata (GET /issue?fields=attachment). */
function dataKindOf(att) {
  const ext = path.extname(String((att && att.filename) || "")).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  if (ext === ".json") return "json";
  const mime = String((att && att.mimeType) || "").toLowerCase();
  if (mime.includes("csv")) return "csv";
  if (mime.includes("tab-separated")) return "tsv";
  if (mime.includes("json")) return "json";
  return "";
}

function stripBom(text) {
  return String(text || "").replace(/^﻿/, "");
}

/** Rows of a CSV / TSV, by line — only used to count and to cut at a row boundary. */
function dataLines(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * One file as prompt text, within `budget` characters. CSV / TSV stay as they are (a model reads
 * them well, and the header names the columns); if they do not fit, whole rows are cut from the
 * end and the cut is stated. JSON is pretty-printed when that fits, compacted when it does not,
 * and cut as a last resort.
 * @returns {{ body: string, cut: boolean, note: string }}
 */
function formatDataFile(kind, raw, budget) {
  const text = stripBom(raw).trim();
  if (kind === "json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      const cut = text.length > budget;
      return { body: cut ? `${text.slice(0, budget)}\n…(cut)` : text, cut, note: "not valid JSON, shown as text" };
    }
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length <= budget) return { body: pretty, cut: false, note: "" };
    const compact = JSON.stringify(parsed);
    if (compact.length <= budget) return { body: compact, cut: false, note: "" };
    return { body: `${compact.slice(0, budget)}\n…(cut)`, cut: true, note: "" };
  }

  const lines = dataLines(text);
  const rows = Math.max(0, lines.length - 1);
  const note = `${rows} data row(s)`;
  if (text.length <= budget) return { body: text, cut: false, note };
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length && used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = lines.length - kept.length;
  return { body: `${kept.join("\n")}\n…(${left} more row(s) cut)`, cut: true, note };
}

/**
 * Pure part: downloaded files → one text block + stats.
 * @param {Array<{ filename: string, kind: string, content: string }>} files newest first
 * @param {{ maxChars?: number }} [options]
 */
function buildTicketDataFilesContext(files, options = {}) {
  const maxChars = intSetting(options.maxChars ?? process.env.TICKET_DATA_FILES_MAX_CHARS, 120000);
  const stats = { used: 0, cut: 0, masked: 0, names: [] };
  const sections = [];
  let used = 0;

  for (const f of Array.isArray(files) ? files : []) {
    const content = stripBom(f.content);
    const remaining = maxChars - used;
    if (remaining < 500) {
      stats.cut += 1;
      continue;
    }
    const { text: safe, masked } = maskPersonalData(content);
    const { body, cut, note } = formatDataFile(f.kind, safe, remaining);
    if (!body.trim()) continue;
    const entry = `--- File: ${f.filename} (${f.kind.toUpperCase()}${note ? `, ${note}` : ""}${cut ? ", cut to fit" : ""})\n${body}`;
    sections.push(entry);
    used += entry.length;
    stats.used += 1;
    stats.masked += masked;
    if (cut) stats.cut += 1;
    stats.names.push(f.filename);
  }

  if (!sections.length) return { text: "", stats };
  const text = `REQUIREMENTS ATTACHED TO THE TICKET AS DATA FILES (part of the requirement — read them as you read the description: fields, values, rules, rows and keys are requirements to cover):
${sections.join("\n\n")}`;
  return { text, stats };
}

/**
 * Fetch + build. Never throws: a failed fetch costs a warning, never the run.
 * @param {Object} jiraClient - JiraClient
 * @param {string} issueKey - the issue whose requirements are analysed (the context issue)
 * @param {{ log?: Console, maxChars?: number }} [options]
 * @returns {Promise<{ text: string, stats: Object|null, error: string }>}
 */
async function loadTicketDataFiles(jiraClient, issueKey, options = {}) {
  const log = options.log || console;
  if (!ticketDataFilesEnabled()) return { text: "", stats: null, error: "" };
  if (!jiraClient || !issueKey) return { text: "", stats: null, error: "" };

  let attachments;
  try {
    attachments = await jiraClient.getAttachments(issueKey);
  } catch (err) {
    const error = `could not list attachments of ${issueKey}: ${err.message}`;
    log.warn(`⚠️  Ticket data files: ${error}`);
    return { text: "", stats: null, error };
  }

  const max = intSetting(process.env.TICKET_DATA_FILES_MAX, 10);
  const candidates = (attachments || [])
    .map((att) => ({ att, kind: dataKindOf(att) }))
    .filter((x) => x.kind)
    .sort((a, b) => Date.parse(b.att.created || 0) - Date.parse(a.att.created || 0));
  if (!candidates.length) return { text: "", stats: null, error: "" };

  const ownComments = await ownAttachmentNames(jiraClient, issueKey, log);
  const files = [];
  let own = 0;
  let tooBig = 0;
  let failed = 0;
  for (const { att, kind } of candidates.slice(0, max)) {
    if (isOwnAttachment(att.filename, ownComments)) {
      own += 1;
      continue;
    }
    if (Number(att.size) > ATTACHMENT_MAX_BYTES) {
      tooBig += 1;
      continue;
    }
    try {
      files.push({ filename: att.filename, kind, content: await jiraClient.getAttachmentContent(att.content) });
    } catch (err) {
      failed += 1;
      log.warn(`⚠️  Ticket data files: could not download ${att.filename}: ${String(err.message).slice(0, 200)}`);
    }
  }

  const { text, stats } = buildTicketDataFilesContext(files, options);
  const left = candidates.length - Math.min(candidates.length, max);
  const skipped = [
    own && `${own} attached by the agent itself`,
    tooBig && `${tooBig} over 2 MB`,
    failed && `${failed} not downloaded`,
    left && `${left} beyond the first ${max}`,
  ].filter(Boolean);
  if (stats.used) {
    log.log(
      `🗂️  Ticket data files: ${stats.used} CSV/JSON file(s) read as requirements — ${stats.names.join(", ")}${
        stats.cut ? ` (${stats.cut} cut to fit)` : ""
      }${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}.`
    );
  } else if (skipped.length) {
    log.log(`🗂️  Ticket data files: none used (skipped: ${skipped.join(", ")}).`);
  }
  if (stats.masked) {
    log.warn(
      `⚠️  Masked ${stats.masked} value(s) in ${issueKey} data files that look like personal data (e-mail, SSN, MRN, DOB, insurance id). Check the files — real patient data should not be there.`
    );
  }
  return { text, stats, error: "" };
}

/**
 * The ticket description with the data files appended — what every prompt reads as <description>.
 * Mutates and returns `issueData`; a ticket without data files is left exactly as it was.
 */
async function appendTicketDataFiles(jiraClient, issueData, options = {}) {
  if (!issueData || !issueData.key) return issueData;
  const { text } = await loadTicketDataFiles(jiraClient, issueData.key, options);
  if (text) {
    const description = String(issueData.description || "").trim();
    issueData.description = description ? `${description}\n\n${text}` : text;
  }
  return issueData;
}

module.exports = {
  appendTicketDataFiles,
  loadTicketDataFiles,
  buildTicketDataFilesContext,
  formatDataFile,
  dataKindOf,
  ticketDataFilesEnabled,
};
