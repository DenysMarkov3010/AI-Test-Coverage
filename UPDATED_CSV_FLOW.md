# Updated CSV Flow

This is a **separate flow** from the default `agent-docs.js` flow.

Goal: take CSV files from `Updated test cases`, re-check them against Jira requirements, approve the updated rows in the review panel, and attach the approved CSV to the Jira ticket for the import step. Works with every test management system — Azure DevOps, TestRail, Zephyr Essential and Xray. With Azure DevOps In use, the Jira side (comments and CSV) lives on the story's **Test design** QA sub-task; with the others, on the ticket you typed.

The import **creates new** test cases from the updated CSV in the provider In use; it does not edit the old cases in place.

## 1) Prepare

- **Web UI (easiest):** on the **Update test design** page click **Browse…** next to *CSV file* and pick the
  file. It is copied into `Updated test cases` for you (any other CSV already there is replaced), and the
  field shows the chosen name — nothing to type.
- **Zephyr Essential / Xray in use:** no export step. In the **Add context from ‹provider›** panel
  tick the old cases — from any folders — and click **Use selected as CSV**. They are written into
  `Updated test cases` as the CSV (any other CSV there is replaced), and the line under the field
  says what was read: `5 case(s) from Xray 2 folders — 3 test case(s), 2 BDD`. The Jira key stays
  what it always was: the ticket with the new requirements; the cases do not have to belong to it.
  Both kinds of case come through — ones this tool imported, and old hand-written ones (Xray
  Precondition issues and Generic tests, Zephyr steps that call another case); see
  [tms-export-csv.js](tms-export-csv.js) for how each field maps back.
  On the CLI, for cases this tool filed: `npm run tms:export-csv -- --jira-key PROJ-123`
  (`--folder <id or path>` to name the folder outright).
- **Azure DevOps / TestRail in use:** export the existing cases from the test management system as a
  CSV and pick it with **Browse…** as above. (For Azure DevOps, `npm run ado:export-tag-csv` exports by
  tag — but into `Test cases/`, the generation-context folder, so copy the file over.)
- Or put your source CSV into `Updated test cases` by hand.
- Or import it from `Downloads` by file name on the CLI:

### Bash

```bash
cd /path/to/ai-test-coverage
npm run csv:from-downloads -- "Web app - Redesign_Add post, comment, reply.csv" --to "Updated test cases"
```

### PowerShell

```powershell
cd PATH_TO_PROJECT
npm run csv:from-downloads -- "Web app - Redesign_Add post, comment, reply.csv" --to "Updated test cases"
```

- Set environment:
  - `JIRA_ISSUE_KEY=PROJ-12345` (the story; or, with Azure DevOps, its Test design sub-task)
  - `CHECK_APPROVAL=false`
  - optional:
    - `UPDATED_FLOW_INPUT_FILE=<file.csv>` (if omitted, latest CSV in folder is used)
    - `UPDATED_FLOW_MODE=auto|testcases|checklist` (default `auto`)

## 2) Generate updated content (Day 1 style)

### Bash

```bash
cd /path/to/ai-test-coverage
JIRA_ISSUE_KEY=PROJ-12345 CHECK_APPROVAL=false UPDATED_FLOW_MODE=checklist node agent-update-csv.js
```

### PowerShell

```powershell
cd PATH_TO_PROJECT
$env:JIRA_ISSUE_KEY="PROJ-12345"
$env:CHECK_APPROVAL="false"
$env:UPDATED_FLOW_MODE="checklist"   # or "testcases" / "auto"
node agent-update-csv.js
```

`UPDATED_FLOW_MODE` can be changed **before each run**:

- `checklist` - force checklist output (legacy segment rules; same as before)
- `testcases` - force test cases output (all `Test Case` parents parsed as test cases, same as before)
- `auto` - walk the CSV **in order** and treat each parent block separately (default)

**`auto` classification (per block, top to bottom):**

1. **Legacy file** (no parent rows with Work Item Type + Title): one checklist segment from all rows (unchanged).
2. **Explicit checklist work item**: Work Item Type contains `checklist` (case-insensitive) → that block is a **checklist** (child rows → checklist items).
3. **`Test Case` work item**:
   - If the step rows are **Gherkin** → **BDD test case** block (checked first; see below).
   - If **every** step row has an empty **Step Expected** → **checklist** block (matches ADO exports where checklists reuse the Test Case shape; items come from Step Action / Title columns).
   - If **at least one** step has a non-empty Step Expected → **test case** block (steps merged like `rowsToTestCases`).

Mixed files are supported: the script runs the test-case LLM and the checklist LLM **as many times as needed**, in **CSV order** (comments in Jira may alternate between ADF test-case posts and checklist text posts).

### Standard vs BDD is read from the CSV

There is no format toggle on the Update page. A test case whose every step line starts with a
Gherkin keyword (`Given` / `When` / `Then` / `And` / `But`, with at least one `Given` or `When`) is
recognised as **BDD**, gets the Gherkin update prompt, and comes back as Gherkin — title, steps and
the posted Jira comment all stay in the scenario form. Everything else is updated in the standard
format, exactly as before.

The check runs **per block**, so one file can hold standard cases next to scenarios and each is
updated in its own format. It also runs in `UPDATED_FLOW_MODE=testcases`, which skips the
classifier above. The detection and the Gherkin ⇄ CSV conversion live in
[web/bdd-format.js](web/bdd-format.js).

