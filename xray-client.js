/**
 * Xray Cloud API client — authentication, GraphQL, the Test Repository folder tree, and creating
 * a Manual test.
 *
 * Four things about this API shape the whole file, and each one differs from the other three
 * providers:
 *
 *  1. **A Test is a Jira issue.** Unlike Zephyr Essential (which stores its own cases) or
 *     TestRail (which is a separate product), an Xray test *is* an issue of type Test in the Jira
 *     project, and its steps live in Xray beside it. So the project here is a Jira project key,
 *     the created case comes back with a Jira key, and the thing that links it to the story is a
 *     Jira issue link — not a field on a foreign object.
 *  2. **Two credentials, and neither is the Jira one.** Xray issues its own API key pair —
 *     Client ID + Client Secret, from Jira → Apps → Xray → API Keys. They buy a bearer token from
 *     `POST /api/v1/authenticate`, which is good for 24 hours; every other call carries it.
 *     The response of that call is a JSON *string* — a quoted token, not an object — which is
 *     unusual enough that parsing it wrongly is the first thing to get wrong.
 *  3. **Everything else is GraphQL**, at `/api/v2/graphql`. One endpoint, one POST shape, and
 *     errors arrive as HTTP 200 with an `errors` array — so a client that only checks the status
 *     reports success on a failed write.
 *  4. **The region is part of the host.** Xray Cloud runs `xray.cloud.getxray.app` plus regional
 *     twins (`us.`, `eu.`, `au.`). A tenant in one region cannot be reached at another's host, so
 *     the base URL is a setting rather than a constant.
 */
const fetch = globalThis.fetch || require("node-fetch");

/** The global host. Tenants pinned to a region use us./eu./au. — see the Setup card. */
const DEFAULT_BASE_URL = "https://xray.cloud.getxray.app";

const DEFAULT_TIMEOUT_MS = 30000;
/** A token is good for 24h; renewing a minute early costs nothing and avoids a race at the edge. */
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const MAX_RETRIES = 2;
/** A folder tree deeper than this is a loop, not a tree. */
const MAX_FOLDER_DEPTH = 10;

class XrayError extends Error {
  /**
   * @param {string} message already human-readable — safe to show in the UI
   * @param {number} [status] HTTP status, when the failure came from a response
   */
  constructor(message, status) {
    super(message);
    this.name = "XrayError";
    this.status = status;
  }
}

/** `https://us.xray.cloud.getxray.app/` → the same without the slash. Accepts a bare host. */
function normalizeBaseUrl(raw) {
  let base = String(raw || "").trim();
  if (!base) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, "");
}

/**
 * The authenticate endpoint answers with the token as a bare JSON string — `"eyJhbGciOi…"`,
 * quotes included. Some proxies hand it back without them, so both shapes are accepted and the
 * quotes are stripped either way.
 */
function parseTokenBody(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {
    /* not JSON — fall through to the unquoted form */
  }
  return raw.replace(/^"|"$/g, "").trim();
}

/** GraphQL reports failures inside a 200; this is the sentence to show for them. */
function graphqlErrorMessage(body) {
  const errors = (body && body.errors) || [];
  const first = errors[0] || {};
  const message = String(first.message || "").trim();
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return message ? `${message}${more}` : "Xray rejected the request";
}

