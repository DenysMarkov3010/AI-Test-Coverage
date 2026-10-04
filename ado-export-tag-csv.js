#!/usr/bin/env node
/**
 * Export Azure DevOps Test Cases that match a tag (WIQL) to a single agent-format CSV.
 * Several tags may be given comma-separated ("Regression, Smoke"): a case matching ANY of them is
 * exported, once, into the same file.
 * under ./Test cases/. Each run removes the previous export file at that path and writes a fresh file.
 *
 * Usage:
 *   node ado-export-tag-csv.js --tag <tag>
 *   npm run ado:export-tag-csv -- --tag Regression
 *
 * Env: ADO_ORG, ADO_PROJECT, ADO_PAT (see ADO_TEST_PLANS.md).
 * Optional: ADO_TAG_CSV_PATH — override output path (still replaced on each run).
 * Optional: ADO_EXPORT_TAG — tag filter when -t/--tag is omitted (good for tags with parentheses).
 *
 * Default CSV path: Test cases/<tag>.csv (tag sanitized for the file system; invalid characters → _).
 */
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

const fs = require("fs");
const path = require("path");
const { AdoClient } = require("./ado-client");
const { mergePreconditionStepsPlain } = require("./merge-precondition-steps");

const FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.WorkItemType",
  "System.AreaPath",
  "System.Tags",
  "System.AssignedTo",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.TCM.Steps",
];

const HEADER = [
  "ID",
  "Work Item Type",
  "Title",
  "Test Step",
  "Step Action",
  "Step Expected",
  "Priority",
  "Area Path",
  "Assigned To",
  "State",
];

function getClient() {
  const org = process.env.ADO_ORG || process.env.AZURE_DEVOPS_ORG;
  const project = process.env.ADO_PROJECT || process.env.AZURE_DEVOPS_PROJECT;
  const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
  if (!org || !project || !pat) {
    console.error("Set ADO_ORG, ADO_PROJECT, and ADO_PAT in .env (see ADO_TEST_PLANS.md)");
    process.exit(1);
  }
  const baseUrl = process.env.ADO_SERVER_URL;
  return new AdoClient(org, project, pat, baseUrl ? { baseUrl } : {});
}