The Gherkin check comes **before** the empty-Step-Expected rule on purpose: a scenario that never
reaches a `Then` has no Step Expected at all, and would otherwise be filed as a checklist.

The run log names what it found, e.g.
`🥒 BDD (Gherkin) blocks detected in CSV: 1/2 — those are updated in Gherkin, the rest in the standard format`.

What happens:

1. Reads CSV from `Updated test cases`.
2. Loads Jira requirements from the parent context issue.
3. Picks where the result goes in Jira: the ticket itself, or — with Azure DevOps In use — the Test design QA sub-task of that parent.
4. Generates updated checklist and/or test cases (depending on mode).
5. Posts the result there:
   - test cases: ADF table comment + `generated-testcases-<KEY>.json` attachment;
   - checklist: checklist comment.
6. Leaves approval instructions in the same place (Update test design only — see below).

## 2b) Editing the draft before it reaches Jira (Web UI)

In the Web UI, the generate step no longer posts straight to Jira. Every block from the CSV appears
in a **Review updated test design** panel first, and nothing reaches the ticket until you press
**Submit to Jira** — which attaches the approved CSV. On the CLI, `node agent-update-csv.js` still
posts the design as comments immediately; the review and the approving are a Web UI feature.

Each CSV parent row is one block:

```
Block 1/2 · Test cases · "Connect Google Calendar"
Block 2/2 · Checklist  · "Sync settings checklist"
```

Blocks are never reordered in the panel: that order is the order of the source CSV, and each block becomes a section of the one CSV that Submit writes.

- **Inside a checklist block:** edit item text, change its category, reorder with ↑ / ↓, delete with
  ✕, or append one with **+ Add checklist item**.
- **Inside a test case block:** edit title, Priority and Area Path; edit the steps table cell by
  cell; move, delete and add step rows (they renumber themselves).

**Approving is per row**, with the **Approve** button on each item and each test case — see
[FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) §3. Each block has its own counter and its own
**Approve all** / **Clear**, and only the marked rows become sections of the CSV.

**Emptying a block is allowed.** Deleting the last item of a block — or the one test case it holds —
does not have to be undone before you can submit: a block with nothing approved in it is simply
absent from the CSV, and every other block is written as usual. Only a review where nothing at all
is approved is refused, because then there is nothing to write.
**What changed is marked for you.** The model classifies every row against the source CSV, so you
do not have to diff by eye:

- **green + "New"** — the row did not exist in the CSV;
- **amber + "Changed"** — it existed and was edited;
- no tint — kept as-is;
- under each marked row (and each marked step) sits one line saying **why**;
- rows the model dropped are listed **above** the block, struck through with the reason, since the
  rows themselves are gone.

These markers are panel-only. The posted comment keeps its existing change-summary section; the
per-row annotations never reach the Jira comment or the JSON attachment.

- **⟳ on a row** regenerates just that row and takes an optional box of extra context. That row gets
  a **Regenerated** marker, and only that row shows a loader — the other blocks stay editable.
- **⟳ in a block header** regenerates that whole block, with the same optional context. The loader
  covers only that block, and no markers are added (every row in it is new).
- The footer shows the token spend for the run, including every regeneration.

**Submit to Jira** writes the approved rows of every block as one CSV — blocks in CSV order, each
one a section — attaches it in Jira (the ticket, or its Test design sub-task for Azure DevOps) and
links it from a comment. The blocks
themselves are not posted as comments: you read them here.

A regeneration in flight blocks structural edits (add / delete / reorder) across the panel: the
regenerate call addresses rows by index, so changing the structure mid-request would apply the
result to the wrong row. Typing in a field stays available.

## 3) Import the approved CSV

No approval comment is read, in either flow. Approving happened in the review panel, and Submit
recorded it by attaching the CSV — so this step takes the **newest CSV attached** by Submit and
imports it into the provider In use. **Manual Import into ‹provider›** on the Update page does the
same into a container you pick — see [FULL_FLOW_GUIDE.md](FULL_FLOW_GUIDE.md) §5.

Run:

### Bash

```bash
cd /path/to/ai-test-coverage
JIRA_ISSUE_KEY=PROJ-12345 CHECK_APPROVAL=true node agent-update-csv.js
```

### PowerShell

```powershell
cd PATH_TO_PROJECT
$env:JIRA_ISSUE_KEY="PROJ-12345"
$env:CHECK_APPROVAL="true"
node agent-update-csv.js
```

`agent-update-csv.js` delegates this step to `agent-docs.js`, which does the same thing for both flows:

- take the newest CSV attached to the ticket,
- import it when the provider's "Auto-import approved CSV" switch is on (`ADO_SYNC_APPROVED_CSV`, `TESTRAIL_SYNC_APPROVED_CSV`, `ZEPHYR_SYNC_APPROVED_CSV` or `XRAY_SYNC_APPROVED_CSV`).
- additionally for this updated flow, an extra CSV copy is created with parent-task naming:
  - `<Parent Summary> (PROJ-12345) (updated by AI).csv`
  - The Jira key is required in the file name when detected from the parent context.

## Notes

- This flow is isolated from the default generation flow; no change to existing commands.
- If no `UPDATED_FLOW_INPUT_FILE` is set, the newest `.csv` in `Updated test cases` is used.
- Requires the usual credentials on the Setup page (`JIRA_*`, `OPENROUTER_API_KEY`), plus the credentials of the provider In use for the import.
