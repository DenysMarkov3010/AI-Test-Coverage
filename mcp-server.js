#!/usr/bin/env node

// MCP server that exposes your existing QA agent as a single tool.
// Based on the official SDK's toolWithSampleServer example.

const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

async function runAgentOnce(agentFile = "agent-docs.js", envOverrides = {}) {
  const cwd = __dirname;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [agentFile], {
      cwd,
      env: { ...process.env, ...envOverrides },
      // IMPORTANT: do not write to stdout because MCP uses it for the protocol.
      // Otherwise logs like "[dotenv@17...]" can break the JSON stream.
      stdio: ["ignore", "ignore", "inherit"],
    });

    child.on("error", (err) => reject(err));

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${agentFile} exited with code ${code}`));
      }
    });
  });
}

async function readReportYaml() {
  const reportPath = path.join(__dirname, "report.yaml");
  if (!fs.existsSync(reportPath)) {
    throw new Error("report.yaml not found after running agent");
  }
  return fs.readFileSync(reportPath, "utf8");
}

async function main() {
  const mcpServer = new McpServer({
    name: "ai-test-coverage",
    version: "1.0.0",
  });

  // Register a tool that runs the documentation-based QA agent
  mcpServer.registerTool(
    "qa_register_tool",
    {
      description:
        "Run the autonomous QA agent that analyzes Jira issues and Confluence documentation to generate test checklists and, after approval, a CSV with the approved checklist. Provide a Jira issue key (e.g., PROJ-123) as the goal.",
      inputSchema: {
        goal: z
          .string()
          .optional()
          .describe(
            "Jira issue key (e.g., 'PROJ-123') or natural language instruction. If not provided, uses JIRA_ISSUE_KEY from environment."
          ),
        issueKey: z
          .string()
          .optional()
          .describe(
            "Jira issue key (e.g., 'PROJ-123'). Alternative to using goal parameter."
          ),
        checkApproval: z
          .boolean()
          .optional()
          .describe(
            "true imports the approved CSV already attached to the ticket (approval happens in the web UI review panel); false generates a new design instead. Default: true."
          ),
      },
    },
    async ({ goal, issueKey, checkApproval }) => {
      const envOverrides = {};
      
      // Use issueKey parameter if provided, otherwise use goal
      const finalIssueKey = issueKey || goal;
      if (finalIssueKey && finalIssueKey.trim().length > 0) {
        envOverrides.JIRA_ISSUE_KEY = finalIssueKey.trim();
      }
      
      if (checkApproval !== undefined) {
        envOverrides.CHECK_APPROVAL = checkApproval.toString();
      }

      await runAgentOnce("agent-docs.js", envOverrides);
      const report = await readReportYaml();

      return {
        content: [
          {
            type: "text",
            text: report,
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("MCP server failed:", err);
  process.exit(1);
});

