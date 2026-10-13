// Repeated-structure detection, in the spirit of MDR (Liu, Grossman & Zhai,
// "Mining Data Records in Web Pages", KDD 2003): siblings whose tag trees match
// are records of one list. We turn each list into one template + a data array,
// so the generated component renders `items.map(...)` instead of N copies.
//
// Signatures collapse runs of identical children ("li*"), so two pricing cards
// with 3 and 5 bullet points still match; the bullets become a nested list prop.
import { isTag, isText, elementChildren } from "./source.mjs";

const ICON_FONT = /(^|\s)(fa[srlbd]?|fa-solid|fa-regular|fa-brands|bi|material-icons|material-symbols-\w+|icofont|ti|lni)(\s|$)/;

export function isIconElement(el) {
  if (!isTag(el)) return false;
  if (el.name === "svg" || el.name === "ion-icon") return true;
  if ((el.name === "i" || el.name === "span") && ICON_FONT.test(el.attribs.class || "")) return true;
  return false;
}

// consecutive paragraphs/headings are prose, not a list worth a .map()
// (and table cells are columns, not lists)
const PROSE = new Set(["p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "br", "blockquote", "td", "th"]);

const FORM_FIELDS = new Set(["input", "textarea", "select"]);

const wsOnly = (n) => isText(n) && !/[^\s]/.test(n.data.replace(/ /g, "x"));
const hasRealText = (el) => (el.children || []).some((c) => isText(c) && !wsOnly(c));

export function normText(s) {
  return s.replace(/[ \t\n\r\f]+/g, " ").trim();
}

export function textOf(el) {
  if (isText(el)) return el.data;
  if (el.name === "br") return " ";
  return (el.children || []).map(textOf).join("");
}

function collapse(sigs) {
  const out = [];
  for (const s of sigs) {
    const last = out[out.length - 1];
    if (last && (last === s || last === `${s}*`)) out[out.length - 1] = `${s}*`;
    else out.push(s);
  }
  return out;
}

export function makeSigner() {
  const memo = { strict: new Map(), loose: new Map() };
  function sig(el, strict) {
    const m = strict ? memo.strict : memo.loose;
    if (m.has(el)) return m.get(el);
    let s;
    if (el.name === "svg") s = "svg";
    else if (isIconElement(el)) s = "icon";
    else {
      const cls = strict ? (el.attribs.class || "").split(/\s+/).filter(Boolean).sort().join(".") : "";
      const kids = (el.children || []).filter((c) => isTag(c) || (isText(c) && !wsOnly(c)));
      const inline = kids.some((c) => isText(c)) ? "~" : "";
      const childSigs = kids.filter(isTag).map((c) => sig(c, strict));
      // items visible in different layouts (lg:hidden vs max-lg:hidden) never form one list
      const vis = strict ? "" : (el.attribs.class || "").split(/\s+/).filter((t) => /^[\w-]+:(hidden|contents)$/.test(t)).sort().join(".");
      s = `${el.name}${cls ? "." + cls : ""}${vis ? "!" + vis : ""}${inline}(${collapse(childSigs).join(",")})`;
    }
    m.set(el, s);
    return s;
  }
  return sig;
}

function treeSize(el) {
  return 1 + elementChildren(el).reduce((a, c) => a + (c.name === "svg" ? 1 : treeSize(c)), 0);
}

/**
 * Find list-like runs of siblings.
 * @returns {Array<{parent, instances, template}>}
 */
export function detectGroups(body) {
  const sig = makeSigner();
  const groups = [];
  const visit = (parent) => {
    if (parent.name === "svg" || isIconElement(parent)) return;
    const kids = elementChildren(parent);
    const inGroup = new Set();
    if (!hasRealText(parent) && kids.length >= 2) {
      // loose first (ignores classes, so an "active" first item still joins
      // its siblings); strict picks up what loose rejected
      for (const strict of [false, true]) {
        let i = 0;
        while (i < kids.length) {
          if (inGroup.has(kids[i])) {
            i++;
            continue;
          }
          let j = i + 1;
          while (j < kids.length && !inGroup.has(kids[j]) && sig(kids[j], strict) === sig(kids[i], strict)) j++;
          let run = kids.slice(i, j);
          // a loose run can swallow a neighbour with a different role (nav links + a CTA
          // button): drop edge items whose semantic classes share nothing with the rest
          if (!strict) {
            const sem = (x) => new Set(hintClasses(x));
            const shares = (x, others) => others.some((o) => [...sem(x)].some((c) => sem(o).has(c)));
            while (run.length > 2 && sem(run[run.length - 1]).size && !shares(run[run.length - 1], run.slice(0, -1))) run = run.slice(0, -1);
            while (run.length > 2 && sem(run[0]).size && !shares(run[0], run.slice(1))) run = run.slice(1);
            j = i + run.length;
          }
          // rows of icons stay literal: a data array of <Icon/> nodes buys nothing
          if (run.length >= 2 && !FORM_FIELDS.has(run[0].name) && !isIconElement(run[0])) {
            const template = buildTemplate(run, sig, strict);
            const prose = PROSE.has(run[0].name) && template?.fields.length === 1 && ["text", "rich"].includes(template.fields[0].kind);
            // two loosely-similar siblings with different classes are usually two layouts, not a list
            const weak = !strict && run.length < 3 && template?.fields.some((f) => f.kind === "class" || f.kind === "flag");
            if (template && template.fields.length && !prose && !weak) {
              groups.push({ parent, instances: run, template, strict });
              run.forEach((r) => inGroup.add(r));
            }
          }
          i = j;
        }
      }
    }
    // Runs nested inside an instance are already list fields of its template.
    for (const k of kids) if (!inGroup.has(k)) visit(k);
  };
  visit(body);
  return groups;
}

export function contains(root, el) {
  for (let p = el; p; p = p.parent) if (p === root) return true;
  return false;
}

// ---------------------------------------------------------------- templates

const NAME_BY_TAG = { h1: "title", h2: "title", h3: "title", h4: "title", h5: "title", h6: "title", p: "description", a: "label", button: "label", span: "label", li: "text", time: "date", strong: "highlight", b: "highlight", em: "note", small: "note", td: "cell", th: "heading", label: "label", figcaption: "caption", blockquote: "quote", cite: "author", dt: "term", dd: "definition", data: "value", q: "quote" };
const ATTR_NAMES = { src: "image", alt: "imageAlt", href: "href", title: "tooltip", datetime: "dateTime", value: "value", "aria-label": "ariaLabel", poster: "poster", name: "name", srcset: "imageSrcSet", target: "target", rel: "rel", placeholder: "placeholder", type: "type", id: "id", for: "htmlFor" };
const UTILITY_LIKE = /[:[\]/]|^-?(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|text|bg|flex|grid|gap|items|justify|rounded|border|shadow|font|leading|tracking|z|opacity|block|inline|hidden|relative|absolute)(-|$)/;

let hintClasses = (el) => (el.attribs?.class || "").split(/\s+/).filter((c) => c && !UTILITY_LIKE.test(c));
/** The pipeline knows which original class names are semantic (styled by the page's own CSS). */
let isFlagClass = () => false;
export function setHintClasses(fn, flagFn) {
  hintClasses = fn;
  if (flagFn) isFlagClass = flagFn;
}

const TAGLIKE = /^(h[1-6]|p|span|div|a|li|ul|ol|img|btn|button|link|active|show|open|hidden|visible|has-\w+|is-\w+)$/;

function semanticHint(el, rootClass) {
  const cls = hintClasses(el).filter((c) => !TAGLIKE.test(c));
  if (!cls.length) return null;
  let c = cls[cls.length - 1];
  if (rootClass && c.startsWith(rootClass)) c = c.slice(rootClass.length);
  const words = c.split(/[-_]+/).filter(Boolean).filter((w) => !/^(item|wrapper|wrap|box|inner|container|content|el|elem|block)$/.test(w));
  if (!words.length) return null;
  const pick = words.slice(-2);
  return pick.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
}

function fieldName(el, kind, attr, rootClass, used, sample = null) {
  let base;
  if (kind === "attr") base = attr === "src" && el.name !== "img" ? `${el.name}Src` : ATTR_NAMES[attr] || attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  else if (kind === "class") base = "className";
  else if (kind === "flag") base = attr.replace(/^is-/, "is ").replace(/[-_ ]+(.)/g, (_, c) => c.toUpperCase());
  else if (kind === "node") base = "icon";
  else if (kind === "text" && (el.name === "a" || el.name === "button")) base = "label";
  else base = semanticHint(el, rootClass) || (kind === "text" && sample && /^(p|div|span)$/.test(el.name) && sample.split(" ").length <= 4 ? (el.name === "span" ? "label" : "title") : null) || NAME_BY_TAG[el.name] || (kind === "rich" ? "content" : "text");
  if (kind === "list") {
    // name nested lists after the item class ("timeline-item" -> "timelines")
    // or the container ("tags-list" -> "tags"), never after the <li> tag
    const own = hintClasses(el).filter((c) => !TAGLIKE.test(c))[0];
    const parent = el.parent ? hintClasses(el.parent).filter((c) => !TAGLIKE.test(c))[0] : null;
    const stem = (own && own.replace(/[-_](item|card|entry|row|col|box)$/i, "")) || (parent && parent.replace(/[-_](list|items|wrapper|wrap|grid|container|group)$/i, "")) || "item";
    const camelStem = stem.replace(/[-_]+(.)/g, (_, c) => c.toUpperCase());
    base = /s$/.test(camelStem) ? camelStem : `${camelStem}s`;
  }
  base = base.replace(/[^A-Za-z0-9_$]/g, "") || "field";
  if (/^\d/.test(base)) base = `f${base}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

function innerKey(el) {
  // structural+textual identity of an element's content, for equality tests
  return (el.children || [])
    .map((c) => (isText(c) ? normText(c.data) : `<${c.name} ${JSON.stringify(c.attribs)}>${innerKey(c)}</${c.name}>`))
    .join("");
}

function segments(el, sig, strict) {
  const kids = elementChildren(el);
  const segs = [];
  for (const k of kids) {
    const s = sig(k, strict);
    const last = segs[segs.length - 1];
    if (last && last.sig === s) last.nodes.push(k);
    else segs.push({ sig: s, nodes: [k] });
  }
  return segs;
}

/**
 * Align N structurally-equal subtrees and find what differs between them.
 * bindings: Map(templateNode -> [{kind, field, attr?, list?}])
 * data: one plain object per instance (values: string | {node} | array)
 */
export function buildTemplate(instances, sig, strict) {
  const fields = [];
  const bindings = new Map();
  const data = instances.map(() => ({}));
  const used = new Set();
  const rootClass = hintClasses(instances[0])[0] || null;
  const bind = (node, b) => {
    if (!bindings.has(node)) bindings.set(node, []);
    bindings.get(node).push(b);
  };
  let ok = true;

  const walk = (nodes) => {
    const t = nodes[0];
    // whole-element variation for icons (different svg / icon name per item)
    if (isIconElement(t)) {
      const keys = nodes.map((n) => `${n.name}${JSON.stringify(n.attribs)}${innerKey(n)}`);
      if (new Set(keys).size > 1) {
        const f = { name: fieldName(t, "node", null, rootClass, used), kind: "node" };
        fields.push(f);
        bind(t, { kind: "node", field: f.name });
        nodes.forEach((n, i) => (data[i][f.name] = { node: n }));
      }
      return;
    }
    // attributes
    const names = new Set(nodes.flatMap((n) => Object.keys(n.attribs || {})));
    for (const a of names) {
      if (t.name === "option" && a === "selected") continue; // becomes <select defaultValue>
      const vals = nodes.map((n) => n.attribs?.[a]);
      if (new Set(vals).size <= 1) continue;
      if (a === "style") {
        ok = false;
        return;
      }
      if (a === "class") {
        // differences that are only state classes ("active") become booleans
        const sets = vals.map((v) => (v || "").split(/\s+/).filter(Boolean));
        const common = sets[0].filter((c) => sets.every((x) => x.includes(c)));
        const extra = [...new Set(sets.flatMap((x) => x.filter((c) => !common.includes(c))))];
        if (extra.length && extra.length <= 3 && extra.every((c) => isFlagClass(c))) {
          const flags = extra.map((tok) => ({ token: tok, field: fieldName(t, "flag", tok, rootClass, used) }));
          flags.forEach((fl) => fields.push({ name: fl.field, kind: "flag", optional: true }));
          bind(t, { kind: "flags", attr: "class", base: common.join(" "), flags });
          sets.forEach((x, i) => flags.forEach((fl) => x.includes(fl.token) && (data[i][fl.field] = true)));
          continue;
        }
      }
      if (a === "class" && new Set(vals).size === 2) {
        // two looks keyed on one semantic class (".plan.featured", ".btn-ghost"):
        // a boolean prop choosing between the two class strings
        const sem = nodes.map((n) => hintClasses(n));
        const all = [...new Set(sem.flat())];
        const diff = all.filter((c) => !sem.every((x) => x.includes(c)));
        if (diff.length === 1) {
          const pattern = sem.map((x) => x.includes(diff[0]));
          const on = vals[pattern.indexOf(true)], off = vals[pattern.indexOf(false)];
          if (pattern.every((p, i) => vals[i] === (p ? on : off))) {
            const same = (x, y) => x.every((v, i) => v === y[i]);
            let f = fields.find((x) => x.kind === "flag" && x.pattern && (same(x.pattern, pattern) || same(x.pattern, pattern.map((v) => !v))));
            const invert = f ? !same(f.pattern, pattern) : false;
            if (!f) {
              const common = all.filter((c) => !diff.includes(c));
              const prefix = common.find((c) => diff[0].startsWith(`${c}-`));
              f = { name: fieldName(t, "flag", prefix ? diff[0].slice(prefix.length + 1) : diff[0], rootClass, used), kind: "flag", optional: true, pattern };
              fields.push(f);
              pattern.forEach((p, i) => p && (data[i][f.name] = true));
            }
            bind(t, { kind: "variant", attr: "class", field: f.name, on: invert ? off : on, off: invert ? on : off });
            continue;
          }
        }
      }
      const kind = a === "class" ? "class" : "attr";
      const f = { name: fieldName(t, kind, a, rootClass, used), kind, attr: a, optional: vals.some((v) => v === undefined) };
      fields.push(f);
      bind(t, { kind, field: f.name, attr: a });
      vals.forEach((v, i) => (data[i][f.name] = v));
    }
    const kids = elementChildren(t);
    if (!kids.length) {
      const texts = nodes.map((n) => normText(textOf(n)));
      if (new Set(texts).size > 1) {
        const longest = texts.reduce((a, b) => (b.length > a.length ? b : a), "");
        const f = { name: fieldName(t, "text", null, rootClass, used, longest), kind: "text", optional: texts.some((x) => !x) };
        fields.push(f);
        bind(t, { kind: "text", field: f.name });
        texts.forEach((x, i) => (data[i][f.name] = x));
      }
      return;
    }
    if (hasRealText(t)) {
      const keys = nodes.map(innerKey);
      if (new Set(keys).size > 1) {
        const f = { name: fieldName(t, "rich", null, rootClass, used), kind: "rich" };
        fields.push(f);
        bind(t, { kind: "rich", field: f.name });
        nodes.forEach((n, i) => (data[i][f.name] = { children: n.children }));
      }
      return;
    }
    const segLists = nodes.map((n) => segments(n, sig, strict));
    const segCount = segLists[0].length;
    if (segLists.some((s) => s.length !== segCount)) {
      ok = false;
      return;
    }
    for (let k = 0; k < segCount; k++) {
      const counts = segLists.map((s) => s[k].nodes.length);
      if (counts.every((c) => c === 1)) {
        walk(segLists.map((s) => s[k].nodes[0]));
        continue;
      }
      // a run of identical children: nested list
      const items = segLists.flatMap((s) => s[k].nodes);
      const inner = buildTemplate(items, sig, strict);
      if (!inner || !inner.fields.length) {
        ok = false;
        return;
      }
      const head = segLists[0][k].nodes[0];
      const f = { name: fieldName(head, "list", null, rootClass, used), kind: "list", inner };
      fields.push(f);
      bind(head, { kind: "list", field: f.name, inner, runNodes: segLists[0][k].nodes });
      let offset = 0;
      segLists.forEach((s, i) => {
        const n = s[k].nodes.length;
        data[i][f.name] = inner.data.slice(offset, offset + n).map((d) => (inner.scalar ? d[inner.fields[0].name] : d));
        offset += n;
      });
    }
  };

  walk(instances);
  if (!ok) return null;
  const scalar = fields.length === 1 && fields[0].kind === "text";
  return { fields, bindings, data, scalar, root: instances[0] };
}

/** Pick a React key: first field whose values are unique non-empty strings. */
export function pickKey(template) {
  const prefer = ["href", "id", "title", "label", "name", "image", "text"];
  const cands = template.fields.filter((f) => (f.kind === "text" || f.kind === "attr") && template.data.every((d) => typeof d[f.name] === "string" && d[f.name]));
  cands.sort((a, b) => {
    const ia = prefer.findIndex((p) => a.name.toLowerCase().includes(p.toLowerCase()));
    const ib = prefer.findIndex((p) => b.name.toLowerCase().includes(p.toLowerCase()));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const f of cands) {
    const vals = template.data.map((d) => d[f.name]);
    if (new Set(vals).size === vals.length) return f.name;
  }
  return null;
}

/** Same-structure subtrees in different places (shared component candidates). */
export function findDuplicates(body, groups, ids) {
  const sig = makeSigner();
  const bySig = new Map();
  const skip = new Set(groups.flatMap((g) => g.instances.slice(1)));
  const walk = (el) => {
    if (skip.has(el) || el.name === "svg") return;
    if (treeSize(el) >= 4) {
      const s = sig(el, true);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(el);
    }
    elementChildren(el).forEach(walk);
  };
  elementChildren(body).forEach(walk);
  const dup = new Map(); // el -> first el with the same structure
  for (const els of bySig.values()) {
    const top = els.filter((e) => !els.some((o) => o !== e && contains(o, e)));
    const distinctParents = new Set(top.map((e) => e.parent));
    if (top.length >= 2 && distinctParents.size >= 2) top.slice(1).forEach((e) => ids.has(e) && dup.set(e, top[0]));
  }
  return dup;
}
