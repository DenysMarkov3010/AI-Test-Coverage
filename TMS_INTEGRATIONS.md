# Test management systems — how the four providers compare

The approved test design can be imported into four test management systems: **Azure DevOps**,
**TestRail**, **Zephyr Essential** and **Xray**. This document is the side-by-side view: what every
provider shares, and where each one differs. The setup and the details of each live in its own
document:

| Provider | Document |
|---|---|
| Azure DevOps | [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md) |
| TestRail | [TESTRAIL.md](TESTRAIL.md) |
| Zephyr Essential | [ZEPHYR.md](ZEPHYR.md) |
| Xray | [XRAY.md](XRAY.md) |

---

## 1. What is shared

**One provider at a time.** Each provider has a card under *Test management* on the Setup page,
with its own credentials, live pickers and **Test connection** button. Configure as many as you
like; the one marked **In use** (`TMS_PROVIDER`: `ado`, `testrail`, `zephyr`, `xray`) is the target
of every run. The Create, Update and Cover a bug pages read that toggle to name the destination and
to show the right pickers.

**One CSV.** Generation, review and approval do not depend on the provider. Submit writes the
approved rows as one CSV — columns ID, Work Item Type, Title, Test Step, Step Action, Step
Expected, Priority, Area Path, Assigned To, State ([TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)) — and
every importer reads that same file. The parser (`parseCsvRows` / `csvRowsToTestCases` in
[ado-sync-csv.js](ado-sync-csv.js)) turns it into a provider-neutral shape:

```js
{
  refId:    "1",              // CSV column "ID"
  title:    "Order is created…",
  priority: "2",
  areaPath: "Web Store",      // CSV column "Area Path"
  steps: [{ stepNumber: 1, action: "…", expected: "…" }]
}
```

**One routing point.** `agent-docs.js` picks the importer for the provider In use
(`maybeSyncCsvToTms`); each provider has one writer next to its client:

| Provider | Client | Importer | npm script |
|---|---|---|---|
| Azure DevOps | `ado-client.js` | `ado-sync-csv.js` | `ado:sync-csv` |
| TestRail | `testrail-client.js` | `testrail-sync-csv.js` | `testrail:sync-csv` |
| Zephyr Essential | `zephyr-client.js` | `zephyr-sync-csv.js` | `zephyr:sync-csv` |
| Xray | `xray-client.js` | `xray-sync-csv.js` | `xray:sync-csv` |

**Features that work the same for all four:**

- **Three ways to import** — the automatic import after Submit (container matched from the Jira
  key, needs only the provider In use with its required fields filled), the **Manual Import** step
  (container picked on the page), and **Cover a bug** (one regression case, container picked on the
  page). See [FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) §4–§6.
- **Standard or BDD** test design format. A Gherkin scenario travels in the ordinary CSV with its
  keywords inside the step text ([web/bdd-format.js](web/bdd-format.js)); each importer stores it
  in its own way (§3).
- **Add context from ‹provider›** — tick existing test cases in the provider and show them to the
  model ([tms-context.js](tms-context.js)). Picks are kept in `.ado-context/` (the name predates the
  other providers).
- **Regenerate guidance** — naming a suite, section or folder in the regenerate box pulls its cases
  in as context.
- **Format examples** — one set of house-style examples on the Setup page, used whichever provider
  is In use. **Add from ‹provider›** turns ticked cases into examples; BDD cases become BDD examples
  for the Gherkin prompts.
- **Import creates new cases.** No importer edits an existing case in place, in any flow,
  including Update.

---

## 2. How the four compare

| | Azure DevOps | TestRail | Zephyr Essential 2.0 (Cloud) | Xray Cloud |
|---|---|---|---|---|
| API | REST | REST | REST | GraphQL (+ REST to authenticate) |
| Base URL | `https://dev.azure.com/{org}` | `https://{instance}.testrail.io` | `https://prod-api.zephyr4jiracloud.com/v2` | `https://xray.cloud.getxray.app` (or a regional host) |
| Auth | Basic, `:{PAT}` | Basic, `email:{API key}` | `Bearer {token}` | Client ID + Secret → 24 h token |
| A test case is | a work item | a TestRail case | a Zephyr entity | a **Jira issue** of type Test |
| Hierarchy | Project → Plan → Suite | Project → Suite → **Section** | Project → **Folder** | Project → Test Repository **folder** |
| Fixed on Setup | Active Test Plan | Project + Suite | Project | Project + root folder |
| Container per ticket | Suite with the Jira key in its name; never created | Section with the key; created when *Create missing section* is on | Folder with the key; created when *Create missing folder* is on | Folder with the key under the root; created when *Create missing folder* is on, otherwise the root |
| Picked by hand (Manual Import, Cover a bug) | Test Plan → Test Suite | Suite → Section | Folder | Folder |
| Jira key on the case | tag `Jira:PROJ-123` | `refs` | label + Jira issue link | label + Jira issue link |
| Area Path | `System.AreaPath` | not used | label | label |
| Priority | 1–4 | `priority_id` (looked up) | by name | not set |

