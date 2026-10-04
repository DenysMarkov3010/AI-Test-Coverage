/**
 * Azure DevOps REST client — Test Plans scope (plans, suites, suite test cases).
 * Test Case step text is read via the Work Items API (see ADO_TEST_PLANS.md).
 */
const fetch = globalThis.fetch || require("node-fetch");

const DEFAULT_API_VERSION = process.env.ADO_API_VERSION || "7.1-preview.1";
/** Suite Test Case GET/POST — documented path uses Plans/Suites/TestCase; api-version=7.1 (see Microsoft testplan suite-test-case REST docs). */
const TESTPLAN_SUITE_API_VERSION = process.env.ADO_TESTPLAN_API_VERSION || "7.1";
/**
 * Bulk suite list uses `GET .../test/Plans/{id}/suites` (legacy **Test** API).
 * Microsoft documents **api-version=5.0**; **7.1** often returns 404 — see `_listFlatSuitesInPlanBulk` fallbacks.
 */
const WIT_API_VERSION = process.env.ADO_WIT_API_VERSION || "7.1";

/**
 * `witFields` results arrive as `workItemFields: [{ "System.Title": "..." }, { "System.State": "..." }]`
 * — an array of single-key objects, not a plain field map. Flatten it into one lookup object.
 * @param {unknown} workItemFields
 * @returns {Record<string, unknown>}
 */
function flattenWorkItemFields(workItemFields) {
  const out = {};
  if (!Array.isArray(workItemFields)) return out;
  for (const entry of workItemFields) {
    if (!entry || typeof entry !== "object") continue;
    for (const [k, v] of Object.entries(entry)) {
      out[k] = v;
    }
  }
  return out;
}

class AdoClient {
  /**
   * @param {string} organization - org name (segment after dev.azure.com)
   * @param {string} project - Azure DevOps project name
   * @param {string} pat - Personal Access Token
   * @param {{ baseUrl?: string, apiVersion?: string }} [options]
   */
  constructor(organization, project, pat, options = {}) {
    if (!organization || !project || !pat) {
      throw new Error("AdoClient: organization, project, and PAT are required");
    }
    this.organization = organization;
    this.project = project;
    this.pat = pat;
    this.apiVersion = options.apiVersion || DEFAULT_API_VERSION;
    this.witApiVersion = options.witApiVersion || WIT_API_VERSION;
    const host =
      (options.baseUrl || process.env.ADO_SERVER_URL || "https://dev.azure.com").replace(/\/$/, "");
    const encProject = encodeURIComponent(project);
    this.apisBase = `${host}/${encodeURIComponent(organization)}/${encProject}/_apis`;
    this.auth = Buffer.from(`:${pat}`).toString("base64");
  }