/** Escape single quotes in WIQL string literals. */
function wiqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function escapeCsvField(val) {
  const s = String(val ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(cells) {
  return cells.map(escapeCsvField).join(",");
}

function decodeXmlText(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Azure DevOps often stores step text as HTML inside parameterizedString (<DIV>, <P>, <BR/>).
 * Strip tags for agent-format plain-text CSV (see TEST_CASE_FORMAT.md).
 */
function htmlToPlainText(html) {
  let t = decodeXmlText(html);
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/p>/gi, "\n");
  t = t.replace(/<\/div>/gi, "\n");
  // List items are line breaks too. Without this a bulleted expected result came back as one
  // run-together string ("onetwothree"), which is then what the prompt and the CSV saw.
  t = t.replace(/<li[^>]*>/gi, "- ");
  t = t.replace(/<\/li>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\u00a0/g, " ");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * Parse Microsoft.VSTS.TCM.Steps XML into ordered { action, expected } (plain text only; HTML stripped).
 */
function parseTcmStepsXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  const steps = [];
  const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
  let m;
  while ((m = stepRe.exec(xml)) !== null) {
    const block = m[1];
    const strs = [...block.matchAll(/<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/gi)];
    const rawA = strs[0] ? strs[0][1] : "";
    const rawE = strs[1] ? strs[1][1] : "";
    steps.push({ action: htmlToPlainText(rawA), expected: htmlToPlainText(rawE) });
  }
  return steps;
}

function assignedToString(field) {
  if (field == null) return "";
  if (typeof field === "string") return field;
  return field.displayName || field.uniqueName || "";
}

/**
 * "Regression, Smoke ,regression" → ["Regression", "Smoke"]: split on commas, trimmed, empty parts
 * dropped, and duplicates removed case-insensitively (WIQL CONTAINS ignores case anyway).
 *
 * @param {string|string[]} raw
 * @returns {string[]}
 */
function splitTags(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const t = String(part ?? "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/**
 * One query for every tag, OR-ed: a Test Case carrying any of them is exported once. A single tag
 * produces exactly the query it always did.
 *
 * @param {string|string[]} tags one tag, a comma-separated list, or an array
 */
function buildWiql(tags) {
  const list = splitTags(tags);
  const conditions = list.map((t) => `[System.Tags] CONTAINS '${wiqlEscape(t)}'`);
  const tagFilter = conditions.length > 1 ? `(${conditions.join(" OR ")})` : conditions[0];
  return (
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.WorkItemType] = 'Test Case' ` +
    `AND ${tagFilter} ` +
    `ORDER BY [System.Id]`
  );
}

/**
 * @param {import("./ado-client").AdoClient} client
 * @param {string|string[]} tag one tag or several (see buildWiql)
 */
async function fetchTestCaseIdsByTag(client, tag) {
  const wiql = buildWiql(tag);
  const res = await client.runWiql(wiql);
  const refs = res.workItems || [];
  const seen = new Set();
  const ids = [];
  for (const w of refs) {
    const id = w && w.id != null ? w.id : null;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * @param {object[]} workItems - from getWorkItemsByIds
 * @returns {string[]} CSV lines (no trailing newline on last line handled by join)
 */
function workItemsToCsvLines(workItems) {
  const sorted = [...workItems].sort((a, b) => (a.id || 0) - (b.id || 0));
  const lines = [rowToCsv(HEADER)];
  for (const wi of sorted) {
    const f = wi.fields || {};
    const id = wi.id != null ? wi.id : f["System.Id"];
    const title = f["System.Title"] ?? "";
    const wit = f["System.WorkItemType"] ?? "Test Case";
    const state = f["System.State"] ?? "";
    const area = f["System.AreaPath"] ?? "";
    const priority = f["Microsoft.VSTS.Common.Priority"] ?? "";
    const assigned = assignedToString(f["System.AssignedTo"]);
    const stepsXml = f["Microsoft.VSTS.TCM.Steps"];
    const steps = mergePreconditionStepsPlain(parseTcmStepsXml(stepsXml));

    lines.push(
      rowToCsv([
        id,
        wit,
        title,
        "",
        "",
        "",
        String(priority),
        area,
        assigned,
        state,
      ])
    );

    if (steps.length === 0) continue;
    steps.forEach((s, idx) => {
      lines.push(
        rowToCsv([
          "",
          "",
          "",
          String(idx + 1),
          s.action,
          s.expected,
          "",
          "",
          "",
          "",
        ])
      );
    });
  }
  return lines;
}

/** Windows / cross-platform: characters not allowed in file names. */
const FILENAME_FORBIDDEN = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Turn the WIQL tag into a safe single-segment file name (without extension).
 */
function sanitizeTagForFileName(tag) {
  let s = String(tag ?? "").trim();
  s = s.replace(FILENAME_FORBIDDEN, "_");
  s = s.replace(/_+/g, "_").replace(/^\.+|\.+$/g, "");
  if (!s) s = "export";
  if (s.length > 150) s = s.slice(0, 150).trim().replace(/\.+$/, "");
  return s || "export";
}

/**
 * @param {string | null | undefined} cliPath - from -o / --output
 * @param {string} tag - resolved tag (used for default file name)
 */
function resolveOutputPath(cliPath, tag) {
  if (cliPath) return path.isAbsolute(cliPath) ? cliPath : path.join(process.cwd(), cliPath);
  const fromEnv = (process.env.ADO_TAG_CSV_PATH || "").trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv);
  }
  const fileBase = sanitizeTagForFileName(tag);
  return path.join(process.cwd(), "Test cases", `${fileBase}.csv`);
}

/**
 * Remove every .csv in the same folder as the export so only the new file remains (ADO tag export workflow).
 */
function removeOtherCsvFilesInDir(dirPath, exceptBasename) {
  if (!fs.existsSync(dirPath)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".csv")) continue;
    if (exceptBasename && e.name === exceptBasename) continue;
    try {
      fs.unlinkSync(path.join(dirPath, e.name));
      removed += 1;
    } catch (err) {
      console.warn(`Could not remove ${path.join(dirPath, e.name)}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Inline --tag=value keeps the whole value in one argv token (works with parentheses; no shell split on spaces).
 */
function parseInlineTagArg(x) {
  if (typeof x !== "string") return null;
  if (x.startsWith("--tag=")) return { raw: x.slice("--tag=".length) };
  if (x.startsWith("-t=") && x.length > "-t=".length) return { raw: x.slice("-t=".length) };
  return null;
}

function parseCli(argv) {
  const out = {
    tag: undefined,
    tagFile: null,
    output: null,
    help: false,
    verbose: false,
    failOnEmpty: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const inline = parseInlineTagArg(x);
    if (inline) {
      out.tag = inline.raw;
      continue;
    }
    if (x === "-h" || x === "--help") out.help = true;
    else if (x === "-v" || x === "--verbose") out.verbose = true;
    else if (x === "--fail-on-empty") out.failOnEmpty = true;
    else if (x === "-t" || x === "--tag") out.tag = a[++i] ?? "";
    else if (x === "--tag-file" || x === "-f") out.tagFile = a[++i] || "";
    else if (x === "-o" || x === "--output") out.output = a[++i] || "";
  }
  return out;
}

/**
 * Resolves tag: CLI (-t / --tag / --tag=) > --tag-file (or "-" = stdin) > ADO_EXPORT_TAG.
 */
function resolveTag(opts) {
  if (opts.tag !== undefined && String(opts.tag).trim() !== "") {
    return String(opts.tag).trim();
  }
  const tf = (opts.tagFile || "").trim();
  if (tf) {
    let text;
    if (tf === "-") {
      text = fs.readFileSync(0, "utf8");
    } else {
      const p = path.isAbsolute(tf) ? tf : path.join(process.cwd(), tf);
      if (!fs.existsSync(p)) {
        throw new Error(`Tag file not found: ${p}`);
      }
      text = fs.readFileSync(p, "utf8");
    }
    const line = text.split(/\r?\n/)[0] ?? "";
    const t = line.replace(/^\uFEFF/, "").trim();
    if (t) return t;
  }
  return (process.env.ADO_EXPORT_TAG || "").trim();
}

function printHelp() {
  console.log(`Usage:
  node ado-export-tag-csv.js --tag <tag> [options]

Tag (one of; see below for parentheses / special characters):
  -t, --tag <text>     Next argv is the tag substring (quote if it contains spaces or brackets).
                       Several tags comma-separated ("Regression, Smoke") export cases with ANY of them
  --tag=<text>         Entire tag after =, one token — best for names with ( ) or spaces
  -t=<text>             Same as --tag=
  -f, --tag-file <path> First line of UTF-8 file is the tag; use "-" to read first line from stdin
  ADO_EXPORT_TAG        In .env when no -t/--tag/--tag-file (same as other ADO_* vars)

Options:
  -o, --output <path>  CSV file path (default: Test cases/<tag>.csv — same name as the tag, sanitized)
                       Override with ADO_TAG_CSV_PATH in .env
  -v, --verbose        Log WIQL work item ids (for troubleshooting)

  --fail-on-empty      Exit with code 2 when WIQL finds no Test Cases (default: exit 0). Used by the web UI to validate tags.

Behavior:
  - Queries all Test Case work items in the project whose Tags field contains the given text.
  - Loads titles, steps (Microsoft.VSTS.TCM.Steps), priority, area, assignee, state.
  - Step text in ADO is often stored as HTML; it is always converted to plain text (no HTML tags in the CSV).
  - Writes Azure DevOps CSV columns (see TEST_CASE_FORMAT.md).
  - Before writing, removes other .csv files in the same folder as the output (then writes the new file), so only this export remains there.

Examples:
  npm run ado:export-tag-csv -- --tag Regression
  npm run ado:export-tag-csv -- --tag="Regression (smoke)"
  npm run ado:export-tag-csv -- --tag=Regression(smoke)
  npm run ado:export-tag-csv -- -f tag.txt
  npm run ado:export-tag-csv -- -t smoke -o "Test cases/my-export.csv"
`);
}

async function main() {
  const opts = parseCli(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  let tag;
  try {
    tag = resolveTag(opts);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
  const tags = splitTags(tag);
  if (!tags.length) {
    console.error("Set a tag: --tag, --tag=…, --tag-file, or ADO_EXPORT_TAG (WIQL [System.Tags] CONTAINS).");
    printHelp();
    process.exit(1);
  }
  // The file is named after the normalized list, so "Smoke,Regression" and "Smoke, Regression"
  // land in the same file.
  tag = tags.join(", ");

  const outPath = resolveOutputPath(opts.output, tag);
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });

  console.log(
    tags.length > 1
      ? `WIQL tag filter (any of ${tags.length}): ${tags.map((t) => JSON.stringify(t)).join(" OR ")}`
      : `WIQL tag filter: ${JSON.stringify(tags[0])}`
  );
  const client = getClient();
  const ids = await fetchTestCaseIdsByTag(client, tags);
  console.log(`Found ${ids.length} Test Case work item(s) (WIQL).`);
  if (opts.verbose && ids.length) {
    console.log(`Work item ids: ${ids.join(", ")}`);
  }

  if (ids.length === 0) {
    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
      console.log(`Removed previous file (no matches): ${outPath}`);
    }
    console.log("Nothing to export; no CSV written.");
    process.exit(opts.failOnEmpty ? 2 : 0);
  }

  const workItems = await client.getWorkItemsByIds(ids, FIELDS);
  const returned = new Set(workItems.map((w) => w.id));
  const missing = ids.filter((id) => !returned.has(id));
  if (missing.length) {
    console.warn(
      `Warning: ${missing.length} id(s) from the query were not returned by the API (deleted, permissions, or not in this project): ${missing.join(", ")}`
    );
  }

  const lines = workItemsToCsvLines(workItems);
  const body = lines.join("\r\n") + "\r\n";

  const outDir = path.dirname(outPath);
  const outBase = path.basename(outPath);
  const nRemoved = removeOtherCsvFilesInDir(outDir, outBase);
  if (nRemoved > 0) {
    console.log(`Removed ${nRemoved} previous CSV file(s) in ${outDir}`);
  }
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }
  fs.writeFileSync(outPath, body, "utf8");
  console.log(`Wrote ${lines.length - 1} data row(s) (+ header) → ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  buildWiql,
  splitTags,
  parseTcmStepsXml,
  workItemsToCsvLines,
  resolveOutputPath,
  sanitizeTagForFileName,
  removeOtherCsvFilesInDir,
  parseCli,
  resolveTag,
  parseInlineTagArg,
  htmlToPlainText,
};
