/**
 * Zephyr Essential Cloud API v2 client — the read paths the Setup page needs:
 * projects, test-case folders and statuses, plus the healthcheck that doubles
 * as a credential test.
 *
 * Four things about this API shape the whole file:
 *
 *  1. **"Zephyr Essential" means two incompatible things.** SmartBear ships a
 *     **1.0 (Legacy Experience)**, which is the old Zephyr Squad — ZAPI v1 at
 *     `prod-api.zephyr4jiracloud.com/connect`, authenticated by signing every
 *     request with an access key + secret key pair — and a **2.0 (New
 *     Experience)**, which is this: one bearer token, at
 *     `https://prod-api.zephyr4jiracloud.com/v2`. They share a name and an
 *     app menu and nothing else. The token screen tells them apart: 2.0 has
 *     **Access Tokens** under the Jira profile menu, 1.0 has **API Keys**
 *     under Apps → Zephyr Squad.
 *  2. **The token carries the identity.** No email, no Basic auth, no request
 *     signing: one bearer token created from the Jira profile menu, scoped to
 *     the account that made it. So a 403 is a Jira permission, not a Zephyr
 *     setting.
 *  3. **A test case belongs to Zephyr, not to Jira.** Unlike 1.0, where a test
 *     was a Jira issue of type Test, 2.0 stores its own `/testcases` addressed
 *     by `projectKey`. That is why this card needs no Jira credentials at all:
 *     the Jira link is one optional call afterwards.
 *  4. **Everything is paginated**, and the default page is small — a folder
 *     picker that ignored that would silently show the first handful of
 *     folders. getCollection() pages through `{ values, isLast, next }` for
 *     every read.
 */
const fetch = globalThis.fetch || require("node-fetch");

/** Essential 2.0 Cloud is one global endpoint — there is no per-tenant host. */
const CLOUD_BASE_URL = "https://prod-api.zephyr4jiracloud.com/v2";

const DEFAULT_TIMEOUT_MS = 20000;
/** 200 keeps a page small enough to stay fast while still being one round trip. */
const PAGE_LIMIT = 200;
/** 8k rows. A picker never needs more, and this stops a runaway paging loop. */
const MAX_PAGES = 40;
const MAX_RETRIES = 2;

class ZephyrError extends Error {
  /**
   * @param {string} message already human-readable — safe to show in the UI
   * @param {number} [status] HTTP status, when the failure came from a response
   */
  constructor(message, status) {
    super(message);
    this.name = "ZephyrError";
    this.status = status;
  }
}

/**
 * `https://prod-api.zephyr4jiracloud.com/v2/` → the same without the slash.
 * Accepts a bare host, defaults to https.
 */
function normalizeBaseUrl(raw) {
  let base = String(raw || "").trim();
  if (!base) return "";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Honours `Retry-After` when Zephyr sends one, otherwise backs off 0.5s, 1s. */
function retryAfterMs(res, attempt) {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10000);
  return 500 * 2 ** attempt;
}

/**
 * One sentence a QA engineer can act on. Zephyr answers a rejected call with
 * `{ errorCode, message }`; Jira-side failures come back as `{ errorMessages: [] }`.
 */
