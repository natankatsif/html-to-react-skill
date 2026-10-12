// CSS side of the pipeline.
//  - parse every local stylesheet in document order
//  - match selectors against the static DOM (css-select through cheerio)
//  - "css" styling: purge to only the rules the page can use
//  - "tailwind" styling: run the cascade per element, then turn the winning
//    declarations into utility classes (variants for media/state/pseudo).
// Anything that cannot be expressed safely as utilities is kept as plain CSS
// and its element keeps the class it needs ("hook"), so nothing is lost.
import postcss from "postcss";
import { parse as parseSelector, stringify as stringifySelector } from "css-what";
import { STATE_PSEUDOS, STRUCTURAL_PSEUDOS, PSEUDO_ELEMENTS, BREAKPOINTS, SHORTHAND_SLOTS, TW4_RENAMES, UA_DEFAULTS, INHERITED_FROM_HTML } from "./maps.mjs";

const COMBINATORS = new Set(["descendant", "child", "adjacent", "sibling", "parent", "column"]);

// ---------------------------------------------------------------- parsing

export function parseStylesheets(cssSources) {
  const rules = []; // element-level rules (one entry per comma-separated selector)
  const globals = []; // postcss nodes that stay global CSS: @font-face, @keyframes, :root, element resets
  const imports = [];
  const parseErrors = [];
  let order = 0;
  let rootFontPx = 16;

  for (const src of cssSources) {
    let root;
    try {
      root = postcss.parse(src.text, { from: src.path || undefined });
    } catch (e) {
      parseErrors.push(`${src.origin}: ${e.reason || e.message}`);
      continue;
    }
    root.walkAtRules("import", (at) => {
      imports.push(at.params);
      at.remove();
    });
    // NB: returning false from a postcss walker stops the whole walk, so the
    // global at-rules are collected in their own pass.
    root.walkAtRules(/^(-\w+-)?(keyframes|font-face|page|property|counter-style)$/, (node) => {
      globals.push({ node, order: order++, origin: src.origin, baseDir: src.baseDir });
    });
    root.walkRules((node) => {
      for (let p = node.parent; p && p.type !== "root"; p = p.parent) if (p.type === "atrule" && /(keyframes|font-face|page)$/.test(p.name)) return;
      const ctx = atRuleContext(node);
      const decls = [];
      node.each((d) => {
        if (d.type === "decl") decls.push({ prop: d.prop.toLowerCase(), value: d.value.trim(), important: !!d.important });
      });
      if (!decls.length) return;
      for (const d of decls) {
        if ((node.selector === "html" || node.selector === ":root") && d.prop === "font-size") {
          const m = d.value.match(/^([\d.]+)(px|%|rem|em)$/);
          if (m) rootFontPx = m[2] === "px" ? +m[1] : m[2] === "%" ? (16 * m[1]) / 100 : 16 * m[1];
        }
      }
      for (const selector of node.selectors) {
        let tokens;
        try {
          tokens = parseSelector(selector)[0];
        } catch {
          parseErrors.push(`${src.origin}: cannot parse selector "${selector}"`);
          continue;
        }
        rules.push({ selector: selector.trim(), tokens, decls, ctx, order: order++, node, origin: src.origin, baseDir: src.baseDir });
      }
    });
  }
  return { rules, globals, imports, parseErrors, rootFontPx };
}

function atRuleContext(node) {
  const media = [];
  const supports = [];
  const other = [];
  for (let p = node.parent; p && p.type !== "root"; p = p.parent) {
    if (p.type !== "atrule") continue;
    if (p.name === "media") media.unshift(p.params);
    else if (p.name === "supports") supports.unshift(p.params);
    else if (p.name !== "layer") other.unshift(`@${p.name} ${p.params}`);
  }
  return { media, supports, other };
}

