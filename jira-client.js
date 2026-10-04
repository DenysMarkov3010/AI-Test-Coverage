const fs = require("fs");
const path = require("path");
const fetch = globalThis.fetch || require("node-fetch");

class JiraClient {
  constructor(baseUrl, email, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  static adfToText(adf) {
    if (!adf) return "";
    if (typeof adf === "string") return adf;
    if (typeof adf !== "object") return "";

    // Atlassian Document Format (ADF) -> plain text
    // https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
    const parts = [];

    const walk = (node) => {
      if (!node) return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      if (typeof node === "string") {
        parts.push(node);
        return;
      }

      if (typeof node !== "object") return;

      if (node.type === "text" && typeof node.text === "string") {
        parts.push(node.text);
      }

      if (node.type === "hardBreak") {
        parts.push("\n");
      }

      if (node.type === "codeBlock" && node.content) {
        if (parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) parts.push("\n");
        for (const c of node.content) {
          if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
        parts.push("\n");
      }

      if (node.type === "table" && node.content) {
        if (parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) parts.push("\n");
        walk(node.content);
      }
      if (node.type === "tableRow" && node.content) {
        const getCellText = (cell) => {
          const out = [];
          const w = (n) => {
            if (!n) return;
            if (Array.isArray(n)) { n.forEach(w); return; }
            if (typeof n === "object" && n.type === "text" && typeof n.text === "string") out.push(n.text);
            if (n && n.content) w(n.content);
          };
          w(cell);
          return out.join("").trim();
        };
        const rowParts = node.content.map((cell) => getCellText(cell));
        parts.push(rowParts.join("\t"));
        parts.push("\n");
        return;
      }
      if (node.type === "tableHeader" || node.type === "tableCell") {
        if (node.content) walk(node.content);
        return;
      }

      // Block separators (paragraph, heading, listItem, etc.)
      if (
        node.type === "paragraph" ||
        node.type === "heading" ||
        node.type === "listItem" ||
        node.type === "blockquote"
      ) {
        if (parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
          parts.push("\n");
        }
      }

      if (node.content) walk(node.content);
    };

    walk(adf);

    return parts
      .join("")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  static textToAdf(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    const paragraphs = normalized.length ? normalized.split(/\n{1,2}/) : [""];

    const content = paragraphs
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => ({
        type: "paragraph",
        content: [{ type: "text", text: p }],
      }));

    return {
      type: "doc",
      version: 1,
      content: content.length
        ? content
        : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
    };
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Basic ${this.auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    return response.json();
  }

  async getIssue(issueKey) {
    return this.request(`/rest/api/3/issue/${issueKey}`, {
      method: "GET",
    });
  }

  async getIssueWithExpand(issueKey, expand = "names,schema,transitions") {
    return this.request(`/rest/api/3/issue/${issueKey}?expand=${encodeURIComponent(expand)}`, {
      method: "GET",
    });
  }

  /**
   * Get the issue key of the "Test design" QA Sub-task for a parent issue.
   * Used to ensure CSV (attachment + comment) is always posted to the Test design subtask.
   * @param {string} parentIssueKey - Parent issue key
   * @param {string} projectKey - Project key (for JQL)
   * @returns {Promise<string|null>} Subtask key or null if not found
   */
  async getTestDesignSubtaskKey(parentIssueKey, projectKey = "PROJ") {
    const jql = `project = ${projectKey} AND parent = ${parentIssueKey} AND issuetype = "QA Sub-task" AND summary ~ "Test design" ORDER BY updated DESC`;
    const res = await this.searchIssues(jql, ["key"], 1);
    const issues = res.issues || [];
    return issues.length > 0 ? issues[0].key : null;
  }

  async searchIssues(jql, fields = ["key", "summary", "status", "labels", "description"], maxResults = 50) {
    // Jira Cloud is deprecating/removing some v2 search endpoints; prefer v3.
    // Use /rest/api/3/search/jql when available; fallback to /rest/api/3/search.
    const fieldsParam = fields.join(",");

    try {
      return await this.request(`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({
          jql,
          fields,
          maxResults,
        }),
      });
    } catch (err) {
      const msg = String(err?.message || "");
      // Fallback for instances without /search/jql
      if (msg.includes("404") || msg.includes("Not Found") || msg.includes("405")) {
        return this.request(
          `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(
            fieldsParam
          )}&maxResults=${encodeURIComponent(maxResults)}`,
          { method: "GET" }
        );
      }
      throw err;
    }
  }

  async addComment(issueKey, comment) {
    return this.request(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: JiraClient.textToAdf(comment),
      }),
    });
  }

  /**
   * Add a comment with raw ADF body (e.g. for tables and code blocks).
   * @param {string} issueKey - Issue key
   * @param {object} adfBody - Full ADF document: { type: "doc", version: 1, content: [...] }
   */
  async addCommentAdf(issueKey, adfBody) {
    return this.request(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adfBody }),
    });
  }

  /**
   * Build ADF paragraph node.
   */
  static buildAdfParagraph(text) {
    return {
      type: "paragraph",
      content: [{ type: "text", text: String(text || "") }],
    };
  }

  /**
   * Build ADF table node. rows = array of arrays of cell strings (first row = header).
   */
  static buildAdfTable(rows) {
    if (!rows || rows.length === 0) return null;
    const cell = (t) => ({
      type: "tableCell",
      content: [{ type: "paragraph", content: [{ type: "text", text: String(t) }] }],
    });
    const headerCell = (t) => ({
      type: "tableHeader",
      content: [{ type: "paragraph", content: [{ type: "text", text: String(t) }] }],
    });
    const buildRow = (arr, isHeader) => ({
      type: "tableRow",
      content: arr.map((s) => (isHeader ? headerCell(s) : cell(s))),
    });
    const content = rows.map((row, i) => buildRow(row, i === 0));
    return { type: "table", content };
  }

  /**
   * Build ADF codeBlock node.
   */
  static buildAdfCodeBlock(text, language = "json") {
    return {
      type: "codeBlock",
      attrs: { language },
      content: [{ type: "text", text: String(text || "") }],
    };
  }

  /**
   * Build ADF heading node (level 1-6).
   */
  static buildAdfHeading(text, level = 3) {
    return {
      type: "heading",
      attrs: { level: Math.min(6, Math.max(1, level)) },
      content: [{ type: "text", text: String(text || "") }],
    };
  }

  /**
   * Add a comment that contains a link to an attachment (file). Renders in Jira as a file link in the comment.
   * Use after addAttachment: pass the attachment URL (from response[].content or built from id+filename).
   * @param {string} issueKey - Issue key
   * @param {string} title - Short title (e.g. "Approved checklist (CSV)")
   * @param {string} attachmentUrl - URL to the attachment (e.g. from attachment.content or secure/attachment/id/filename)
   * @param {string} fileName - Display name for the link (e.g. "approved-checklist-PROJ-99.csv")
   */
  async addCommentWithFileLink(issueKey, title, attachmentUrl, fileName) {
    const safeTitle = String(title || "Approved checklist (CSV)").trim();
    const safeFileName = String(fileName || "attachment.csv").trim();
    const href = String(attachmentUrl || "").trim();
    if (!href) {
      throw new Error("attachmentUrl is required for addCommentWithFileLink");
    }
    const body = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "📄 " + safeTitle + " " },
            {
              type: "text",
              text: safeFileName,
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ],
    };
    return this.request(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async getComments(issueKey) {
    // Get comments via dedicated endpoint (API v3). Body is ADF.
    const res = await this.request(`/rest/api/3/issue/${issueKey}/comment?maxResults=100`, {
      method: "GET",
    });
    const comments = res.comments || [];
    return comments.map((c) => ({
      ...c,
      bodyText: JiraClient.adfToText(c.body),
    }));
  }

  async updateIssue(issueKey, updateFields) {
    return this.request(`/rest/api/3/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: updateFields,
      }),
    });
  }

