#!/usr/bin/env node
// Step 1: read an HTML page (+ its local CSS/JS) and write a compact work dir:
//   outline.txt   - the only thing the model needs to read to plan components
//   behavior.md   - what the page's JavaScript does, mapped to node ids
//   plan.json     - pre-filled plan for generate.mjs (edit, then generate)
//   scripts/      - extracted JS, read only if a behavior is unclear
// Usage: node analyze.mjs <page.html> [--css extra.css]... [--project .] [--work .h2r/<slug>] [--styling tailwind|css] [--force]
// An existing plan.json is never overwritten (a fresh one goes to plan.suggested.json) unless --force.
import fs from "node:fs";
import path from "node:path";
import { detectProject, loadTailwindValidator } from "./lib/project.mjs";
import { buildModel } from "./lib/pipeline.mjs";
import { renderOutline, renderHeader } from "./lib/outline.mjs";
import { elementChildren } from "./lib/source.mjs";
import { normText, textOf } from "./lib/repeat.mjs";

function args(argv) {
  const o = { css: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--css") o.css.push(argv[++i]);
    else if (a === "--force") o.force = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const pascal = (s) => s.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function suggestName(el, used) {
  const a = el.attribs || {};
  const tagNames = { nav: "Navbar", header: "Header", footer: "Footer", aside: "Sidebar", form: "ContactForm" };
  let name = null;
  if (a.id && /^[a-z]/i.test(a.id)) name = pascal(a.id);
  if (!name && tagNames[el.name]) name = tagNames[el.name];
  if (!name) {
    const h = [];
    const find = (n) => {
      for (const c of elementChildren(n)) {
        if (/^h[1-3]$/.test(c.name)) h.push(c);
        else if (!h.length) find(c);
      }
    };
    find(el);
    if (h.length) name = pascal(normText(textOf(h[0])).split(" ").slice(0, 3).join(" "));
  }
  if (!name || !/^[A-Z]/.test(name) || name.length > 28) name = `Section`;
  if (/^(Section|Div|Main)$/.test(name) && el.name === "section") name = "Section";
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${name}${i}`;
  used.add(n);
  return n;
}

async function main() {
  const o = args(process.argv.slice(2));
  const html = o._[0];
  if (!html || !fs.existsSync(html)) {
    console.error("usage: node analyze.mjs <page.html> [--css extra.css] [--project .] [--work dir] [--styling tailwind|css]");
    process.exit(2);
  }
  const project = detectProject(o.project || process.cwd());
  const styling = o.styling || (project.tailwind ? "tailwind" : "css");
  const tw4 = (project.tailwind ?? 4) >= 4;
  const validator = styling === "tailwind" && tw4 ? await loadTailwindValidator(project) : null;
  const base = path.basename(html, path.extname(html));
  const slug = kebab(base === "index" ? path.basename(path.dirname(path.resolve(html))) : base) || "page";
  const work = path.resolve(o.work || path.join(project.root, ".h2r", slug));
  fs.mkdirSync(path.join(work, "scripts"), { recursive: true });

  const model = await buildModel(html, { extraCss: o.css, styling, tw4, validator });
  const outlineBody = renderOutline(model);
  const header = renderHeader(model, { outlineChars: outlineBody.length, file: path.relative(project.root, path.resolve(html)) });
  fs.writeFileSync(path.join(work, "outline.txt"), `${header}\n${outlineBody}\n`);

  // ---- behavior.md
  const b = [];
  const idOf = (el) => model.ids.get(el) || model.ids.get(el?.parent) || "?";
  model.scriptSources.forEach((s, i) => fs.writeFileSync(path.join(work, "scripts", `script-${i + 1}.js`), `// ${s.origin}\n${s.text.trim()}\n`));
  if (model.behavior.scripts.length || model.elNotes.size) {
    b.push("# Behavior to rebuild in React (static page JS is NOT carried over)");
    for (const s of model.behavior.scripts) {
      b.push(`\n## script-${s.index}.js (${s.origin}, ${s.lines} lines)`);
      if (s.events.length) b.push(`events: ${s.events.join(", ")}`);
      if (s.toggled.length) {
        b.push(`toggles classes: ${s.toggled.join(" ")}`);
        const rec = s.toggled.filter((c) => model.recipes.has(c)).map((c) => `  .${c} = ${model.recipes.get(c)}`);
        if (rec.length) b.push("utility equivalents:", ...rec);
      }
      const sel = s.selectors.filter((x) => x.elements.length).map((x) => `${x.selector} -> ${[...new Set(x.elements.map(idOf))].slice(0, 6).join(" ")}${x.elements.length > 6 ? " …" : ""}`);
      if (sel.length) b.push(`touches: ${sel.join("; ")}`);
      const missing = s.selectors.filter((x) => !x.elements.length).map((x) => x.selector);
      if (missing.length) b.push(`selectors with no static match (created at runtime or state classes): ${missing.join(", ")}`);
      if (s.libs.length) b.push(`libraries: ${s.libs.join("; ")}`);
    }
    const inline = [...model.elNotes].filter(([, notes]) => notes.some((n) => n.startsWith("on") || n.startsWith("markup")));
    if (inline.length) {
      b.push("\n## inline handlers / markup widgets");
      for (const [el, notes] of inline) b.push(`${idOf(el)} ${el.name}: ${notes.filter((n) => n.startsWith("on") || n.startsWith("markup")).join(" | ")}`);
    }
    if (model.meta.externalJs.length) b.push(`\n## external scripts (not loaded): ${model.meta.externalJs.join(", ")}`);
  }
  fs.writeFileSync(path.join(work, "behavior.md"), b.length ? b.join("\n") + "\n" : "No scripts or inline handlers: the page is static.\n");

  // ---- plan.json (pre-filled; the model edits names/boundaries, not markup)
  const used = new Set();
  const components = {};
  const top = elementChildren(model.body).length === 1 && elementChildren(elementChildren(model.body)[0]).length > 1 ? elementChildren(elementChildren(model.body)[0]) : elementChildren(model.body);
  for (const el of top) {
    if (!model.ids.has(el) || el.name === "svg" || el.name === "script") continue;
    if (model.$.html(el).length < 600) continue;
    components[model.ids.get(el)] = suggestName(el, used);
  }
  const icons = {};
  // big multi-color illustrations become files (<img>), small/currentColor ones become components
  for (const ic of model.icons.values()) icons[ic.id] = ic.size > 3000 && !ic.currentColor ? "file" : ic.title ? `${pascal(ic.title)}Icon` : `Icon${ic.id.slice(1)}`;
  const iconFonts = Object.fromEntries([...model.iconFonts.keys()].map((k) => [k, ""]));
  const compDir = project.componentsDir || (project.appDir ? `${project.appDir}/components` : "src/components");
  const pageFile = project.router === "app" ? `${project.appDir}/${slug}/page.${project.typescript ? "tsx" : "jsx"}` : `${compDir}/${slug}/${pascal(slug)}Page.${project.typescript ? "tsx" : "jsx"}`;
  const plan = {
    source: path.resolve(html),
    css: o.css.map((c) => path.resolve(c)),
    sourceHash: model.meta.sourceHash,
    project: project.root,
    styling,
    outDir: `${compDir}/${slug}`,
    page: { file: pageFile, name: `${pascal(slug)}Page` },
    assets: { dir: `${project.publicDir || "public"}/${slug}`, url: `/${slug}` },
    components,
    lists: {},
    icons,
    iconFonts,
    client: [],
    drop: [],
    image: "img",
    link: project.framework.startsWith("next") ? "next" : "a", // Next lint rejects <a> for internal routes
  };
  const planPath = path.join(work, "plan.json");
  if (fs.existsSync(planPath) && !o.force) fs.writeFileSync(path.join(work, "plan.suggested.json"), JSON.stringify(plan, null, 2) + "\n");
  else fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");

  const notes = model.notes;
  const top3 = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}${v > 1 ? `×${v}` : ""}`).join(" ");
  const report = {
    project: { framework: project.framework, typescript: project.typescript, tailwind: project.tailwind, alias: project.alias?.prefix || null, indent: project.indent, libs: project.libs, twValidator: !!validator },
    meta: { title: model.meta.title, description: model.meta.description, fonts: model.meta.fonts, externalCss: model.meta.externalCss, externalJs: model.meta.externalJs, tailwindSource: model.twSource, tailwindConfig: model.meta.tailwindConfig ? "present (port to @theme)" : null },
    cleanup: {
      droppedClasses: Object.fromEntries(notes.droppedClasses), jsHookClasses: Object.fromEntries(notes.jsHookClasses), unknownClasses: Object.fromEntries(notes.unknownClasses),
      renamedTwClasses: notes.renamed, v4BorderColorFixes: notes.borderFixes, flattenedWrappers: notes.flattened, removedEmpty: notes.emptied, droppedIds: notes.droppedIds, droppedAttrs: Object.fromEntries(notes.droppedAttrs),
    },
    css: model.styling === "tailwind" ? { convertedRules: model.parsed.rules.length, keptAsCss: model.tw.leftovers.map((l) => `${l.rule.selector} (${l.reason})`), globalCssLines: model.globalsCss.split("\n").length } : { keptSelectors: model.cssOut.kept, droppedSelectors: model.cssOut.dropped },
    parseErrors: model.parsed.parseErrors,
    customElements: [...model.customElements],
    missingAssets: model.assets.summary().missing,
  };
  fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2) + "\n");

  // ---- stdout: short on purpose
  const rel = (p) => path.relative(process.cwd(), p) || ".";
  const out = [];
  out.push(header.split("\n").slice(0, 3).join("\n"));
  out.push(`project: ${project.framework}, ${project.typescript ? "TS" : "JS"}, tailwind ${project.tailwind ?? "none"}${validator ? " (classes validated)" : ""}, indent ${project.indent}, alias ${project.alias?.prefix || "none"}`);
  if (notes.droppedClasses.size) out.push(`dropped dead classes: ${top3(notes.droppedClasses)}`);
  if (notes.unknownClasses.size) out.push(`dropped classes unknown to Tailwind ${tw4 ? "v4" : ""}: ${top3(notes.unknownClasses)}`);
  if (notes.jsHookClasses.size) out.push(`JS hook classes (rebuild as state): ${top3(notes.jsHookClasses)}`);
  if (model.tw?.leftovers.length) out.push(`CSS rules kept as CSS (not expressible as utilities): ${model.tw.leftovers.length}`);
  if (model.iconFonts.size) out.push(`icon fonts used: ${[...model.iconFonts.keys()].slice(0, 12).join(" ")} -> map them in plan.iconFonts (e.g. "lucide:Mail")`);
  if (model.customElements.size) out.push(`custom elements: ${[...model.customElements].join(", ")}`);
  if (model.meta.tailwindConfig) out.push("inline tailwind.config found: port its theme to @theme in globals.css");
  if (report.missingAssets.length) out.push(`missing local assets: ${report.missingAssets.slice(0, 5).join(", ")}${report.missingAssets.length > 5 ? " …" : ""}`);
  out.push(`wrote ${rel(work)}/{outline.txt, behavior.md, plan.json, report.json}`);
  out.push(`next: read outline.txt${model.elNotes.size || model.behavior.scripts.length ? " + behavior.md" : ""}, edit plan.json, run generate.mjs ${rel(planPath)}`);
  console.log(out.join("\n"));
}

main().catch((e) => {
  console.error(`analyze failed: ${e.stack || e.message}`);
  process.exit(1);
});
