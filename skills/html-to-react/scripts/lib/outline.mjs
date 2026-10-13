// Renders the compact, token-cheap view of the page that the model reads
// instead of the raw HTML: tag tree with ids, short text, list/icon markers.
// Styling detail is deliberately absent - the generator carries it verbatim,
// so the model never needs to read or re-type class strings.
import { isTag, isText, elementChildren } from "./source.mjs";
import { iconIdentifier } from "./pipeline.mjs";
import { normText, textOf, isIconElement } from "./repeat.mjs";

const est = (chars) => Math.round(chars / 3.6); // rough chars->tokens for markup
const fmtTok = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`);
const UTILITY_LIKE = /[:[\]/!]|^-?(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min|max|text|bg|flex|grid|gap|items|justify|self|place|rounded|border|shadow|font|leading|tracking|z|opacity|block|inline|hidden|relative|absolute|fixed|sticky|top|left|right|bottom|inset|overflow|container|space|divide|col|row|order|transition|duration|ease|transform|scale|rotate|translate|cursor|select|object|aspect|fill|stroke|sr|underline|no-underline|uppercase|lowercase|capitalize|italic|truncate|whitespace|break|list|outline|ring|backdrop|blur|from|to|via|bg-gradient|group|peer|antialiased|appearance|pointer|resize|shrink|grow|basis|float|clear|align|content|visible|invisible|static|table|toggle|animate)(-|$)/;

function short(s, n = 42) {
  s = normText(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function renderOutline(model, { title = "page" } = {}) {
  const { body, ids, groups, duplicates, svgOf, elNotes, origClasses, cssClasses, $ } = model;
  const groupByFirst = new Map(groups.map((g) => [g.instances[0], g]));
  const skip = new Set(groups.flatMap((g) => g.instances.slice(1)));
  const lines = [];

  const label = (el, binding) => {
    let s = ids.get(el) ? `${ids.get(el)} ` : "";
    s += el.name;
    const a = el.attribs || {};
    if (a.id) s += `#${a.id}`;
    const layer = model.layerNames?.get(el);
    if (layer) s += `⟨${layer.length > 32 ? layer.slice(0, 31) + "…" : layer}⟩`;
    const only = model.variantInfo?.only.get(el);
    if (only) {
      const [kind, bp] = only.split("@");
      s += { base: ` [<${bp} only]`, bp: ` [${bp}+ only]`, "wrap-base": ` [wrapper <${bp}]`, "wrap-bp": ` [wrapper ${bp}+]` }[kind];
    }
    const sem = (origClasses.get(el) || "").split(/\s+/).filter((c) => c && (cssClasses.has(c) || !UTILITY_LIKE.test(c))).slice(0, 2);
    if (sem.length) s += `.${sem.join(".")}`;
    if (el.name === "a" && a.href) s += `(${a.href.length > 30 ? a.href.slice(0, 29) + "…" : a.href})`;
    if (el.name === "img") s += `(${(a.src || "").split("/").pop().slice(0, 30)}${a.alt ? ` "${short(a.alt, 30)}"` : ""})`;
    if (el.name === "input" || el.name === "button" && a.type) s += `[${a.type || "text"}${a.name ? " " + a.name : ""}]`;
    if (a.placeholder) s += ` "${short(a.placeholder, 30)}"`;
    if (/(^|\s)hidden(\s|$)/.test(a.class || "")) s += " (hidden)";
    const icon = iconIdentifier(el);
    if (icon) s += ` ${icon}`;
    if (elNotes.has(el)) s += " ⚡";
    if (duplicates.has(el)) s += ` ≈${ids.get(duplicates.get(el))}`;
    if (binding) s += ` {${binding.map((b) => b.field || (b.flags || []).map((f) => f.field).join(",")).join(",")}}`;
    return s;
  };

  const inlineText = (el) => {
    const kids = el.children || [];
    const hasText = kids.some((c) => isText(c) && c.data.trim());
    if (!hasText && elementChildren(el).length) return null;
    const t = short(textOf(el));
    return t ? `"${t}"` : null;
  };

  const walk = (el, depth, ctx) => {
    if (skip.has(el)) return;
    if (el.name === "svg") {
      lines.push(`${"  ".repeat(depth)}${svgOf.get(el)}${el.attribs?.class ? "" : ""}`);
      return;
    }
    const g = groupByFirst.get(el);
    let tmpl = ctx.template;
    let head = label(el, tmpl?.bindings.get(el));
    if (g) {
      const fields = g.template.fields.map((f) => (f.kind === "list" ? `${f.name}[]` : f.name));
      head += ` ×${g.instances.length} list{${fields.join(", ")}}`;
      tmpl = g.template;
    }
    const size = est($.html(el).length) * (g ? g.instances.length : 1);
    if (size > 350) head += ` [~${fmtTok(size)}t]`;
    // inline content: show text and stop
    const kids = elementChildren(el);
    const txt = inlineText(el);
    if (txt && (kids.length === 0 || (el.children || []).some((c) => isText(c) && c.data.trim()))) {
      const inlineIcons = kids.filter((k) => k.name === "svg").map((k) => svgOf.get(k));
      lines.push(`${"  ".repeat(depth)}${head} ${txt}${inlineIcons.length ? " " + inlineIcons.join(" ") : ""}`);
      return;
    }
    // chain of single children: print on one line
    let chain = head;
    let cur = el;
    while (true) {
      const ks = elementChildren(cur).filter((k) => !skip.has(k));
      if (ks.length !== 1 || ks[0].name === "svg" || groupByFirst.has(ks[0]) || isIconElement(ks[0])) break;
      const k = ks[0];
      const t = inlineText(k);
      chain += ` > ${label(k, tmpl?.bindings.get(k))}`;
      cur = k;
      if (t) {
        chain += ` ${t}`;
        const icons = elementChildren(k).filter((x) => x.name === "svg").map((x) => svgOf.get(x));
        if (icons.length) chain += ` ${icons.join(" ")}`;
        lines.push(`${"  ".repeat(depth)}${chain}`);
        return;
      }
    }
    const rest = elementChildren(cur).filter((k) => !skip.has(k));
    const allIcons = rest.length && rest.every((k) => k.name === "svg" || isIconElement(k));
    if (allIcons) {
      lines.push(`${"  ".repeat(depth)}${chain} ${rest.map((k) => (k.name === "svg" ? svgOf.get(k) : iconIdentifier(k) || k.name)).join(" ")}`);
      return;
    }
    lines.push(`${"  ".repeat(depth)}${chain}`);
    for (const k of rest) walk(k, depth + 1, { template: tmpl });
  };

  const bodyLine = label(body);
  lines.push(bodyLine);
  for (const k of elementChildren(body)) walk(k, 1, {});
  return lines.join("\n");
}