export function specificity(tokens) {
  let a = 0, b = 0, c = 0;
  for (const t of tokens) {
    if (t.type === "attribute") {
      if (t.name === "id" && t.action === "equals") a++;
      else b++;
    } else if (t.type === "pseudo") {
      if (["not", "is", "has"].includes(t.name) && Array.isArray(t.data)) {
        const inner = t.data.map(specificity).sort(cmpSpec).pop() || [0, 0, 0];
        a += inner[0]; b += inner[1]; c += inner[2];
      } else if (t.name !== "where") b++;
    } else if (t.type === "tag") c++;
    else if (t.type === "pseudo-element") c++;
  }
  return [a, b, c];
}
const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

function splitCompounds(tokens) {
  const compounds = [{ tokens: [], comb: null }];
  for (const t of tokens) {
    if (COMBINATORS.has(t.type)) compounds.push({ tokens: [], comb: t.type });
    else compounds[compounds.length - 1].tokens.push(t);
  }
  return compounds;
}

const isClassTok = (t) => t.type === "attribute" && t.name === "class" && t.action === "element";

/**
 * A rule stays global CSS only when it targets the document itself (*, html,
 * body, :root, ::selection). Element-type rules like `a {}` or `article {}`
 * are matched per element instead: imported as global CSS they would leak
 * into every other page of the app.
 */
export function isGlobalSelector(tokens) {
  const compounds = splitCompounds(tokens);
  if (compounds.length > 1) return false;
  const t = compounds[0].tokens;
  const tags = t.filter((x) => x.type === "tag").map((x) => x.name);
  if (tags.some((n) => n !== "html" && n !== "body")) return false;
  // plain `body {}` styles move onto the page's root element (the host app
  // owns <body>); body::-webkit-scrollbar & co. have to stay global
  if (tags.includes("body") && !t.some((x) => x.type === "pseudo-element")) return false;
  if (t.some((x) => x.type === "attribute")) return false;
  return t.every((x) => x.type === "tag" || x.type === "universal" || x.type === "pseudo-element" || (x.type === "pseudo" && ["root", "focus", "focus-visible", "hover", "where", "is", "not"].includes(x.name)));
}

// ---------------------------------------------------------------- matching

/**
 * Analyse one selector into: a static selector css-select can match against
 * the DOM, plus the Tailwind variants that replace its dynamic parts.
 * Returns null when the selector cannot be expressed (caller keeps it as CSS).
 */