class XrayClient {
  /**
   * @param {{ baseUrl?: string, clientId: string, clientSecret: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, clientId, clientSecret, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.clientId = String(clientId || "").trim();
    this.clientSecret = String(clientSecret || "").trim();
    this.timeoutMs = timeoutMs;
    this.token = "";
    this.tokenAt = 0;
  }

  /**
   * The bearer token, bought once and reused until it is nearly stale.
   *
   * A wrong key pair answers 401 here rather than on the first real call, which is what makes
   * this worth doing eagerly: the Setup page's Test connection can then say "keys rejected"
   * instead of quoting a GraphQL error about a query nobody typed.
   */
  async authenticate(force = false) {
    if (!force && this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    if (!this.clientId || !this.clientSecret) {
      throw new XrayError("Xray Client ID and Client Secret are required");
    }

    const url = `${this.baseUrl}/api/v1/authenticate`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new XrayError(
        e && e.name === "TimeoutError" ? `Xray did not answer in ${this.timeoutMs / 1000}s` : `Cannot reach ${url}: ${e.message}`
      );
    }

    const text = await res.text();
    if (res.status === 401) throw new XrayError("Xray rejected the API key pair (401)", 401);
    if (!res.ok) throw new XrayError(`Xray authentication failed: HTTP ${res.status} ${res.statusText}`, res.status);

    const token = parseTokenBody(text);
    if (!token) throw new XrayError("Xray accepted the keys but returned no token");
    this.token = token;
    this.tokenAt = Date.now();
    return token;
  }

  /**
   * One GraphQL round trip.
   *
   * Retries once on an expired token — a run that spans a day boundary would otherwise fail on
   * the call that happened to cross it — and on the transient statuses, which for this API are
   * mostly the rate limiter.
   *
   * @param {string} query
   * @param {Object} [variables]
   * @returns {Promise<Object>} the `data` object
   */
  async graphql(query, variables = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const token = await this.authenticate(attempt > 0 && lastError && lastError.status === 401);
      let res;
      try {
        res = await fetch(`${this.baseUrl}/api/v2/graphql`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = new XrayError(
          e && e.name === "TimeoutError" ? `Xray did not answer in ${this.timeoutMs / 1000}s` : `Cannot reach Xray: ${e.message}`
        );
        if (attempt === MAX_RETRIES) throw lastError;
        continue;
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* an HTML error page, handled below */
      }

      if (res.status === 401) {
        lastError = new XrayError("Xray token was rejected (401)", 401);
        // The token is stale rather than wrong: drop it and let the next attempt buy a new one.
        this.token = "";
        if (attempt === MAX_RETRIES) throw lastError;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new XrayError(`Xray is unavailable: HTTP ${res.status} ${res.statusText}`, res.status);
        if (attempt === MAX_RETRIES) throw lastError;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new XrayError(
          `Xray error: HTTP ${res.status} ${res.statusText}${body ? ` — ${graphqlErrorMessage(body)}` : ""}`,
          res.status
        );
      }
      // The 200 that is not a success: GraphQL puts the failure in the body.
      if (!body || body.errors) throw new XrayError(graphqlErrorMessage(body));
      return body.data || {};
    }
    throw lastError || new XrayError("Xray call failed");
  }

