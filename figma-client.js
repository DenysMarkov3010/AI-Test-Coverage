/**
 * Figma hybrid analyzer.
 *
 * Two layers feed a single text block for the LLM prompt:
 *   1) Structural (REST tree): pages, sections, frames, text content, named
 *      interactive elements, component variants.
 *   2) Visual (Image API + multimodal LLM): renders up to N top-level frames as
 *      PNG, asks an OpenRouter vision model to describe what a tester should see.
 *
 * Activated only when FIGMA_URL is non-empty. Token must be in FIGMA_TOKEN.
 *
 * URL formats handled:
 *   https://www.figma.com/design/<fileKey>/<name>?node-id=<nodeId>
 *   https://www.figma.com/file/<fileKey>/<name>?node-id=<nodeId>
 *   https://www.figma.com/board/<fileKey>/<name>?node-id=<nodeId>
 * `node-id` may use either "1:23" or "1-23" syntax — both are normalized.
 */

const fetch = globalThis.fetch || require("node-fetch");
const { callAnthropic, activeLlmProvider, activeLlmApiKey, activeVisionModel, missingLlmKeyMessage } = require("./llm-client");

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

function parseFigmaUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  if (!FIGMA_HOSTS.has(host)) return null;
  const m = u.pathname.match(/^\/(design|file|board|proto)\/([A-Za-z0-9]+)(?:\/[^/]*)?/i);
  if (!m) return null;
  const fileKey = m[2];
  let nodeId = u.searchParams.get("node-id") || "";
  if (nodeId) nodeId = nodeId.replace(/-/g, ":");
  return { fileKey, nodeId: nodeId || null };
}

function isFigmaUrl(rawUrl) {
  return !!parseFigmaUrl(rawUrl);
}

async function figmaApi(token, endpoint, log) {
  const url = `https://api.figma.com/v1${endpoint}`;
  const res = await fetch(url, {
    headers: { "X-FIGMA-TOKEN": token, Accept: "application/json" },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const snippet = t ? ` ${t.slice(0, 240)}` : "";
    throw new Error(`Figma API ${res.status} ${res.statusText} on ${endpoint}.${snippet}`);
  }
  return res.json();
}

async function fetchNodes(token, fileKey, ids, log) {
  const idsParam = encodeURIComponent(Array.isArray(ids) ? ids.join(",") : String(ids));
  const data = await figmaApi(token, `/files/${fileKey}/nodes?ids=${idsParam}&geometry=paths`, log);
  return data.nodes || {};
}

async function fetchFileShallow(token, fileKey, depth, log) {
  return figmaApi(token, `/files/${fileKey}?depth=${encodeURIComponent(depth)}`, log);
}

async function fetchImages(token, fileKey, ids, scale, log) {
  const idsParam = encodeURIComponent(ids.join(","));
  const data = await figmaApi(
    token,
    `/images/${fileKey}?ids=${idsParam}&format=png&scale=${encodeURIComponent(scale)}`,
    log,
  );
  return data.images || {};
}

/** Build a path-by-name from the file root to the target node, for auto-expand to parent SECTION/PAGE. */
function findNodePath(rootDocument, targetId) {
  const stack = [{ node: rootDocument, path: [] }];
  while (stack.length) {
    const { node, path } = stack.pop();
    if (!node || typeof node !== "object") continue;
    const cur = [...path, node];
    if (node.id === targetId) return cur;
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], path: cur });
    }
  }
  return null;
}

/** Extract every text leaf inside a node subtree (preserves visual order). */
function collectText(node, out, limit = 300) {
  if (!node || out.length >= limit) return;
  if (node.type === "TEXT" && typeof node.characters === "string") {
    const trimmed = node.characters.replace(/\s+/g, " ").trim();
    if (trimmed) out.push(trimmed);
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectText(c, out, limit);
  }
}