export function planSelector(tokens, domClasses, jsClasses, tw4, stateClasses = new Set()) {
  const compounds = splitCompounds(tokens);
  const subject = compounds[compounds.length - 1];
  const variants = []; // ordered: group/peer, state, structural, pseudo-element
  let pseudoEl = null;
  const relations = []; // {index, kind:'group'|'peer', variant}
  let unsupported = null;

  const staticCompounds = compounds.map((cp, idx) => {
    const isSubject = idx === compounds.length - 1;
    const kept = [];
    for (const t of cp.tokens) {
      if (t.type === "pseudo-element") {
        if (!isSubject) unsupported = "pseudo-element not on subject";
        pseudoEl = PSEUDO_ELEMENTS[t.name] || `[&::${t.name}]`;
        continue;
      }
      if (isClassTok(t) && (!domClasses.has(t.value) || stateClasses.has(t.value))) {
        // A state class (toggled by JS, maybe present initially) - keep the
        // rule alive as a variant keyed on that class: [&.active]:block
        if (!jsClasses.has(t.value) && !stateClasses.has(t.value)) return null; // dead class: rule unused
        if (isSubject) variants.push(`[&.${t.value}]`);
        else relations.push({ idx, variant: `[.${t.value}]` });
        continue;
      }
      if (t.type === "pseudo") {
        const name = t.name;
        const nth = name === "nth-child" || name === "nth-of-type" ? String(t.data).replace(/\s+/g, "") : null;
        let v = STATE_PSEUDOS[name] || STRUCTURAL_PSEUDOS[name] || null;
        if (nth === "odd" || nth === "2n+1") v = name === "nth-child" ? "odd" : null;
        if (nth === "even" || nth === "2n") v = name === "nth-child" ? "even" : null;
        if (!v && (nth !== null || name === "nth-last-child" || name === "nth-last-of-type")) v = `[&:${name}(${t.data})]`;
        if (!v && name === "not") {
          const inner = stringifySelector([t.data[0] || []]);
          const innerDynamic = (t.data[0] || []).some((x) => x.type === "pseudo" || (isClassTok(x) && !domClasses.has(x.value)));
          if (!innerDynamic) {
            kept.push(t); // static :not() - css-select can evaluate it
            continue;
          }
          v = `[&:not(${inner.replace(/\s+/g, "_")})]`;
        }
        if (!v) {
          if (["is", "where", "has", "root", "lang", "dir", "scope"].includes(name)) {
            kept.push(t);
            continue;
          }
          unsupported = `:${name}`;
          continue;
        }
        if (isSubject) variants.push(v);
        else relations.push({ idx, variant: v.startsWith("[&") ? `[${v.slice(2, -1).replace(/^:/, ":")}]` : v });
        continue;
      }
      kept.push(t);
    }
    return { tokens: kept, comb: cp.comb };
  });
  if (unsupported || staticCompounds.includes(null)) return unsupported ? { unsupported } : null;
  // Removing state classes must not leave a compound that matches anything
  // (".active {}" -> "*"): such rules stay CSS, keyed on the kept class.
  const lastStatic = staticCompounds[staticCompounds.length - 1].tokens;
  if (!lastStatic.length && compounds[compounds.length - 1].tokens.some(isClassTok)) return { unsupported: "rule keyed only on a state class" };
  for (const r of relations) if (!staticCompounds[r.idx].tokens.length) return { unsupported: "state on an unqualified ancestor" };

  // relations: the compound with a state must be the subject's ancestor
  // (descendant/child) or preceding sibling (+ / ~) - one level of relation only.
  const rel = [];
  for (const r of relations) {
    const combAfter = compounds[r.idx + 1]?.comb;
    const isLastRelational = r.idx === compounds.length - 2;
    if (!isLastRelational && combAfter !== "descendant" && combAfter !== "child") return { unsupported: "state on distant compound" };
    const kind = combAfter === "adjacent" || combAfter === "sibling" ? "peer" : "group";
    rel.push({ ...r, kind });
  }
  const relIdx = new Set(rel.map((r) => r.idx));
  if (relIdx.size > 1) return { unsupported: "states on several compounds" };

  const staticTokens = [];
  staticCompounds.forEach((cp, i) => {
    if (i > 0) staticTokens.push({ type: cp.comb });
    if (!cp.tokens.length) staticTokens.push({ type: "universal", namespace: null });
    else staticTokens.push(...cp.tokens);
  });
  const staticSelector = stringifySelector([staticTokens]);
  const relationCompound = rel.length ? stringifySelector([staticCompounds[rel[0].idx].tokens.length ? staticCompounds[rel[0].idx].tokens : [{ type: "universal", namespace: null }]]) : null;
  const relationVariants = rel.map((r) => {
    const base = r.kind; // group | peer
    if (r.variant.startsWith("[")) return `${base}-${r.variant}`; // group-[.open], group-[:nth-child(3)]
    return `${base}-${r.variant}`; // group-hover, peer-checked
  });
  return {
    staticSelector,
    relation: rel.length
      ? { kind: rel[0].kind, comb: rel[0].idx === compounds.length - 2 ? compounds[rel[0].idx + 1].comb : "descendant", compound: relationCompound }
      : null,
    variants: [...relationVariants, ...variants, ...(pseudoEl ? [pseudoEl] : [])],
    specificity: specificity(tokens),
  };
}

