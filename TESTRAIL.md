# TestRail integration

Status: **working.** The Setup page talks to a TestRail instance, lists its
projects, suites, templates and case types, and verifies the account; mark
TestRail **In use** and an approved CSV is imported into it by
[testrail-sync-csv.js](testrail-sync-csv.js) instead of into Azure DevOps.

The section each ticket's cases land in is found from the Jira key at import
time, so it is not a setting — see section 2.

---

## 1. Before anything works: switch the API on

TestRail ships with its API disabled. Until an administrator enables it, every
call comes back `403 API Is Not Enabled`.

1. Administration → Site Settings → **API**
2. tick **Enable API**
3. (recommended) tick **Enable session authentication for API** off, so only
   API keys are accepted

Then create the key the agent will use: **My Settings → API Keys → Add Key**.
The key is shown once. It is stored in `config.local.json` (git-ignored,
chmod 600), never in the repo.

## 2. Fields on the Setup page

| Field | Key | Where the value comes from |
|---|---|---|
| Instance URL * | `TESTRAIL_BASE_URL` | `https://yourcompany.testrail.io`. A pasted `/index.php?/api/v2` suffix is stripped. |
| Account email * | `TESTRAIL_EMAIL` | login email of the account the key belongs to |
| API key * | `TESTRAIL_API_KEY` | My Settings → API Keys |
| Project * | `TESTRAIL_PROJECT_ID` | live list (`get_projects`) |
| Suite * | `TESTRAIL_SUITE_ID` | live list (`get_suites`); `get_sections` cannot read a multi-suite project without one, and a single-suite project has its only suite filled in automatically |
| Template | `TESTRAIL_TEMPLATE_ID` | live list (`get_templates`); empty = project default |
| Case type | `TESTRAIL_TYPE_ID` | live list (`get_case_types`); empty = instance default |
| Steps field | `TESTRAIL_STEPS_FIELD` | `auto` / `custom_steps_separated` / `custom_steps` |
| Auto-import approved CSV | `TESTRAIL_SYNC_APPROVED_CSV` | `true` / `false` |
| Create the section when missing | `TESTRAIL_CREATE_MISSING_SECTION` | `true` / `false` |

`*` = required before the card reads **Configured**.

**There is no Section field, on purpose.** A section pinned here would have to
be changed by hand between tickets, which is exactly what the Azure DevOps card
avoids: it asks for a Test Plan and finds the suite per ticket. TestRail works
the same way — cases land in the section whose name carries the ticket key, and
`TESTRAIL_CREATE_MISSING_SECTION` decides what happens when there is none
(create one at the root of the suite, or stop and say which key found nothing).
See section 4 for the full mapping.

A section this flow creates is named **`PROJ-123 Story summary`**, not `PROJ-123`.
The key leads because the key is what the next run matches on — it is taken as a
token anywhere in the name, so the summary after it changes nothing about
matching — and the summary is there because a board of bare keys tells a human
reading TestRail nothing. It comes from the CSV's own file name, which the
approval step writes as `"<story summary> (PROJ-123).csv"`, so it costs no extra
Jira call. A CSV named after the key alone still produces a bare-key section.

The dropdowns cascade: pick a project and the suite and template lists re-read
themselves for it. A required picker whose list comes back with exactly one
entry selects it by itself, which is what stops a single-suite project from
reading **Incomplete** over a value you have no say in — the selection is
marked unsaved like any other edit, never written behind your back.

Nothing is saved until you press Save. The lists load from credentials typed
into the form, so they fill in before the first save.

## 3. Which provider a run imports into

Every provider card can be configured at once. The one marked **In use**
(the toggle next to its badge) is the destination of a run — that is the
`TMS_PROVIDER` value:

| Toggle | `TMS_PROVIDER` | Effect |
|---|---|---|
| Azure DevOps in use | `ado` (default) | `ADO_SYNC_APPROVED_CSV` behaves as it always has |
| TestRail in use | `testrail` | `TESTRAIL_SYNC_APPROVED_CSV` drives the import; the Azure DevOps one is skipped and says so in the run log |
| Zephyr Essential in use | `zephyr` | `ZEPHYR_SYNC_APPROVED_CSV` drives it — see [ZEPHYR.md](ZEPHYR.md) |
| Xray in use | `xray` | `XRAY_SYNC_APPROVED_CSV` drives it — see [XRAY.md](XRAY.md) |

