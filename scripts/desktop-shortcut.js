#!/usr/bin/env node
/**
 * Cross-platform dispatcher for `npm run shortcut`.
 * Windows: runs scripts/create-desktop-shortcut.ps1 via PowerShell.
 * macOS:   runs scripts/create-desktop-shortcut.sh via /bin/bash.
 */
const path = require("path");
const { spawn } = require("child_process");

const SCRIPTS_DIR = __dirname;

function runWindows() {
  const ps1 = path.join(SCRIPTS_DIR, "create-desktop-shortcut.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { stdio: "inherit" }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`Failed to launch powershell.exe: ${err.message}`);
    process.exit(1);
  });
}

function runMac() {
  const sh = path.join(SCRIPTS_DIR, "create-desktop-shortcut.sh");
  const child = spawn("/bin/bash", [sh], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`Failed to launch /bin/bash: ${err.message}`);
    process.exit(1);
  });
}

if (process.platform === "win32") {
  runWindows();
} else if (process.platform === "darwin") {
  runMac();
} else {
  console.error(`Desktop shortcut creation is not supported on ${process.platform}.`);
  process.exit(1);
}