function errorMessage(res, body, text) {
  const apiError =
    (body && typeof body.message === "string" && body.message.trim()) ||
    (body && Array.isArray(body.errorMessages) && body.errorMessages.join("; ").trim()) ||
    "";

  if (res.status === 401) {
    // Three mistakes land here and only one of them is a typo: the token has
    // an expiry date, and the *ID* shown in the token list is not the token.
    return (
      "API token rejected (401) — tokens expire, and the ID in the Access Tokens list " +
      "is not the token itself. Create a new one under the Jira profile menu → " +
      "Zephyr Essential API Access Tokens and copy the value it shows once."
    );
  }
  if (res.status === 403) {
    return (
      apiError ||
      "Access denied (403) — the Jira account that owns this token has no Zephyr access to that project"
    );
  }
  if (res.status === 404) return apiError || "Not found (404) — check the project key";
  if (res.status === 429) return apiError || "Rate limit reached (429) — try again in a moment";
  if (apiError) return `${apiError} (HTTP ${res.status})`;

  const snippet = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`;
}

class ZephyrEssentialClient {
  /**
   * @param {string} apiToken Jira profile menu → Zephyr Essential API Access Tokens
   * @param {{ baseUrl?: string, timeoutMs?: number }} [options]
   *   `baseUrl` overrides the fixed Cloud endpoint — for a proxy or a test
   *   double, nothing else.
   */
  constructor(apiToken, options = {}) {
    const token = String(apiToken || "").trim();
    if (!token) throw new ZephyrError("ZephyrEssentialClient: an API token is required");

    this.token = token;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    // Cloud is the only deployment this speaks, so it is the constant, not a
    // setting. An override is still honoured for a proxy or a test double.
    this.baseUrl = normalizeBaseUrl(options.baseUrl) || CLOUD_BASE_URL;
  }

  /**
   * @param {string} path e.g. `/folders`
   * @param {Record<string, string|number|boolean|undefined>} [params] query string
   */
  url(path, params = {}) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}${query ? `?${query}` : ""}`;
  }

  /**
   * One request, retried on 429.
   *
   * @param {string} path
   * @param {{ params?: Record<string, unknown>, method?: string, body?: unknown }} [options]
   * @returns {Promise<unknown>} parsed JSON (null for an empty body)
   */
  async request(path, options = {}) {
    if (!this.baseUrl) throw new ZephyrError("Zephyr Essential base URL is empty");
    const url = this.url(path, options.params || {});

    for (let attempt = 0; ; attempt++) {
      // Rebuilt per attempt: an AbortSignal cannot be reused once it has fired.
      const init = {
        method: options.method || (options.body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);

      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new ZephyrError(
            `Zephyr Essential timed out after ${Math.round(this.timeoutMs / 1000)}s`
          );
        }
        const cause = e && e.cause != null ? ` (${String(e.cause.message || e.cause)})` : "";
        throw new ZephyrError(`Zephyr Essential request failed: ${(e && e.message) || e}${cause}`);
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON — handled below */
      }

      if (!res.ok) throw new ZephyrError(errorMessage(res, body, text), res.status);
      if (body === null && text) {
        // A 200 that is not JSON means the URL reached a web page, not the API.
        // The usual cause is a 1.0 host: `/connect` answers, but not with this.
        throw new ZephyrError(
          "That URL did not return Zephyr Essential API JSON — check the base URL override"
        );
      }
      return body;
    }
  }

  /**
   * Pages through a `{ startAt, maxResults, total, isLast, next, values }`
   * envelope until Zephyr says it is done. A bare array is passed through so
   * an endpoint that never paginated cannot break a picker.
   *
   * @param {string} path
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async getCollection(path, params = {}) {
    const rows = [];
    let startAt = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request(path, {
        params: { ...params, maxResults: PAGE_LIMIT, startAt },
      });
      if (Array.isArray(body)) return body;
      const chunk = body && Array.isArray(body.values) ? body.values : [];
      rows.push(...chunk);
      // `isLast` is authoritative; the short-page check is the guard for an
      // endpoint that omits it, not a second opinion.
      if (!chunk.length || body.isLast === true || chunk.length < PAGE_LIMIT) break;
      startAt += chunk.length;
    }
    return rows;
  }

  // ── reads used by the Setup page ─────────────────────────────────────────

  /**
   * The cheapest authenticated read there is, so it doubles as the credential
   * check. It returns nothing useful — reaching it *is* the result.
   */
  healthcheck() {
    return this.request("/healthcheck");
  }

  /**
   * Projects Zephyr Essential is enabled for. Each carries `key` (what every
   * other read takes), `id`, `jiraProjectId` and `enabled` — but no display
   * name, so a picker can only ever label a project by its key.
   */
  listProjects() {
    return this.getCollection("/projects");
  }

  /**
   * Test-case folders of one project, flat, each carrying `parentId` — the
   * tree has to be rebuilt locally (see buildFolderPaths()).
   *
   * @param {string} projectKey e.g. `PROJ`
   * @param {string} [folderType] `TEST_CASE` (default), `TEST_PLAN` or `TEST_CYCLE`
   */
  listFolders(projectKey, folderType = "TEST_CASE") {
    return this.getCollection("/folders", { projectKey, folderType });
  }

  /**
   * Statuses a new test case may carry (Draft / Approved / …). Project-scoped:
   * Zephyr lets each project rename them. Nothing on the Setup page reads this
   * — it is here because `POST /testcases` takes a `statusName`, and that is
   * the call the importer will make.
   */
  listStatuses(projectKey, statusType = "TEST_CASE") {
    return this.getCollection("/statuses", { projectKey, statusType });
  }

  /** Project priorities — what the CSV's 1-4 scale is mapped onto by name. */
  listPriorities(projectKey) {
    return this.getCollection("/priorities", { projectKey });
  }

  // ── reads used by the generation-context picker ──────────────────────────

  /**
   * Test cases filed directly in one folder. Each carries `key`, `name`, `objective` and
   * `precondition`; steps are a separate call (getTestSteps), made only for picked cases.
   *
   * @param {string} projectKey
   * @param {number|string} folderId
   */
  listTestCases(projectKey, folderId) {
    return this.getCollection("/testcases", { projectKey, folderId });
  }

  /** Steps of one case, as `[{ inline: { description, testData, expectedResult } }]`. */
  getTestSteps(testCaseKey) {
    return this.getCollection(`/testcases/${encodeURIComponent(testCaseKey)}/teststeps`);
  }

  /** The test script of one case (`{ type, text }`) — what a BDD case has instead of steps. */
  getTestScript(testCaseKey) {
    return this.request(`/testcases/${encodeURIComponent(testCaseKey)}/testscript`);
  }

  // ── writes used by the importer ──────────────────────────────────────────

  /**
   * Create one test case. Only `projectKey` and `name` are required; a folder,
   * priority or status left out means the project's own default.
   *
   * @param {{ projectKey: string, name: string, objective?: string, precondition?: string,
   *           priorityName?: string, statusName?: string, folderId?: number, labels?: string[] }} input
   * @returns {Promise<{ id: number, key: string }>} `key` is what every later call takes
   */
  createTestCase(input) {
    return this.request("/testcases", { body: input });
  }

  /**
   * Replace a case's steps. `OVERWRITE` rather than `APPEND` because the case
   * was just created — appending would be the same thing with a worse failure
   * mode on a retry.
   *
   * @param {string} testCaseKey
   * @param {Array<{ description: string, testData?: string, expectedResult?: string }>} steps
   */
  setTestSteps(testCaseKey, steps) {
    return this.request(`/testcases/${encodeURIComponent(testCaseKey)}/teststeps`, {
      body: { mode: "OVERWRITE", items: steps.map((inline) => ({ inline })) },
    });
  }

  /**
   * Replace a case's test script — the Gherkin counterpart of steps. A case has
   * one or the other, never both, which is why a scenario never calls
   * setTestSteps().
   *
   * @param {string} testCaseKey
   * @param {string} text
   * @param {"plain"|"bdd"} [type]
   */
  setTestScript(testCaseKey, text, type = "bdd") {
    return this.request(`/testcases/${encodeURIComponent(testCaseKey)}/testscript`, {
      body: { type, text },
    });
  }

  /**
   * Link a case to the Jira issue it was designed from. Takes the issue's
   * numeric id, not its key — the caller has to resolve that through Jira.
   *
   * @param {string} testCaseKey
   * @param {number} issueId
   */
  linkIssue(testCaseKey, issueId) {
    return this.request(`/testcases/${encodeURIComponent(testCaseKey)}/links/issues`, {
      body: { issueId: Number(issueId) },
    });
  }

  /**
   * Create a test-case folder. `parentId` nests it; omit for the project root.
   *
   * @param {{ name: string, projectKey: string, parentId?: number, folderType?: string }} input
   */
  createFolder(input) {
    return this.request("/folders", { body: { folderType: "TEST_CASE", ...input } });
  }
}