// Tailwind v4 emits arbitrary min-[..]/max-[..] variants before named ones
// (sm, md, lg) whatever their values, so mixing them breaks the cascade.
// When a stylesheet uses any non-standard breakpoint, every breakpoint of
// that kind is written as an arbitrary value (those sort by value).
export function breakpointMode(rules) {
  const mins = new Set(), maxs = new Set();
  for (const r of rules) {
    for (const q of r.ctx.media) {
      for (const m of q.matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/g)) {
        const px = m[3] === "px" ? +m[2] : +m[2] * 16;
        (m[1] === "min" ? mins : maxs).add(px);
      }
    }
  }
  const named = new Set(BREAKPOINTS.map(([, v]) => v));
  return {
    arbitraryMin: [...mins].some((v) => !named.has(v)),
    arbitraryMax: [...maxs].some((v) => !named.has(v + 1) && ![...named].some((n) => Math.abs(n - v - 0.02) < 0.001 || n === v + 0.5)),
  };
}

export function mediaToVariant(media, tw4, mode = {}) {
  const parts = [];
  for (const q of media) {
    if (q.includes(",")) return null;
    let s = q.toLowerCase().replace(/\bonly\s+/g, "").replace(/^\s*(screen|all)\s+and\s+/, "").replace(/^\s*(screen|all)\s*$/, "").trim();
    if (!s) continue;
    if (s === "print") {
      parts.push("print");
      continue;
    }
    const conds = s.split(/\s+and\s+/);
    for (const cond of conds) {
      const m = cond.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)$/);
      if (m) {
        const px = m[3] === "px" ? +m[2] : +m[2] * 16;
        if (m[1] === "min") {
          const bp = !mode.arbitraryMin && BREAKPOINTS.find(([, v]) => v === px);
          parts.push(bp ? bp[0] : `min-[${px}px]`);
        } else {
          const bp = !mode.arbitraryMax && BREAKPOINTS.find(([, v]) => v === px + 1 || Math.abs(v - px - 0.02) < 0.001 || v === px + 0.5);
          parts.push(bp ? `max-${bp[0]}` : `max-[${px}px]`);
        }
        continue;
      }
      if (/prefers-color-scheme\s*:\s*dark/.test(cond)) parts.push("dark");
      else if (/prefers-reduced-motion\s*:\s*reduce/.test(cond)) parts.push("motion-reduce");
      else if (/prefers-reduced-motion\s*:\s*no-preference/.test(cond)) parts.push("motion-safe");
      else if (/orientation\s*:\s*portrait/.test(cond)) parts.push("portrait");
      else if (/orientation\s*:\s*landscape/.test(cond)) parts.push("landscape");
      else if (/^\(\s*hover\s*:\s*hover\s*\)$/.test(cond)) continue; // Tailwind's hover already implies it
      else return null;
    }
  }
  return parts;
}

// ---------------------------------------------------------------- cascade -> tailwind

const prec = (e) => [e.important ? 1 : 0, ...e.spec, e.order];
const cmpPrec = (x, y) => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// Split a shorthand into longhands when we can do it exactly. Needed because
// Tailwind sorts arbitrary properties ([font:inherit]) after regular
// utilities, so a shorthand that lost some slots must not be emitted whole.
const BOX = { margin: "margin-%", padding: "padding-%", "border-width": "border-%-width", "border-style": "border-%-style", "border-color": "border-%-color" };
function splitValues(v) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of v.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
export function expandShorthand(prop, value) {
  const slots = SHORTHAND_SLOTS[prop];
  if (!slots) return null;
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value.trim())) return slots.map((p) => ({ prop: p, value: value.trim() }));
  const v = splitValues(value);
  const four = (vals) => {
    const [t, r = t, b = t, l = r] = vals;
    return [t, r, b, l];
  };
  if (BOX[prop] && v.length >= 1 && v.length <= 4) {
    const vals = four(v);
    return ["top", "right", "bottom", "left"].map((side, i) => ({ prop: BOX[prop].replace("%", side), value: vals[i] }));
  }
  if (prop === "inset" && v.length <= 4) return four(v).map((x, i) => ({ prop: ["top", "right", "bottom", "left"][i], value: x }));
  if (prop === "gap" && v.length <= 2) return [{ prop: "row-gap", value: v[0] }, { prop: "column-gap", value: v[1] || v[0] }];
  if (prop === "overflow" && v.length <= 2) return [{ prop: "overflow-x", value: v[0] }, { prop: "overflow-y", value: v[1] || v[0] }];
  if (prop === "border-radius" && !value.includes("/") && v.length <= 4) {
    const [a, b = a, c = a, d = b] = v;
    return [a, b, c, d].map((x, i) => ({ prop: SHORTHAND_SLOTS["border-radius"][i], value: x }));
  }
  if (/^(margin|padding)-(block|inline)$/.test(prop) && v.length <= 2) return slots.map((p, i) => ({ prop: p, value: v[i] || v[0] }));
  return null;
}