export function renderHeader(model, { outlineChars, file }) {
  const m = model.meta;
  const src = est(m.rawChars);
  const out = est(outlineChars);
  const iconsUnique = model.icons.size;
  const iconsTotal = [...model.icons.values()].reduce((a, i) => a + i.els.length, 0);
  const h = [];
  h.push(`# h2r outline: ${file}`);
  h.push(`# source ≈${fmtTok(src)} tok -> outline ≈${fmtTok(out)} tok | ${model.ids.size} elements, ${model.groups.length} lists, ${iconsTotal} svg (${iconsUnique} unique)`);
  const tw = model.twSource ? `source Tailwind v${model.twSource.version} -> ${model.tw4 ? "v4" : "v3"}` : "source CSS";
  h.push(`# styling: ${model.styling} (${tw})${m.externalCss.length ? ` | external CSS kept: ${m.externalCss.length}` : ""}`);
  if (model.variantInfo) {
    const bp = model.variantInfo.widths.find((w) => w.prefix)?.prefix || "lg";
    h.push(`# merged layouts: ${model.variantInfo.widths.map((w) => `${w.w}px${w.prefix ? ` from ${w.prefix}:` : " (base)"}`).join(" + ")} | [<${bp} only] / [${bp}+ only] = exists in one layout, rendered with ${bp}:hidden / max-${bp}:hidden | [wrapper ...] = box only in that layout (display:contents in the other)`);
  }
  h.push(`# legend: nID element${model.layerNames?.size ? " ⟨layer name⟩" : ""} | ×N list{fields} rendered with .map | {field} bound to list data | iN svg icon | ⚡ behavior (behavior.md) | ≈nX same shape as nX | [~Nt] JSX size`);
  return h.join("\n");
}
