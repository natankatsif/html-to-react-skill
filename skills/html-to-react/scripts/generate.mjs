#!/usr/bin/env node
// Step 2: apply plan.json and write the React files. The model only decides
// boundaries and names; every byte of markup is carried over by this script.
// Usage: node generate.mjs <work>/plan.json [--dry]
import fs from "node:fs";
import path from "node:path";
import { optimize } from "svgo";
import * as cheerio from "cheerio";
import { detectProject, loadTailwindValidator } from "./lib/project.mjs";
import { buildModel, cssModeText, preflightUndo, iconIdentifier, splitClass } from "./lib/pipeline.mjs";
import { Assets } from "./lib/assets.mjs";
import { attrName, attrValue, styleObject, escapeText, templateLiteral, formAttrs, selectDefault, jsString } from "./lib/jsx.mjs";
import { INLINE_ELEMENTS, VOID_ELEMENTS } from "./lib/maps.mjs";
import { pickKey, contains, isIconElement } from "./lib/repeat.mjs";
import { isTag, isText, elementChildren } from "./lib/source.mjs";

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const RESERVED = new Set(["default", "class", "function", "new", "delete", "switch", "case", "var", "let", "const", "item", "key", "this", "export", "import", "return"]);
const MAX_LINE = 120;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const camel = (s) => s.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
const plural = (s) => (/(s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const singular = (s) => (/ies$/.test(s) ? `${s.slice(0, -3)}y` : /(ch|sh|x|ss)es$/.test(s) ? s.slice(0, -2) : /s$/.test(s) ? s.slice(0, -1) : s);

class FileCtx {
  constructor(file) {
    this.file = file;
    this.imports = new Map(); // module -> { default?: name, named: Set }
    this.dataDefs = [];
    this.names = new Set();
    this.rootNotes = [];
    this.usesFragment = false;
    this.typeImports = new Set();
  }
  addImport(mod, name, isDefault = false) {
    if (!this.imports.has(mod)) this.imports.set(mod, { default: null, named: new Set() });
    const e = this.imports.get(mod);
    if (isDefault) e.default = name;
    else e.named.add(name);
  }
  uniqueName(base) {
    let n = base;
    for (let i = 2; this.names.has(n) || RESERVED.has(n); i++) n = `${base}${i}`;
    this.names.add(n);
    return n;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const planPath = argv.find((a) => !a.startsWith("--"));
  const dry = argv.includes("--dry");
  if (!planPath) die("usage: node generate.mjs <work>/plan.json [--dry]");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const project = detectProject(plan.project || process.cwd());
  const root = project.root;
  const ts = plan.typescript ?? project.typescript;
  const ext = ts ? "tsx" : "jsx";
  const unit = " ".repeat(plan.indent ?? project.indent);
  const styling = plan.styling || (project.tailwind ? "tailwind" : "css");
  const tw4 = (project.tailwind ?? 4) >= 4;
  const exportStyle = plan.exports || project.exportStyle;
  const validator = styling === "tailwind" && tw4 ? await loadTailwindValidator(project) : null;
  const htmlDir = path.dirname(path.resolve(plan.source));
  const assets = new Assets({ htmlDir, publicDir: path.join(root, plan.assets?.dir || "public"), publicUrl: plan.assets?.url ?? "", dryRun: dry });
  const model = await buildModel(plan.source, { extraCss: plan.css || [], styling, tw4, validator, assets });
  const warnings = [];
  if (plan.sourceHash && plan.sourceHash !== model.meta.sourceHash) warnings.push("source changed since analyze: node ids may have shifted - re-run analyze.mjs and re-check the plan");

  // ------------------------------------------------------------ validate plan
  const errors = [];
  const { byId, ids } = model;
  // "unroll": lists the plan wants written out literally instead of mapped
  for (const id of plan.unroll || []) if (!model.groups.some((g) => ids.get(g.instances[0]) === id)) errors.push(`unroll: ${id} is not the first element of a list`);
  const groups = model.groups.filter((g) => !(plan.unroll || []).includes(ids.get(g.instances[0])));
  const groupByFirst = new Map(groups.map((g) => [g.instances[0], g]));
  const laterInstance = new Map();
  groups.forEach((g) => g.instances.slice(1).forEach((el) => laterInstance.set(el, g)));
  const insideTemplate = (el) => groups.find((g) => g.instances[0] !== el && contains(g.instances[0], el));
  const insideLater = (el) => groups.find((g) => g.instances.slice(1).some((i) => contains(i, el)));

  const comps = new Map(); // el -> {name, client, item, group}
  const names = new Set();
  for (const [id, spec] of Object.entries(plan.components || {})) {
    const name = typeof spec === "string" ? spec : spec?.name;
    const el = byId.get(id);
    if (!el || id === "n0") errors.push(`components.${id}: no such element (see outline.txt)`);
    else if (!name || !PASCAL.test(name)) errors.push(`components.${id}: "${name}" is not a PascalCase component name`);
    else if (names.has(name)) errors.push(`components.${id}: duplicate name "${name}"`);
    else if (insideLater(el)) errors.push(`components.${id}: is inside a repeated list item - use the first item (${ids.get(insideLater(el).instances[0])}) instead`);
    else if (insideTemplate(el)) errors.push(`components.${id}: is inside list item ${ids.get(insideTemplate(el).instances[0])}; make that list item the component, or leave ${id} inline`);
    else {
      names.add(name);
      comps.set(el, { name, client: (plan.client || []).includes(name), group: groupByFirst.get(el) || null });
    }
  }
  const IDENT = /^[a-z][A-Za-z0-9]*$/;
  for (const [id, raw] of Object.entries(plan.lists || {})) {
    const spec = typeof raw === "string" ? { name: raw } : raw || {};
    const el = byId.get(id);
    if (!el || !groupByFirst.has(el)) {
      errors.push(`lists.${id}: not the first element of a list (lists are marked "×N" in outline.txt)`);
      continue;
    }
    if (spec.name && !IDENT.test(spec.name)) errors.push(`lists.${id}: "${spec.name}" must be a camelCase identifier`);
    // optional field renames: {"name": "skills", "fields": {"value2": "percent"}}
    const tmpl = groupByFirst.get(el).template;
    for (const [from, to] of Object.entries(spec.fields || {})) {
      const f = tmpl.fields.find((x) => x.name === from);
      if (!f) errors.push(`lists.${id}.fields.${from}: no such field (have: ${tmpl.fields.map((x) => x.name).join(", ")})`);
      else if (!IDENT.test(to) || tmpl.fields.some((x) => x.name === to)) errors.push(`lists.${id}.fields.${from}: "${to}" is not a free camelCase name`);
      else {
        f.name = to;
        for (const bs of tmpl.bindings.values()) for (const b of bs) {
          if (b.field === from) b.field = to;
          for (const fl of b.flags || []) if (fl.field === from) fl.field = to;
        }
        for (const d of tmpl.data) if (from in d) (d[to] = d[from]), delete d[from];
      }
    }
  }
  const iconById = new Map([...model.icons.values()].map((i) => [i.id, i]));
  for (const [id, v] of Object.entries(plan.icons || {})) {
    if (!iconById.has(id)) errors.push(`icons.${id}: unknown icon id`);
    else if (v && !(v === "file" || v === "inline" || /^lucide:[A-Z][A-Za-z0-9]*$/.test(v) || PASCAL.test(v))) errors.push(`icons.${id}: use "Name", "file", "inline" or "lucide:Name"`);
  }
  const drop = new Set();
  for (const id of plan.drop || []) {
    const el = byId.get(id);
    if (!el) errors.push(`drop: ${id} not found`);
    else if (insideLater(el) || insideTemplate(el)) errors.push(`drop: ${id} is inside a list item; drop the whole list (${ids.get((insideLater(el) || insideTemplate(el)).instances[0])}) or nothing`);
    else {
      drop.add(el);
      if (groupByFirst.has(el)) groupByFirst.get(el).instances.forEach((i) => drop.add(i));
    }
  }
  for (const name of plan.client || []) if (!names.has(name) && name !== plan.page?.name) errors.push(`client: "${name}" is not a component in this plan`);
  if (!plan.page?.file || !plan.page?.name || !PASCAL.test(plan.page.name)) errors.push(`page: needs {"file": "...", "name": "PascalName"}`);
  if (errors.length) die(`plan.json has ${errors.length} problem(s):\n- ${errors.join("\n- ")}`);

  const outDir = path.join(root, plan.outDir);
  const pageFile = path.join(root, plan.page.file);
  const fileOf = (comp) => path.join(outDir, `${comp.name}.${ext}`);
  const pageComp = { name: plan.page.name, client: (plan.client || []).includes(plan.page.name), page: true };

  // ------------------------------------------------------------ imports between files
  const importPath = (fromFile, toFile) => {
    const noExt = toFile.replace(/\.(tsx|jsx|ts|js)$/, "");
    if (project.alias && path.dirname(fromFile) !== path.dirname(toFile)) {
      const target = path.join(root, project.alias.target);
      if (noExt.startsWith(target)) return project.alias.prefix + path.relative(target, noExt).split(path.sep).join("/");
    }
    let rel = path.relative(path.dirname(fromFile), noExt).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  };
  const importComp = (fctx, comp, file) => fctx.addImport(importPath(fctx.file, file), comp.name, exportStyle === "default");

  // ------------------------------------------------------------ icons
  const iconFile = path.join(outDir, `icons.${ext}`);
  const iconDefs = new Map(); // icon id -> {name, code}
  const iconNames = new Set();
  const iconMode = (ic) => {
    const v = plan.icons?.[ic.id];
    if (v === "file") return { mode: "file" };
    if (v && v.startsWith("lucide:")) return { mode: "lucide", name: v.slice(7) };
    let name = v && v !== "inline" ? v : null;
    if (!name) name = ic.size > 3000 && !ic.currentColor && v !== "inline" ? null : `Icon${ic.id.slice(1)}`;
    return name ? { mode: "inline", name } : { mode: "file" };
  };
  const svgoCfg = { multipass: true, plugins: [{ name: "preset-default", params: { overrides: { cleanupIds: false } } }, "removeXMLNS"] };

  // ------------------------------------------------------------ renderer
  const listNamesUsed = new Map(); // file -> Set
  const todo = [];

  function notesFor(el) {
    const n = model.elNotes.get(el) || [];
    return n.length ? `TODO(h2r): ${ids.get(el) || ""} ${n.join(" | ")}`.replace(/\*\//g, "* /") : null;
  }

  function isInlineLevel(el) {
    if (!isTag(el)) return true;
    if (el.name === "svg" || isIconElement(el)) return true;
    return INLINE_ELEMENTS.has(el.name) && !comps.has(el);
  }

  const flexOrGrid = (el) => /(^|\s)([\w-]+:)*(inline-)?(flex|grid)(\s|$)/.test(el.attribs?.class || "");

  function openTag(tag, attrs, depth, selfClose) {
    const pad = unit.repeat(depth);
    const parts = attrs.map(([k, v]) => (v === null ? k : `${k}=${v}`));
    const one = `${pad}<${tag}${parts.length ? " " + parts.join(" ") : ""}${selfClose ? " />" : ">"}`;
    if (one.length <= MAX_LINE || parts.length <= 1) return [one];
    return [`${pad}<${tag}`, ...parts.map((p) => `${pad}${unit}${p}`), `${pad}${selfClose ? "/>" : ">"}`];
  }

  function buildAttrs(el, scope) {
    const binds = scope.template?.bindings.get(el) || [];
    const bound = new Map(binds.filter((b) => ["attr", "class", "flags", "variant"].includes(b.kind)).map((b) => [b.attr, b]));
    const boundExpr = (b) => (b.kind === "flags" ? flagExpr(b) : b.kind === "variant" ? `{${scope.expr(b.field)} ? ${jsString(b.on)} : ${jsString(b.off)}}` : `{${scope.expr(b.field)}}`);
    const flagExpr = (b) => "{`" + b.base.replace(/[`$\\]/g, "\\$&") + b.flags.map((f) => `\${${scope.expr(f.field)} ? "${b.base ? " " : ""}${f.token}" : ""}`).join("") + "`}";
    let a = formAttrs(el, el.attribs || {});
    const inSvg = scope.inSvg;
    const out = [];
    if (el.name === "img" && a.alt === undefined) a.alt = "";
    for (const [k, v] of Object.entries(a)) {
      if (bound.has(k)) {
        const b = bound.get(k);
        out.push([k === "class" ? "className" : attrName(k, inSvg), boundExpr(b)]);
        continue;
      }
      if (k === "style") {
        const s = styleObject(v, ts);
        if (s) out.push(["style", s]);
        continue;
      }
      if (k === "defaultChecked") {
        out.push(["defaultChecked", null]);
        continue;
      }
      if (el.name === "textarea" && k === "value") continue;
      out.push([attrName(k, inSvg), attrValue(k, v)]);
    }
    for (const [k, b] of bound) if (!(k in a)) out.push([k === "class" ? "className" : attrName(k, inSvg), boundExpr(b)]);
    if (el.name === "select") {
      const d = selectDefault(el);
      if (d !== null) out.push(["defaultValue", attrValue("defaultValue", d)]);
    }
    if (el.name === "textarea") {
      const t = (el.children || []).map((c) => c.data || "").join("");
      if (t.trim()) out.push(["defaultValue", `{${jsString(t)}}`]);
    }
    return out;
  }

  /** Render <svg> occurrences: component usage, lucide icon, or <img> file. */
  function renderSvg(el, depth, scope) {
    const id = model.svgOf.get(el);
    const ic = iconById.get(id);
    const mode = iconMode(ic);
    const pad = unit.repeat(depth);
    const a = el.attribs || {};
    const passAttrs = [];
    if (a.class) passAttrs.push(["className", attrValue("class", a.class)]);
    for (const k of ["width", "height", "aria-hidden", "aria-label", "role", "focusable", "style", "id"]) {
      if (a[k] === undefined) continue;
      if (k === "style") {
        const s = styleObject(a[k], ts);
        if (s) passAttrs.push(["style", s]);
      } else passAttrs.push([attrName(k, true), attrValue(k, a[k])]);
    }
    if (mode.mode === "lucide") {
      scope.fctx.addImport("lucide-react", mode.name);
      return openTag(mode.name, passAttrs, depth, true);
    }
    if (mode.mode === "file") {
      const rel = `svg/${id}.svg`;
      if (!iconDefs.has(`${id}:file`)) {
        const svgText = optimize(model.$.html(el), svgoCfg).data;
        iconDefs.set(`${id}:file`, { url: assets.writeFile(rel, svgText.includes("xmlns") ? svgText : svgText.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')) });
      }
      const url = iconDefs.get(`${id}:file`).url;
      const imgAttrs = [["src", `"${url}"`], ["alt", `"${(ic.title || "").replace(/"/g, "")}"`], ...passAttrs.filter(([k]) => k !== "aria-hidden" && k !== "focusable" && k !== "role")];
      return openTag("img", imgAttrs, depth, true);
    }
    if (!iconDefs.has(id)) {
      let name = mode.name;
      while (iconNames.has(name)) name = `${name}X`;
      iconNames.add(name);
      const rootAttrs = Object.fromEntries(Object.entries(a).filter(([k]) => !["class", "width", "height", "style", "id", "aria-hidden", "aria-label", "role", "focusable"].includes(k)));
      const clone = `<svg ${Object.entries(rootAttrs).map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`).join(" ")}>${model.$.html(el.children || [])}</svg>`;
      let optimized = clone;
      try {
        optimized = optimize(clone, svgoCfg).data;
      } catch {
        /* keep original */
      }
      const $s = cheerio.load(optimized, { xml: { xmlMode: true, decodeEntities: false } });
      const svgEl = $s("svg")[0];
      const innerScope = { ...scope, inSvg: true, template: null, fctx: iconCtx };
      const attrs = Object.entries(svgEl.attribs).filter(([k]) => k !== "xmlns" && k !== "xmlns:xlink").map(([k, v]) => [attrName(k, true), attrValue(k, v)]);
      attrs.push(["{...props}", null]);
      const body = elementChildren(svgEl).flatMap((c) => renderEl(c, 3, innerScope));
      const lines = [
        `export function ${name}(props${ts ? ": SVGProps<SVGSVGElement>" : ""}) {`,
        `${unit}return (`,
        ...(body.length ? [...openTag("svg", attrs, 2, false), ...body, `${unit.repeat(2)}</svg>`] : openTag("svg", attrs, 2, true)),
        `${unit});`,
        `}`,
      ];
      iconDefs.set(id, { name, code: lines.join("\n") });
    }
    const name = iconDefs.get(id).name;
    scope.fctx.addImport(importPath(scope.fctx.file, iconFile), name);
    return [`${pad}<${name}${passAttrs.length ? " " + passAttrs.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(" ") : ""} />`];
  }

  function renderIconFont(el, depth, scope) {
    const ident = iconIdentifier(el);
    const target = ident && plan.iconFonts?.[ident];
    if (!target) return null;
    const name = target.startsWith("lucide:") ? target.slice(7) : target;
    if (target.startsWith("lucide:")) scope.fctx.addImport("lucide-react", name);
    else scope.fctx.addImport(importPath(scope.fctx.file, iconFile), name);
    const cls = (el.attribs?.class || "").split(/\s+/).filter((c) => c && !/^(fa[srlbd]?|fa-.+|bi|bi-.+|material-icons.*|material-symbols.*)$/.test(c) && !/\[--(ionicon|fa)-/.test(c));
    const attrs = [];
    if (styling === "tailwind") cls.unshift("size-[1em]");
    if (cls.length) attrs.push(["className", attrValue("class", cls.join(" "))]);
    if (styling !== "tailwind") attrs.push(["width", '"1em"'], ["height", '"1em"']);
    attrs.push(["aria-hidden", '"true"']);
    return openTag(name, attrs, depth, true);
  }

  function renderEl(el, depth, scope) {
    if (drop.has(el)) return [];
    const pad = unit.repeat(depth);
    if (el !== scope.root && comps.has(el) && !comps.get(el).group) {
      const c = comps.get(el);
      importComp(scope.fctx, c, fileOf(c));
      return [`${pad}<${c.name} />`];
    }
    if (el !== scope.groupRoot && groupByFirst.has(el) && !scope.inSvg) return renderGroup(groupByFirst.get(el), depth, scope);
    const binds = scope.template?.bindings.get(el) || [];
    const nodeBind = binds.find((b) => b.kind === "node");
    if (nodeBind) return [`${pad}{${scope.expr(nodeBind.field)}}`];
    if (el.name === "svg" && !scope.inSvg) return renderSvg(el, depth, scope);
    const iconFont = !scope.inSvg && renderIconFont(el, depth, scope);
    if (iconFont) return iconFont;

    let tag = el.name;
    if (!scope.inSvg && tag === "a" && plan.link === "next" && /^\/(?!\/)/.test(el.attribs?.href || "")) {
      tag = "Link";
      scope.fctx.addImport("next/link", "Link", true);
    }
    let attrs = buildAttrs(el, scope);
    if (!scope.inSvg && tag === "img" && plan.image === "next" && /^\d+$/.test(el.attribs?.width || "") && /^\d+$/.test(el.attribs?.height || "")) {
      tag = "Image";
      scope.fctx.addImport("next/image", "Image", true);
    }
    if (tag.includes("-") && !scope.inSvg && !todo.some((t) => t.includes(`<${tag}>`))) todo.push(`custom element <${tag}> kept as-is (TS may need a JSX.IntrinsicElements declaration, or map it)`);
    if (scope.keyAttr && el === scope.groupRoot) attrs = [["key", scope.keyAttr], ...attrs];

    const textBind = binds.find((b) => b.kind === "text" || b.kind === "rich");
    const voidEl = VOID_ELEMENTS.has(tag) || tag === "Image";
    if (voidEl) return openTag(tag, attrs, depth, true);
    if (tag === "textarea") return openTag(tag, attrs, depth, true);
    if (textBind) {
      const open = openTag(tag, attrs, depth, false);
      const inner = `{${scope.expr(textBind.field)}}`;
      if (open.length === 1 && open[0].length + inner.length + tag.length + 3 <= MAX_LINE * 1.4) return [`${open[0]}${inner}</${tag}>`];
      return [...open, `${pad}${unit}${inner}`, `${pad}</${tag}>`];
    }
    if (tag === "pre" || (tag === "code" && el.parent?.name === "pre")) {
      const raw = model.$(el).text();
      const open = openTag(tag, attrs, depth, false);
      return [`${open.join("\n")}${templateLiteral(raw)}</${tag}>`];
    }
    const kids = renderChildren(el, depth + 1, scope);
    if (!kids.length) return openTag(tag, attrs, depth, true);
    const open = openTag(tag, attrs, depth, false);
    if (kids.inline !== undefined && open.length === 1) {
      const line = `${open[0]}${kids.inline}</${tag}>`;
      if (line.length <= MAX_LINE * 1.4 || kids.inline.length <= 60) return [line];
    }
    return [...open, ...kids, `${pad}</${tag}>`];
  }

  function renderChildren(el, depth, scope) {
    const pad = unit.repeat(depth);
    const listBinds = new Map((scope.template?.bindings ? [...scope.template.bindings] : []).flatMap(([n, bs]) => bs.filter((b) => b.kind === "list").map((b) => [n, b])));
    const skipRun = new Set();
    for (const [, b] of listBinds) b.runNodes.slice(1).forEach((n) => skipRun.add(n));
    const tokens = [];
    for (const c of el.children || []) {
      if (isText(c)) {
        const t = c.data.replace(/[ \t\n\r\f]+/g, " ");
        if (t === " " || t === "") tokens.push({ kind: "space" });
        else tokens.push({ kind: "text", text: t });
        continue;
      }
      if (!isTag(c) || drop.has(c) || laterInstance.has(c) || skipRun.has(c)) continue;
      if (listBinds.has(c)) {
        tokens.push({ kind: "el", lines: renderList(c, listBinds.get(c), depth, scope), inline: false });
        continue;
      }
      const note = comps.has(c) || groupByFirst.has(c) ? null : notesFor(c); // those carry their own note
      const lines = renderEl(c, depth, scope);
      if (!lines.length) continue;
      tokens.push({ kind: "el", lines, inline: isInlineLevel(c), note, br: c.name === "br" });
    }
    // collapse insignificant whitespace (HTML rules), make significant whitespace explicit
    const fg = flexOrGrid(el);
    const items = [];
    tokens.forEach((t, i) => {
      const prev = tokens[i - 1], next = tokens[i + 1];
      // whitespace next to <br> collapses at the line edge, so it never matters
      const inl = (x) => x && (x.kind === "text" || (x.kind === "el" && x.inline && !x.br));
      if (t.kind === "space") {
        if (!fg && inl(prev) && inl(next)) items.push({ kind: "space" });
        return;
      }
      if (t.kind === "text") {
        let text = t.text;
        const lead = text.startsWith(" ") && !fg && inl(prev);
        const trail = text.endsWith(" ") && !fg && inl(next);
        text = text.replace(/^ +| +$/g, ""); // not .trim(): it would also eat &nbsp;
        if (lead) items.push({ kind: "space" });
        if (text) items.push({ kind: "text", text: escapeText(text) });
        if (trail) items.push({ kind: "space" });
        return;
      }
      items.push(t);
    });
    // dedupe consecutive spaces
    const clean = items.filter((x, i) => !(x.kind === "space" && (i === 0 || i === items.length - 1 || items[i - 1].kind === "space")));
    if (!clean.length) return [];
    const canInline = clean.every((x) => x.kind !== "el" || (x.lines.length === 1 && x.inline && !x.note)) && clean.some((x) => x.kind === "text");
    const result = [];
    if (canInline) {
      const s = clean.map((x) => (x.kind === "space" ? " " : x.kind === "text" ? x.text : x.lines[0].trim())).join("");
      if (s.length <= 90) {
        result.inline = s;
        return Object.assign(result, flow(clean, pad));
      }
      // long running text: wrap like prettier - break only at spaces; JSX
      // re-joins text lines with a space, element boundaries need {" "}
      return flow(clean, pad);
    }
    for (let i = 0; i < clean.length; i++) {
      const x = clean[i];
      if (x.kind === "space") {
        if (result.length && !result[result.length - 1].endsWith("}")) result[result.length - 1] += '{" "}';
        else result.push(`${pad}{" "}`);
        continue;
      }
      if (x.kind === "text") {
        result.push(`${pad}${x.text}`);
        continue;
      }
      if (x.note) result.push(`${pad}{/* ${x.note} */}`);
      result.push(...x.lines);
    }
    return result;
  }

  function flow(items, pad) {
    const width = Math.max(60, MAX_LINE - pad.length);
    const atoms = []; // {t: string, brk: "soft"|"hard"|null} - brk = break allowed before this atom
    for (const x of items) {
      if (x.kind === "space") {
        atoms.push({ t: " ", space: true });
        continue;
      }
      if (x.kind === "text") {
        x.text.split(" ").forEach((w, i) => {
          if (i) atoms.push({ t: " ", space: true, soft: true });
          if (w) atoms.push({ t: w });
        });
        continue;
      }
      atoms.push({ t: x.lines[0].trim(), el: true });
    }
    const lines = [];
    let cur = "";
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.space) {
        // look ahead: length of the next unbreakable run
        let run = "";
        for (let j = i + 1; j < atoms.length && !atoms[j].space; j++) run += atoms[j].t;
        if (cur && (cur + " " + run).length > width) {
          const prevEl = atoms[i - 1]?.el, nextEl = atoms[i + 1]?.el;
          lines.push(a.soft && !prevEl && !nextEl ? cur : `${cur}{" "}`);
          cur = "";
        } else cur += " ";
        continue;
      }
      cur += a.t;
    }
    if (cur) lines.push(cur);
    return lines.map((l) => `${pad}${l}`);
  }

  function dataLiteral(value, depth, scope) {
    const pad = unit.repeat(depth);
    if (value === undefined) return "undefined";
    if (typeof value === "string") return jsString(value);
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      if (value.every((v) => typeof v === "string")) {
        const one = `[${value.map(jsString).join(", ")}]`;
        if (one.length + pad.length < MAX_LINE) return one;
      }
      return `[\n${value.map((v) => `${pad}${unit}${dataLiteral(v, depth + 1, scope)},`).join("\n")}\n${pad}]`;
    }
    if (value.node) {
      const lines = renderEl(value.node, 0, { ...scope, template: null, groupRoot: null, keyAttr: null });
      return lines.length === 1 ? lines[0].trim() : `(\n${lines.map((l) => pad + unit + l).join("\n")}\n${pad})`;
    }
    if (value.children) {
      const fake = { type: "tag", name: "__frag", attribs: {}, children: value.children };
      const kids = renderChildren(fake, depth + 1, { ...scope, template: null, groupRoot: null, keyAttr: null });
      if (kids.inline !== undefined) return `<>${kids.inline}</>`;
      return `(\n${pad}${unit}<>\n${kids.map((l) => unit + l).join("\n")}\n${pad}${unit}</>\n${pad})`;
    }
    // object
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const parts = entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsString(k)}: ${dataLiteral(v, depth + 1, scope)}`);
    const one = `{ ${parts.join(", ")} }`;
    if (one.length + pad.length <= MAX_LINE && !one.includes("\n")) return one;
    return `{\n${parts.map((p) => `${pad}${unit}${p},`).join("\n")}\n${pad}}`;
  }

  function listName(g, fctx) {
    const first = g.instances[0];
    const id = ids.get(first);
    const spec = plan.lists?.[id];
    const wanted = typeof spec === "string" ? spec : spec?.name;
    if (wanted) return fctx.uniqueName(wanted);
    const comp = comps.get(first);
    let base = null;
    if (comp) base = plural(camel(comp.name));
    if (!base && g.parent.name === "select") base = "options";
    if (!base) {
      const hint = (model.origClasses.get(first) || "").split(/\s+/).find((c) => model.cssClasses.has(c));
      if (hint) base = camel(hint.replace(/[-_](item|card|box|wrapper|col|li|link)$/i, ""));
      if (base && !/s$/.test(base)) base = plural(base);
    }
    if (!base) {
      const hint = (model.origClasses.get(g.parent) || "").split(/\s+/).find((c) => model.cssClasses.has(c));
      if (hint) base = camel(hint.replace(/[-_](list|wrapper|wrap|container|grid|items|box|row|inner|area)$/i, ""));
      if (base && !/s$/.test(base)) base = plural(base);
    }
    if (!base && g.parent.name === "ul" && g.parent.parent?.name === "nav") base = "navLinks";
    if (!base) base = "items";
    if (!/^[a-z][A-Za-z0-9]*$/.test(base)) base = "items";
    return fctx.uniqueName(base);
  }

  function keyExpr(tmpl, v, idxVar) {
    const k = pickKey(tmpl);
    if (tmpl.scalar) return new Set(tmpl.data.map((d) => d[tmpl.fields[0].name])).size === tmpl.data.length ? v : idxVar;
    return k ? `${v}.${k}` : idxVar;
  }

  function renderGroup(g, depth, scope) {
    const pad = unit.repeat(depth);
    const fctx = scope.fctx;
    const name = listName(g, fctx);
    const v = (() => {
      let s = singular(name);
      if (s === name || RESERVED.has(s)) s = "item";
      return s;
    })();
    const tmpl = g.template;
    const usesIndex = !pickKey(tmpl) && !tmpl.scalar;
    const idx = usesIndex || (tmpl.scalar && new Set(tmpl.data.map((d) => d[tmpl.fields[0].name])).size !== tmpl.data.length) ? "index" : null;
    const key = keyExpr(tmpl, v, "index");
    const itemComp = comps.get(g.instances[0]);
    // data array, typed by inference
    const data = tmpl.scalar ? tmpl.data.map((d) => d[tmpl.fields[0].name]) : tmpl.data;
    fctx.dataDefs.push(`const ${name} = ${dataLiteral(data, 0, { ...scope, fctx })};`);
    const sep = whitespaceBetween(g);
    const params = idx ? `(${v}, index)` : `(${v})`;
    let body;
    if (itemComp) {
      importComp(fctx, itemComp, fileOf(itemComp));
      body = [`${pad}${unit}<${itemComp.name} key={${key}} {...${v}} />`];
      if (sep) {
        fctx.addImport("react", "Fragment");
        body = [`${pad}${unit}<Fragment key={${key}}>`, `${pad}${unit}${unit}<${itemComp.name} {...${v}} />{" "}`, `${pad}${unit}</Fragment>`];
      }
    } else {
      const inner = { ...scope, template: tmpl, groupRoot: g.instances[0], expr: (f) => (tmpl.scalar ? v : `${v}.${f}`), keyAttr: sep ? null : `{${key}}` };
      body = renderEl(g.instances[0], depth + (sep ? 2 : 1), inner);
      if (sep) {
        fctx.addImport("react", "Fragment");
        body[body.length - 1] += '{" "}';
        body = [`${pad}${unit}<Fragment key={${key}}>`, ...body, `${pad}${unit}</Fragment>`];
      }
    }
    const note = itemComp ? null : notesFor(g.instances[0]); // item components carry it in their own file
    const lines = [];
    if (note) lines.push(`${pad}{/* ${note} */}`);
    if (body.length === 1 && body[0].trim().length + name.length + v.length + 20 <= MAX_LINE) lines.push(`${pad}{${name}.map(${params} => ${body[0].trim()})}`);
    else lines.push(`${pad}{${name}.map(${params} => (`, ...body, `${pad}))}`);
    return lines;
  }

  function renderList(head, bind, depth, scope) {
    const pad = unit.repeat(depth);
    const inner = bind.inner;
    const listExpr = scope.expr(bind.field);
    let v = singular(bind.field);
    if (v === bind.field || RESERVED.has(v)) v = "entry";
    const scalarUnique = inner.scalar && new Set(inner.data.map((d) => d[inner.fields[0].name])).size === inner.data.length;
    const k = inner.scalar ? (scalarUnique ? v : "index") : pickKey(inner) ? `${v}.${pickKey(inner)}` : "index";
    const params = k === "index" ? `(${v}, index)` : `(${v})`;
    const sub = { ...scope, template: inner, groupRoot: head, expr: (f) => (inner.scalar ? v : `${v}.${f}`), keyAttr: `{${k}}` };
    const body = renderEl(head, depth + 1, sub);
    if (body.length === 1 && body[0].trim().length + listExpr.length + 20 <= MAX_LINE) return [`${pad}{${listExpr}.map(${params} => ${body[0].trim()})}`];
    return [`${pad}{${listExpr}.map(${params} => (`, ...body, `${pad}))}`];
  }

  function whitespaceBetween(g) {
    const a = g.instances[0];
    if (!isInlineLevel(a) || flexOrGrid(g.parent)) return false;
    const between = [];
    for (let n = a.next; n && n !== g.instances[1]; n = n.next) between.push(n);
    return between.some((n) => isText(n));
  }

  // ------------------------------------------------------------ types for item components
  function tsType(field) {
    if (field.kind === "rich" || field.kind === "node") return "ReactNode";
    if (field.kind === "flag") return "boolean";
    if (field.kind === "list") {
      const inner = field.inner;
      if (inner.scalar) return "string[]";
      return `{ ${inner.fields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${tsType(f)}`).join("; ")} }[]`;
    }
    return "string";
  }

  // ------------------------------------------------------------ write component files
  const iconCtx = new FileCtx(iconFile);
  const files = [];

  function componentSource(comp, rootEl, file) {
    const fctx = new FileCtx(file);
    const isItem = !!comp.group;
    const tmpl = isItem ? comp.group.template : null;
    const scope = { fctx, root: rootEl, template: tmpl, groupRoot: isItem ? rootEl : null, expr: (f) => f, inSvg: false, keyAttr: null };
    let jsx;
    if (comp.page) {
      const a = rootEl.attribs || {};
      // css styling always scopes the stylesheet to this class (see cssModeText)
      let cls = undoPreflight || styling === "css" ? `${scopeClass} ${a.class || ""}`.trim() : a.class || "";
      // body backgrounds paint the whole viewport; the wrapper must at least fill it
      // flow-root keeps children's margins inside (as <body> would)
      if (/(^|\s)(bg-|\[background)/.test(cls) && !/min-h-/.test(cls)) cls = `${cls} min-h-screen flow-root`.trim();
      const pseudo = { type: "tag", name: "div", attribs: { ...(cls ? { class: cls } : {}), ...(a.style ? { style: a.style } : {}) }, children: rootEl.children, parent: null };
      if (Object.keys(pseudo.attribs).length) jsx = renderEl(pseudo, 2, { ...scope, root: pseudo });
      else {
        const kids = renderChildren(rootEl, 3, scope);
        jsx = [`${unit.repeat(2)}<>`, ...kids, `${unit.repeat(2)}</>`];
      }
      // the page's web fonts: React 19 hoists <link precedence> into <head>
      if (fontLinks.length) {
        const links = fontLinks.map((href) => `${unit.repeat(3)}<link rel="stylesheet" href=${attrValue("href", href)} precedence="default" />`);
        if (jsx[0].trim() === "<>") jsx.splice(1, 0, ...links);
        else jsx = [`${unit.repeat(2)}<>`, ...links, ...jsx.map((l) => unit + l), `${unit.repeat(2)}</>`];
      }
    } else jsx = renderEl(rootEl, 2, scope);
    const rootNote = notesFor(rootEl);

    const lines = [];
    if (comp.client) lines.push(`"use client";`, "");
    const imports = [];
    const reactNamed = new Set(fctx.imports.get("react")?.named || []);
    const typeNames = [];
    if (isItem && tmpl.fields.some((f) => tsType(f).includes("ReactNode")) && ts) typeNames.push("ReactNode");
    fctx.imports.delete("react");
    if (reactNamed.size || typeNames.length) imports.push(`import { ${[...reactNamed, ...typeNames.map((t) => `type ${t}`)].join(", ")} } from "react";`);
    if (comp.page && project.router === "app" && !comp.client && (model.meta.title || model.meta.description) && ts) imports.push(`import type { Metadata } from "next";`);
    const sorted = [...fctx.imports].sort(([a], [b]) => (a.startsWith(".") || a.startsWith("@/")) - (b.startsWith(".") || b.startsWith("@/")) || a.localeCompare(b));
    for (const [mod, e] of sorted) {
      const parts = [];
      if (e.default) parts.push(e.default);
      if (e.named.size) parts.push(`{ ${[...e.named].sort().join(", ")} }`);
      imports.push(`import ${parts.join(", ")} from "${mod}";`);
    }
    if (comp.page && cssFile) imports.push(`import "${importPath(file, cssFile).replace(/\.css$/, "")}.css";`);
    lines.push(...imports);
    if (imports.length) lines.push("");
    if (comp.page && project.router === "app" && !comp.client && (model.meta.title || model.meta.description)) {
      const md = [];
      if (model.meta.title) md.push(`${unit}title: ${jsString(model.meta.title)},`);
      if (model.meta.description) md.push(`${unit}description: ${jsString(model.meta.description)},`);
      lines.push(`export const metadata${ts ? ": Metadata" : ""} = {`, ...md, "};", "");
    }
    if (fctx.dataDefs.length) lines.push(...fctx.dataDefs.flatMap((d) => [d, ""]));
    let sig = "";
    if (isItem) {
      const props = tmpl.fields.map((f) => f.name);
      if (ts) {
        lines.push(`type ${comp.name}Props = {`, ...tmpl.fields.map((f) => `${unit}${f.name}${f.optional ? "?" : ""}: ${tsType(f)};`), "};", "");
        sig = `{ ${props.join(", ")} }: ${comp.name}Props`;
      } else sig = `{ ${props.join(", ")} }`;
    }
    if (rootNote) lines.push(`// ${rootNote}`);
    lines.push(`export ${exportStyle === "default" ? "default " : ""}function ${comp.name}(${sig}) {`);
    lines.push(`${unit}return (`, ...jsx, `${unit});`, "}");
    return lines.join("\n") + "\n";
  }

  const fontLinks = Number(project.react) >= 19 ? model.meta.fonts : [];

  // css file
  let cssFile = null;
  const slug = path.basename(plan.outDir);
  const scopeClass = `${slug}-page`;
  // plain-CSS sources inside a Tailwind v4 app: scope the page and undo Preflight there
  const hasForms = model.$("body input, body button, body select, body textarea").length > 0;
  const undoPreflight = !!project.tailwind && !model.twSource && (styling === "css" || (tw4 && hasForms));
  let cssText = styling === "tailwind" ? model.globalsCss : cssModeText(model, scopeClass, { preflight: !!project.tailwind });
  if (styling === "tailwind" && undoPreflight) cssText = `${preflightUndo(scopeClass, { mode: "forms" })}\n\n${cssText}`.trim();
  if (cssText && cssText.trim()) cssFile = path.join(outDir, `${slug}.css`);

  // render children first so the icon file collects every icon used
  const outputs = [];
  for (const [el, comp] of comps) outputs.push({ file: fileOf(comp), code: componentSource(comp, el, fileOf(comp)), comp });
  outputs.push({ file: pageFile, code: componentSource(pageComp, model.body, pageFile), comp: pageComp });
  if (iconDefs.size && [...iconDefs.values()].some((d) => d.code)) {
    const defs = [...iconDefs.values()].filter((d) => d.code);
    const head = ts ? `import type { SVGProps } from "react";\n\n` : "";
    outputs.push({ file: iconFile, code: head + defs.map((d) => d.code).join("\n\n") + "\n" });
  }
  const cssHeader = styling === "css" ? "the page's own CSS, purged and scoped to this page" : "page-level CSS that utilities cannot express";
  if (cssFile) outputs.push({ file: cssFile, code: `/* generated by html-to-react from ${path.basename(plan.source)}: ${cssHeader} */\n${cssText}\n` });

  // ------------------------------------------------------------ todo + report
  const todoLines = [];
  for (const o of outputs) {
    const hits = o.code.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => l.includes("TODO(h2r)"));
    if (hits.length) todoLines.push(`${path.relative(root, o.file)}:`, ...hits.map(([l, n]) => `  L${n}: ${l.trim().replace(/^\{\/\*\s*|\s*\*\/\}$/g, "").replace(/^\/\/\s*/, "")}`));
  }
  const unmapped = [...model.iconFonts.keys()].filter((k) => !plan.iconFonts?.[k]);
  if (unmapped.length) todo.push(`icon-font icons left as markup (map them in plan.iconFonts): ${unmapped.join(", ")}`);
  if (model.meta.fonts.length) todo.push(fontLinks.length ? `fonts are loaded with <link precedence> in the page; move them to next/font if you want self-hosting (keep the CSS font-family names working)` : `fonts: ${model.meta.fonts.join(", ")} -> load with next/font or a <link> in the root layout`);
  if (model.meta.tailwindConfig) todo.push("inline tailwind.config: port theme.extend values to @theme in globals.css");
  if (model.meta.externalCss.length) todo.push(`external stylesheets still needed: ${model.meta.externalCss.join(", ")}`);
  const a = assets.summary();
  if (a.missing.length) todo.push(`missing local assets (left as-is): ${a.missing.join(", ")}`);
  for (const w of warnings) todo.push(`WARNING: ${w}`);

  if (!dry) {
    for (const o of outputs) {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(o.file, o.code);
    }
    assets.flush();
  }
  const work = path.dirname(path.resolve(planPath));
  fs.writeFileSync(path.join(work, "todo.md"), ["# Left for the model", ...(todoLines.length ? ["", "## behavior markers in code", ...todoLines] : []), ...(todo.length ? ["", "## other", ...todo.map((t) => `- ${t}`)] : []), ""].join("\n"));
  const allowedClasses = [...model.stateClasses, ...(model.tw?.hookClasses || []), ...(undoPreflight ? [scopeClass] : [])];
  fs.writeFileSync(path.join(work, "generated.json"), JSON.stringify({ files: outputs.map((o) => path.relative(root, o.file)), outDir: plan.outDir, page: plan.page.file, allowedClasses }, null, 2) + "\n");

  const rel = (p) => path.relative(process.cwd(), p);
  const total = outputs.reduce((s, o) => s + o.code.split("\n").length, 0);
  console.log(`${dry ? "[dry] would write" : "wrote"} ${outputs.length} files, ${total} lines:`);
  for (const o of outputs) console.log(`  ${rel(o.file)} (${o.code.split("\n").length - 1} lines${o.comp?.client ? ", client" : ""})`);
  console.log(`assets: ${a.copied} copied + ${a.written} written to ${plan.assets?.dir}${a.missing.length ? `, ${a.missing.length} missing` : ""}`);
  const nTodo = todoLines.filter((l) => l.startsWith("  L")).length;
  console.log(`todo: ${nTodo} behavior marker(s), ${todo.length} other note(s) -> ${rel(path.join(work, "todo.md"))}`);
  console.log(`next: implement todo.md, then node ${rel(path.join(path.dirname(new URL(import.meta.url).pathname), "check.mjs"))} ${rel(planPath)}`);
}

main().catch((e) => {
  console.error(`generate failed: ${e.stack || e.message}`);
  process.exit(1);
});