  /**
   * Add an attachment to an issue.
   * @param {string} issueKey - Issue key (e.g. PROJ-99)
   * @param {string} filePath - Absolute or relative path to the file to upload
   * @returns {Promise<Array>} Attachment metadata from Jira
   */
  async addAttachment(issueKey, filePath) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const fileName = path.basename(absolutePath);
    const fileBuffer = fs.readFileSync(absolutePath);
    const contentType = fileName.toLowerCase().endsWith(".json") ? "application/json" : "text/csv";
    const boundary = "----JiraAttachment" + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, "utf8"),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`, "utf8"),
      Buffer.from(`Content-Type: ${contentType}\r\n\r\n`, "utf8"),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${this.auth}`,
        "X-Atlassian-Token": "no-check",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira attachments API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get list of attachments for an issue.
   * @param {string} issueKey - Issue key
   * @returns {Promise<Array>} Array of attachment objects (id, filename, content URL, ...)
   */
  async getAttachments(issueKey) {
    const issue = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`, { method: "GET" });
    return issue.fields?.attachment || [];
  }

  /**
   * Fetch attachment content by URL (from attachment.content).
   * @param {string} contentUrl - Full URL or path (e.g. /rest/api/3/attachment/content/123)
   * @returns {Promise<string>} Response text
   */
  async getAttachmentContent(contentUrl) {
    const url = contentUrl.startsWith("http") ? contentUrl : `${this.baseUrl}${contentUrl.startsWith("/") ? "" : "/"}${contentUrl}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!response.ok) {
      const t = await response.text();
      throw new Error(`Jira attachment content error: ${response.status} ${response.statusText}. ${t}`);
    }
    return response.text();
  }

  async addLabel(issueKey, label) {
    const issue = await this.getIssue(issueKey);
    const currentLabels = issue.fields.labels || [];
    if (currentLabels.includes(label)) {
      return issue; // Label already exists
    }
    
    return this.updateIssue(issueKey, {
      labels: [{ add: label }],
    });
  }

  extractIssueData(issue) {
    const descriptionText = JiraClient.adfToText(issue.fields?.description);
    return {
      key: issue.key,
      issueType: issue.fields?.issuetype?.name || null,
      status: issue.fields?.status?.name || null,
      summary: issue.fields?.summary || null,
      description: descriptionText || null,
      descriptionAdf: issue.fields?.description || null,
      labels: issue.fields?.labels || [],
      assignee: issue.fields?.assignee?.displayName || null,
      reporter: issue.fields?.reporter?.displayName || null,
      created: issue.fields?.created || null,
      updated: issue.fields?.updated || null,
      // NOTE: Use getComments() for up-to-date comments; issue.fields.comment may be paginated.
      comments: (issue.fields?.comment?.comments || []).map((c) => ({
        ...c,
        bodyText: JiraClient.adfToText(c.body),
      })),
      issueLinks: issue.fields?.issuelinks || [],
    };
  }
}