/** Heuristic guess of UI element role from a node's name. Pure naming convention sniff. */
function guessRoleFromName(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return null;
  if (/(^|[\s/_-])(button|btn|cta)(\b|[\s/_-])/.test(s)) return "button";
  if (/(input|textfield|text\s*field|field)/.test(s)) return "input";
  if (/(checkbox|check\s*box)/.test(s)) return "checkbox";
  if (/(radio)/.test(s)) return "radio";
  if (/(dropdown|select|combobox|combo\s*box)/.test(s)) return "dropdown";
  if (/(toggle|switch)/.test(s)) return "toggle";
  if (/(modal|dialog|popup|popover)/.test(s)) return "modal";
  if (/(tooltip)/.test(s)) return "tooltip";
  if (/(toast|snackbar|notification|alert)/.test(s)) return "notification";
  if (/(link|hyperlink)/.test(s)) return "link";
  if (/(tab|chip|badge)/.test(s)) return s.match(/tab|chip|badge/)[0];
  if (/(icon)/.test(s)) return "icon";
  if (/(card)/.test(s)) return "card";
  if (/(list)/.test(s)) return "list";
  if (/(table)/.test(s)) return "table";
  if (/(form)/.test(s)) return "form";
  return null;
}

/** Walk a frame subtree and harvest interactive-element guesses. Dedupes by (role, name). */
function collectInteractive(node, out, limit = 100) {
  if (!node || out.length >= limit) return;
  const role = guessRoleFromName(node.name);
  if (role && node.name) {
    out.push({ role, name: String(node.name).trim(), type: node.type });
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectInteractive(c, out, limit);
  }
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * Find the top-level "render-worthy" frames inside the scope: prefer FRAME nodes that
 * have non-zero size and look like screens / mockups, not nested layout containers.
 */
function pickRenderableFrames(scopeNode, maxFrames) {
  const candidates = [];

  const visit = (node, depth) => {
    if (!node) return;
    if (node.type === "FRAME") {
      const w = node.absoluteBoundingBox?.width || 0;
      const h = node.absoluteBoundingBox?.height || 0;
      candidates.push({ node, depth, w, h, area: w * h });
      return; // do not descend into nested frames — we want top-level screens
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c, depth + 1);
    }
  };

  if (scopeNode.type === "FRAME") {
    candidates.push({
      node: scopeNode,
      depth: 0,
      w: scopeNode.absoluteBoundingBox?.width || 0,
      h: scopeNode.absoluteBoundingBox?.height || 0,
      area:
        (scopeNode.absoluteBoundingBox?.width || 0) *
        (scopeNode.absoluteBoundingBox?.height || 0),
    });
  } else if (Array.isArray(scopeNode.children)) {
    for (const c of scopeNode.children) visit(c, 1);
  }

  candidates.sort((a, b) => b.area - a.area || a.depth - b.depth);
  return candidates.slice(0, maxFrames).map((c) => c.node);
}

/** Format a single frame's text/interactive harvest into a compact section. */
function formatFrameSummary(frame) {
  const texts = [];
  collectText(frame, texts);
  const interactive = [];
  collectInteractive(frame, interactive);
  const interactiveDedup = dedupeBy(interactive, (x) => `${x.role}::${x.name.toLowerCase()}`);

  const w = Math.round(frame.absoluteBoundingBox?.width || 0);
  const h = Math.round(frame.absoluteBoundingBox?.height || 0);
  const lines = [];
  lines.push(`Frame: ${frame.name || "(unnamed)"}${w && h ? `  (${w}×${h})` : ""}`);
  if (texts.length) {
    const compact = texts.slice(0, 60).join(" | ");
    lines.push(`  Visible text: ${compact}${texts.length > 60 ? " | …" : ""}`);
  }
  if (interactiveDedup.length) {
    const grouped = {};
    for (const it of interactiveDedup) {
      grouped[it.role] = grouped[it.role] || [];
      if (grouped[it.role].length < 10) grouped[it.role].push(it.name);
    }
    const interactiveLine = Object.entries(grouped)
      .map(([role, names]) => `${role}: ${names.join(", ")}`)
      .join(" | ");
    if (interactiveLine) lines.push(`  Interactive: ${interactiveLine}`);
  }
  return { text: lines.join("\n"), name: frame.name || "(unnamed)", id: frame.id };
}

