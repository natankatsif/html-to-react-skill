#!/usr/bin/env node
// Step 3: verify the generated files without reading them.
//   - TODO(h2r) markers left (behavior not rebuilt yet)
//   - HTML that slipped into JSX (class=, onclick=, style="...", <script>, comments)
//   - className tokens unknown to the project's Tailwind (v4 projects)
//   - repeated JSX blocks (a missed component or .map)
//   - optional: tsc / eslint restricted to the generated files
// Usage: node check.mjs <work>/plan.json [--tsc] [--lint]
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { detectProject, loadTailwindValidator } from "./lib/project.mjs";

const argv = process.argv.slice(2);
const planPath = argv.find((a) => !a.startsWith("--"));
if (!planPath) {
  console.error("usage: node check.mjs <work>/plan.json [--tsc] [--lint]");
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const work = path.dirname(path.resolve(planPath));
const gen = JSON.parse(fs.readFileSync(path.join(work, "generated.json"), "utf8"));
const project = detectProject(plan.project || process.cwd());
const root = project.root;
const files = gen.files.filter((f) => /\.(tsx|jsx)$/.test(f)).map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
const problems = [];
const notes = [];
const where = (f, i) => `${path.relative(root, f)}:${i + 1}`;

// ---- markers and leftovers
const LEFTOVER = [
  [/\sclass=["{]/, "class= (use className)"],
  [/\sfor=["{]/, "for= (use htmlFor)"],
  [/\son[a-z]+=["']/, "inline HTML event handler"],
  [/\sstyle="/, 'style="..." string (JSX needs an object)'],
  [/<script\b/, "<script> inside JSX"],
  [/<!--/, "HTML comment inside JSX"],
  [/\s(tabindex|readonly|maxlength|colspan|rowspan|autocomplete|srcset|crossorigin)=/, "lowercase HTML attribute"],
  [/\b(document\.(getElementById|querySelector)|\$\()/, "direct DOM access (use refs/state)"],
];
let todo = 0;
const blocks = new Map();
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (l.includes("TODO(h2r)")) {
      todo++;
      if (todo <= 15) problems.push(`${where(f, i)} unresolved ${l.trim().replace(/^\{\/\*\s*|\s*\*\/\}$|^\/\/\s*/g, "").slice(0, 140)}`);
    }
    for (const [re, msg] of LEFTOVER) if (re.test(l)) problems.push(`${where(f, i)} ${msg}`);
    if (/<[a-z]+-[a-z-]+[\s/>]/.test(l)) notes.push(`${where(f, i)} custom element ${l.match(/<([a-z]+-[a-z-]+)/)[1]} (map it to a component or declare it for TS)`);
  });
  // 6-line windows of JSX, whitespace-normalized
  for (let i = 0; i + 6 <= lines.length; i++) {
    const win = lines.slice(i, i + 6).map((l) => l.trim());
    if (win.filter((l) => /^<[A-Za-z]/.test(l)).length < 3) continue; // opening tags, not closing-tag tails
    const key = win.join("\n");
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(where(f, i));
  }
}
if (todo > 15) problems.push(`... ${todo - 15} more TODO(h2r) markers`);
// overlapping windows of one repeated region: report the region once
const seen = new Set();
const dups = [...blocks.values()].filter((w) => w.length > 1).filter((w) => {
  const prev = w.map((p) => p.replace(/:(\d+)$/, (_, n) => `:${n - 1}`)).join("=");
  const key = w.join("=");
  const contiguous = seen.has(prev);
  seen.add(key);
  return !contiguous;
});
if (dups.length) notes.push(`repeated JSX blocks (missed component/.map?): ${dups.slice(0, 4).map((w) => w.join(" = ")).join("; ")}${dups.length > 4 ? ` (+${dups.length - 4})` : ""}`);
for (const f of files) {
  const n = fs.readFileSync(f, "utf8").split("\n").length;
  if (n > 300) notes.push(`${path.relative(root, f)} has ${n} lines: consider splitting it (plan.components)`);
}

// ---- Tailwind class validity
const validator = plan.styling === "tailwind" && (project.tailwind ?? 0) >= 4 ? await loadTailwindValidator(project) : null;
if (validator) {
  const allowed = new Set([...(gen.allowedClasses || []), "group", "peer"]); // group/peer emit no CSS of their own
  const bad = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const strings = [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, " "));
    for (const m of text.matchAll(/(?:^|[\s{(,])"([^"\n]*(?:\s|^)(?:[a-z]+:)*-?(?:p|m|w|h|text|bg|flex|grid|gap|rounded|border|font)-[^"\n]*)"/gm)) strings.push(m[1]); // class strings in data arrays
    const tokens = [...new Set(strings.flatMap((s) => s.split(/\s+/).filter(Boolean)))].filter((t) => !allowed.has(t) && !/[{}$]/.test(t));
    const ok = validator(tokens);
    for (const t of tokens) if (!ok.has(t)) bad.set(t, (bad.get(t) || 0) + 1);
  }
  if (bad.size) problems.push(`classes unknown to Tailwind v${project.tailwind}: ${[...bad.keys()].slice(0, 20).join(" ")}${bad.size > 20 ? " …" : ""}`);
} else if (plan.styling === "tailwind") notes.push("Tailwind class validation skipped (needs a Tailwind v4 project with node_modules installed)");

// ---- compiler / linter, filtered to generated files
const rel = files.map((f) => path.relative(root, f));
if (argv.includes("--tsc") && project.typescript) {
  try {
    execSync("npx tsc --noEmit -p .", { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`.split("\n").filter((l) => rel.some((r) => l.startsWith(r)));
    out.slice(0, 12).forEach((l) => problems.push(`tsc: ${l.trim()}`));
    if (out.length > 12) problems.push(`tsc: … ${out.length - 12} more`);
  }
}
if (argv.includes("--lint")) {
  try {
    execSync(`npx eslint ${rel.map((r) => JSON.stringify(r)).join(" ")}`, { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (e) {
    const out = `${e.stdout || ""}`.split("\n").filter((l) => /\s(error|warning)\s/.test(l));
    const errors = out.filter((l) => /\serror\s/.test(l));
    errors.slice(0, 10).forEach((l) => problems.push(`eslint: ${l.trim()}`));
    const warns = out.length - errors.length;
    if (warns) notes.push(`eslint: ${warns} warning(s) (e.g. ${out.find((l) => /\swarning\s/.test(l))?.trim().replace(/\s+/g, " ").slice(0, 120)})`);
  }
}

console.log(problems.length ? `✗ ${problems.length} problem(s):` : "✓ no blocking problems");
problems.forEach((p) => console.log(`  ${p}`));
if (notes.length) {
  console.log("notes:");
  notes.slice(0, 12).forEach((n) => console.log(`  ${n}`));
}
process.exit(problems.length ? 1 : 0);
