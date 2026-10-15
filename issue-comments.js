/**
 * Comments of the analysed Jira issue, as requirements context for generation.
 *
 * A ticket's description is rarely the last word: decisions ("the limit is 64, not 50"), removed
 * scope and reproduction details for a bug land in the comments. This module turns them into one
 * text block for the prompt — the same contract as figma-client / attachment-analyzer: gathered
 * once per run, stored in the review session's promptContext, reused by Regenerate.
 *
 * What is left out:
 *   - the agent's own comments (generated checklists / test cases, "Updated CSV flow" summaries,
 *     "Approved … (CSV)" links, validation errors) — the agent posts with the user's own Jira
 *     account, so they are recognised by their markers, not by author;
 *   - approval comments ("APPROVED: 1,2,3") — workflow, not requirements;
 *   - comments by apps / bots, and empty ones.
 *
 * What is changed:
 *   - authors become "Commenter 1", "Commenter 2"… — who said it matters less than the order, and
 *     names have no business in a prompt;
 *   - obvious personal-data values (SSN, e-mail, labelled MRN / DOB / insurance or member ids) are
 *     masked before anything leaves the machine. A heuristic, not a guarantee: the run log says how
 *     many values were masked so the QA engineer can check the ticket.
 *
 * Settings (env / .env only — deliberately not on the Web UI):
 *   ENABLE_ISSUE_COMMENTS        default true; "false" turns the whole thing off
 *   ISSUE_COMMENTS_MAX           newest N comments kept, default 30
 *   ISSUE_COMMENTS_MAX_CHARS     total budget for the block, default 15000 (newest win)
 */

const MAX_PER_COMMENT_CHARS = 3000;

/** Text the agent itself writes into comments. Any of these means "ours, skip it". */
const AGENT_MARKERS = [
  /AI-Generated (Test|BDD)/i,
  /^\s*Updated CSV flow: source file/i,
  /\(Updated CSV flow\)/i,
  /^\s*Approved (updated )?(checklist|test cases|test design)\b.*\(CSV\)/i,
  /^\s*⚠️?\s*Validation Error\b/i,
  /Replying to this comment approves nothing/i,
];

function issueCommentsEnabled(env = process.env) {
  return String(env.ENABLE_ISSUE_COMMENTS || "true").trim().toLowerCase() !== "false";
}

