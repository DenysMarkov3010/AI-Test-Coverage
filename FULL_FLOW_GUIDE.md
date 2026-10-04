# Full Flow Guide — from Jira to CSV (and into your test management system)

> **Keys, URLs and defaults** are configured on the **Setup** page of the Web UI
> (<http://127.0.0.1:3847/setup.html>). Where this guide names a variable, the value has a field on
> that page — or, for the few with no field, is set as an environment variable for the run.

This is the **single operational guide**. Read it once and you'll know every command the agent supports.

- New to the project? Start with **[README.md](README.md)** first.
- Need CSV column descriptions? **[TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md)**.
- Provider details? **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** (Azure DevOps) · **[TESTRAIL.md](TESTRAIL.md)** · **[ZEPHYR.md](ZEPHYR.md)** · **[XRAY.md](XRAY.md)** · how they compare: **[TMS_INTEGRATIONS.md](TMS_INTEGRATIONS.md)**.
- Re-doing an existing CSV after requirements changed? **[UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)**.

## What the agent does, in 5 stages

| # | Stage | Who runs it | Result |
|---|---|---|---|
| 0 | Setup | You (once) | Node.js, `npm install`, the Web UI started, a filled-in Setup page. |
| 1 | (Optional) Check the test management system | You (once) | Confirm the provider you use accepts your credentials. |
| 2 | **Day 1** — generate | Agent | A checklist or test cases, shown in the Web UI for editing. |
| 2b | Edit & approve | You | Fix items in the UI and mark each one **APPROVED**. |
| 3 | Submit | You | **Submit to Jira** writes the approved rows as a CSV, saved locally and attached to the ticket. |
| 4 | Import | Agent | The attached CSV becomes test cases in the provider In use (Azure DevOps, TestRail, Zephyr Essential or Xray). |
| 5 | (Optional) Manual import | You | The approved CSV (or, on the CLI, any CSV) goes into a container you pick, without the Jira-key match. |

Every run targets exactly one Jira ticket.

> **Watching a run:** the log prints `→ Asking <model>…`, ticks every 5 s while the model is
> thinking, and closes with `← <model> responded after Ns` plus the token spend for the run. The
> run-log heading also carries a live `running Ns` clock. Set `DEBUG_PLACEHOLDER_GUARD=true` if you
> want to see which redaction placeholders were cleaned out of the model's answer.

> **Tip:** you don't have to type any of the commands below. Start the Web UI with the launcher —
> `bash scripts/launch-ai-test-coverage.sh` (macOS) or
> `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1` (Windows), or the
> **AI Test Coverage** Desktop shortcut — and click. It starts the server if needed and opens
> <http://127.0.0.1:3847/>; the Web UI runs the same commands for you.

## Conventions in this document

- **Bash** = macOS, Linux, Git Bash for Windows.
- **PowerShell** = Windows.
- Replace `PATH_TO_PROJECT` with your project folder (the one that contains `agent-docs.js` and `package.json`).
- Examples use `PROJ-123` as a placeholder Jira key. Use your actual key.

---

## 0. One-time setup

Fill in the **Setup** page with at least these values:

| Variable | Where to get it |
|---|---|
| `JIRA_BASE_URL` | `https://<your-company>.atlassian.net` (no trailing slash) |
| `JIRA_EMAIL` | The email you sign into Jira with |
| `JIRA_API_TOKEN` | <https://id.atlassian.com/manage-profile/security/api-tokens> |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> |
| `JIRA_PROJECT_KEY` | Your project prefix, e.g. `PROJ` |

Then install dependencies:

**Bash**

```bash
cd PATH_TO_PROJECT
npm install
```

**PowerShell**

```powershell
cd PATH_TO_PROJECT
npm install
```

This is a one-time step per checkout. Then start the Web UI and open **Setup**:

| | Command |
|---|---|
| macOS | `bash scripts/launch-ai-test-coverage.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1` |
| Linux, or by hand | `npm run web`, then open <http://127.0.0.1:3847/> |

The launcher starts the server in its own window if it is not running yet and opens the page in
Chrome (or the default browser). The first start also creates the **AI Test Coverage** Desktop
shortcut on macOS and Windows, which does the same.

---

## 1. (Optional) Check the test management system

Skip this section if you only want the CSV.

On the **Setup** page, fill in the card of the provider you use — Azure DevOps, TestRail, Zephyr
Essential or Xray — mark it **In use**, and press **Test connection**. It checks the credentials
against the real service and says what it found. What each card needs:
[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md), [TESTRAIL.md](TESTRAIL.md), [ZEPHYR.md](ZEPHYR.md),
[XRAY.md](XRAY.md).

Azure DevOps can also be checked from the command line (needs `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT`):

**Bash**

```bash
npm run ado:list-plans
```

**PowerShell**

```powershell
npm run ado:list-plans
```

**Expected:** the console lists your Test Plans (id and name). If the list is empty or you see errors, the PAT is missing the **Test (Read)** scope, or `ADO_ORG` / `ADO_PROJECT` is wrong.

---

## 2. Day 1 — generate checklist or test cases

The agent reads the Jira ticket you give it — its parent story, when you give it a sub-task — and drafts either a **checklist** (numbered scenarios) or **test cases** (structured steps with expected results).

### Test design format: Standard or BDD

The Create page has a **Test design format** toggle, and it applies to every test management
system — Azure DevOps, TestRail, Zephyr Essential and Xray — because the format never changes how
the design is delivered, only what it says.

| | Standard | BDD |
| --- | --- | --- |
| Output | Step Action + Step Expected per step | one Gherkin `Scenario` per test case |
| Generation mode | Checklist or Test cases | Test cases (a Feature is made of Scenarios; "BDD checklist" is not a thing, so the selector is pinned) |
| Env var | *(default)* | `TEST_DESIGN_FORMAT=bdd` |

A scenario travels through the flow in the **same approved CSV** as a standard case — the
Given/When/Then keywords are kept inside the step text, so nothing else in the pipeline needs a
second format:

```
ID       Work Item Type  Title                           Test Step  Step Action                              Step Expected
PROJ-123  Test Case       Manager sees latest order
                                                         1          Given the manager is signed in
                                                         2          When the manager opens "Orders"          Then the "Latest order" card is displayed
                                                                                                             And the order date is in the store time zone
```

Each `Given` / `When` line gets its own step row so the steps grid stays readable line by line;
the `Then` lines land in the Expected column of the row they verify, which is what that column is
for. The conversion lives in [web/bdd-format.js](web/bdd-format.js) and is reversible — that is
what lets the Update flow recognise a Gherkin case with no extra CSV column.

**After the import:**

- **Azure DevOps** — Title = the Scenario name, `Microsoft.VSTS.TCM.Steps` = the Gherkin lines,
  tag `Jira:PROJ-123`, priority and Area Path as usual. **Summary / `System.Description` is left
  empty**: the steps already *are* the scenario, so the import no longer generates a second
  Gherkin copy there (and spends no LLM call doing it). Standard cases are unaffected —
  `ADO_SYNC_BDD_FROM_PROMPT` still generates their Description as before.
- **TestRail** — a scenario gets its **own template**: `"Behaviour Driven Development"`, with the
  whole `.feature` text in `custom_testrail_bdd_scenario` (TestRail's native Gherkin field) and the
  setup in `custom_preconds`. `refs = PROJ-123`, priority and case type as usual. Standard cases keep
  `TESTRAIL_TEMPLATE_ID` — the template is picked per case, so a mixed CSV lands correctly in one
  run. The target is auto-detected from `get_case_fields`, so there is no extra Setup field;
  instances with no BDD template fall back to `Test Case (Text)`. Details and the API quirks
  involved: [TESTRAIL.md](TESTRAIL.md) section 7.
- **Zephyr Essential** — a scenario is stored as a **BDD test script** instead of steps, and the
  setup goes to `precondition`. Labels carry `PROJ-123` and the Area Path, plus a real Jira issue
  link. See [ZEPHYR.md](ZEPHYR.md).
- **Xray** — a scenario becomes a **Cucumber** test (standard cases are Manual tests), and the
  setup is kept as `#` comment lines above it. Labels carry `PROJ-123` and the Area Path, plus a
  Jira issue link. See [XRAY.md](XRAY.md).

**Preconditions are generated separately from the `Given` lines**, because they answer different
questions: `Given` is the scenario's business context and stays in the Gherkin, while Preconditions
is what a *run* needs first — environment, build, access, seeded data, feature flags. A scenario
carries them in the CSV exactly like a standard case (step 1, `"Preconditions: …"`, expected `—`),
so no column was added; `splitPreconditionsRow()` peels that row off before the Gherkin is read or
detected. An empty value is normal and preferable to invented prerequisites.

Bash: add `TEST_DESIGN_FORMAT=bdd`. PowerShell: `$env:TEST_DESIGN_FORMAT="bdd"`.

### Where the draft goes

- **Web UI:** the draft appears on the *Create new test design* page for editing and **nothing is posted to Jira yet**. See [Editing the draft before it reaches Jira](#editing-the-draft-before-it-reaches-jira) below.
- **CLI:** `node agent-docs.js` still posts the draft straight to the Jira comment, exactly as before. The review step is a Web UI feature; the command-line flow is unchanged.

The Update test design flow has the same review and approval step — see [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md), where each CSV block is reviewed and approved separately, and each becomes a section of the one CSV.

### Generate

**Checklist (default)**

**Bash**

```bash
cd PATH_TO_PROJECT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_PROJECT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
node agent-docs.js
```

**Test cases**

**Bash**

```bash
cd PATH_TO_PROJECT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false GENERATE_MODE=testcases node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_PROJECT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="false"
$env:GENERATE_MODE="testcases"
node agent-docs.js
```

**Want to influence the related-issue search for this run?** Add `RELATED_ISSUES_KEYWORDS="comma, separated, phrases"`. The agent still returns at most 30 related issues — keywords just steer the search. On the web UI, the **Preview** button next to Related Keywords runs the exact same search and shows the matching issues *before* you spend a generation run — tune the keywords until the list looks right.

### Context the generation uses (and how to see it)

Every Day 1 comment now ends with a **Context used** section: which related issues, Confluence pages, existing test case files, Figma frames and prototype screens the draft was based on. When existing test cases were analyzed, the comment also includes **Coverage notes** — which scenarios were already covered by existing tests (and deliberately not duplicated), plus gaps the agent noticed in the existing coverage.

Related knobs (env vars, or the Setup page → Jira card):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELATED_ISSUES_TYPES` | `Story, Improvement` | Issue types included in the related search. Add `Bug` to learn from past defects in the area. |
| `ENABLE_RELATED_CHECKLISTS` | `true` | For up to 5 closest related issues, reuse the QA scenarios the agent previously posted on their Test design sub-tasks, so new drafts align with (and don't duplicate) them. Only finds something where related issues have a **Test design** QA sub-task — the Azure DevOps convention. |
| `ENABLE_TEST_CASES_ANALYSIS` | `false` (CLI) / `Yes` (web UI) | Analyze CSV/TXT files in the project `Test cases/` folder (style + coverage alignment). The create page owns this per run via **Analyze existing test cases** (default Yes); for CLI runs set the env var explicitly. |

The web UI (Create page) also shows a **Generation context** panel under the tag export: which files sit in `Test cases/`, how many cases they contain, how fresh they are, and whether the next run will actually use them — with **Refresh** / **Clear folder** buttons.

The tag export appears **only while Azure DevOps is the provider marked In use** on the Setup page — it is a WIQL query, and the other providers have no tags to query. The **Steps** dropdown names whichever provider is in use ("Automate import into TestRail", and so on).

Below it, **Add context from <provider>** lets you skip the CSV export entirely: browse the test management system that is In use, tick the exact test cases you want the model to see, and click Add. What you browse depends on the provider:

| In use | Browse |
|---|---|
| Azure DevOps | Test Plan → Test Suite. The dropdown lists **active plans only**; tick **Include inactive plans** to reach archived ones. |
| TestRail | Suite → Section. A single-suite project skips the suite dropdown. |
| Zephyr Essential | Folders of the project set on the Setup page. |
| Xray | Test Repository folders of the project set on the Setup page. |

Each Add appends a source, so selections from several plans, suites and folders stack up; **Include full steps** off sends titles only, which is far cheaper in tokens. The same card is on the Update page. Picks stay in `.ado-context/` in the project folder (the name predates the other providers). Azure DevOps walkthrough: [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md) section 10.

> On the Create page this context is gated by the same **Analyze existing test cases** switch as `Test cases/` — set it to No and the selection is skipped (the panel says so).

---


### Editing the draft before it reaches Jira

After **Run** finishes, the Web UI shows a **Review generated …** panel. Nothing has been posted to
Jira at this point — the draft lives in a short-lived local session next to your project (a
`.review-sessions/` folder, git-ignored, pruned after 24 h).

**Checklist drafts**

- Edit any item's text in place; change its category (Functional / Negative / Boundary / Integration).
- Reorder with ↑ / ↓, remove with ✕.
- **+ Add checklist item** appends a new one; pick its category next to the button.
- The ⟳ icon on an item regenerates just that item. It opens a box where you can type extra
  context ("cover revoked access in Google settings"), which is sent to the model as reviewer
  guidance together with the original issue context. The other items are passed along too, so the
  rewrite does not duplicate coverage that already exists.
- **Regenerate all** at the top redoes the whole checklist, and takes the same optional context.
- The context box can also point at existing test cases: name a suite, section or folder of the
  provider In use ("consider the related areas in the Payments and Refunds suites") and its cases
  are fetched from that TMS and shown to the model for this regeneration. A name counts when it
  appears as written, in quotes («Checkout / Refunds»), or as an id after "suite" / "сьют" / `#`;
  very generic names (Smoke, Regression, UI…) only count when quoted or after such a word. A
  message after the regeneration lists what was used, and any quoted name that was not found.
  At most 60 cases (`TMS_GUIDANCE_MAX_CASES`) from 8 containers are added per regeneration. For
  Azure DevOps the suites of the Setup page's active Test Plan, and of plans you already picked
  from, are searched.
- Every regeneration also re-reads the picked context above, so a source added after the first
  run is used too.

**Test case drafts**

- Edit the title, Priority and Area Path of each case. (Area Path is an Azure DevOps field; Zephyr
  and Xray carry it as a label, TestRail does not use it.)
- The steps table is editable cell by cell; Step Action and Step Expected grow as you type.
- Per step row: ↑ / ↓ to move it, ✕ to delete it. Steps are renumbered automatically.
- **+ Add step** appends a row at the end of that case.
- ⟳ works at **test case level only** (not per step) and takes the same optional context box.

**Submit**

**Submit to Jira** writes exactly the rows marked APPROVED — the edited content, not the original
generation — as the CSV, attaches it in Jira and links it from a comment. It lands on the issue you
typed; with Azure DevOps In use, on the story's **Test design** QA sub-task instead. The
design itself is not posted: you already read it here, and the CSV is what the next step needs.

If a regeneration or the submit fails, the error is shown in the panel and your edits stay put, so
you can retry without losing work.


## 3. Approve in the review panel

Approving is part of reviewing now — it happens on the same screen, one row at a time.

Every checklist item and every test case carries an **Approve** button. Nothing starts approved: a
row reaches a test management system because someone read it and said so, not because Submit was
pressed quickly. Once a row is marked, the button reads **APPROVED** in green.

- **Approve all** / **Clear** — per block, above the rows. Useful after you have read the block.
- The bar above each block counts what is marked: *"3 of 8 items approved"* — that is exactly what
  the CSV will hold.
- **Submit to Jira** stays off until at least one row is approved, and its hint says how many rows
  it is about to write.

Unapproved rows are simply left out of the CSV. They are not deleted, not posted, not flagged —
reviewed and not approved is an answer.

> Replying `APPROVED: 1,2,3` in Jira does nothing now. No comment is parsed anywhere in either
> flow; the CSV attached by Submit is the record of what was approved.

---

## 4. Import the approved CSV

### Run the import

Same Jira key as in stage 2. The step takes the newest CSV attached by Submit — on the ticket, or
on its Test design sub-task for Azure DevOps — and imports it into the provider In use. It reads no
comments.

The import runs only when that provider's **Auto-import approved CSV** switch is on (Setup card;
`ADO_SYNC_APPROVED_CSV`, `TESTRAIL_SYNC_APPROVED_CSV`, `ZEPHYR_SYNC_APPROVED_CSV`,
`XRAY_SYNC_APPROVED_CSV`). Where the cases land is chosen from the Jira key — see section 5.

**Bash**

```bash
cd PATH_TO_PROJECT
JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true node agent-docs.js
```

**PowerShell**

```powershell
cd PATH_TO_PROJECT
$env:JIRA_ISSUE_KEY="PROJ-123"
$env:CHECK_APPROVAL="true"
node agent-docs.js
```

### Where the CSV ends up

- **Local file:** `OneDrive/Desktop/Checklists and Test cases` in your home folder, or the folder in the `CHECKLIST_OUTPUT_DIR` environment variable.
- **File name:** `<Parent task title> (<PROJ-KEY>).csv`.
- **Jira:** the same file is attached where Submit put it (the ticket, or its **Test design** sub-task for Azure DevOps); a link is also posted as a comment.

### What to do next

- If the import ran, the cases are in your test management system — section 5 says where.
- Otherwise open the CSV in Excel, grab it from the Jira attachment, or import it by hand (section 5).

---

## 5. Where the import lands, and importing by hand

### 5A. Automatic import (stage 4)

The provider In use decides where each approved CSV goes. Every provider finds the container for a
ticket by the **Jira key** — taken from the CSV file name (`… (PROJ-123).csv`) — and stamps the key
on every case it creates.

| In use | Fixed on the Setup card | Container per ticket | Jira key on the case |
|---|---|---|---|
| Azure DevOps | Active Test Plan | Test Suite whose name or path contains the key. Never created; falls back to `ADO_SYNC_SUITE_ID` | tag `Jira:PROJ-123` |
| TestRail | Project + Suite | Section whose name contains the key; created at the suite root when **Create missing section** is on | `refs` |
| Zephyr Essential | Project | Folder whose name contains the key; created as `PROJ-123 <summary>` when **Create missing folder** is on (default), otherwise the import stops | label + Jira issue link |
| Xray | Project + root folder | Folder under the root whose name contains the key; created when **Create missing folder** is on (default), otherwise the cases go to the root folder | label + Jira issue link |

Provider-specific details — fields, priorities, BDD, quirks — are in
[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md), [TESTRAIL.md](TESTRAIL.md), [ZEPHYR.md](ZEPHYR.md) and
[XRAY.md](XRAY.md).

#### Azure DevOps specifics

| Variable | Value |
|---|---|
| `ADO_SYNC_APPROVED_CSV` | `true` |
| `ADO_PAT` | A PAT with **Work Items: Read & write** scope |
| — | Area Path comes from the CSV's own **Area Path** column |
| `ADO_ACTIVE_TEST_PLAN_ID` | The Test Plan id where new work items should land |

To disable suite matching entirely: `ADO_SYNC_SUITE_MATCH_CSV_KEY=false`. After the CSV is written
you'll see `Azure DevOps Test Case #…` lines in the log.

> `ADO_ACTIVE_TEST_PLAN_ID` is **only** for the automatic flow. The manual `ado:sync-csv` script uses `ADO_SYNC_PLAN_ID` (or `--plan-id`) — see 5B.

**Summary / Description (`ADO_SYNC_BDD_FROM_PROMPT`, default on).** Azure DevOps only. For a
**standard** test case the import makes one LLM call per work item and writes the resulting Gherkin
into `System.Description`. For a case that is **already a Gherkin scenario** it writes nothing and
makes no call — the steps are the scenario, so a second copy would only duplicate the work item's
own content. That is decided per case, by reading the CSV, so the manual `ado:sync-csv` run in 5B
behaves exactly the same. The log says which happened. The other providers make no LLM call during
the import.

### 5B. Manual import

**Web UI:** on the Create or Update page pick **Manual Import into ‹provider›** in the **Steps**
dropdown, type the Jira key, choose the destination (the same pickers as in
[Cover a bug](#6-closing-a-coverage-gap--cover-a-bug)), and import. It takes the approved CSV
attached by Submit, exactly like stage 4, but skips the Jira-key match and the **Auto-import
approved CSV** switch: the container you picked is used.

**CLI:** one script per provider. Each takes the CSV path; without a container option it matches
the Jira key from the file name, exactly like 5A.

| Provider | Command |
|---|---|
| Azure DevOps | `npm run ado:sync-csv -- --plan-id <plan> --suite-id <suite> <file.csv>` |
| TestRail | `npm run testrail:sync-csv -- --section-id <section> <file.csv>` |
| Zephyr Essential | `npm run zephyr:sync-csv -- --folder-id <folder> <file.csv>` |
| Xray | `npm run xray:sync-csv -- --folder "<path>" <file.csv>` |

All four accept `--jira-key PROJ-123` to override the key read from the file name, and `--help`.

#### Azure DevOps example

**Bash**

```bash
cd PATH_TO_PROJECT
export ADO_SYNC_JIRA_KEY=PROJ-100
npm run ado:sync-csv -- -p 6329 -s 6330 /path/to/approved-PROJ-100.csv
```

**PowerShell**

```powershell
cd PATH_TO_PROJECT
$env:ADO_SYNC_JIRA_KEY="PROJ-100"
npm run ado:sync-csv -- --plan-id 6329 --suite-id 6330 "C:\path\to\approved-PROJ-100.csv"
```

You can omit `-p`/`-s` if `ADO_SYNC_PLAN_ID` / `ADO_SYNC_SUITE_ID` are already set. Use `npm run ado:list-suites -- <planId>` to find the right suite id.

**Reading plan / suite ids from the ADO URL:** the address bar looks like `…/_testPlans/define?planId=<plan>&suiteId=<suite>`. Everything before `_testPlans` is org/project (`ADO_ORG` / `ADO_PROJECT`) — **not** the plan id.

For all ADO options, see **[ADO_TEST_PLANS.md](ADO_TEST_PLANS.md)** §9.

---

## 6. Closing a coverage gap — Cover a bug

A defect reaches testing or production, you look for the test that should have caught it, and
there isn't one. Stages 2 to 5 are built around designing coverage for a *requirement* and having
a human approve every row — heavy machinery for adding the single case that closes a known gap.
The **Cover a bug** page (Web UI home, third card) collapses it into generate → edit → import.

The page has a **Steps** dropdown, like the Create page. Step 2 is disabled until step 1 has
produced a test case, then stays open: the same regression case often belongs in more than one
suite, so the draft and the picker survive an import and you can send it somewhere else.

**Step 1 — Generate regression case from bug**

1. Paste the bug link. A `…/browse/PROJ-123` URL, a board link carrying `?selectedIssue=PROJ-123`,
   or the bare key all work. Any issue type is accepted — the name reflects the usual case, not a
   restriction, so an edge case described in a story works the same way.
2. Pick **Standard** or **BDD (Gherkin)**. There is no limit control: the flow is one ticket → one
   test case. `TEST_CASES_LIMIT` is pinned to `1`, and the prompt reads a cap of 1 as *"this case
   is the entire test design"* — one deep case that walks the main flow end to end and folds the
   validation, negative and boundary checks into its steps, not a thin sample.
3. **Generate**. `ENABLE_RELATED_ISSUES_SEARCH` and `ENABLE_CONFLUENCE_SEARCH` are both pinned to
   `false` here: only the linked ticket is read. Neighbouring issues would contribute their own QA
   scenarios and blur a single focused case, so nothing linked is pulled in. The project's
   `Test cases` folder is still used, for house style rather than for content. None of this is
   echoed in the run log: those lines report settings the Create page offers and this page does
   not, so the log here shows only the ticket, the model call and the result.

**Step 2 — Import to ‹the provider in use›**

4. The page switches here by itself once the case exists. Edit exactly as in §2 — per-step
   editing and **Regenerate** (singular here: there is only ever one case).
5. Pick the destination: **Test Plan → Test Suite** for Azure DevOps, **Suite → Section** for
   TestRail, a **folder** for Zephyr Essential and Xray. What the page shows follows the **In use**
   toggle on the Setup page, which also names the step.
6. **Import** creates the case in the chosen container, showing a spinner while it runs. The
   button sits under the picker and stays disabled until a container is chosen. Afterwards
   everything stays on screen: pick another suite and press **Import** again, and the result panel
   lists each import separately.

What is deliberately different from Day 1 / Day 2:

| | Create (§2–§5) | Cover a bug |
|---|---|---|
| Jira comment | posted with the CSV (on the **Test design** sub-task for Azure DevOps) | never — no sub-task is required |
| Approval | per-row APPROVED marks in the review panel | the editor itself |
| Which ticket is read | the ticket's **parent**, when it has one | the ticket in the link, always |
| How many cases | as many as the story needs, up to the limit you pick | always exactly one |
| Related issues / Confluence | searched and fed to the prompt | never — the linked ticket only |
| Destination | `ADO_ACTIVE_TEST_PLAN_ID` + suite matched from the Jira key | picked on the page |
| CSV | `CHECKLIST_OUTPUT_DIR`, attached to Jira | `CHECKLIST_OUTPUT_DIR/From issue`, kept as the audit trail |
| Repeat runs | one approval, one import | import the same case into as many suites as you like |

There is no CLI equivalent: the flow is built around editing the draft, and the two stages it uses
(`PIPELINE_STAGE=generate` with `DIRECT_TMS_IMPORT=true`, then `PIPELINE_STAGE=import-tms`) read
their input from a review session the Web UI owns.

---

## Command cheat sheet

| Action | Command |
|---|---|
| Install dependencies | `npm install` |
| Start the server and open the Web UI | `bash scripts/launch-ai-test-coverage.sh` (macOS) · `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1` (Windows) |
| Start the server only | `npm run web` (default port 3847; override with `WEB_UI_PORT=…`) |
| Create / refresh the Desktop shortcut | `npm run shortcut` |
| Single ticket: checklist | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=false node agent-docs.js` |
| Single ticket: test cases | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=false GENERATE_MODE=testcases node agent-docs.js` |
| Single ticket: import the approved CSV | `JIRA_ISSUE_KEY=… CHECK_APPROVAL=true node agent-docs.js` |
| Import a CSV (manual) | `npm run ado:sync-csv` · `testrail:sync-csv` · `zephyr:sync-csv` · `xray:sync-csv` — see §5B |
| Update an existing CSV | `npm run update-csv-flow` (see [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md)) |
| Export cases this tool imported back to CSV (Zephyr, Xray) | `npm run tms:export-csv -- --jira-key PROJ-123` |
| Azure DevOps: list Test Plans | `npm run ado:list-plans` |
| Azure DevOps: list suites in a plan | `npm run ado:list-suites -- <planId>` |
| Azure DevOps: export plan as JSON | `npm run ado:export-plan -- <planId>` |
| Azure DevOps: export test cases by tag | `npm run ado:export-tag-csv -- --tag "<tag>"` (several: `--tag "Regression, Smoke"`) |
| MCP server for Cursor | `npm run mcp-server` |

---

## Run it on a schedule

Every run targets one ticket, so a scheduled job needs a `JIRA_ISSUE_KEY`. Both stages use the same
script with a different `CHECK_APPROVAL` value, and must run with the project folder as the working
directory.

**Linux / macOS crontab — example (Day 1 at 09:00, Day 2 at 18:00):**

```cron
0  9 * * * cd /path/to/AI_Test_Coverage && JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=false /usr/bin/node agent-docs.js >> logs/day1.log 2>&1
0 18 * * * cd /path/to/AI_Test_Coverage && JIRA_ISSUE_KEY=PROJ-123 CHECK_APPROVAL=true  /usr/bin/node agent-docs.js >> logs/day2.log 2>&1
```

**Windows Task Scheduler:**

- **Program:** full path to `node.exe`
- **Arguments:** full path to `agent-docs.js`
- **Start in:** the project folder
- Set `JIRA_ISSUE_KEY` and `CHECK_APPROVAL` (`false` or `true`) per task.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm error code ENOENT — Could not read package.json` | You're not in the project folder. `cd` into the folder that contains `package.json` and `agent-docs.js`. |
| Web UI shows **Folder must contain agent-docs.js (AI Test Coverage root)** | In **Browse**, pick the folder that contains `agent-docs.js` (usually `…/AI Test Coverage/`, not its parent). |
| Agent posts nothing in Jira | Re-check `JIRA_API_TOKEN`. With Azure DevOps In use, the Jira key must also point to a story that has a **Test design** QA sub-task (or directly to that sub-task). |
| `APPROVED:` comment is ignored | Comments are not read any more — approve rows in the review panel and press **Submit to Jira** (§3). |
| Import skipped | The provider must be marked **In use**, and its **Auto-import approved CSV** switch must be on (`ADO_SYNC_APPROVED_CSV`, `TESTRAIL_SYNC_APPROVED_CSV`, `ZEPHYR_SYNC_APPROVED_CSV`, `XRAY_SYNC_APPROVED_CSV`). For Azure DevOps the PAT also needs **Work Items: Read & write**. |
| Container not matched by file name | The CSV file name must contain the Jira key (e.g. `… (PROJ-123).csv`). Azure DevOps falls back to `ADO_SYNC_SUITE_ID`; TestRail, Zephyr and Xray can create the missing section / folder (see §5A). Or use the Manual Import (§5B). |
| Port 3847 already in use | Use a different port: `WEB_UI_PORT=4000 npm run web`. |
| macOS Desktop shortcut does nothing on click | Open `/tmp/ai-test-coverage.log` for diagnostics. Most often: the project folder was moved — rebuild the shortcut with `npm run shortcut` from the new location. |
| OpenRouter returns 401 / 403 | Wrong API key on the Setup page (**AI model (OpenRouter)**), or the configured model needs paid credits. See [OPENROUTER.md](OPENROUTER.md). |

---

## Related documentation

| Topic | File |
|---|---|
| Project overview, installation, troubleshooting | [README.md](README.md) |
| CSV column format, architecture, MCP prompts | [TEST_CASE_FORMAT.md](TEST_CASE_FORMAT.md) |
| Azure DevOps Test Plans, sync, tag CSV export | [ADO_TEST_PLANS.md](ADO_TEST_PLANS.md) |
| TestRail | [TESTRAIL.md](TESTRAIL.md) |
| Zephyr Essential | [ZEPHYR.md](ZEPHYR.md) |
| Xray | [XRAY.md](XRAY.md) |
| How the four providers compare | [TMS_INTEGRATIONS.md](TMS_INTEGRATIONS.md) |
| Update an existing CSV when requirements change | [UPDATED_CSV_FLOW.md](UPDATED_CSV_FLOW.md) |
| Choosing the LLM model (OpenRouter) | [OPENROUTER.md](OPENROUTER.md) |
