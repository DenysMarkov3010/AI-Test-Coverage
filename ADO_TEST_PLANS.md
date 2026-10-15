# Azure DevOps: Test Plans and direct test case analysis

> **Plan ids:** you do not have to look these up. On the Web UI **Setup** page the Azure DevOps card
> lists every Test Plan in the project as a dropdown (by name) once the PAT is filled in.

**Where this fits in the overall pipeline:** `[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md)` (stages 1, 4–5).

**Terminal commands:** where both appear, **Bash** = macOS / Linux / Git Bash; **PowerShell** = Windows.

This integration talks to **Azure DevOps over the REST API only**. Test cases remain the **source of truth in Azure DevOps**; the agent **reads** them in real time (in memory), optionally filters them, analyzes them, and can then drive checklist / test case generation — **without** having to import or mirror the whole plan into a local file first.

Official API documentation: [Test Plan REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/testplan/), [Work Items](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items), [WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql).

---

## How analysis works (directly in / from Azure DevOps)


| Step                  | What happens                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Connect            | `ado-client.js` uses your org, project, and PAT — all calls go to Azure DevOps.                                                                                                     |
| 2. Choose scope       | Either a **Test Plan** (plan id → suites → case ids) or a **WIQL** query (e.g. filter **Test Cases** by **tags**, area path, state).                                                |
| 3. Load details       | `getWorkItemsByIds` loads titles, steps, and other fields from work items — still **live data** from ADO, not a stale file.                                                         |
| 4. Analyze & generate | Your script or LLM pipeline uses that payload to **review coverage, gaps, or duplicates**, then **generates** new checklists or test cases (same idea as `agent-docs.js` for Jira). |


**Export to JSON** (`npm run ado:export-plan`) is **optional**: useful for debugging, snapshots, or sharing. The primary model for automation is **API → memory → analysis/generation**, not “download file first.”

**Filtering by tags:** use **WIQL** (e.g. `[System.Tags] CONTAINS 'your-tag'`). The client exposes `runWiql(wiql)` for this. To narrow to cases that also belong to a specific Test Plan, combine WIQL with your process (e.g. query by tags and intersect with ids from the plan, or use fields/links your project uses).

---

## 1. What the code reads


| Resource                                                    | Purpose                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET .../testplan/plans`                                    | List Test Plans (to find **Plan ID**); paginated via `x-ms-continuationtoken` |
| `GET .../testplan/plans/{planId}`                           | One plan (including **rootSuite**)                                          |
| `GET .../testplan/plans/{planId}/suites`                    | Child suites (`parentSuiteId`), or the **whole tree in one call** with `asTreeView=true` |
| `GET .../testplan/plans/{planId}/suites/{suiteId}/testcase` | Test Case work item references in a suite; add `witFields=System.Title,...` to get titles **without** a second Work Items call |
| `POST .../wit/wiql`                                         | **WIQL** — filter Test Cases (tags, etc.) **without** exporting a plan file |
| `GET .../wit/workitems?ids=...`                             | Work item fields (title, steps) for analysis                                |


Test Case step text lives in **work items**, so you need **Work Items (Read)** on the PAT for full text analysis, in addition to **Test (Read)** for plan/suite APIs.

---

## 2. Settings

Fill in the **Azure DevOps** card on the Setup page (these are the underlying variables):


| Variable                      | Required | Description                                                                                                                                                            |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADO_ORG`                     | Yes      | Organization segment after `https://dev.azure.com/`                                                                                                                    |
| `ADO_PROJECT`                 | Yes      | Project name (as in the URL)                                                                                                                                           |
| `ADO_PAT`                     | Yes      | Personal Access Token (see section 3)                                                                                                                                  |
| `ADO_ACTIVE_TEST_PLAN_ID`     | No       | Default **active** (feature) Test Plan id for `npm run ado:export-plan` / `npm run ado:list-suites` when no CLI argument                                               |
| `ADO_API_VERSION`             | No       | Test Plan API version (default `7.1-preview.1`)                                                                                                                        |
| `ADO_WIT_API_VERSION`         | No       | WIT / WIQL API version (default `7.1`)                                                                                                                                 |
| `ADO_EXPORT_DIR`              | No       | Optional folder for JSON exports only                                                                                                                                  |