/** entries: [{prefix, decls:[{prop,value,important}], spec, order}] -> Map(prefix -> decls[]) */
export function resolveCascade(entries) {
  const byPrefix = new Map();
  for (const e of entries) {
    for (const d of e.decls) {
      const slots = SHORTHAND_SLOTS[d.prop] || [d.prop];
      const cand = { ...d, spec: e.spec, order: e.order, key: `${e.order}|${d.prop}` };
      if (!byPrefix.has(e.prefix)) byPrefix.set(e.prefix, new Map());
      const slotMap = byPrefix.get(e.prefix);
      for (const s of slots) {
        const cur = slotMap.get(s);
        if (!cur || cmpPrec(prec(cand), prec(cur)) >= 0) slotMap.set(s, cand);
      }
    }
  }
  const base = byPrefix.get("") || new Map();
  const out = new Map();
  for (const [prefix, slotMap] of byPrefix) {
    const winners = new Map();
    for (const [slot, cand] of slotMap) {
      if (prefix !== "") {
        const b = base.get(slot);
        if (b && cmpPrec(prec(b), prec(cand)) > 0) continue; // base rule outranks this variant
      }
      if (!winners.has(cand.key)) winners.set(cand.key, { ...cand, won: new Set() });
      winners.get(cand.key).won.add(slot);
    }
    // a shorthand that lost some of its slots: keep only the longhands it won
    for (const [key, w] of [...winners]) {
      const slots = SHORTHAND_SLOTS[w.prop];
      if (!slots || w.won.size === slots.length) continue;
      const parts = expandShorthand(w.prop, w.value);
      if (!parts) continue;
      winners.delete(key);
      parts.filter((p) => w.won.has(p.prop)).forEach((p, i) => winners.set(`${key}|${i}`, { ...w, prop: p.prop, value: p.value }));
    }
    const decls = [...winners.values()].sort((a, b) => a.order - b.order);
    if (decls.length) out.set(prefix, decls);
  }
  return out;
}

// `background: <one color | one gradient | one url>` -> the longhand the
// converter understands. Runs after the cascade, so the shorthand's reset of
// other background longhands has already been applied.
// var(--x) is deliberately not "colorish": it may hold a gradient.
const COLORISH = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^)]*\)|[a-z]+)$/i;
function expandBackground(d) {
  if (d.prop !== "background") return d;
  const v = d.value.trim();
  if (/^(none|transparent)$/i.test(v)) return { ...d, prop: "background-color", value: "transparent" };
  if (COLORISH.test(v) && !/^(inherit|initial|unset|revert)$/i.test(v)) return { ...d, prop: "background-color" };
  if (/^((repeating-)?(linear|radial|conic)-gradient\(.*\)|url\([^)]*\))$/i.test(v) && !/\)\s*,|\)\s+\S/.test(v.replace(/\([^()]*\)/g, "()").replace(/\([^()]*\)/g, "()"))) return { ...d, prop: "background-image" };
  return d;
}