/**
 * Does this issue only exist to hold a test design, making its PARENT the thing to analyse?
 *
 * Matched on a "test design" summary prefix rather than an exact title, because the same story
 * carries several of them — "Test design" and "Test design by AI" are both QA Sub-tasks of the
 * same Story, both are a request to design tests for that Story, and both have an empty
 * description of their own. An exact-title rule would send the second one into the generator
 * with nothing to read.
 *
 * @param {object} issue full issue as returned by getIssueWithExpand()
 * @returns {boolean}
 */
function isTestDesignSubtask(issue) {
  const type = issue && issue.fields ? issue.fields.issuetype : null;
  if (!type || type.subtask !== true) return false;
  const summary = String((issue.fields && issue.fields.summary) || "")
    .trim()
    .toLowerCase();
  return summary.startsWith("test design");
}

/**
 * The requirement issue a run should read, given the issue it was triggered on.
 *
 * The key that was typed IS the ticket to analyse. One exception: a "Test design" sub-task is
 * not a requirement, it is a request to write one for its parent, and it carries no description
 * of its own — so that, and only that, climbs.
 *
 * Anything looser breaks in a way that is easy to miss. `fields.parent` on its own does not mean
 * "I am a sub-task": modern Jira puts a Story's Epic in `fields.parent` too, so hopping whenever
 * a parent exists reads the Epic instead of the Story — the test design gets generated from the
 * wrong ticket, the Epic's key lands in the CSV file name and from there in the TestRail `refs`
 * and the section match, and Confluence links that live in the Story's description are never
 * seen. Climbing out of every sub-task is wrong for the same reason in reverse: a `[BE]` or
 * `[FE]` sub-task is a requirement in its own right and must be analysed as typed.
 *
 * @param {object} issue full issue as returned by getIssueWithExpand()
 * @param {string} issueKey the key the run was triggered on — returned when there is no hop
 * @returns {string}
 */
function contextIssueKeyFor(issue, issueKey) {
  if (!isTestDesignSubtask(issue)) return issueKey;
  const parentKey = issue.fields.parent ? issue.fields.parent.key : "";
  return parentKey || issueKey;
}

module.exports = { JiraClient, contextIssueKeyFor, isTestDesignSubtask };