Alternative names: `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT`.

**`.env` only:** `ADO_SERVER_URL` is no longer on the Setup card. The default is still `https://dev.azure.com`; for **Azure DevOps Server**, set the collection URL in `.env`.

**Active plan:** `ADO_ACTIVE_TEST_PLAN_ID` is the plan that receives newly generated test cases, and the default when you run `npm run ado:list-suites` or `npm run ado:export-plan` **without** a numeric argument. To inspect any other plan once, pass its id explicitly: `npm run ado:list-suites -- <id>` or `npm run ado:export-plan -- <id>`.

**Legacy:** `ADO_TEST_PLAN_ID` is still read as a fallback for the active plan id only (same role as `ADO_ACTIVE_TEST_PLAN_ID`); rename to `ADO_ACTIVE_TEST_PLAN_ID` when you can.

---

## 3. Personal Access Token (PAT)

1. **User settings** → **Personal access tokens** → **New Token**.
2. **Custom defined** scopes.
3. **Test** → **Read** (plans, suites, cases in plan).
4. **Work items** → **Read** (WIQL, work item fields, Test Case steps).

Keep scopes minimal; do not add Build/Code/Release unless needed.

Paste it into the **PAT** field of the Azure DevOps card on the Setup page. It is stored in `config.local.json`, which is git-ignored.

---

## 4. How to find Plan ID

**From the URL:** look for `planId=...` in the Test Plan URL.

**From CLI:**

**Bash**

```bash
npm run ado:list-plans
```

**PowerShell**

```powershell
npm run ado:list-plans
```

First column = **Plan ID**.

---

## 5. npm commands (optional export)