---

## 3. Where the providers differ

### BDD scenarios

| Provider | How a Gherkin scenario is stored | Preconditions |
|---|---|---|
| Azure DevOps | Gherkin lines in the normal steps field (`Microsoft.VSTS.TCM.Steps`) | first step, as in the CSV |
| TestRail | the **Behaviour Driven Development** template, `custom_testrail_bdd_scenario`; falls back to the text template when the instance has none | `custom_preconds` |
| Zephyr Essential | a **BDD test script** instead of steps | `precondition` |
| Xray | a **Cucumber** test (standard cases become Manual tests) | `#` comment lines above the scenario |

### Features only one provider has

| Feature | Provider | Why only there |
|---|---|---|
| **Test design** QA sub-task — Submit attaches the CSV and posts comments on the story's sub-task, and the run fails without one | Azure DevOps | The other providers attach to the Jira issue you typed |
| Generated Gherkin **Description** for standard cases (`ADO_SYNC_BDD_FROM_PROMPT`, converted from the approved steps, up to 10 cases per LLM call) | Azure DevOps | The others have no matching field; their imports make no LLM calls |
| **Export by tag** on the Create page, `ado:export-tag-csv`, `ado:list-plans` / `ado:list-suites` / `ado:export-plan` | Azure DevOps | Tags are queried with WIQL; the others have no equivalent query |
| **Include inactive plans** in the pickers | Azure DevOps | Only Azure DevOps has plan state |
| Area Path settings (`ADO_DEFAULT_AREA_PATH`, `ADO_AREA_PATH_PREFIX`; `.env` only, not on the Setup card) | Azure DevOps | Only Azure DevOps has an area axis |
| Template, case type and steps-field settings | TestRail | Step fields are per instance — see below |
| **Use selected as CSV** on the Update page, `tms:export-csv` | Zephyr Essential, Xray | Cases are read back into the CSV the Update flow starts from ([tms-export-csv.js](tms-export-csv.js)) |
| Separate Jira credentials, plus region and issue-link type (`.env` only) | Xray | Xray tests are Jira issues, and Xray may live on a different Jira site than the tickets |

### Things worth knowing before you configure one

**"Zephyr Essential" does not identify an API on its own.** SmartBear ships two experiences under
that name. **2.0 (New Experience)** — the one supported here — is a bearer token at `.../v2`, and
its test cases are Zephyr entities. **1.0 (Legacy Experience)**, the former Zephyr Squad, is at
`.../connect`, signs every request with an access key + secret key pair, and its test cases are Jira
issues of type Test. The token screen tells them apart: 2.0 lists **Access Tokens** under the Jira
profile menu, 1.0 shows **API Keys** under Apps → Zephyr Squad. Plain **Zephyr** (the former Zephyr
Scale) is a third product again. Picking the wrong one produces a 401 that reads exactly like a
typo. Details: [ZEPHYR.md](ZEPHYR.md).

**TestRail step fields are per instance.** `custom_steps_separated` exists only when the project
uses a template that has it ("Test Case (Steps)"); a project on the plain template stores a single
text blob in `custom_steps`. The importer reads `get_case_fields` and picks the field that exists,
or uses the steps-field setting. Details: [TESTRAIL.md](TESTRAIL.md).

**An Xray test is a Jira issue.** It is created in the project set on the card, and Jira labels
cannot contain spaces — an Area Path of `Customer Portal` becomes the label `Customer_Portal`. The
Xray keys are not a Jira API token. Reading the project and linking each test to the story use the
Xray card's own Jira credentials, or the main Jira card's when those are empty; when the story lives
on another Jira site, the key stays on the test as a label only. Details: [XRAY.md](XRAY.md).

**Azure DevOps never creates a suite.** When no suite in the active plan carries the Jira key, the
import falls back to `ADO_SYNC_SUITE_ID`. Details: [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md) §9.

---

## 4. Adding a fifth provider

What a new provider needs, judging by the four that exist:

1. **A client** next to the others (`<provider>-client.js`): authentication, list projects and
   containers, create a case with steps, and a cheap call for **Test connection**.
2. **An importer** (`<provider>-sync-csv.js`) that takes the shared parser's output, finds or
   creates the container for the Jira key, writes title, steps, priority and the Jira key, and
   returns `{ created, errors }`. Handle BDD cases (`web/bdd-format.js` detects them).
3. **A Setup card** in `config-store.js`, including its **In use** toggle and the live pickers
   (`REMOTE_LISTS`).
4. **Routing** — the importer registered in `agent-docs.js` next to the other four, an adapter in
   `tms-context.js` for the context picker and regenerate guidance, and the picker fields in
   `web/tms-target-panel.js` for Manual Import and Cover a bug.
5. **A document** like the four above, and a row in each table here.
