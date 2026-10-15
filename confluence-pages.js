/**
 * Confluence pages as requirements context — shared by Create (agent-docs.js) and Update
 * (agent-update-csv.js).
 *
 * Two sources, both behind Setup → Confluence → "Search Confluence":
 *   1. the "Confluence link" field on the Create / Update page (CONFLUENCE_LINKS, set per run by
 *      the Web UI — one or several page links), read first;
 *   2. Confluence links found in the Jira description (ADF link marks, smart links, plain URLs).
 *
 * The host is taken from the link itself, so no Confluence base URL has to be configured: a
 * client is built per origin with the Jira credentials. CONFLUENCE_BASE_URL (env / .env, no
 * longer on the Setup page) still resolves relative links and widens which description links
 * count as Confluence; it defaults to JIRA_BASE_URL.
 */

const { ConfluenceClient } = require("./confluence-client");

const MAX_LINKS = 10;

function getBaseOrigin(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeConfluenceUrl(baseUrl, rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).toString();
    return new URL(s, String(baseUrl || "")).toString();
  } catch {
    return "";
  }
}

function extractUrlsFromAdf(adf) {
  const out = [];
  const seen = new Set();
  const push = (url) => {
    const u = String(url || "").trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node.marks)) {
      for (const m of node.marks) if (m && m.type === "link" && m.attrs && m.attrs.href) push(m.attrs.href);
    }
    if ((node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") && node.attrs && node.attrs.url) {
      push(node.attrs.url);
    }
    if (node.type === "link" && node.attrs && node.attrs.href) push(node.attrs.href);
    if (node.content) walk(node.content);
  };
  walk(adf);
  return out;
}

function extractUrlsFromText(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  return [...new Set(matches.map((m) => m.trim()).filter(Boolean))];
}

function isConfluencePageUrl(url) {
  return /^https?:\/\/[^\s/]+\/wiki\//i.test(String(url || ""));
}