| Command                               | Action                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run ado:list-plans`              | List Test Plans (id, name, rootSuite)                                                                             |
| `npm run ado:list-suites -- <planId>` | List suites in that plan (`suiteId`, path, test case count) — use ids for `ado:sync-csv` / `ADO_SYNC_`*           |
| `npm run ado:export-plan`             | Write a **snapshot** JSON under `ado-exports/` (suite tree + case ids) — **not** required for direct API analysis |
| `npm run ado:export-tag-csv`          | Export all **Test Cases** whose **Tags** contain a substring to **one CSV** in `Test cases/` — see §5a            |


**Bash**

```bash
npm run ado:export-plan -- 12345
```

**PowerShell**

```powershell
npm run ado:export-plan -- 12345
```

### 5a. Export Test Cases by tag → CSV (`Test cases/`)

Use this when you want a **local agent-format CSV** of every Test Case in the project whose **Tags** field contains a given text (same idea as `[System.Tags] CONTAINS` in WIQL).

**Several tags:** separate them with commas — `Regression, Smoke`, in the Web UI field or in `--tag`. A Test Case carrying **any** of them is exported, once, into the same CSV (the conditions are OR-ed in one WIQL query). Spaces around the commas and repeated tags are ignored; the file is named after the list, e.g. `Test cases/Regression, Smoke.csv`. Up to 20 tags per export in the Web UI.

**Flow**

1. **WIQL** loads all matching work item ids: `Test Case` type and tag substring.
2. **Work Items API** loads fields in batches (title, steps, priority, area path, assignee, state).
3. Steps are read from **Microsoft.VSTS.TCM.Steps** and written in the usual columns (**Test Step**, **Step Action**, **Step Expected**). ADO often stores step text as HTML; the exporter **always strips tags** so the CSV contains only plain text.
4. Output defaults to `**Test cases/<tag>.csv`** — the file name matches the import tag (characters that are invalid in file names are replaced with `_`). Path is relative to the current working directory when you run npm (usually the project root).
5. **Each run keeps a single CSV in that folder:** before writing, **all other `.csv` files** in the same directory as the output file are **removed** (then the new file is written). Override path with `**-o`** / `**--output**` or the `**ADO_TAG_CSV_PATH**` environment variable (the same cleanup applies to that folder). Put unrelated CSVs elsewhere if you need to keep them.

**Bash**

```bash
npm run ado:export-tag-csv -- --tag Regression
npm run ado:export-tag-csv -- --tag "Regression, Smoke"
```

**PowerShell**

```powershell
npm run ado:export-tag-csv -- --tag="Regression"
```

Optional: `npm run ado:export-tag-csv -- --tag smoke -o "Test cases/custom-name.csv"`

**Tags with parentheses or spaces:** In PowerShell, `( )` are special unless the value is quoted. Prefer one of:

- **Equals form (one argv token):** `npm run ado:export-tag-csv -- --tag=Regression(smoke)` or `--tag="Regression (smoke)"`
- **Tag file:** put the exact tag on the first line of e.g. `tag.txt`, then `npm run ado:export-tag-csv -- --tag-file tag.txt`
- **Environment variable:** `ADO_EXPORT_TAG="Regression (smoke)" npm run ado:export-tag-csv` (no `--tag` needed)

If the query returns **no** work items, any **existing** file at the output path is **removed** so you do not keep a stale export.

**Fewer rows than expected:** The exporter only includes work items of type **Test Case** whose `**System.Tags`** field matches the substring (WIQL `CONTAINS`). Items that appear only under a Test Plan filter but **do not** have that tag on the work item itself, or items of another type (e.g. shared steps), are **not** returned. Run with `**--verbose`** to print the list of ids returned by WIQL. If the console shows a **Warning** about ids “not returned by the API”, those work items were in the WIQL result but were omitted when loading details (permissions, deleted, or wrong project).

---

## 6. Suggested automation flow (no file)

1. Instantiate `AdoClient` with env credentials.
2. **Option A — by plan:** walk plan/suites (`getTestPlan`, `listChildSuites`, `listTestCasesInSuite`), collect work item ids.
3. **Option B — by tags:** `runWiql(\`SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND [System.Tags] CONTAINS 'tag')`, collect ids from` workItems`.
4. **Option C — combine:** intersect ids from A with results from B in your script.
5. `getWorkItemsByIds(ids)` — load fields needed for analysis.
6. Pass structured text to your LLM (chunk if large), then generate checklists / new test cases per your prompts.

---

## 7. Common issues


| Symptom                                                             | What to check                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Access Denied`                                             | PAT, expiry, scopes                                                                                                                                                                                                                                                                                                                |
| WIQL errors                                                         | [WIQL syntax](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax), project process (field names)                                                                                                                                                                                                            |
| Empty plan                                                          | Wrong `ADO_PROJECT` or no plans                                                                                                                                                                                                                                                                                                    |
| No step text                                                        | **Work items (Read)**                                                                                                                                                                                                                                                                                                              |
| Create Test Case fails (403 / field error)                          | PAT needs **Work items (Write)**; the CSV's **Area Path** column must name a real area in the project (an unknown one is dropped with a warning)                                                                                                                                                                                                      |
| `404` on `.../testplan/.../testcase` — “controller … was not found” | Often **Azure DevOps Server** routing: the supported URL is `.../testplan/Plans/{planId}/Suites/{suiteId}/TestCase` with `**api-version=7.1`** (the client uses this; set `**ADO_TESTPLAN_API_VERSION**` if your server needs another version). Also confirm **suite id** comes from `ado:list-suites`, not a random work item id. |


---

## 9. Push approved CSV to Azure DevOps (after Jira approval)

After you approve a checklist or AI test cases and run with `**CHECK_APPROVAL=true`**, the agent writes the same **Azure-style CSV** as today (locally + Jira attachment). You can **also** create **Test Case** work items in Azure DevOps from that file. (This section applies while Azure DevOps is the provider **In use**; the other providers are in [TMS_INTEGRATIONS.md](TMS_INTEGRATIONS.md).)

**The Test design QA sub-task (Azure DevOps only).** With Azure DevOps In use, Submit attaches the approved CSV — and the CLI posts its comments — to the story's QA Sub-task titled **Test design**, not to the story itself, and the import reads the CSV from there. The story must have that sub-task, or the run stops with *No QA Sub-task with title 'Test design' found*. You can type either the story key or the sub-task key. TestRail, Zephyr Essential and Xray need no sub-task: they use the issue you typed.

### Automatic sync (with approval run)

1. Mark Azure DevOps **In use** on the Setup page (nothing is In use by default) and fill its required fields. There is no separate import switch.
2. Ensure the PAT has **Work items → Read & write** (not read-only).
3. Set `**ADO_ACTIVE_TEST_PLAN_ID`** to the Test Plan id where new cases should be linked (same as your **active** plan for `ado:export-plan` / `ado:list-suites`). **Automatic sync uses this plan id only** — it does **not** use `**ADO_SYNC_PLAN_ID`** or the `**planId**` from `**ADO_SYNC_TEST_PLAN_URL**` (those apply to **manual** `npm run ado:sync-csv` only).
4. Set area path helpers in `.env` if needed (see *Area Path* below).
5. **Suite selection (default):** the sync calls Azure DevOps `**GET .../_apis/test/Plans/{planId}/suites`** (Test REST API) to load **all suites in one paginated response**, builds each suite’s **path** from `parent` links, reads the Jira key from the **CSV file name** (e.g. `approved-testcases-PROJ-123.csv` or `… (PROJ-123).csv`), and picks the suite whose **name or path** contains that key as a **token** (so `PROJ-123` does not match `PROJ-1234`). The log prints **one line**: either `**"KEY" → suite {id} — {path}`** or `**"KEY" → Not found**`. New Test Cases are **linked to that suite**. If no suite matches, `**ADO_SYNC_SUITE_ID`** / `**ADO_SYNC_TEST_PLAN_URL**` (suite only) is used as **fallback** when set. If the bulk call fails, the client **falls back** to walking the tree (`testplan` API per suite). Set `**ADO_SYNC_SUITE_USE_TREE_WALK=true`** to force the slow tree walk only.
6. Set `**ADO_SYNC_SUITE_MATCH_CSV_KEY=false**` only if you want to **skip** listing/matching and use `**ADO_SYNC_SUITE_ID`** / URL alone. Optional `**ADO_SYNC_SUITE_LIST_VERBOSE=true**` prints many suite lines (capped by `**ADO_SYNC_SUITE_LIST_MAX**`, default `**50**`).
7. Run the agent with `**CHECK_APPROVAL=true**` as usual. After the CSV is generated, work items are created; the run logs `Azure DevOps Test Case #…` lines.

**Naming in Azure DevOps:** create or rename a suite so its **title** (or a segment of the path) includes the Jira key, e.g. a suite named `**PROJ-123`** or `**… / PROJ-123 / …**`, so the matcher can find it.

### Area Path

Two optional settings, `.env`-only — they are not on the Setup card. Neither is required.

| Key | What it does |
|---|---|
| `ADO_DEFAULT_AREA_PATH` | Used when the CSV's Area Path column is empty, and shown to the model as the value to generate. Empty falls back to `ADO_PROJECT`, because a project's root Area Path in Azure DevOps *is* the project name. |
| `ADO_AREA_PATH_PREFIX` | Prepended to a *relative* path from the CSV: `Checkout` → `YourProject\\Checkout`. A value that already starts with the prefix, or that carries a backslash of its own, is left alone. |

An Area Path that does not exist in the project is not fatal: Azure DevOps answers TF401347, and
the work item is retried without the field, landing at the project root with a warning in the log.

### Pick a Test Suite (plan id + suite id)

In the browser the URL looks like:  
`…/{org}/{project}/_testPlans/define?planId=1234&suiteId=5678`  

- `**suiteId**` matches `**ADO_SYNC_SUITE_ID**`, `**-s**`, and the REST API. For **automatic approval sync**, `**planId` in the URL is not used** — use `**ADO_ACTIVE_TEST_PLAN_ID`** for the plan (see §9 *Automatic sync*). For **manual** `ado:sync-csv`, `**planId*`* matches `**ADO_SYNC_PLAN_ID**`, `**-p**`, etc.  
- The `**org**` / `**project**` path segments (e.g. `your-org` / `YourProject`) map to `**ADO_ORG**` / `**ADO_PROJECT**` — do not confuse them with the plan id.

Ways to choose ids:

1. **Manual sync:** copy `**planId`** / `**suiteId**` into `**ADO_SYNC_PLAN_ID**` / `**ADO_SYNC_SUITE_ID**`, or paste the full URL into `**ADO_SYNC_TEST_PLAN_URL**`.
2. **Automatic approval sync:** set `**ADO_ACTIVE_TEST_PLAN_ID`** (plan); suite is resolved by **Jira key in the CSV file name** vs suite **titles/paths** in that plan, with `**ADO_SYNC_SUITE_ID`** / URL as fallback.
3. `**npm run ado:list-plans**` — plan id is the first column.
4. `**npm run ado:list-suites -- <planId>**` — the `**suiteId**` column for each suite.
5. CLI (`ado:sync-csv` only): `**-p**` / `**-s**` or `**-u "https://dev.azure.com/…/define?planId=…&suiteId=…"**`.

### Manual sync (any CSV on disk)

**Bash**

```bash
npm run ado:sync-csv -- "/path/to/approved-testcases-PROJ-123.csv"
```

**PowerShell**

```powershell
npm run ado:sync-csv -- "C:\path\to\approved-testcases-PROJ-123.csv"
```

With a specific suite (overrides the saved settings for this run):

**Bash**

```bash
npm run ado:sync-csv -- --plan-id 1234 --suite-id 5678 "/path/to/approved-testcases-PROJ-123.csv"
npm run ado:sync-csv -- -p 1234 -s 5678 ./approved.csv
npm run ado:sync-csv -- -u "https://dev.azure.com/your-org/YourProject/_testPlans/define?planId=1234&suiteId=5678" ./approved.csv
```

**PowerShell**

```powershell
npm run ado:sync-csv -- --plan-id 1234 --suite-id 5678 "C:\path\to\approved-testcases-PROJ-123.csv"
npm run ado:sync-csv -- -p 1234 -s 5678 .\approved.csv
npm run ado:sync-csv -- -u "https://dev.azure.com/your-org/YourProject/_testPlans/define?planId=1234&suiteId=5678" .\approved.csv
```

You can mix CLI options and environment variables (e.g. `ADO_SYNC_PLAN_ID` set, `**--suite-id**` on the command line). Plan id and suite id must both be set somewhere, or both omitted (work items are created but not added to a plan suite).

Optional: `**ADO_SYNC_JIRA_KEY=PROJ-123**` or `**--jira-key PROJ-123**` / `**-j**` so the tag `**Jira:PROJ-123**` is set on each new Test Case.

### Extra environment variables (sync)


| Variable                                 | Purpose                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADO_SYNC_BDD_FROM_PROMPT`               | Default **on** (`false` / `0` / `no` to disable). When on, **after** each Test Case is created in Azure DevOps, the importer converts each **test case**'s approved steps into one Gherkin Scenario — batched, up to `ADO_BDD_BATCH_SIZE` cases per LLM call, with the ticket used only as a short glossary — and writes it into **System.Description**. A **checklist** work item still gets a whole-ticket Feature designed from the requirement (prompt in **TEST_CASE_FORMAT.md → "Prompt: BDD / Gherkin for Azure DevOps Summary"** as the fallback) (Summary tab → Description). Requires `OPENROUTER_API_KEY`. Mode (`test_case` / `checklist`) is auto-detected per Test Case based on Step Expected fill rate. Failures of BDD generation are non-fatal: a warning is logged and the imported work item is preserved with empty Description. **Exception — a case that is already a Gherkin scenario** (generated with the Create page's *Test design format: BDD*, i.e. `TEST_DESIGN_FORMAT=bdd`) gets **no Description and no LLM call**: its steps already are the scenario, so a second copy would duplicate the work item's own content. Detected per case by reading the CSV, so the manual `npm run ado:sync-csv` behaves the same. |
| `ADO_BDD_BATCH_SIZE`                     | Test cases converted to Gherkin per LLM call (default `10`). A batch that is cut off or unparsable is split in half and retried. |
| `ADO_BDD_STYLE`                          | Shape of the Gherkin summary written into **System.Description** for a test case: `auto` (default) — a case with more than `ADO_BDD_SPLIT_STEPS` steps becomes **2–5 short Scenarios** (one per distinct behaviour, 3–6 lines each), a shorter case **one compact Scenario** of at most 10 lines; `compact` / `split` force one shape; `full` — one Scenario with every Expected result as a Then/And line (the previous behaviour). The summary is written at the behaviour level — environment setup, repeats and secondary UI facts stay on the Steps tab. Applies to every flow that imports into Azure DevOps (Create, Update, Cover a bug, Manual Import). A **checklist** work item's whole-ticket Feature follows the same brevity: Scenarios of 3–6 lines, usually 3–6 of them (`full` restores the exhaustive Feature). |
| `ADO_BDD_SPLIT_STEPS`                    | Step count (preconditions not counted) above which `ADO_BDD_STYLE=auto` splits the summary into several Scenarios (default `10`). |
| `ADO_BDD_TICKET_CONTEXT_CHARS`           | How much of the ticket description goes into the batch prompt as domain vocabulary (default `3000`; `0` = none). |
| `ADO_SYNC_BDD_MAX_TOKENS`                | Minimum max-tokens for a BDD LLM call (default `4000`); a batch gets at least 1200 per case + 1000.                                                                                                                                                                                                                              |
| `ADO_TEST_CASE_WORK_ITEM_TYPE`           | Defaults to `Test Case` (change if your process renames the type)                                                                                                                                                                                                                           |
| `ADO_JIRA_TAG_PREFIX`                    | Defaults to `Jira`; tag becomes `Jira:STORY-KEY`                                                                                                                                                                                                                                            |
| `ADO_ACTIVE_TEST_PLAN_ID`                | **Required for automatic approval sync** — Test Plan id where new cases are linked (same as `**ADO_ACTIVE_TEST_PLAN_ID`** for export/list). **Not** used by manual `ado:sync-csv` (that uses `ADO_SYNC_PLAN_ID` / `ADO_SYNC_TEST_PLAN_URL` / `-p`). Legacy `ADO_TEST_PLAN_ID` if unset.     |
| `ADO_SYNC_PLAN_ID` / `ADO_SYNC_SUITE_ID` | Same numbers as `**planId` / `suiteId`** in the Test Plan page URL — **manual** `ado:sync-csv` and CLI. **Automatic approval sync:** set `**ADO_SYNC_SUITE_ID`** (and suite from URL if needed); **do not** rely on `**ADO_SYNC_PLAN_ID`** for the plan (use `**ADO_ACTIVE_TEST_PLAN_ID**`) |
| `ADO_SYNC_TEST_PLAN_URL`                 | Full browser URL `…/define?planId=…&suiteId=…` — **manual** sync: full plan/suite. **Automatic approval sync:** **suite id** from URL is used as **fallback** when no suite matches the Jira key; **plan id in URL is ignored**                                                             |
| `ADO_SYNC_SUITE_MATCH_CSV_KEY`           | Default **on** (set to `false` to disable). When on, automatic sync lists suites and matches **Jira key from CSV filename** to suite name/path                                                                                                                                              |
| `ADO_SYNC_SUITE_LIST_VERBOSE`            | `true` to print many suite id/path lines after load (default: **one** line — match or **Not found**)                                                                                                                                                                                        |
| `ADO_SYNC_SUITE_LIST_MAX`                | With verbose: max suite lines printed (default `**50`**; full list is still loaded for matching)                                                                                                                                                                                            |
| `ADO_SYNC_SUITE_USE_TREE_WALK`           | `true` = do **not** use bulk `GET .../test/Plans/.../suites`; use slow per-node tree API only                                                                                                                                                                                               |
| `ADO_TEST_PLAN_BULK_API_VERSION`         | API version for bulk suite list (default `**5.0`** only — no 7.x probe; override if your server requires another version)                                                                                                                                                                   |


---

## 8. Files in the repository


| File                    | Role                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ado-client.js`         | Plans, suites, cases, **WIQL**, get work items, **create work items**, **add cases to suite**, `**listFlatSuitesInPlan`** (suite tree for sync matching) |
| `ado-plan-tools.js`     | CLI: `list` / `suites` / `export` (optional snapshot)                                                                                                    |
| `ado-sync-csv.js`       | Parse approved CSV → create Test Cases in Azure DevOps; CLI `ado:sync-csv`                                                                               |
| `ado-export-tag-csv.js` | WIQL by tag → agent CSV in `Test cases/`; CLI `ado:export-tag-csv`                                                                                       |
| `ado-context-store.js`  | Test Cases picked plan-by-suite in the Web UI → accumulating generation context in `.ado-context/` (see section 10)                                     |
| `ADO_TEST_PLANS.md`     | This guide                                                                                                                                               |


`ado-exports/` is in `.gitignore` for optional JSON snapshots.
---

## 10. Pick Work Items as generation context (Web UI)

Instead of exporting a CSV first, you can read Test Case work items **straight out of Azure DevOps**
and hand them to the model as context. This is on both the **Create new test design** and
**Update test design** pages, in the card **“Add context from Azure DevOps”**.

This section describes the card while Azure DevOps is the provider marked **In use**. With another
provider In use the same card reads **Add context from ‹provider›** and browses that provider's own
tree instead (TestRail: Suite → Section; Zephyr Essential and Xray: folders) — see
[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) §2.

### How to use it

1. Open the **Test Plan** dropdown (the plan list loads on first open).
   Only **active** plans are listed — a long-lived project accumulates dozens of archived sprint
   plans that bury the handful anyone picks context from. Tick **Include inactive plans** when you
   need test cases out of an archived one.
2. Pick a plan — its **whole suite tree** loads in one request.
3. Click the caret on a suite to load its **test cases**. Tick individual cases, or use the
   suite-level checkbox to take every case in that suite.
4. Leave **Include full steps** on to send the complete step-by-step text, or turn it off for
   **titles only** — far cheaper in tokens and often enough to align wording and style.
5. Click **Add N selected to context**.

**Adds accumulate.** Every Add appends one *source*, so you can go back to the dropdown, pick a
different plan or suite, and add again. The list under the tree shows one row per source with its
case count, mode and size, each removable on its own; **Clear all sources** drops everything.

A work item already covered by an earlier source is skipped rather than added twice — the same
Test Case often sits in several suites, and paying for its steps twice in one prompt is waste.

### Where it is stored

`.ado-context/` in the project folder (git-ignored):

- `selection.json` — the index: one record per source with plan/suite ids, work item ids and mode;
- one `<uuid>.csv` (with steps) or `<uuid>.txt` (titles only) per source, resolved at Add time.

Resolving at Add time is deliberate: a later generation run needs no network access, the UI can
show a real case count and byte size before you spend tokens, and the run is reproducible.

### How it reaches the prompt

| Flow   | Path |
| ------ | ---- |
| Create | merged into `projectTestCases` by `loadProjectTestCases()` in `agent-docs.js`, alongside the `Test cases/` folder |
| Update | its own reference block, built by `buildAdoContextBlock()` in `prompts-docs.js` |

> **Create flow only:** picked context goes through the same **“Analyze existing test cases”**
> switch as the `Test cases/` folder. Set it to **No** and the selection is not used — the panel
> warns you when that happens.

### Why a separate folder and not `Test cases/`

`Clear folder` on the Create page deletes everything in `Test cases/`, and `ado-export-tag-csv.js`
wipes sibling CSVs on every run. A picked selection kept there would disappear at unpredictable
moments, so it gets its own folder and both are merged at generation time.

### Environment variables

| Variable                            | Default | Purpose |
| ----------------------------------- | ------- | ------- |
| `ADO_CONTEXT_MAX_IDS_PER_SOURCE`    | `500`   | Cap on work items in a single Add |
| `ADO_MAX_PAGES`                     | `200`   | Continuation-token page cap for paginated list calls |

### Active vs inactive plans

The picker asks Azure DevOps for active plans only (`filterActivePlans=true`), so the filtering
happens server-side — 8 rows instead of 72 on a project like YourProject. The authority is the plan's
own `state` field; a team convention of naming archived plans `[INACTIVE] Sprint 47` lines up with
it but is not what the filter reads.

The **Setup page** plan picker deliberately still lists *every* plan: it displays the stored
`ADO_ACTIVE_TEST_PLAN_ID`, and hiding an already-saved inactive plan there would make a valid
saved config look empty. That is why `listAdoTestPlans()` defaults `activeOnly` to `false` and only
the context picker opts in.
