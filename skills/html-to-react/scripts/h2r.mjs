#!/usr/bin/env node
// Entry point: `node h2r.mjs <analyze|generate|check|visual-diff> ...args`.
// Installs the scripts' npm dependencies on first run (plugin installs do not
// run npm), then hands over to the requested command. No third-party imports
// here, so it works before node_modules exists.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = ["analyze", "generate", "check", "visual-diff"];
const cmd = process.argv[2];
if (!COMMANDS.includes(cmd)) {
  console.error(`usage: node h2r.mjs <${COMMANDS.join("|")}> [args]`);
  process.exit(2);
}
if (!fs.existsSync(path.join(dir, "node_modules", "cheerio"))) {
  console.error("html-to-react: installing script dependencies (one time)...");
  try {
    execSync("npm install --no-audit --no-fund --loglevel=error", { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    console.error(`npm install failed. Run it yourself: npm install --prefix "${dir}"`);
    process.exit(1);
  }
}
process.argv.splice(2, 1); // the command sees its own args at argv[2..]
await import(pathToFileURL(path.join(dir, `${cmd}.mjs`)).href);