Being in use is necessary but not sufficient: each provider still has its own
**Auto-import approved CSV** switch. The Create and Update pages read the same
toggle — the Steps dropdown reads "Automate import into TestRail", the
context picker and the manual import step switch to TestRail's Suite → Section
pickers, and the Azure DevOps-only tag export disappears. With TestRail in use
the approved CSV is attached to the Jira issue you typed — there is no
**Test design** sub-task to find, unlike Azure DevOps.

A stored value naming an unknown provider falls back to Azure DevOps rather
than silently importing nowhere.

## 4. How TestRail's model differs from Azure DevOps

This is what shapes the field list, and what the importer has to bridge:

| Azure DevOps | TestRail |
|---|---|
| a Test Case work item is created, then **linked** into a Plan → Suite | a case is created **inside a Section** of a Suite; Runs and Plans are a separate execution layer this flow never touches |
| `Microsoft.VSTS.TCM.Steps` (XML) | `custom_steps_separated[]` on the "Test Case (Steps)" template, otherwise a single `custom_steps` text block |
| `Priority` 1–4, **1 = highest** | `priority_id`, and on a stock instance **4 = Critical**, 1 = Low — the scale is inverted and must be resolved through `get_priorities` |
| `System.Tags` = `Jira:PROJ-123` | `refs`, a plain string field, set while creating the case |
| generated Gherkin summary in `System.Description` | nothing — a stock template has no equivalent field, so the TestRail import generates no summary at all |
| a BDD *test design* lands in the same `Microsoft.VSTS.TCM.Steps` as any other case | a scenario gets its **own template**: "Behaviour Driven Development" with the `.feature` text in `custom_testrail_bdd_scenario`, picked per case — see section 7 |
| `System.AreaPath` from the CSV column | no second axis; the CSV's Area Path does not select the section |
| suite matched by walking the plan's suite tree, by Jira key from the CSV filename | same idea: sections are a tree too (`parent_id`), read in one `get_sections` call and matched on the same key |
| no suite is created when the match fails — it falls back to `ADO_SYNC_SUITE_ID` | there is no pinned fallback, so `TESTRAIL_CREATE_MISSING_SECTION` creates the section instead |
| export by tag via WIQL | no tags; the equivalent filter is `refs` |

## 5. API notes worth knowing

- **URL shape.** The method lives inside the query string:
  `https://co.testrail.io/index.php?/api/v2/get_sections/12&suite_id=3`. This
  is why `testrail-client.js` builds URLs by hand instead of using `URL`.
- **Pagination.** Since TestRail 6.7 `get_projects`, `get_sections` and
  `get_cases` answer with `{ offset, limit, size, _links, <collection> }`.
  Older versions and `get_suites` / `get_templates` / `get_case_types` return a
  bare array. The client reads both.
- **Rate limits.** TestRail Cloud throttles and answers `429` with
  `Retry-After`. The client honours it and retries twice — the import creates
  one case per request, so this matters.
- **`suite_mode`.** `1` single suite, `2` single suite + baselines, `3` multiple
  suites. In mode 3, `get_sections` without a `suite_id` is an error, which is
  why Suite stays a required field even though the section under it is not.

## 6. Running the import by hand

```bash
npm run testrail:sync-csv -- "path/to/approved-testcases-PROJ-123.csv"
npm run testrail:sync-csv -- --section-id 42 ./export.csv   # skip the key match
```

The Jira key comes from the file name (`approved-testcases-PROJ-123.csv`), or
`--jira-key`. It does two jobs: it picks the section, and it is written to
`refs`. `TESTRAIL_SYNC_SECTION_LIST_VERBOSE=true` prints every section the
match considered.

## 7. Two things the import resolves at run time

**Priority.** The CSV scale runs 1-4 with **1 = highest**; a stock TestRail is
the mirror image (Low, Medium, High, Critical). So the mapping is positional:
the instance's own priorities are ranked lowest-first through `get_priorities`
and counted in from the top, which survives a renamed or resized scale. The
resolved order is printed once per run. `TESTRAIL_PRIORITY_MAP=1:4,2:3,3:2,4:1`
overrides it outright when a team's scales do not line up.

