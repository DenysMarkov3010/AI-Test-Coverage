#!/usr/bin/env node
/**
 * CLI: list Test Plans or export one plan to JSON (suite tree → test case ids).
 * Usage:
 *   node ado-plan-tools.js list
 *   node ado-plan-tools.js suites [planId]
 *   node ado-plan-tools.js export [planId]
 * Env: ADO_ORG, ADO_PROJECT, ADO_PAT; optional ADO_ACTIVE_TEST_PLAN_ID when exporting/listing suites without an argument.
 */
// Setup page config (config.local.json) wins, then .env as fallback.
require("./config-store.js").loadEnv();

const fs = require("fs");
const path = require("path");
const { AdoClient } = require("./ado-client");

/** Default active Test Plan id: `ADO_ACTIVE_TEST_PLAN_ID`, or legacy `ADO_TEST_PLAN_ID`. */
function envActiveTestPlanId() {
  return (
    process.env.ADO_ACTIVE_TEST_PLAN_ID ||
    process.env.ADO_TEST_PLAN_ID ||
    ""
  );
}

function getClient() {
  const org = process.env.ADO_ORG || process.env.AZURE_DEVOPS_ORG;
  const project = process.env.ADO_PROJECT || process.env.AZURE_DEVOPS_PROJECT;
  const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
  if (!org || !project || !pat) {
    console.error("❌ Set ADO_ORG, ADO_PROJECT, and ADO_PAT in .env (see ADO_TEST_PLANS.md)");
    process.exit(1);
  }
  const baseUrl = process.env.ADO_SERVER_URL;
  return new AdoClient(org, project, pat, baseUrl ? { baseUrl } : {});
}

async function cmdList() {
  const client = getClient();
  const plans = await client.listTestPlans();
  if (!Array.isArray(plans) || plans.length === 0) {
    console.log("ℹ️  No Test Plans found or the list is empty.");
    return;
  }
  console.log(`📋 Test Plans (${plans.length}):\n`);
  plans.forEach((p) => {
    const id = p.id != null ? p.id : "?";
    const name = p.name || "(no name)";
    const root = p.rootSuite != null ? `rootSuite=${p.rootSuite.id}` : "";
    console.log(`  ${id}\t${name}\t${root}`);
  });
}

function extractWorkItemIds(testCaseRefs) {
  return (testCaseRefs || [])
    .map((row) => {
      if (row.workItem && row.workItem.id) return row.workItem.id;
      if (row.testCaseWorkItemId) return row.testCaseWorkItemId;
      if (row.id) return row.id;
      return null;
    })
    .filter((id) => id != null);
}

/**
 * Walk the suite tree from root: cases at each level + child suites.
 */
async function exportPlanStructure(client, planId) {
  const plan = await client.getTestPlan(planId);
  const rootSuite = plan.rootSuite;
  if (!rootSuite || rootSuite.id == null) {
    throw new Error("Test plan response has no rootSuite.id");
  }

  const flatSuites = [];

  async function processSuite(suiteObj, parentPath) {
    const suiteId = suiteObj.id;
    const name = suiteObj.name || `Suite-${suiteId}`;
    const pathStr = [...parentPath, name].join(" / ");

    let testCaseRefs = [];
    try {
      testCaseRefs = await client.listTestCasesInSuite(planId, suiteId);
    } catch (e) {
      flatSuites.push({
        suiteId,
        suiteName: name,
        path: pathStr,
        testCaseCount: 0,
        workItemIds: [],
        error: e.message,
      });
      return;
    }

    const workItemIds = extractWorkItemIds(testCaseRefs);
    flatSuites.push({
      suiteId,
      suiteName: name,
      path: pathStr,
      testCaseCount: workItemIds.length,
      workItemIds,
    });

    const children = await client.listChildSuites(planId, suiteId);
    for (const child of children) {
      await processSuite(child, [...parentPath, name]);
    }
  }

  await processSuite(rootSuite, []);

  return {
    exportedAt: new Date().toISOString(),
    plan: {
      id: plan.id,
      name: plan.name,
      rootSuiteId: rootSuite.id,
    },
    suites: flatSuites,
  };
}

/** Flat list of plan suites (id, path, case count) — pick ADO_SYNC_SUITE_ID / --suite-id. */
async function cmdSuites(planIdArg) {
  const planId = parseInt(
    planIdArg || envActiveTestPlanId(),
    10
  );
  if (!Number.isFinite(planId) || planId < 1) {
    console.error(
      "❌ Pass a numeric plan id: node ado-plan-tools.js suites <planId> or set ADO_ACTIVE_TEST_PLAN_ID in .env"
    );
    process.exit(1);
  }

  const client = getClient();
  console.log(`📂 Loading Test Plan ${planId} structure...`);
  const data = await exportPlanStructure(client, planId);
  console.log(`\nPlan "${data.plan.name}" (id ${data.plan.id})\n`);
  console.log("suiteId\tpath\ttestCases");
  for (const s of data.suites) {
    console.log(`${s.suiteId}\t${s.path}\t${s.testCaseCount}`);
  }
}

async function cmdExport(planIdArg) {
  const planId = parseInt(
    planIdArg || envActiveTestPlanId(),
    10
  );
  if (!Number.isFinite(planId) || planId < 1) {
    console.error(
      "❌ Pass a numeric plan id: node ado-plan-tools.js export <planId> or set ADO_ACTIVE_TEST_PLAN_ID in .env"
    );
    process.exit(1);
  }

  const client = getClient();
  console.log(`📥 Exporting Test Plan ${planId} structure...`);
  const data = await exportPlanStructure(client, planId);

  const outDir = process.env.ADO_EXPORT_DIR || path.join(__dirname, "ado-exports");
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `test-plan-${planId}-${new Date().toISOString().split("T")[0]}.json`;
  const outPath = path.join(outDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`✅ Saved: ${outPath}`);
  console.log(`   Suite rows: ${data.suites.length}`);
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === "list") {
    await cmdList();
    return;
  }
  if (cmd === "suites") {
    await cmdSuites(arg);
    return;
  }
  if (cmd === "export") {
    await cmdExport(arg);
    return;
  }
  console.log(`Usage:
  node ado-plan-tools.js list
  node ado-plan-tools.js suites <planId>
  node ado-plan-tools.js export <planId>

Environment: ADO_ORG, ADO_PROJECT, ADO_PAT; optional ADO_ACTIVE_TEST_PLAN_ID, ADO_SERVER_URL`);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