/**
 * Turns the flat folder list into `[{ id, name, path, depth }]` with a
 * `Parent / Child` path, so a picker can show where a folder actually sits.
 * A folder whose parent is missing (no access, or a partial page) is treated
 * as a root rather than dropped — a folder the user can see should be pickable.
 *
 * @param {Array<{ id: number|string, name?: string, parentId?: number|string|null }>} folders
 * @returns {Array<{ id: string, name: string, path: string, depth: number }>}
 */
function buildFolderPaths(folders) {
  const rows = (folders || []).filter((f) => f && f.id != null);
  const byId = new Map(rows.map((f) => [String(f.id), f]));

  const pathOf = (folder, seen = new Set()) => {
    const id = String(folder.id);
    const name = String(folder.name || `Folder ${id}`);
    const parentId = folder.parentId == null ? "" : String(folder.parentId);
    // `seen` guards against a cycle: Zephyr should never send one, but a
    // picker must not hang if it does.
    if (!parentId || seen.has(id) || !byId.has(parentId)) return name;
    seen.add(id);
    return `${pathOf(byId.get(parentId), seen)} / ${name}`;
  };

  return rows
    .map((f) => {
      const path = pathOf(f);
      return {
        id: String(f.id),
        name: String(f.name || `Folder ${f.id}`),
        path,
        depth: path.split(" / ").length - 1,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  ZephyrEssentialClient,
  ZephyrError,
  CLOUD_BASE_URL,
  normalizeBaseUrl,
  buildFolderPaths,
  PAGE_LIMIT,
};