**Steps field.** `custom_steps_separated` only renders on a template that has
it — the stock "Test Case (Steps)" one. On the default "Test Case (Text)"
template TestRail accepts the field and then shows nothing, which looks exactly
like a failed import. So `auto` reads the template that will actually be used
(the configured one, else the project default) and picks `custom_steps` unless
that template carries separated steps. Setting the field by hand to something
the template cannot render gets a warning, not silence.

**Preconditions.** The preconditions row (step 1, expected "—") moves into
`custom_preconds` rather than pretending to be a step, because TestRail has a
real field for it.

The legacy one-line `a; b; c` form is split on its semicolons; a multi-line cell
is split on its own lines only, so a semicolon inside a written-out precondition
survives. Either way the result is written as a `<ul>` — see section 8 for why.

**No generated BDD summary.** Azure DevOps has a Description field on the Summary
tab and a generated Gherkin summary goes there. TestRail has nowhere equivalent
on a stock template, and putting it in Preconditions meant a wall of prose on top
of the actual preconditions. So the TestRail import makes **no LLM calls at all**
— it is pure REST, and costs nothing per run. That generated summary remains an
Azure DevOps feature (`ADO_SYNC_BDD_FROM_PROMPT`).

**BDD as the test design format works here in full**, and it gets its own
template. That is a different thing from the generated summary above: the
Standard/BDD toggle on the Create page makes the scenario *be* the test case.

`TESTRAIL_TEMPLATE_ID` stays the template for **standard** cases — for action +
expected-result rows "Test Case (Steps)" genuinely is the right shape. A scenario
has neither shape, and forcing it into that grid is what it looks like:

| | Step | Expected Result |
| --- | --- | --- |
| 1 | `Given the manager is signed in` | *(empty)* |
| 2 | `And the order has a tracking number` | *(empty)* |
| 3 | `When the manager opens the "Orders" tab` | `Then the card is displayed`<br>`And the order date is local` |

Numbered boxes, two empty cells, and the whole `Then` block crammed into the
last one. So the template is chosen **per case**: a Gherkin case goes to the
**"Behaviour Driven Development"** template and its whole `.feature` text into
`custom_testrail_bdd_scenario`, TestRail's native Gherkin field.

The target is read out of `get_case_fields` rather than configured, because the
field declares the `template_ids` it belongs to — the instance names its own
template and there is nothing to keep in sync. Preference order:

1. a field of **type 13** (`custom_testrail_bdd_scenario` on a stock instance) →
   its template, e.g. id 4 "Behaviour Driven Development";
2. `custom_steps` → the text template, one readable `<pre>` block, for instances
   predating the BDD field;
3. neither → today's behaviour, ordinary steps, with a warning.

`refs`, `priority_id`, `type_id` and the section match are unchanged, and
`custom_preconds` is filled by the same rule as a standard case — see below.

### Preconditions on a scenario are a different layer from `Given`

Both exist, and they are not interchangeable. TestRail documents its
Preconditions section as *"the setup or configuration required for a successful
execution — data files, hardware, security access, OS, browser, previous steps,
or other prerequisites"*. That is what a **run** needs before it can start.
`Given` is the **scenario's own business context**, in the language of the
domain, and it has to stay inside the Gherkin: a scenario that opens on `When`
is not valid Gherkin and would not survive a `.feature` export.

So the generation produces both, and they land in different places:

| | Example | Where it goes |
|---|---|---|
| environment / setup | "QA environment with the order-tracking feature flag enabled" | `custom_preconds` |
| business context | `Given the user is signed in as "Store Manager"` | the Gherkin field |

In the CSV a scenario carries its preconditions exactly the way a standard case
does — step 1, `"Preconditions: …"`, expected `—` — so no column was added and
every writer downstream already handled it. `splitPreconditionsRow()` in
[web/bdd-format.js](web/bdd-format.js) peels that row off before anything reads
or *detects* the Gherkin, which is what keeps the row from breaking the
"every line starts with a keyword" check.

The prompts are explicit that a precondition must never be a paraphrased `Given`,
and that `""` is a good answer when the requirement implies no setup beyond a
normal working environment.

### Two things about the BDD field that the docs do not tell you

Both were established against a live instance, and the first one bites hard.

