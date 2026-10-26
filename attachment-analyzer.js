/**
 * Requirement attachments: images and PDFs the QA engineer attaches on the Create, Update or
 * Cover a bug page, read by a multimodal model and turned into ONE text block for the generation
 * prompt.
 *
 * Same contract as figma-client / prototype-client: the expensive, multimodal part happens once,
 * before generation, and what the generator sees is plain text. That keeps every generation
 * prompt (and every fallback model in OPENROUTER_MODELS) text-only, lets the review session store
 * the result so Regenerate never re-reads the files, and puts what the model "saw" in the run log
 * where the reviewer can check it.
 *
 *   images (png / jpeg / webp / gif) — sent as `image_url` parts, a few per call
 *   PDFs                             — sent as an OpenRouter `file` part, one PDF per call; the
 *                                      `file-parser` plugin picks the engine (ATTACHMENTS_PDF_ENGINE)
 *
 * Failures never cost the run: a file that cannot be read is reported in `stats.failed` and in the
 * log, and generation continues with whatever was extracted.
 *
 * Settings (Setup → Requirement attachments, or env):
 *   ATTACHMENTS_VISION_MODEL   default FIGMA_VISION_MODEL, then google/gemini-2.5-flash
 *   ATTACHMENTS_PDF_ENGINE     auto (default) | native | cloudflare-ai | mistral-ocr
 *   ATTACHMENTS_MAX_FILES      default 10
 *   ATTACHMENTS_MAX_FILE_MB    default 20
 *   ATTACHMENTS_MAX_TOKENS     output cap per call, default 6000
 *
 * The Web UI passes the stored files as REQUIREMENT_ATTACHMENTS: a JSON array of absolute paths.
 */

const fs = require("fs");
const path = require("path");
const { callModel, activeLlmProvider, activeLlmApiKey, activeVisionModel, missingLlmKeyMessage, LlmTruncatedError } = require("./llm-client");

/**
 * Lowest per-reading cap with the Claude API: Claude thinks before it answers and the thinking
 * counts towards max_tokens, so the OpenRouter-sized default would cut readings off.
 */
const CLAUDE_MIN_READING_TOKENS = 16000;

const DEFAULTS = {
  visionModel: "google/gemini-2.5-flash",
  pdfEngine: "auto",
  maxFiles: 10,
  maxFileMb: 20,
  maxTokens: 6000,
  imagesPerCall: 4,
};

const PDF_ENGINES = new Set(["auto", "native", "cloudflare-ai", "mistral-ocr"]);

const MIME_BY_KIND = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Extensions the picker accepts. The bytes are what is trusted, see sniffKind(). */
const ACCEPTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"];

/**
 * File kind from its first bytes — never from the name, which the browser lets anyone pick.
 * @param {Buffer} buf
 * @returns {"png"|"jpeg"|"gif"|"webp"|"pdf"|null}
 */
function sniffKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.slice(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  // "%PDF" may be preceded by a little junk; the spec allows it within the first 1024 bytes.
  if (buf.slice(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  return null;
}

function isImageKind(kind) {
  return kind === "png" || kind === "jpeg" || kind === "gif" || kind === "webp";
}

function intSetting(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Everything tunable, read at call time so a Setup save applies to the next run. */
function resolveSettings(options = {}) {
  const env = process.env;
  let pdfEngine = String(options.pdfEngine || env.ATTACHMENTS_PDF_ENGINE || DEFAULTS.pdfEngine)
    .trim()
    .toLowerCase();
  if (pdfEngine === "pdf-text") pdfEngine = "cloudflare-ai"; // OpenRouter's deprecated alias
  if (!PDF_ENGINES.has(pdfEngine)) pdfEngine = DEFAULTS.pdfEngine;
  return {
    visionModel:
      String(options.visionModel || env.ATTACHMENTS_VISION_MODEL || env.FIGMA_VISION_MODEL || "").trim() ||
      DEFAULTS.visionModel,
    pdfEngine,
    maxFiles: intSetting(options.maxFiles ?? env.ATTACHMENTS_MAX_FILES, DEFAULTS.maxFiles),
    maxFileMb: intSetting(options.maxFileMb ?? env.ATTACHMENTS_MAX_FILE_MB, DEFAULTS.maxFileMb),
    maxTokens: intSetting(options.maxTokens ?? env.ATTACHMENTS_MAX_TOKENS, DEFAULTS.maxTokens),
    imagesPerCall: intSetting(options.imagesPerCall, DEFAULTS.imagesPerCall),
  };
}

/**
 * REQUIREMENT_ATTACHMENTS → absolute paths. Accepts a JSON array (what the Web UI writes) or,
 * for a hand-run CLI, a list separated by newlines or the platform path delimiter.
 * @returns {string[]}
 */
function attachmentPathsFromEnv(raw = process.env.REQUIREMENT_ATTACHMENTS) {
  const s = String(raw || "").trim();
  if (!s) return [];
  let list;
  if (s.startsWith("[")) {
    try {
      list = JSON.parse(s);
    } catch {
      list = [];
    }
  } else {
    list = s.split(new RegExp(`[\\r\\n${path.delimiter === ";" ? ";" : ":"}]+`));
  }
  return (Array.isArray(list) ? list : [])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

/** What the extraction model is asked to do — once per call, whatever the mix of files. */
function extractionInstructions({ issueKey, flowHint }) {
  return [
    "You are a senior QA analyst. The attached file(s) are REQUIREMENTS SOURCES for designing tests" +
      (issueKey ? ` for Jira issue ${issueKey}` : "") +
      ": UI mockups, screenshots, specifications, acceptance criteria, flow diagrams, tables" +
      (flowHint ? `, ${flowHint}` : "") +
      ".",
    "Extract everything a tester needs, faithfully. Do NOT summarize away numbers, conditions or exact wording, and do NOT invent anything that is not in the file.",
    "",
    "For EACH file, in the order given, output exactly this block (use the file label you were given, e.g. [A1]):",
    "=== [A#] <file name> ===",
    "Kind: UI screen | specification | flow diagram | table | bug screenshot | other",
    "Requirements and rules: numbered list — business rules, acceptance criteria, validations, limits and boundary values, formats, permissions/roles, states and transitions, calculations. Quote exact text where the file has it.",
    "UI elements: exact visible labels of screens, fields, buttons, tabs, columns, menus, dialogs, and every message text, verbatim in double quotes.",
    "Data and values: concrete allowed values, ranges, enumerations, defaults, units.",
    "Flows: step sequences and navigation the file shows.",
    "Visible state: errors, warnings, disabled/selected/empty/loading states shown.",
    "Unclear or missing: what is ambiguous, contradictory, cut off or unreadable.",
    "",
    "Rules:",
    "- Report only what is in the file. If a section has nothing, write \"none\".",
    "- Keep labels and messages in the file's own language and spelling.",
    "- For a multi-page PDF, cite the page (p.N) next to each rule.",
    "- Personal data: if the file shows what looks like real people's data (names, IDs, dates of birth, contact, insurance or medical details), never copy the values. Describe the field instead (e.g. \"Patient name field, required\") and add \"contains personal data values — not copied\" under Unclear or missing.",
    "- Plain text only: no markdown bold, no tables.",
  ].join("\n");
}

/**
 * Group images into calls of `imagesPerCall`; every PDF is a call of its own. Pending images are
 * flushed before a PDF so the extracted sections come back in [A1], [A2]… order.
 */
function planCalls(files, imagesPerCall) {
  const calls = [];
  let batch = [];
  for (const f of files) {
    if (f.kind === "pdf") {
      if (batch.length) {
        calls.push(batch);
        batch = [];
      }
      calls.push([f]);
      continue;
    }
    batch.push(f);
    if (batch.length >= imagesPerCall) {
      calls.push(batch);
      batch = [];
    }
  }
  if (batch.length) calls.push(batch);
  return calls;
}

function contentPartsFor(batch, instructions) {
  const parts = [{ type: "text", text: instructions }];
  for (const f of batch) {
    parts.push({ type: "text", text: `File ${f.label}: ${f.name}` });
    const dataUrl = `data:${MIME_BY_KIND[f.kind]};base64,${f.buffer.toString("base64")}`;
    if (f.kind === "pdf") {
      parts.push({ type: "file", file: { filename: f.name, file_data: dataUrl } });
    } else {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }
  }
  return parts;
}

/** Display name: the stored copy keeps the original name, prefixed by nothing. */
function displayName(filePath) {
  return path.basename(filePath);
}

/**
 * Main entry.
 *
 * @param {string[]} filePaths - absolute paths; usually attachmentPathsFromEnv()
 * @param {Object} [options]
 * @param {string} [options.issueKey]
 * @param {string} [options.flowHint] - extra kind of file this flow expects, e.g. "bug screenshots"
 * @param {Object} [options.usageTally] - llm-usage tally of the run, so the spend is counted
 * @param {string} [options.apiKey]
 * @param {Console} [options.log]
 * @returns {Promise<{ summary: string, error: string, stats: Object|null }>}
 *   summary — text block for the prompt ("" when nothing could be read)
 *   error   — short reason when summary is empty
 *   stats   — counts for the log line and the "context used" note
 */
async function analyzeAttachments(filePaths, options = {}) {
  const log = options.log || console;
  const paths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!paths.length) return { summary: "", error: "", stats: null };

  // The key of the provider Setup → AI model points at; with the Claude API the files are read by
  // the Claude model picked there (every Claude model reads images and PDFs).
  const apiKey = options.apiKey || activeLlmApiKey();
  if (!apiKey) return { summary: "", error: `${missingLlmKeyMessage()} — attachments not analyzed`, stats: null };

  const settings = resolveSettings(options);
  const onClaude = activeLlmProvider() === "anthropic";
  settings.visionModel = activeVisionModel(settings.visionModel);
  // An explicitly higher ATTACHMENTS_MAX_TOKENS still wins.
  const maxTokens = onClaude ? Math.max(settings.maxTokens, CLAUDE_MIN_READING_TOKENS) : settings.maxTokens;
  const failed = [];
  const skipped = [];

  let selected = paths;
  if (paths.length > settings.maxFiles) {
    selected = paths.slice(0, settings.maxFiles);
    for (const p of paths.slice(settings.maxFiles)) {
      skipped.push({ name: displayName(p), reason: `over the ${settings.maxFiles}-file limit` });
    }
  }

  const files = [];
  for (const p of selected) {
    const name = displayName(p);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error("not a file");
      if (st.size > settings.maxFileMb * 1024 * 1024) {
        skipped.push({ name, reason: `larger than ${settings.maxFileMb} MB` });
        continue;
      }
      const buffer = fs.readFileSync(p);
      const kind = sniffKind(buffer);
      if (!kind) {
        skipped.push({ name, reason: "not a PNG, JPEG, WebP, GIF or PDF" });
        continue;
      }
      files.push({ path: p, name, kind, buffer, size: st.size });
    } catch (err) {
      skipped.push({ name, reason: err.code === "ENOENT" ? "file no longer exists — attach it again" : err.message });
    }
  }
  files.forEach((f, i) => {
    f.label = `[A${i + 1}]`;
  });

  for (const s of skipped) log.warn(`⚠️  Attachment skipped: ${s.name} — ${s.reason}`);
  if (!files.length) {
    return {
      summary: "",
      error: "no readable attachment",
      stats: { files: 0, images: 0, pdfs: 0, analyzed: 0, failed, skipped, model: null, names: [] },
    };
  }

  const instructions = extractionInstructions({ issueKey: options.issueKey, flowHint: options.flowHint });
  const sections = [];
  const analyzedLabels = new Set();

  for (const batch of planCalls(files, settings.imagesPerCall)) {
    const names = batch.map((f) => `${f.label} ${f.name}`).join(", ");
    log.log(`📎 Reading attachment${batch.length > 1 ? "s" : ""} ${names} via ${settings.visionModel}…`);
    const isPdf = batch[0].kind === "pdf";
    const extraBody =
      isPdf && settings.pdfEngine !== "auto"
        ? { plugins: [{ id: "file-parser", pdf: { engine: settings.pdfEngine } }] }
        : null;
    try {
      const text = await callModel(contentPartsFor(batch, instructions), {
        maxTokens,
        apiKey,
        models: [settings.visionModel],
        // With the Claude API: the Claude vision model (Figma card), resolved above.
        anthropicModel: settings.visionModel,
        usageTally: options.usageTally || null,
        heartbeatLabel: `${settings.visionModel} (attachments)`,
        announce: false,
        trimResult: true,
        extraBody,
        labels: {
          httpError: "Attachment analysis API error",
          truncationRemedy: "Raise ATTACHMENTS_MAX_TOKENS on the Setup page, or attach fewer / smaller files.",
        },
      });
      if (!text) throw new Error("the model returned an empty answer");
      sections.push(text);
      batch.forEach((f) => analyzedLabels.add(f.label));
    } catch (err) {
      const reason =
        err instanceof LlmTruncatedError
          ? `answer cut off at ${maxTokens} tokens — raise ATTACHMENTS_MAX_TOKENS`
          : String(err && err.message ? err.message : err).slice(0, 300);
      for (const f of batch) failed.push({ name: f.name, reason });
      log.warn(`⚠️  Could not analyze ${names}: ${reason}`);
    }
  }

  const analyzedFiles = files.filter((f) => analyzedLabels.has(f.label));
  const stats = {
    files: files.length,
    images: files.filter((f) => isImageKind(f.kind)).length,
    pdfs: files.filter((f) => f.kind === "pdf").length,
    analyzed: analyzedFiles.length,
    failed,
    skipped,
    model: settings.visionModel,
    names: analyzedFiles.map((f) => f.name),
  };

  if (!sections.length) {
    return { summary: "", error: "none of the attachments could be analyzed", stats };
  }

  const index = analyzedFiles
    .map((f) => `${f.label} ${f.name} (${f.kind === "pdf" ? "PDF" : "image"})`)
    .join("\n");
  const summary = `REQUIREMENTS FROM ATTACHED FILES (images / PDFs the QA engineer attached to this run, read by ${settings.visionModel}):
${index}

${sections.join("\n\n")}`;

  return { summary, error: "", stats };
}

module.exports = {
  analyzeAttachments,
  attachmentPathsFromEnv,
  sniffKind,
  resolveSettings,
  ACCEPTED_EXTENSIONS,
  MIME_BY_KIND,
  DEFAULTS,
};