  async request(absolutePath, options = {}) {
    const url = `${this.apisBase}${absolutePath}`;
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (e) {
      const cause = e && e.cause != null ? ` (${String(e.cause.message || e.cause)})` : "";
      throw new Error(`Azure DevOps fetch failed: ${e.message || e}${cause}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  /**
   * GET with api-version query parameter.
   * @param {string} path - e.g. /testplan/plans
   * @param {Record<string, string|number|undefined>} [query]
   */
  async get(path, query = {}, getOptions = {}) {
    const params = new URLSearchParams();
    params.set("api-version", getOptions.apiVersion ?? this.apiVersion);
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    });
    const q = params.toString();
    const sep = path.includes("?") ? "&" : "?";
    return this.request(`${path}${sep}${q}`, { method: "GET" });
  }

  /**
   * Same as `get`, but also hands back the response headers — Azure DevOps returns
   * `x-ms-continuationtoken` there, and `get()` throws it away.
   * @param {string} path
   * @param {Record<string, string|number|undefined>} [query]
   * @returns {Promise<{ body: any, continuationToken: string | null }>}
   */
  async getPage(path, query = {}, getOptions = {}) {
    const params = new URLSearchParams();
    params.set("api-version", getOptions.apiVersion ?? this.apiVersion);
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    });
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.apisBase}${path}${sep}${params.toString()}`;
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Basic ${this.auth}`, Accept: "application/json" },
      });
    } catch (e) {
      const cause = e && e.cause != null ? ` (${String(e.cause.message || e.cause)})` : "";
      throw new Error(`Azure DevOps fetch failed: ${e.message || e}${cause}`);
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    const ct = response.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await response.json() : await response.text();
    return { body, continuationToken: response.headers.get("x-ms-continuationtoken") || null };
  }

  /**
   * Follow `x-ms-continuationtoken` until the collection is exhausted, concatenating `value[]`.
   * A page that comes back as text instead of JSON means the PAT was rejected (Azure DevOps
   * answers 203 + a sign-in page, not 401) — surface the partial/raw body so callers can detect it.
   * @param {string} path
   * @param {Record<string, string|number|undefined>} query
   * @returns {Promise<any[] | string>} merged rows, or the raw text of a non-JSON response
   */
  async _getAllPages(path, query = {}, getOptions = {}) {
    const maxPages = Math.max(1, parseInt(process.env.ADO_MAX_PAGES || "200", 10) || 200);
    const merged = [];
    let continuationToken = null;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await this.getPage(path, { ...query, continuationToken }, getOptions);
      if (!res.body || typeof res.body === "string" || !Array.isArray(res.body.value)) {
        // Not a paged JSON collection — hand the raw body back untouched.
        return page === 0 ? res.body : merged;
      }
      merged.push(...res.body.value);
      continuationToken = res.continuationToken;
      if (!continuationToken) break;
    }
    return merged;
  }

  /**
   * List Test Plans in the project (for planId selection).
   * Paginated: an org with more plans than one page would otherwise be silently truncated.
   * @param {{ filterActivePlans?: boolean }} [options]
   */
  async listTestPlans(options = {}) {
    const query = {};
    if (options.filterActivePlans) query.filterActivePlans = "true";
    const res = await this._getAllPages("/testplan/plans", query);
    return Array.isArray(res) ? res : res || [];
  }

  /** One Test Plan metadata (includes rootSuite). */
  async getTestPlan(planId) {
    return this.get(`/testplan/plans/${planId}`);
  }

  /**
   * Build "Root / Folder / Suite" from bulk API rows (each row may include `parent` id).
   * @param {object} suite
   * @param {Map<number, object>} idMap
   */
  _suitePathFromBulkRow(suite, idMap) {
    const parts = [];
    let cur = suite;
    const guard = new Set();
    while (cur && cur.id != null) {
      if (guard.has(cur.id)) break;
      guard.add(cur.id);
      parts.unshift(cur.name || `Suite-${cur.id}`);
      const pid = cur.parent != null && cur.parent.id != null ? cur.parent.id : null;
      cur = pid != null ? idMap.get(pid) : null;
    }
    return parts.join(" / ");
  }

  /**
   * All suites in one plan via **Test** REST API (`GET .../test/Plans/{id}/suites`).
   * Default **api-version=5.0** (documented for this route; 7.x often 404 on dev.azure.com).
   * Override with `ADO_TEST_PLAN_BULK_API_VERSION` — only that version is used (no automatic retries).
   * @param {number} planId
   * @param {string} apiVersion
   */
  async _listFlatSuitesInPlanBulkWithApiVersion(planId, apiVersion) {
    const merged = [];
    let skip = 0;
    const pageSize = 500;
    for (;;) {
      const res = await this.get(
        `/test/Plans/${planId}/suites`,
        { $skip: skip, $top: pageSize },
        { apiVersion }
      );
      const batch = res.value || [];
      merged.push(...batch);
      if (batch.length < pageSize) break;
      skip += pageSize;
    }
    const idMap = new Map(merged.map((s) => [s.id, s]));
    return merged.map((s) => ({
      suiteId: s.id,
      suiteName: s.name || `Suite-${s.id}`,
      path: this._suitePathFromBulkRow(s, idMap),
    }));
  }

  async _listFlatSuitesInPlanBulk(planId) {
    const envVer = (process.env.ADO_TEST_PLAN_BULK_API_VERSION || "").trim();
    const apiVersion = envVer || "5.0";
    return this._listFlatSuitesInPlanBulkWithApiVersion(planId, apiVersion);
  }

  /**
   * Fallback: walk the suite tree via Test Plan API (`parentSuiteId` per level).
   * @param {number} planId
   */
  async _listFlatSuitesInPlanTreeWalk(planId) {
    const plan = await this.getTestPlan(planId);
    const rootSuite = plan.rootSuite;
    if (!rootSuite || rootSuite.id == null) {
      throw new Error("Test plan response has no rootSuite.id");
    }
    /** @type {Array<{ suiteId: number, suiteName: string, path: string }>} */
    const flat = [];

    let frontier = [{ suiteObj: rootSuite, parentPathSegments: /** @type {string[]} */ ([]) }];
    const treeConcurrency = Math.max(
      1,
      Math.min(32, parseInt(process.env.ADO_SYNC_SUITE_TREE_CONCURRENCY || "4", 10) || 4)
    );

    while (frontier.length) {
      const nextFrontier = [];
      for (let i = 0; i < frontier.length; i += treeConcurrency) {
        const chunk = frontier.slice(i, i + treeConcurrency);
        const wave = await Promise.all(
          chunk.map(async ({ suiteObj, parentPathSegments }) => {
            const suiteId = suiteObj.id;
            const name = suiteObj.name || `Suite-${suiteId}`;
            const pathStr = [...parentPathSegments, name].join(" / ");
            const entry = { suiteId, suiteName: name, path: pathStr };
            const children = await this.listChildSuites(planId, suiteId);
            const nextSegments = [...parentPathSegments, name];
            return { entry, children, nextSegments };
          })
        );
        for (const w of wave) {
          flat.push(w.entry);
          for (const child of w.children) {
            nextFrontier.push({ suiteObj: child, parentPathSegments: w.nextSegments });
          }
        }
      }
      frontier = nextFrontier;
    }

    return flat;
  }

  /**
   * All suites in a Test Plan (flat), with hierarchical path — same shape as `ado-plan-tools` export, without test case counts.
   * Prefers **one bulk** `GET .../test/Plans/{id}/suites?api-version=5.0` (filter by Jira key client-side); falls back to tree walk if bulk fails.
   * Set `ADO_SYNC_SUITE_USE_TREE_WALK=true` to force the slow tree API.
   * @param {number} planId
   * @returns {Promise<Array<{ suiteId: number, suiteName: string, path: string }>>}
   */
  async listFlatSuitesInPlan(planId) {
    if (process.env.ADO_SYNC_SUITE_USE_TREE_WALK === "true") {
      return this._listFlatSuitesInPlanTreeWalk(planId);
    }
    try {
      return await this._listFlatSuitesInPlanBulk(planId);
    } catch (e) {
      console.warn(
        `   ⚠️  Azure DevOps: bulk suite list (GET .../test/Plans/.../suites, api-version=${(process.env.ADO_TEST_PLAN_BULK_API_VERSION || "").trim() || "5.0"}) failed: ${e.message}. Falling back to tree walk.`
      );
      return this._listFlatSuitesInPlanTreeWalk(planId);
    }
  }

  /**
   * Child suites under a parent suite (start from the plan’s rootSuite).
   * @param {number} planId
   * @param {number} parentSuiteId
   */
  async listChildSuites(planId, parentSuiteId) {
    const res = await this.get(`/testplan/plans/${planId}/suites`, {
      parentSuiteId,
    });
    return res.value || [];
  }

  /**
   * Test case entries in a suite (references to work items).
   *
   * `witFields` is the reason the context picker does not need a second WIT round trip: the
   * requested fields ride along in `workItem.workItemFields`, so titles for the checkbox list
   * come straight out of this call. `excludeFlags=3` drops point assignments and the repeated
   * plan/suite/link blobs, which dominate the payload on a suite with a few hundred cases.
   *
   * @param {number} planId
   * @param {number} suiteId
   * @param {{ witFields?: string[], isRecursive?: boolean, excludeFlags?: number|string, expand?: boolean }} [options]
   */
  async listTestCasesInSuite(planId, suiteId, options = {}) {
    const path = `/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`;
    const query = {};
    if (options.witFields && options.witFields.length) query.witFields = options.witFields.join(",");
    if (options.isRecursive) query.isRecursive = "true";
    if (options.excludeFlags !== undefined) query.excludeFlags = options.excludeFlags;
    if (options.expand === false) query.expand = "false";
    const res = await this._getAllPages(path, query, { apiVersion: TESTPLAN_SUITE_API_VERSION });
    return Array.isArray(res) ? res : [];
  }

  /**
   * Lightweight test case rows for the context picker: id + title + state + tags, no steps.
   * Steps are deliberately NOT requested here — a 200-case suite would pull hundreds of KB of
   * TCM XML that nobody looks at. They are fetched later, only for the ids the user ticked.
   *
   * @param {number} planId
   * @param {number} suiteId
   * @param {{ isRecursive?: boolean }} [options]
   * @returns {Promise<Array<{ id: number, title: string, state: string, tags: string }>>}
   */
  async listSuiteTestCaseSummaries(planId, suiteId, options = {}) {
    const rows = await this.listTestCasesInSuite(planId, suiteId, {
      witFields: ["System.Id", "System.Title", "System.State", "System.Tags"],
      excludeFlags: 3,
      expand: false,
      isRecursive: options.isRecursive === true,
    });
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const wi = row && row.workItem ? row.workItem : null;
      const id = wi && wi.id != null ? Number(wi.id) : null;
      if (id == null || Number.isNaN(id) || seen.has(id)) continue;
      seen.add(id);
      const fields = flattenWorkItemFields(wi.workItemFields);
      out.push({
        id,
        title: String(fields["System.Title"] ?? wi.name ?? `Test Case ${id}`),
        state: String(fields["System.State"] ?? ""),
        tags: String(fields["System.Tags"] ?? ""),
      });
    }
    return out;
  }

  /**
   * Whole suite tree of a plan in ONE request (`asTreeView=true` → nested `children[]`),
   * normalised into rows the UI can render directly.
   *
   * The older `listChildSuites` / `_listFlatSuitesInPlan*` paths cost one request per level (or
   * fall back to the legacy `test/` route pinned to api-version 5.0); for an interactive tree
   * that is both slower and more fragile.
   *
   * @param {number} planId
   * @returns {Promise<Array<{ suiteId: number, suiteName: string, path: string, parentSuiteId: number|null, depth: number, suiteType: string, hasChildren: boolean }>>}
   */
  async listSuiteTree(planId) {
    const roots = await this._getAllPages(
      `/testplan/Plans/${planId}/suites`,
      { asTreeView: "true", expand: "children" },
      { apiVersion: TESTPLAN_SUITE_API_VERSION }
    );
    if (!Array.isArray(roots)) {
      // A rejected PAT is not an HTTP error here: Azure DevOps answers 203 with a sign-in page,
      // which arrives as text. Anything that is not the expected collection means the same thing.
      throw new Error(
        "Azure DevOps did not return a suite list — the PAT was most likely rejected or has expired"
      );
    }
    /** @type {Array<{ suiteId: number, suiteName: string, path: string, parentSuiteId: number|null, depth: number, suiteType: string, hasChildren: boolean }>} */
    const flat = [];
    const visited = new Set();

    const walk = (suite, parentPathSegments, parentSuiteId, depth) => {
      if (!suite || suite.id == null) return;
      const suiteId = Number(suite.id);
      // Guard against a cycle in a malformed tree — one visit per suite id.
      if (visited.has(suiteId)) return;
      visited.add(suiteId);
      const name = String(suite.name || `Suite-${suiteId}`);
      const segments = [...parentPathSegments, name];
      const children = Array.isArray(suite.children) ? suite.children : [];
      flat.push({
        suiteId,
        suiteName: name,
        path: segments.join(" / "),
        parentSuiteId,
        depth,
        suiteType: String(suite.suiteType || ""),
        hasChildren: children.length > 0 || suite.hasChildren === true,
      });
      for (const child of children) {
        walk(child, segments, suiteId, depth + 1);
      }
    };

    for (const root of roots) {
      walk(root, [], null, 0);
    }
    return flat;
  }

  /**
   * Run a WIQL query (filter Test Cases by tags, area path, etc.). Results reference work items in Azure DevOps only — no export required.
   * Uses explicit $top and follows x-ms-continuationtoken until exhausted so large result sets are not truncated.
   * @param {string} wiql - e.g. SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'smoke'
   * @param {{ $top?: number }} [options]
   * @returns {Promise<object>} API response (merged workItems[] with id/url; other fields from last page)
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql
   */
  async runWiql(wiql, options = {}) {
    const $top = options.$top ?? 20000;
    const allWorkItems = [];
    let continuationToken = null;
    /** @type {object | null} */
    let lastJson = null;
    let pages = 0;
    const maxPages = 500;

    do {
      pages += 1;
      if (pages > maxPages) {
        throw new Error(`Azure DevOps WIQL: pagination exceeded ${maxPages} pages; refine your query`);
      }
      const params = new URLSearchParams();
      params.set("api-version", this.witApiVersion);
      params.set("$top", String($top));
      if (continuationToken) {
        params.set("continuationToken", continuationToken);
      }
      const url = `${this.apisBase}/wit/wiql?${params.toString()}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: wiql }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure DevOps WIQL error: ${response.status} ${response.statusText}. ${errorText}`);
      }
      const data = await response.json();
      lastJson = data;
      const batch = data.workItems || [];
      allWorkItems.push(...batch);
      continuationToken = response.headers.get("x-ms-continuationtoken");
    } while (continuationToken);

    const seen = new Set();
    const merged = [];
    for (const w of allWorkItems) {
      if (!w || w.id == null || seen.has(w.id)) continue;
      seen.add(w.id);
      merged.push(w);
    }
    return { ...lastJson, workItems: merged };
  }

  /**
   * Work item details via batch POST (avoids GET URL length limits with many ids/fields).
   * @param {number[]} ids
   * @param {string[]} [fields] - optional field list
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch
   */
  async getWorkItemsBatch(ids, fields) {
    if (!ids.length) return [];
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const url = `${this.apisBase}/wit/workitemsbatch?${params.toString()}`;
    const body = { ids };
    if (fields && fields.length) {
      body.fields = fields;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps WIT batch error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    const data = await response.json();
    return data.value || [];
  }

  /**
   * Work item details (Test Case — title, steps). Uses WIT batch API in chunks of 200.
   * @param {number[]} ids
   * @param {string[]} [fields] - optional field list
   */
  async getWorkItemsByIds(ids, fields) {
    if (!ids.length) return [];
    const chunkSize = 200;
    const out = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const part = ids.slice(i, i + chunkSize);
      const batch = await this.getWorkItemsBatch(part, fields);
      out.push(...batch);
    }
    return out;
  }

  /**
   * Create a work item (e.g. Test Case) via JSON Patch.
   * @param {string} workItemTypeName - e.g. "Test Case"
   * @param {Array<{ op: string, path: string, value?: unknown }>} patchDocument
   */
  async createWorkItem(workItemTypeName, patchDocument) {
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const typeSeg = encodeURIComponent(workItemTypeName);
    const url = `${this.apisBase}/wit/workitems/$${typeSeg}?${params.toString()}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(patchDocument),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps create work item error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    return response.json();
  }

  /**
   * Update fields of an existing work item (e.g. patch System.Description after creation).
   * @param {number} id
   * @param {Array<{ op: string, path: string, value?: unknown }>} patchDocument
   */
  async updateWorkItem(id, patchDocument) {
    const params = new URLSearchParams();
    params.set("api-version", this.witApiVersion);
    const url = `${this.apisBase}/wit/workitems/${encodeURIComponent(id)}?${params.toString()}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(patchDocument),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps update work item error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    return response.json();
  }

  /**
   * Add existing Test Case work items to a suite in a Test Plan.
   * @param {number} planId
   * @param {number} suiteId
   * @param {number[]} workItemIds
   */
  async addTestCasesToSuite(planId, suiteId, workItemIds) {
    if (!workItemIds.length) return null;
    const params = new URLSearchParams();
    params.set("api-version", TESTPLAN_SUITE_API_VERSION);
    const path = `/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`;
    const url = `${this.apisBase}${path}?${params.toString()}`;
    const body = workItemIds.map((id) => ({ workItem: { id } }));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps add test cases to suite error: ${response.status} ${response.statusText}. ${errorText}`);
    }
    if (response.status === 204) return null;
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) return response.json();
    return null;
  }
}

module.exports = { AdoClient, flattenWorkItemFields };