/** Component variants (states) summary if the scope contains COMPONENT_SET nodes. */
function collectComponentVariants(scopeNode) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (node.type === "COMPONENT_SET" && Array.isArray(node.children)) {
      const variants = node.children
        .filter((c) => c && c.type === "COMPONENT")
        .map((c) => c.name)
        .filter(Boolean);
      if (variants.length > 1) {
        out.push({ name: node.name || "(unnamed component)", variants });
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c);
    }
  };
  visit(scopeNode);
  return out;
}

async function downloadAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  }
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr).toString("base64");
}

/**
 * Send rendered frame PNGs to a multimodal LLM (OpenRouter) and ask for a tester-focused description.
 * Returns plain text. Failures degrade gracefully (returns "" with a console warning).
 */
async function callVisionLLM({ apiKey, model, images, log }) {
  if (!apiKey || !images.length) return "";

  const content = [
    {
      type: "text",
      text:
        "You are a QA engineer looking at screens of a product. " +
        "For EACH screen in order, output a numbered block:\n" +
        "  1. <Screen label / frame name if you can guess>\n" +
        "     - Layout summary (one sentence).\n" +
        "     - Key UI elements (forms, buttons, dropdowns, tables, modals, empty states).\n" +
        "     - Visible state cues (errors, loading, disabled, selected).\n" +
        "     - Potential testable scenarios specific to this screen (3-7 bullets, " +
        "concrete: validation, edge cases, role/permission impact, empty/loaded/error states).\n" +
        "Keep it factual: describe ONLY what you see, no general advice. Use plain text, no markdown bold.",
    },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${img.base64}` },
    })),
  ];

  // With the Claude API picked on Setup → AI model the same screens go to the Claude model there.
  // The cap gets headroom: Claude thinks before answering, and the thinking counts towards it.
  if (activeLlmProvider() === "anthropic") {
    return callAnthropic(content, { maxTokens: 16000, announce: false, trimResult: true, heartbeatLabel: `${model} (vision)`, anthropicModel: model });
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 2500,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vision LLM ${res.status} ${res.statusText}. ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error("Vision LLM returned no choices");
  }
  return String(data.choices[0].message?.content || "").trim();
}

/**
 * Main entry. Returns { summary, error, stats }:
 *   summary — plain-text block ready to inject into the LLM prompt (empty on failure).
 *   error   — short string when summary is empty due to a non-fatal problem (URL invalid,
 *             token missing, API error). The agent should log it and continue.
 *   stats   — counts and identifiers for the console log line.
 */
async function analyzeFigmaUrl(rawUrl, options = {}) {
  const log = options.log || console;
  const token = options.token || process.env.FIGMA_TOKEN;
  // The key and model of the provider Setup → AI model points at (OpenRouter or the Claude API).
  const openrouterApiKey = options.openrouterApiKey || activeLlmApiKey();
  const visionModel = activeVisionModel(options.visionModel || process.env.FIGMA_VISION_MODEL || "google/gemini-2.5-flash");
  const includeVision =
    options.includeVision !== undefined
      ? !!options.includeVision
      : (process.env.FIGMA_INCLUDE_VISION || "true").toLowerCase() !== "false";
  const maxVisionFrames =
    Number.parseInt(
      String(options.maxVisionFrames ?? process.env.FIGMA_VISION_MAX_FRAMES ?? "3"),
      10,
    ) || 3;
  const autoExpandToParent =
    options.autoExpandToParent !== undefined
      ? !!options.autoExpandToParent
      : (process.env.FIGMA_AUTO_EXPAND_TO_PARENT || "true").toLowerCase() !== "false";
  const maxFramesInTree =
    Number.parseInt(String(options.maxFramesInTree ?? process.env.FIGMA_MAX_FRAMES ?? "40"), 10) || 40;

  if (!rawUrl) {
    return { summary: "", error: null, stats: null };
  }

  const parsed = parseFigmaUrl(rawUrl);
  if (!parsed) {
    return { summary: "", error: `Not a Figma URL: ${rawUrl}`, stats: null };
  }
  if (!token) {
    return {
      summary: "",
      error: "FIGMA_TOKEN is not set in .env — design analysis skipped.",
      stats: null,
    };
  }

  const { fileKey, nodeId } = parsed;
  log.log?.(`🎨 Figma: analyzing file ${fileKey}${nodeId ? ` (node ${nodeId})` : " (whole file)"}`);

  let scopeNode = null;
  let scopeKind = "file"; // "section" | "page" | "frame" | "file" | "node"
  let scopeSourceNote = "";
  let fileName = "";

  try {
    if (nodeId) {
      const nodes = await fetchNodes(token, fileKey, [nodeId], log);
      const entry = nodes[nodeId];
      if (!entry || !entry.document) {
        return {
          summary: "",
          error: `Figma node ${nodeId} not found in file ${fileKey}`,
          stats: null,
        };
      }
      scopeNode = entry.document;
      if (scopeNode.type === "SECTION") scopeKind = "section";
      else if (scopeNode.type === "CANVAS") scopeKind = "page";
      else if (scopeNode.type === "FRAME") scopeKind = "frame";
      else scopeKind = "node";

      if (scopeKind === "frame" && autoExpandToParent) {
        try {
          const file = await fetchFileShallow(token, fileKey, 4, log);
          fileName = file.name || "";
          const pathToNode = findNodePath(file.document, scopeNode.id);
          if (pathToNode && pathToNode.length >= 2) {
            const parent = pathToNode[pathToNode.length - 2];
            if (parent && (parent.type === "SECTION" || parent.type === "CANVAS")) {
              log.log?.(
                `   ↪ Frame is inside ${parent.type === "SECTION" ? "Section" : "Page"} "${parent.name}" — expanding scope to analyze sibling frames too.`,
              );
              const parentNodes = await fetchNodes(token, fileKey, [parent.id], log);
              const parentEntry = parentNodes[parent.id];
              if (parentEntry && parentEntry.document) {
                scopeNode = parentEntry.document;
                scopeKind = parent.type === "SECTION" ? "section" : "page";
                scopeSourceNote = `auto-expanded from frame "${entry.document.name}" to parent ${scopeKind} "${parent.name}"`;
              }
            }
          }
        } catch (err) {
          log.warn?.(`⚠️  Figma auto-expand to parent failed (continuing with frame only): ${err.message}`);
        }
      }
    } else {
      const file = await fetchFileShallow(token, fileKey, 4, log);
      fileName = file.name || "";
      scopeNode = file.document;
      scopeKind = "file";
    }
  } catch (err) {
    return { summary: "", error: `Figma fetch failed: ${err.message}`, stats: null };
  }

  if (!fileName) {
    try {
      const file = await fetchFileShallow(token, fileKey, 1, log);
      fileName = file.name || "";
    } catch {
      /* non-fatal */
    }
  }

  const pages = [];
  if (scopeNode.type === "DOCUMENT" && Array.isArray(scopeNode.children)) {
    for (const page of scopeNode.children) {
      if (page.type === "CANVAS") pages.push(page);
    }
  } else if (scopeNode.type === "CANVAS") {
    pages.push(scopeNode);
  }

  let framesForAnalysis = [];
  if (pages.length) {
    for (const page of pages) {
      if (!Array.isArray(page.children)) continue;
      for (const child of page.children) {
        if (child.type === "SECTION" && Array.isArray(child.children)) {
          for (const f of child.children) {
            if (f.type === "FRAME") framesForAnalysis.push(f);
          }
        } else if (child.type === "FRAME") {
          framesForAnalysis.push(child);
        }
      }
    }
  } else if (scopeNode.type === "SECTION" && Array.isArray(scopeNode.children)) {
    for (const c of scopeNode.children) {
      if (c.type === "FRAME") framesForAnalysis.push(c);
    }
  } else if (scopeNode.type === "FRAME") {
    framesForAnalysis.push(scopeNode);
  } else if (Array.isArray(scopeNode.children)) {
    for (const c of scopeNode.children) {
      if (c.type === "FRAME") framesForAnalysis.push(c);
    }
  }

  framesForAnalysis = framesForAnalysis.slice(0, maxFramesInTree);

  const frameSummaries = framesForAnalysis.map((f) => formatFrameSummary(f));
  const componentVariants = collectComponentVariants(scopeNode);

  let visionText = "";
  let visionUsedFrames = [];
  if (includeVision && framesForAnalysis.length && openrouterApiKey) {
    try {
      const renderTargets = pickRenderableFrames(
        scopeNode.type === "FRAME"
          ? { children: [scopeNode] }
          : scopeNode,
        maxVisionFrames,
      );
      if (renderTargets.length) {
        log.log?.(`🎨 Figma: rendering ${renderTargets.length} frame(s) for vision analysis…`);
        const ids = renderTargets.map((f) => f.id);
        const imageMap = await fetchImages(token, fileKey, ids, 1, log);
        const images = [];
        for (const f of renderTargets) {
          const url = imageMap[f.id];
          if (!url) continue;
          try {
            const base64 = await downloadAsBase64(url);
            images.push({ id: f.id, name: f.name || "(unnamed)", base64 });
            visionUsedFrames.push(f.name || "(unnamed)");
          } catch (e) {
            log.warn?.(`⚠️  Figma: could not download render for ${f.name}: ${e.message}`);
          }
        }
        if (images.length) {
          visionText = await callVisionLLM({
            apiKey: openrouterApiKey,
            model: visionModel,
            images,
            log,
          });
        }
      }
    } catch (err) {
      log.warn?.(`⚠️  Figma vision analysis failed (continuing with structural only): ${err.message}`);
      visionText = "";
    }
  } else if (includeVision && !openrouterApiKey) {
    log.warn?.(`⚠️  ${missingLlmKeyMessage()} — Figma vision step skipped.`);
  }

  const lines = [];
  lines.push("FIGMA DESIGN CONTEXT (linked by the QA author for this ticket)");
  const sourceParts = [];
  if (fileName) sourceParts.push(`file "${fileName}"`);
  sourceParts.push(`scope: ${scopeKind} "${scopeNode.name || "(unnamed)"}"`);
  if (scopeSourceNote) sourceParts.push(scopeSourceNote);
  lines.push(`Source: ${sourceParts.join(" — ")}`);
  lines.push(`URL: ${rawUrl}`);

  lines.push("");
  lines.push("Structural overview (parsed from Figma JSON):");
  if (frameSummaries.length === 0) {
    lines.push("  (no FRAME nodes found in the linked scope)");
  } else {
    for (const s of frameSummaries) lines.push(s.text);
  }

  if (componentVariants.length) {
    lines.push("");
    lines.push("Component variants / states found in the design system area of this scope:");
    for (const cv of componentVariants.slice(0, 10)) {
      lines.push(`  - ${cv.name}: ${cv.variants.slice(0, 12).join(" | ")}`);
    }
  }

  if (visionText) {
    lines.push("");
    lines.push(`Visual analysis (vision LLM looked at ${visionUsedFrames.length} screenshot(s)):`);
    lines.push(visionText);
  }

  lines.push("");
  lines.push("How to use this context:");
  lines.push(
    "  - Treat visible text labels as the EXACT wording for fields, buttons, and messages in test steps.",
  );
  lines.push(
    "  - For every interactive element listed, add at least one happy-path step and at least one negative / boundary step where applicable.",
  );
  lines.push(
    "  - For every component variant (Default/Hover/Disabled/Error/Loading/etc.), cover the state transition that triggers it.",
  );
  lines.push(
    "  - If the visual analysis mentions an empty / error / loading state, include a dedicated test scenario for it.",
  );
  lines.push(
    "  - Do NOT invent UI elements that are neither in the structural overview nor in the visual analysis.",
  );

  const summary = lines.join("\n");

  return {
    summary,
    error: null,
    stats: {
      fileKey,
      fileName: fileName || null,
      scopeKind,
      scopeName: scopeNode.name || null,
      framesAnalyzed: frameSummaries.length,
      visionFrames: visionUsedFrames.length,
      visionModel: visionUsedFrames.length ? visionModel : null,
    },
  };
}

module.exports = {
  parseFigmaUrl,
  isFigmaUrl,
  analyzeFigmaUrl,
};