**It takes a real array, not the JSON string it returns.** `get_case` hands the
field back as a *string* containing `[{"content":"…"}]`, and TestRail normally
accepts on write whatever it returns. Not here — posting that string fails with:

```
Field :custom_testrail_bdd_scenario is not a valid array. (HTTP 400)
```

So the payload is the array itself, one element holding the whole `.feature`
text (`Feature:` header plus the indented `Scenario:` block), which is how
TestRail's own sample BDD case stores it. Our model is one case per scenario, so
each case carries a one-scenario feature. The Feature *name* is recovered from
the approved CSV's file name — `"<story summary> (PROJ-123).csv"` — since a
scenario's feature is the story it came from and the CSV has no column for it.

**TestRail rewrites the content on write and there is no way to stop it.** The
field's config says `format: "markdown"`, and the API write path runs that
conversion: plain text comes back wrapped in `<p>…</p>\n`. Content already
starting with a block tag (`<pre>`) passes through untouched, but nothing
suppresses the conversion — `markdown_editor_id` (0/1/2) and `format: "plain"`
were all tried and all ignored. The same thing happens to the ordinary steps
field, which has always rendered correctly, so the wrapper is normal TestRail
behaviour rather than a sign of a bad payload.

## 8. These fields are HTML, whatever `get_case_fields` says

`get_case_fields` reports `"format": "markdown"` on `custom_preconds` and
`custom_steps`, but the editor behind them is a WYSIWYG one and the stored
value is HTML. Text posted as plain lines comes back as a **single `<p>` with
the newlines intact**, and a browser collapses those to spaces — which is how a
list of preconditions ended up rendered as one long line.

Markdown syntax does not rescue it. Sent as the literal two-character escape
`\n` below, every one of these round-trips verbatim inside that one `<p>`, so
all five render identically — as one line:

| Sent | Comes back as |
|---|---|
| `- a\n- b` | `<p>- a\n- b</p>` |
| `* a\n* b` | `<p>* a\n* b</p>` |
| `1. a\n2. b` | `<p>1. a\n2. b</p>` |
| `a\n\nb` (blank line) | `<p>a\n\nb</p>` |
| `a··\nb` (two-space hard break) | `<p>a··\n b</p>` |

Real markup does work, and survives byte for byte: `<ul>`, `<ol>`, `<br>` and
`<em>` all come back exactly as sent. So the import writes list markup — the
rules themselves live in [tms-rich-text.js](tms-rich-text.js), because Zephyr
Essential stores its fields the same way and needed the same treatment:

- **Preconditions** — `<ul><li>one thesis</li>…</ul>`
- **Steps, text template** — `<ol><li>action<br><em>Expected:</em> …</li>…</ol>`
- **Steps, Steps template** — one cell per step, so nothing collapses *between*
  steps; the cells are still rich text, so a cell that is itself multi-line — a
  bulleted expected result, or a BDD `Then … / And …` block — is written as a
  `<ul>` or as `<br>`-joined lines rather than posted raw

Anything coming out of the CSV is HTML-escaped first, or a step reading
`value < 5` would be swallowed as an unknown tag.

## 9. Files

| File | Role |
|---|---|
| [testrail-client.js](testrail-client.js) | REST client: URL shape, auth, pagination, 429 backoff, readable errors, `add_case` / `add_section` |
| [testrail-sync-csv.js](testrail-sync-csv.js) | the importer: section match, priority and steps-field resolution, payload, CLI |
| [tms-rich-text.js](tms-rich-text.js) | the HTML cell rules of section 8, shared with the Zephyr importer |
| [ado-sync-csv.js](ado-sync-csv.js) | shared with it: the CSV parser and the Jira-key container match |
| [config-store.js](config-store.js) | the `testrail` schema section, the `REMOTE_LISTS` entries behind each dropdown, `testConnection("testrail")` |
| [agent-docs.js](agent-docs.js) | `maybeSyncCsvToTms()` — routes the approved CSV to the provider in use |
| [web-ui-server.js](web-ui-server.js) | `POST /__da/tms/options` for the dropdowns, `GET /__da/tms/active` for the pages that name the destination |
| [web/setup-app.js](web/setup-app.js) | the generic `remote-select` picker and the **In use** toggle |