function arbitraryProperty(prop, value) {
  const v = value.replace(/_/g, "\\_").replace(/"/g, "'").replace(/\s*,\s*/g, ",").replace(/\s+/g, "_");
  return `[${prop}:${v}]`;
}

export class TailwindEmitter {
  constructor({ rootFontPx = 16, tw4 = true, validator = null } = {}) {
    this.rootFontPx = rootFontPx;
    this.tw4 = tw4;
    this.validator = validator;
    this.cache = new Map();
    this.converter = null;
  }

  async init() {
    try {
      const { TailwindConverter } = await import("css-to-tailwindcss");
      this.converter = new TailwindConverter({ remInPx: this.rootFontPx, tailwindConfig: { content: [] } });
    } catch {
      this.converter = null; // fallback: arbitrary properties only
    }
  }

  async declsToClasses(decls) {
    decls = decls.map(expandBackground);
    const key = decls.map((d) => `${d.prop}:${d.value}${d.important ? "!" : ""}`).join(";");
    if (this.cache.has(key)) return this.cache.get(key);
    const out = [];
    for (const important of [false, true]) {
      const group = decls.filter((d) => d.important === important);
      if (!group.length) continue;
      let classes = [];
      let left = group;
      if (this.converter) {
        try {
          const css = `.x{${group.map((d) => `${d.prop}:${d.value}`).join(";")}}`;
          const r = await this.converter.convertCSS(css);
          classes = r.nodes[0]?.tailwindClasses || [];
          left = [];
          r.convertedRoot.walkDecls((d) => left.push({ prop: d.prop, value: d.value }));
        } catch {
          classes = [];
          left = group;
        }
      }
      classes = classes.concat(left.map((d) => arbitraryProperty(d.prop, d.value)));
      classes = classes.map((c) => this.normalize(c));
      // The converter speaks Tailwind v3; when a class it produced is not
      // valid for the project's Tailwind, redo that group one declaration at
      // a time and fall back to an arbitrary property for the failures.
      if (this.validator) {
        const ok = this.validator(classes);
        if (classes.some((c) => !ok.has(c))) {
          classes = [];
          for (const d of group) {
            const one = (await this.convertOne(d)).map((c) => this.normalize(c));
            const okOne = this.validator(one);
            classes.push(...(one.length && one.every((c) => okOne.has(c)) ? one : [this.normalize(arbitraryProperty(d.prop, d.value))]));
          }
        }
      }
      if (important) classes = classes.map((c) => (c.startsWith("!") ? c.slice(1) : c)).map((c) => (this.tw4 ? `${c}!` : `!${c}`));
      out.push(...classes);
    }
    this.cache.set(key, out);
    return out;
  }

  async convertOne(d) {
    if (!this.converter) return [];
    try {
      const r = await this.converter.convertCSS(`.x{${d.prop}:${d.value}}`);
      let left = 0;
      r.convertedRoot.walkDecls(() => left++);
      return left ? [] : r.nodes[0]?.tailwindClasses || [];
    } catch {
      return [];
    }
  }

  normalize(c) {
    c = c.replace(/content-\[""\]/g, "content-['']").replace(/"/g, "'");
    if (this.tw4 && TW4_RENAMES[c]) c = TW4_RENAMES[c];
    // v4 shorthand for CSS variables: bg-[color:var(--x)] -> bg-(color:--x)
    if (this.tw4) c = c.replace(/^([\w-]+)-\[(?:([a-z-]+):)?var\((--[\w-]+)\)\]$/, (_, u, hint, v) => `${u}-(${hint ? hint + ":" : ""}${v})`);
    return c;
  }
}

/** Map each element to its Tailwind classes. Returns { classesByEl, groupMarks, leftovers } */
export async function cssToTailwind($, parsed, { domClasses, jsClasses, tw4, inlineEntries = new Map(), stateClasses = new Set(), validator = null, uaDefaults = false }) {
  const emitter = new TailwindEmitter({ rootFontPx: parsed.rootFontPx, tw4, validator });
  await emitter.init();
  const entriesByEl = new Map();
  for (const [el, decls] of inlineEntries) entriesByEl.set(el, [{ prefix: "", decls, spec: [1000, 0, 0], order: Number.MAX_SAFE_INTEGER }]);
  const push = (el, entry) => {
    if (!entriesByEl.has(el)) entriesByEl.set(el, []);
    entriesByEl.get(el).push(entry);
  };
  // lowest priority: browser defaults Preflight would otherwise remove.
  // Properties a `*` reset already sets are skipped (that reset stays global CSS).
  if (uaDefaults) {
    const universal = new Set();
    for (const r of parsed.rules) {
      if (r.tokens.length === 1 && r.tokens[0].type === "universal") r.decls.forEach((d) => (SHORTHAND_SLOTS[d.prop] || [d.prop]).forEach((x) => universal.add(x)));
    }
    $("body, body *").each((_, el) => {
      const ua = (UA_DEFAULTS[el.name] || []).filter(([prop]) => !(SHORTHAND_SLOTS[prop] || [prop]).some((x) => universal.has(x)));
      if (ua.length) push(el, { prefix: "", decls: ua.map(([prop, value]) => ({ prop, value, important: false })), spec: [-1, 0, 0], order: -1 });
    });
  }
  const leftovers = []; // rules kept as CSS (selector text + reason)
  const hookClasses = new Set();
  const marks = new Map(); // el -> Set('group'|'peer')
  const globals = [];
  const bpMode = breakpointMode(parsed.rules);

  for (const rule of parsed.rules) {
    if (isGlobalSelector(rule.tokens)) {
      globals.push(rule);
      // html {font-family; color; line-height} reaches the page through inheritance:
      // copy it onto the page root, below anything that targets body itself
      if (rule.tokens.length === 1 && rule.tokens[0].name === "html" && !rule.ctx.other.length) {
        const decls = rule.decls.filter((d) => INHERITED_FROM_HTML.has(d.prop));
        const media = mediaToVariant(rule.ctx.media, tw4, bpMode);
        const body = $("body")[0];
        if (decls.length && media && body) push(body, { prefix: media.map((v) => `${v}:`).join(""), decls, spec: [0, 0, 0], order: rule.order });
      }
      continue;
    }
    if (rule.ctx.media.some((m) => /print/.test(m) && !/screen/.test(m))) continue; // print-only styles are out of scope
    const plan = planSelector(rule.tokens, domClasses, jsClasses, tw4, stateClasses);
    if (plan === null) continue; // dead rule
    const media = mediaToVariant(rule.ctx.media, tw4, bpMode);
    const supports = rule.ctx.supports.map((s) => `supports-[${s.replace(/^\(|\)$/g, "").replace(/\s+/g, "_")}]`);
    if (plan.unsupported || media === null || rule.ctx.other.length) {
      leftovers.push({ rule, reason: plan.unsupported || (media === null ? `@media ${rule.ctx.media.join(" & ")}` : rule.ctx.other.join(" ")) });
      rule.tokens.filter(isClassTok).forEach((t) => hookClasses.add(t.value));
      for (const cp of splitCompounds(rule.tokens)) cp.tokens.filter(isClassTok).forEach((t) => hookClasses.add(t.value));
      continue;
    }
    let els;
    try {
      els = $(plan.staticSelector).toArray();
    } catch {
      leftovers.push({ rule, reason: "selector not matchable" });
      continue;
    }
    if (!els.length) continue;
    const prefix = [...media, ...supports, ...plan.variants].map((v) => `${v}:`).join("");
    for (const el of els) {
      if (plan.relation) {
        const rel = findRelation($, el, plan.relation);
        if (!rel) continue;
        if (!marks.has(rel)) marks.set(rel, new Set());
        marks.get(rel).add(plan.relation.kind);
      }
      if (!entriesByEl.has(el)) entriesByEl.set(el, []);
      entriesByEl.get(el).push({ prefix, decls: rule.decls, spec: plan.specificity, order: rule.order });
    }
  }

  const classesByEl = new Map();
  for (const [el, entries] of entriesByEl) {
    const resolved = resolveCascade(entries);
    const classes = [];
    for (const [prefix, decls] of resolved) {
      const cls = await emitter.declsToClasses(decls.map(({ prop, value, important }) => ({ prop, value, important })));
      classes.push(...cls.map((c) => prefix + c));
    }
    classesByEl.set(el, classes);
  }
  return { classesByEl, marks, leftovers, hookClasses, globals, emitter };
}

function findRelation($, el, relation) {
  const test = (n) => {
    try {
      return $(n).is(relation.compound);
    } catch {
      return false;
    }
  };
  if (relation.kind === "group") {
    if (relation.comb === "child") return el.parent && test(el.parent) ? el.parent : null;
    for (let p = el.parent; p && p.type !== "root"; p = p.parent) if (test(p)) return p;
    return null;
  }
  let s = el.prev;
  while (s) {
    if (s.type === "tag" && test(s)) return s;
    if (relation.comb === "adjacent" && s.type === "tag") return null;
    s = s.prev;
  }
  return null;
}

/** Convert one standalone class rule (".gradient{...}") to utilities - for behavior notes. */
export async function classRecipe(emitter, decls) {
  return emitter.declsToClasses(decls.map(({ prop, value, important }) => ({ prop, value, important })));
}

// ---------------------------------------------------------------- purge (css styling)

/** Keep only rules whose selectors can match this page (now or after JS toggles a class). */
export function purgeCss($, cssSources, { domClasses, jsClasses }) {
  const out = [];
  const usedAnimations = new Set();
  const keyframes = [];
  let kept = 0, dropped = 0;
  for (const src of cssSources) {
    let root;
    try {
      root = postcss.parse(src.text);
    } catch {
      continue;
    }
    root.walkAtRules("import", (at) => at.remove());
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
      const keep = rule.selectors.filter((sel) => selectorCanMatch($, sel, domClasses, jsClasses));
      dropped += rule.selectors.length - keep.length;
      kept += keep.length;
      if (!keep.length) rule.remove();
      else {
        rule.selectors = keep;
        rule.walkDecls(/^(-\w+-)?animation(-name)?$/, (d) => d.value.split(/[\s,]+/).forEach((w) => usedAnimations.add(w)));
      }
    });
    root.walkAtRules(/keyframes$/, (at) => {
      keyframes.push(at);
    });
    // drop empty at-rules left behind
    let changed = true;
    while (changed) {
      changed = false;
      root.walkAtRules((at) => {
        if (at.nodes && at.nodes.length === 0 && !/font-face|page/.test(at.name)) {
          at.remove();
          changed = true;
        }
      });
    }
    out.push({ origin: src.origin, root });
  }
  for (const at of keyframes) if (!usedAnimations.has(at.params.trim())) at.remove();
  return { roots: out, kept, dropped };
}

function selectorCanMatch($, sel, domClasses, jsClasses) {
  let tokens;
  try {
    tokens = parseSelector(sel)[0];
  } catch {
    return true; // unknown syntax: keep, better safe than broken
  }
  const stripped = [];
  for (const t of tokens) {
    if (t.type === "pseudo-element") continue;
    if (t.type === "pseudo") continue; // dropping pseudos only widens the match: safe for purging
    if (isClassTok(t) && !domClasses.has(t.value)) {
      if (!jsClasses.has(t.value)) return false;
      continue;
    }
    stripped.push(t);
  }
  if (!stripped.length || COMBINATORS.has(stripped[stripped.length - 1].type)) return true;
  try {
    return $(stringifySelector([stripped])).length > 0;
  } catch {
    return true;
  }
}