function intSetting(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function firstLine(text) {
  return (
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || ""
  );
}

function isAgentComment(text) {
  const t = String(text || "");
  return AGENT_MARKERS.some((re) => re.test(t));
}

/** "APPROVED", "APPROVED: all", "APPROVED: 1,2,5" as the first line — the approval workflow. */
function isApprovalComment(text) {
  return /^approved\b\s*(:|[.!]*\s*$)/i.test(firstLine(text));
}

function isBotAuthor(author) {
  const type = String((author && author.accountType) || "").toLowerCase();
  return type === "app" || type === "bot";
}

/**
 * Mask values that look like personal data. Only labelled or unambiguous shapes are touched, so a
 * requirement such as "allow 8-64 characters" or "1000-2000 USD" survives untouched.
 * @returns {{ text: string, masked: number }}
 */
function maskPersonalData(text) {
  let masked = 0;
  const hit = (replacement) => () => {
    masked += 1;
    return replacement;
  };
  let t = String(text || "");
  // e-mail
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, hit("(e-mail removed)"));
  // US SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, hit("(SSN removed)"));
  // Labelled identifiers: MRN, patient / member / policy / insurance / subscriber id
  t = t.replace(
    /\b(MRN|medical record (?:number|no\.?|#)|patient id|member id|policy (?:number|no\.?|#|id)|insurance (?:number|no\.?|#|id)|subscriber id)\s*[:#=]?\s*[A-Za-z0-9-]{3,}/gi,
    (m, label) => {
      masked += 1;
      return `${label}: (value removed)`;
    }
  );
  // Labelled dates of birth
  t = t.replace(
    /\b(DOB|D\.O\.B\.?|date of birth|birth ?date)\s*[:=]?\s*(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3,9}\.? \d{4})/gi,
    (m, label) => {
      masked += 1;
      return `${label}: (value removed)`;
    }
  );
  return { text: t, masked };
}

function isoDate(value) {
  const d = new Date(value || 0);
  return Number.isFinite(d.getTime()) && d.getTime() > 0 ? d.toISOString().slice(0, 10) : "unknown date";
}

/**
 * Pure part: Jira comments (as returned by JiraClient.getComments) → prompt block + stats.
 * @param {Array<{ bodyText?: string, created?: string, author?: Object }>} comments
 * @param {{ max?: number, maxChars?: number }} [options]
 * @returns {{ text: string, stats: { total: number, used: number, skippedAgent: number, skippedApproval: number, skippedBot: number, skippedEmpty: number, truncated: number, masked: number } }}
 */
function buildIssueCommentsContext(comments, options = {}) {
  const max = intSetting(options.max ?? process.env.ISSUE_COMMENTS_MAX, 30);
  const maxChars = intSetting(options.maxChars ?? process.env.ISSUE_COMMENTS_MAX_CHARS, 15000);
  const stats = {
    total: 0,
    used: 0,
    skippedAgent: 0,
    skippedApproval: 0,
    skippedBot: 0,
    skippedEmpty: 0,
    truncated: 0,
    masked: 0,
  };
  const list = Array.isArray(comments) ? comments : [];
  stats.total = list.length;

  const kept = [];
  for (const c of list) {
    const body = String((c && (c.bodyText ?? c.body)) || "").trim();
    if (typeof (c && c.body) === "object" && !c.bodyText) {
      // ADF without a text rendering — nothing we can read safely.
      stats.skippedEmpty += 1;
      continue;
    }
    if (!body) {
      stats.skippedEmpty += 1;
      continue;
    }
    if (isBotAuthor(c.author)) {
      stats.skippedBot += 1;
      continue;
    }
    if (isAgentComment(body)) {
      stats.skippedAgent += 1;
      continue;
    }
    if (isApprovalComment(body)) {
      stats.skippedApproval += 1;
      continue;
    }
    kept.push({ comment: c, body });
  }

  kept.sort((a, b) => new Date(a.comment.created || 0) - new Date(b.comment.created || 0));

  // Authors numbered in order of first appearance across ALL kept comments, so the label of a
  // person is stable even when older comments fall outside the budget below.
  const authorLabel = new Map();
  for (const k of kept) {
    const a = k.comment.author || {};
    const id = a.accountId || a.emailAddress || a.displayName || "unknown";
    if (!authorLabel.has(id)) authorLabel.set(id, `Commenter ${authorLabel.size + 1}`);
    k.author = authorLabel.get(id);
  }

  // Newest first into the budget, then printed oldest first: the latest decisions are the ones
  // that must not be dropped.
  let recent = kept.slice(-max);
  stats.truncated += kept.length - recent.length;
  const chosen = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const k = recent[i];
    const { text, masked } = maskPersonalData(k.body);
    const clipped = text.length > MAX_PER_COMMENT_CHARS ? `${text.slice(0, MAX_PER_COMMENT_CHARS)} …(cut)` : text;
    const entry = `--- ${isoDate(k.comment.created)}, ${k.author}:\n${clipped}`;
    if (chosen.length && used + entry.length > maxChars) {
      stats.truncated += i + 1;
      break;
    }
    chosen.unshift(entry);
    used += entry.length;
    stats.masked += masked;
  }
  stats.used = chosen.length;

  if (!chosen.length) return { text: "", stats };

  const text = `COMMENTS ON THE ISSUE (discussion under the ticket, oldest first; authors anonymised${
    stats.truncated ? `; ${stats.truncated} older comment(s) left out` : ""
  }):
${chosen.join("\n\n")}`;
  return { text, stats };
}

/**
 * Fetch + build. Never throws: a failed fetch costs a warning, never the run.
 * @param {Object} jiraClient - JiraClient
 * @param {string} issueKey - the issue whose requirements are analysed (the context issue)
 * @param {{ log?: Console }} [options]
 * @returns {Promise<{ text: string, stats: Object|null, error: string }>}
 */
async function loadIssueComments(jiraClient, issueKey, options = {}) {
  const log = options.log || console;
  if (!issueCommentsEnabled()) return { text: "", stats: null, error: "" };
  if (!jiraClient || !issueKey) return { text: "", stats: null, error: "" };
  let comments;
  try {
    comments = await jiraClient.getComments(issueKey);
  } catch (err) {
    const error = `could not read comments of ${issueKey}: ${err.message}`;
    log.warn(`⚠️  Issue comments: ${error}`);
    return { text: "", stats: null, error };
  }
  const { text, stats } = buildIssueCommentsContext(comments, options);
  const skipped = stats.skippedAgent + stats.skippedApproval + stats.skippedBot + stats.skippedEmpty;
  if (stats.used) {
    log.log(
      `💬 Issue comments: ${stats.used} of ${stats.total} used${
        skipped ? ` (${skipped} skipped: agent / approval / bot / empty)` : ""
      }${stats.truncated ? `, ${stats.truncated} older left out` : ""}.`
    );
  } else if (stats.total) {
    log.log(`💬 Issue comments: none usable (${stats.total} skipped: agent / approval / bot / empty).`);
  }
  if (stats.masked) {
    log.warn(
      `⚠️  Masked ${stats.masked} value(s) in ${issueKey} comments that look like personal data (e-mail, SSN, MRN, DOB, insurance id). Check the ticket — real patient data should not be there.`
    );
  }
  return { text, stats, error: "" };
}

module.exports = {
  loadIssueComments,
  buildIssueCommentsContext,
  maskPersonalData,
  isAgentComment,
  isApprovalComment,
  issueCommentsEnabled,
};