  /**
   * The Test Repository folder tree of one project, flattened to `{ path, name, testsCount }`.
   *
   * `getFolder` answers with the folder at `path` plus its children, and the children arrive as a
   * nested JSON structure rather than a list — so the tree is walked here once and handed to the
   * caller flat, which is the shape a picker and a name match both want.
   *
   * @param {string|number} projectId the **Jira numeric project id**, not the key
   * @returns {Promise<Array<{ path: string, name: string, testsCount: number }>>}
   */
  async listFolders(projectId) {
    const data = await this.graphql(
      `query folders($projectId: String, $path: String!) {
         getFolder(projectId: $projectId, path: $path) {
           name
           path
           testsCount
           folders
         }
       }`,
      { projectId: String(projectId), path: "/" }
    );
    const root = (data && data.getFolder) || null;
    if (!root) return [];

    const out = [];
    // `folders` is free-form JSON: an array of folder objects on some tenants, an object keyed by
    // name on others. Both are walked, and anything else is ignored rather than guessed at.
    const walk = (node, depth) => {
      if (!node || depth > MAX_FOLDER_DEPTH) return;
      const children = node.folders;
      const list = Array.isArray(children)
        ? children
        : children && typeof children === "object"
          ? Object.values(children)
          : [];
      for (const child of list) {
        if (!child || typeof child !== "object") continue;
        const path = String(child.path || "").trim();
        if (!path) continue;
        out.push({
          path,
          name: String(child.name || path.split("/").filter(Boolean).pop() || path),
          testsCount: Number(child.testsCount || 0),
        });
        walk(child, depth + 1);
      }
    };
    walk(root, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /**
   * Tests filed directly in one Test Repository folder, steps and Gherkin included, so the
   * generation-context picker needs no second call per test. Paged 100 at a time — Xray's cap.
   *
   * @param {string|number} projectId the **Jira numeric project id**, not the key
   * @param {string} folderPath e.g. "/Checkout"; "/" is the repository root
   * @param {{ maxTests?: number }} [options]
   * @returns {Promise<Array<{ issueId: string, key: string, summary: string, testType: string,
   *   steps: Array<{ action: string, data: string, result: string }>, gherkin: string,
   *   labels: string[], priority: string, unstructured: string,
   *   preconditions: Array<{ key: string, summary: string, definition: string }> }>>}
   */
  async listTestsInFolder(projectId, folderPath, options = {}) {
    const PAGE = 100;
    const maxTests = Math.max(1, options.maxTests || 1000);
    const out = [];
    for (let start = 0; start < maxTests; start += PAGE) {
      const data = await this.graphql(
        `query tests($projectId: String, $path: String!, $limit: Int!, $start: Int) {
           getTests(projectId: $projectId, folder: { path: $path, includeDescendants: false }, limit: $limit, start: $start) {
             total
             results {
               issueId
               testType { name }
               steps { action data result }
               gherkin
               unstructured
               preconditions(limit: 10) {
                 results {
                   definition
                   jira(fields: ["key", "summary"])
                 }
               }
               jira(fields: ["key", "summary", "labels", "priority"])
             }
           }
         }`,
        { projectId: String(projectId), path: String(folderPath || "/") || "/", limit: PAGE, start }
      );
      const page = (data && data.getTests) || {};
      const results = Array.isArray(page.results) ? page.results : [];
      for (const t of results) {
        const jira = t.jira || {};
        out.push({
          issueId: String(t.issueId || ""),
          key: String(jira.key || jira.Key || t.issueId || ""),
          summary: String(jira.summary || jira.Summary || ""),
          testType: String((t.testType && t.testType.name) || ""),
          steps: (t.steps || []).map((s) => ({
            action: String(s.action || ""),
            data: String(s.data || ""),
            result: String(s.result || ""),
          })),
          gherkin: String(t.gherkin || ""),
          labels: Array.isArray(jira.labels) ? jira.labels.map(String) : [],
          priority: String((jira.priority && jira.priority.name) || ""),
          // What a test written by hand carries and ours never do: a Generic test's free text, and
          // Precondition issues linked to it (Xray keeps a precondition as its own issue type).
          unstructured: String(t.unstructured || ""),
          preconditions: ((t.preconditions && t.preconditions.results) || []).map((p) => {
            const pj = p.jira || {};
            return {
              key: String(pj.key || ""),
              summary: String(pj.summary || ""),
              definition: String(p.definition || ""),
            };
          }),
        });
      }
      const total = Number(page.total || 0);
      if (results.length < PAGE || out.length >= total) break;
    }
    return out;
  }

  /**
   * Create one Test Repository folder, and return its path.
   *
   * `createTest` takes a `folderPath` but is not documented to create one that does not exist, and
   * a test that quietly lands at the root instead of the folder its ticket asked for is the kind
   * of miss nobody notices until the repository is full of them. So the folder is made first and
   * explicitly, the way the Zephyr importer creates its folder before filing cases in it.
   *
   * Creating a folder that already exists is not treated as failure by the caller — the match
   * runs first, so this is only reached when the tree really had nothing.
   *
   * @param {string|number} projectId the **Jira numeric project id**, not the key
   * @param {string} folderPath absolute path from the repository root, e.g. "/PROJ-123 Story"
   * @returns {Promise<{ path: string, name: string, warnings: string[] }>}
   */
  async createFolder(projectId, folderPath) {
    const path = String(folderPath || "").trim();
    if (!path || path === "/") throw new XrayError("A folder path is required, and it cannot be the root");

    const data = await this.graphql(
      `mutation createFolder($projectId: String, $path: String!) {
         createFolder(projectId: $projectId, path: $path) {
           folder {
             name
             path
           }
           warnings
         }
       }`,
      { projectId: String(projectId), path }
    );

    const made = (data && data.createFolder) || {};
    const folder = made.folder || {};
    return {
      path: String(folder.path || path),
      name: String(folder.name || path.split("/").filter(Boolean).pop() || path),
      warnings: made.warnings || [],
    };
  }

  /**
   * Create one Manual test: a Jira issue of type Test, with its steps.
   *
   * `folderPath` files it in the Test Repository; "/" is the project root. `jira.fields` is the
   * ordinary Jira create payload, so a summary and a project key are the minimum and anything
   * else the project requires can ride along.
   *
   * @param {object} input
   * @param {string} input.projectKey
   * @param {string} input.summary
   * @param {Array<{ action: string, data?: string, result?: string }>} input.steps
   * @param {string} [input.folderPath]
   * @param {string[]} [input.labels]
   * @returns {Promise<{ issueId: string, key: string, warnings: string[] }>}
   */
  async createManualTest({ projectKey, summary, steps, folderPath, labels }) {
    const fields = { summary: String(summary || "Test case").trim(), project: { key: String(projectKey) } };
    if (labels && labels.length) fields.labels = labels;

    const data = await this.graphql(
      `mutation createTest($testType: UpdateTestTypeInput, $steps: [CreateStepInput], $folderPath: String, $jira: JSON!) {
         createTest(testType: $testType, steps: $steps, folderPath: $folderPath, jira: $jira) {
           test {
             issueId
             jira(fields: ["key"])
           }
           warnings
         }
       }`,
      {
        testType: { name: "Manual" },
        steps: (steps || []).map((s) => ({
          action: String(s.action || ""),
          data: String(s.data || ""),
          result: String(s.result || ""),
        })),
        // "/" is the root; an empty string would be a folder named nothing.
        folderPath: String(folderPath || "/") || "/",
        jira: { fields },
      }
    );

    const made = (data && data.createTest) || {};
    const test = made.test || {};
    const key = test.jira && (test.jira.key || test.jira.Key);
    if (!key) throw new XrayError("Xray accepted the test but returned no Jira key");
    return { issueId: String(test.issueId || ""), key: String(key), warnings: made.warnings || [] };
  }

  /**
   * Create a Cucumber test from a Gherkin scenario — the BDD half of the same endpoint.
   * The scenario text is the body only: Xray owns the `Scenario:` header, as its editor shows it.
   */
  async createCucumberTest({ projectKey, summary, gherkin, folderPath, labels }) {
    const fields = { summary: String(summary || "Scenario").trim(), project: { key: String(projectKey) } };
    if (labels && labels.length) fields.labels = labels;

    const data = await this.graphql(
      `mutation createTest($testType: UpdateTestTypeInput, $gherkin: String, $folderPath: String, $jira: JSON!) {
         createTest(testType: $testType, gherkin: $gherkin, folderPath: $folderPath, jira: $jira) {
           test {
             issueId
             jira(fields: ["key"])
           }
           warnings
         }
       }`,
      {
        testType: { name: "Cucumber" },
        gherkin: String(gherkin || ""),
        folderPath: String(folderPath || "/") || "/",
        jira: { fields },
      }
    );

    const made = (data && data.createTest) || {};
    const test = made.test || {};
    const key = test.jira && (test.jira.key || test.jira.Key);
    if (!key) throw new XrayError("Xray accepted the scenario but returned no Jira key");
    return { issueId: String(test.issueId || ""), key: String(key), warnings: made.warnings || [] };
  }
}

module.exports = {
  XrayClient,
  XrayError,
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  parseTokenBody,
};