/** Page id from the two long URL shapes Confluence Cloud uses; "" for a short link (/wiki/x/…). */
function pageIdFromUrl(url) {
  const s = String(url || "");
  const m = s.match(/\/pages\/(\d+)(?:\/|$|[?#])/i) || s.match(/[?&]pageId=(\d+)/i);
  return m ? m[1] : "";
}

/**
 * Page id hidden in a short link — "Copy link" / Share in Confluence gives /wiki/x/<tiny id>.
 * The tiny id is the page id as little-endian bytes, base64-encoded with "/" → "-", "+" → "_",
 * and the padding and trailing "A"s (zero bits) cut off. Decoded locally; when the page cannot be
 * read with it, collectConfluencePages() falls back to following the link's redirect.
 */
function pageIdFromTinyLink(url) {
  const m = String(url || "").match(/\/wiki\/x\/([A-Za-z0-9_-]+)/);
  if (!m) return "";
  let b64 = m[1].replace(/-/g, "/").replace(/_/g, "+");
  while (b64.length % 4) b64 += "A";
  const bytes = Buffer.from(b64, "base64").subarray(0, 8);
  let id = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) id = (id << 8n) | BigInt(bytes[i]);
  return id > 0n ? id.toString() : "";
}

function isTinyLink(url) {
  return /\/wiki\/x\/[A-Za-z0-9_-]+/.test(String(url || ""));
}

/** Follow a short link's redirect (authenticated) and read the page id off the long URL. */
async function resolveTinyLinkByRedirect(url, email, token) {
  const fetchFn = globalThis.fetch || require("node-fetch");
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetchFn(current, { method: "GET", redirect: "manual", headers: { Authorization: `Basic ${auth}` } });
    const location = res.headers && res.headers.get ? res.headers.get("location") : "";
    if (!location) return "";
    current = new URL(location, current).toString();
    const id = pageIdFromUrl(current);
    if (id) return id;
  }
  return "";
}

/**
 * The "Confluence link" field → page links. Accepts several links separated by spaces, commas
 * or new lines.
 * @returns {{ links: string[], invalid: string[] }}
 */
function parseConfluenceLinks(raw) {
  const tokens = String(raw || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const links = [];
  const invalid = [];
  for (const t of tokens) {
    if (isConfluencePageUrl(t)) {
      if (!links.includes(t)) links.push(t);
    } else {
      invalid.push(t);
    }
  }
  return { links: links.slice(0, MAX_LINKS), invalid };
}

/** Confluence links in the Jira description, restricted to the known Confluence hosts. */
function linksFromIssue(issueData, baseUrl, extraOrigins = []) {
  const origins = new Set([getBaseOrigin(baseUrl), ...extraOrigins].filter(Boolean));
  const raw = [...extractUrlsFromAdf(issueData && issueData.descriptionAdf), ...extractUrlsFromText(issueData && issueData.description)];
  const out = [];
  for (const r of raw) {
    const abs = normalizeConfluenceUrl(baseUrl, r);
    if (!abs || !isConfluencePageUrl(abs)) continue;
    if (origins.size && !origins.has(getBaseOrigin(abs))) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Confluence storage HTML → readable text for a prompt. */
function confluenceBodyToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&[lr]squo;/g, "'")
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Read the pages: the field's links first, then the description's, de-duplicated by page id.
 * Never throws — an unreadable page costs a warning.
 *
 * @param {Object} o
 * @param {Object} [o.issueData] - from JiraClient.extractIssueData (description + descriptionAdf)
 * @param {string[]} [o.extraLinks] - the "Confluence link" field (CONFLUENCE_LINKS)
 * @param {string} [o.baseUrl] - CONFLUENCE_BASE_URL || JIRA_BASE_URL
 * @param {string} o.email
 * @param {string} o.token
 * @param {Console} [o.log]
 * @returns {Promise<{ pages: Array<Object>, fromField: number, fromIssue: number, tried: number }>}
 */
async function collectConfluencePages({ issueData, extraLinks = [], baseUrl = "", email, token, log = console }) {
  const field = extraLinks.filter(isConfluencePageUrl);
  const fieldOrigins = field.map(getBaseOrigin);
  const fromDescription = linksFromIssue(issueData, baseUrl, fieldOrigins);
  const ordered = [...field.map((u) => ({ url: u, source: "field" })), ...fromDescription.map((u) => ({ url: u, source: "issue" }))];

  const clients = new Map();
  const clientFor = (url) => {
    const origin = getBaseOrigin(url);
    if (!clients.has(origin)) clients.set(origin, new ConfluenceClient(origin, email, token));
    return clients.get(origin);
  };

  const pages = [];
  const seenIds = new Set();
  let fromField = 0;
  let fromIssue = 0;
  for (const { url, source } of ordered.slice(0, MAX_LINKS * 2)) {
    const tiny = !pageIdFromUrl(url) && isTinyLink(url);
    let pageId = pageIdFromUrl(url) || pageIdFromTinyLink(url);
    if (!pageId) {
      log.warn(`   ⚠️  Skipping Confluence link (no page id in it): ${url}`);
      continue;
    }
    const key = `${getBaseOrigin(url)}#${pageId}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    try {
      const client = clientFor(url);
      let page;
      try {
        page = await client.getPageContent(pageId);
      } catch (firstError) {
        // A short link decoded to the wrong id (or a format change on Atlassian's side): ask
        // Confluence where the link points instead of guessing.
        if (!tiny) throw firstError;
        const resolved = await resolveTinyLinkByRedirect(url, email, token).catch(() => "");
        if (!resolved || resolved === pageId) throw firstError;
        pageId = resolved;
        seenIds.add(`${getBaseOrigin(url)}#${pageId}`);
        page = await client.getPageContent(pageId);
      }
      const data = client.extractPageData(page);
      data.url = url;
      data.source = source;
      pages.push(data);
      if (source === "field") fromField += 1;
      else fromIssue += 1;
    } catch (e) {
      log.warn(`   ⚠️  Could not read Confluence page ${pageId}: ${e.message}`);
    }
  }
  return { pages, fromField, fromIssue, tried: ordered.length };
}

/**
 * Pages → one text block for prompts that have no structured Confluence slot (the Update flow,
 * every Regenerate). The Create prompts keep receiving the page objects as before.
 */
function confluencePagesToText(pages, { maxPerPage = 8000, maxTotal = 24000 } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return "";
  const parts = [];
  let total = 0;
  for (const p of list) {
    let body = confluenceBodyToText(p.body);
    if (body.length > maxPerPage) body = `${body.slice(0, maxPerPage)} …(cut)`;
    const entry = `--- ${p.title || "(untitled)"}${p.space ? ` [${p.space}]` : ""}${p.url ? ` — ${p.url}` : ""}\n${body}`;
    if (parts.length && total + entry.length > maxTotal) break;
    parts.push(entry);
    total += entry.length;
  }
  return `CONFLUENCE PAGES (requirements documentation linked to this ticket):\n${parts.join("\n\n")}`;
}

module.exports = {
  collectConfluencePages,
  confluencePagesToText,
  confluenceBodyToText,
  parseConfluenceLinks,
  linksFromIssue,
  pageIdFromUrl,
  pageIdFromTinyLink,
  isConfluencePageUrl,
  getBaseOrigin,
  MAX_LINKS,
};
