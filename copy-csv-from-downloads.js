const fs = require("fs");
const path = require("path");
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

function parseArgs(argv) {
  const out = {
    name: "",
    target: process.env.CSV_COPY_TARGET || "Updated test cases",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to" || a === "-t") {
      out.target = argv[i + 1] || out.target;
      i++;
      continue;
    }
    if (!out.name && !a.startsWith("-")) {
      out.name = a;
    }
  }
  return out;
}

function getDownloadsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return process.env.DOWNLOADS_DIR || path.join(home, "Downloads");
}

function listCsvFilesFlat(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ".csv")
    .map((e) => path.join(dir, e.name));
}

function pickBestMatch(files, nameQuery) {
  const q = String(nameQuery || "").trim().toLowerCase();
  if (!q) return null;
  const exact = files.filter((f) => path.basename(f).toLowerCase() === q);
  const contains = files.filter((f) => path.basename(f).toLowerCase().includes(q));
  const pool = exact.length > 0 ? exact : contains;
  if (!pool.length) return null;
  return pool
    .slice()
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    console.error('❌ Usage: node copy-csv-from-downloads.js "<file name or part>" [--to "Updated test cases"]');
    process.exit(1);
  }

  const downloads = getDownloadsDir();
  const allCsv = listCsvFilesFlat(downloads);
  const src = pickBestMatch(allCsv, args.name);
  if (!src) {
    console.error(`❌ CSV not found in Downloads by name: ${args.name}`);
    process.exit(1);
  }

  const targetDir = path.isAbsolute(args.target) ? args.target : path.join(__dirname, args.target);
  ensureDir(targetDir);
  const dst = path.join(targetDir, path.basename(src));
  fs.copyFileSync(src, dst);

  console.log(`✅ Copied:\n   from: ${src}\n   to:   ${dst}`);
}

run();

