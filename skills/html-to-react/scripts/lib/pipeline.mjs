// The shared, deterministic model of a page. `analyze` and `generate` both
// call buildModel() on the same input, so node ids (n12, i3) always refer to
// the same elements in the outline the model read and in the code it emits.
import postcss from "postcss";
import { loadSource, isTag, isText, elementChildren, sha } from "./source.mjs";
import { analyzeScripts } from "./behavior.mjs";
import { parseStylesheets, cssToTailwind, purgeCss, isGlobalSelector, classRecipe } from "./css.mjs";
import path from "node:path";
import { TW4_RENAMES, TW_NOOP_CLASSES, DROP_ATTRS, INLINE_ELEMENTS, UA_DEFAULTS } from "./maps.mjs";
import { detectGroups, findDuplicates, isIconElement, setHintClasses } from "./repeat.mjs";
import { Assets } from "./assets.mjs";

const BLOCKISH = new Set(["div", "section", "article", "aside", "header", "footer", "main", "nav", "ul", "ol", "form", "figure", "table", "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "dl", "details", "fieldset", "picture", "video"]);

/** Split "md:hover:shadow!" into { variants: "md:hover:", base: "shadow", bang } (brackets-aware). */
export function splitClass(c) {
  let depth = 0, last = -1;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === "[") depth++;
    else if (c[i] === "]") depth--;
    else if (c[i] === ":" && depth === 0) last = i;
  }
  let variants = c.slice(0, last + 1);
  let base = c.slice(last + 1);
  let lead = "", trail = "";
  if (base.startsWith("!")) (lead = "!"), (base = base.slice(1));
  if (base.endsWith("!")) (trail = "!"), (base = base.slice(0, -1));
  return { variants, base, lead, trail };
}

function parseInlineStyle(style) {
  try {
    const root = postcss.parse(`a{${style}}`);
    const decls = [];
    root.walkDecls((d) => decls.push({ prop: d.prop.toLowerCase(), value: d.value.trim(), important: !!d.important }));
    return decls;
  } catch {
    return [];
  }
}

function allElements(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (!isTag(c)) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function classesOf(el) {
  return (el.attribs?.class || "").split(/\s+/).filter(Boolean);
}

/**
 * @param {string} htmlPath
 * @param {{extraCss?:string[], styling:'tailwind'|'css', tw4:boolean, validator?:Function|null, assets?:Assets}} opts
 */
export async function buildModel(htmlPath, opts) {
  const src = loadSource(htmlPath, { extraCss: opts.extraCss || [] });
  const { $, body, meta } = src;
  const assets = opts.assets || new Assets({ htmlDir: meta.baseDir });
  const styling = opts.styling;
  const tw4 = opts.tw4 !== false;
  const twSource = meta.tailwind; // {version} | null
  const notes = { droppedClasses: new Map(), jsHookClasses: new Map(), unknownClasses: new Map(), renamed: 0, borderFixes: 0, flattened: 0, emptied: 0, droppedIds: 0, droppedAttrs: new Map() };
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

  // original semantic class names, for the outline (they explain intent)
  const origClasses = new Map();
  $("body, body *").each((_, el) => el.attribs?.class && origClasses.set(el, el.attribs.class));

  const behavior = analyzeScripts($, src.scriptSources);
  const parsed = parseStylesheets(src.cssSources);

  // ---- assets (before CSS conversion, so url() values are final)
  for (const r of parsed.rules) r.decls = r.decls.map((d) => (/url\(/.test(d.value) ? { ...d, value: assets.rewriteCssUrls(d.value, r.baseDir) } : d));
  for (const g of parsed.globals) g.node.walkDecls((d) => /url\(/.test(d.value) && (d.value = assets.rewriteCssUrls(d.value, g.baseDir)));
  const elements = [body, ...allElements(body)];
  for (const el of elements) {
    const a = el.attribs || {};
    for (const k of ["src", "href", "srcset", "poster", "action", "data-src"]) if (typeof a[k] === "string") a[k] = a[k].trim(); // browsers ignore surrounding whitespace in URLs
    if (a["data-src"] && (!a.src || /^data:|placeholder|blank|lazy/i.test(a.src))) (a.src = a["data-src"]), delete a["data-src"];
    if (a["data-srcset"]) (a.srcset = a["data-srcset"]), delete a["data-srcset"];
    if (a["data-bg"]) (a.style = `${a.style ? a.style + ";" : ""}background-image:url(${a["data-bg"]})`), delete a["data-bg"];
    for (const k of ["src", "poster"]) if (a[k] && el.name !== "svg") a[k] = assets.rewrite(a[k]);
    if (a.href && (el.name === "link" || /\.(pdf|png|jpe?g|webp|svg|zip|mp4)$/i.test(a.href))) a.href = assets.rewrite(a.href);
    if (a.srcset) a.srcset = assets.rewriteSrcset(a.srcset);
    if (a.style && /url\(/.test(a.style)) a.style = assets.rewriteCssUrls(a.style);
  }

  // ---- class vocabularies
  const domClasses = new Set(elements.flatMap(classesOf));
  const cssClasses = new Set();
  const cssIds = new Set();
  const cssAttrs = new Set();
  const collect = (tokens) => {
    for (const t of tokens) {
      if (t.type === "attribute" && t.name === "class" && t.action === "element") cssClasses.add(t.value);
      else if (t.type === "attribute" && t.name === "id") cssIds.add(t.value);
      else if (t.type === "attribute") cssAttrs.add(t.name);
      if (Array.isArray(t.data)) t.data.forEach(collect);
    }
  };
  parsed.rules.forEach((r) => collect(r.tokens));
  const jsClasses = behavior.jsClasses;
  // classes JS toggles that the page's CSS styles: kept on elements as state
  // hooks; their rules become [&.active]: / group-[.open]: variants
  const stateClasses = new Set([...behavior.toggledClasses].filter((c) => cssClasses.has(c)));

  // ---- styling
  let tw = null;
  let cssOut = null;
  const inlineEntries = new Map();
  if (styling === "tailwind") {
    for (const el of elements) if (el.attribs?.style) inlineEntries.set(el, parseInlineStyle(el.attribs.style));
    tw = await cssToTailwind($, parsed, { domClasses, jsClasses, tw4, inlineEntries, stateClasses, validator: opts.validator || null, uaDefaults: !twSource && opts.preflight !== false });
  } else {
    cssOut = purgeCss($, src.cssSources, { domClasses, jsClasses });
    for (const r of cssOut.roots) r.root.walkDecls((d) => /url\(/.test(d.value) && (d.value = assets.rewriteCssUrls(d.value, src.cssSources.find((s) => s.origin === r.origin)?.baseDir || meta.baseDir)));
  }

  // Recipes for single-class rules (".gradient{...}") so behavior notes can say
  // "JS adds .gradient" => "add these utilities" when rebuilding toggles.
  const recipes = new Map();
  if (tw) {
    for (const r of parsed.rules) {
      if (r.tokens.length === 1 && r.tokens[0].name === "class" && !r.ctx.media.length && (jsClasses.has(r.tokens[0].value) || !domClasses.has(r.tokens[0].value))) {
        recipes.set(r.tokens[0].value, (await classRecipe(tw.emitter, r.decls)).join(" "));
      }
    }
  }

  // ---- validate source Tailwind classes against the target design system
  const twSourceClasses = new Set();
  if (twSource) for (const el of elements) for (const c of classesOf(el)) if (!cssClasses.has(c)) twSourceClasses.add(c);
  // breakpoints the page defined in its inline tailwind.config (tablet:, laptop:)
  // do not exist in the target project: write every breakpoint as min-[..]/max-[..]
  const screens = twSource ? customScreens(meta.tailwindConfig) : null;
  if (screens) notes.customScreens = Object.keys(screens).length;
  const rewriteScreens = (variants) => {
    if (!screens || !variants) return variants;
    return variants
      .slice(0, -1)
      .split(":")
      .map((v) => {
        const neg = v.startsWith("max-") && screens[v.slice(4)];
        const sc = neg ? screens[v.slice(4)] : screens[v];
        if (!sc) return v;
        if (neg) return sc.min != null ? `max-[${sc.min}px]` : v;
        return [sc.min != null ? `min-[${sc.min}px]` : null, sc.max != null ? `max-[${sc.max}px]` : null].filter(Boolean).join(":");
      })
      .join(":") + ":";
  };
  const renameTw = (c) => {
    let { variants, base, lead, trail } = splitClass(c);
    const v2 = rewriteScreens(variants);
    if (!tw4 || !twSource || twSource.version >= 4 || !TW4_RENAMES[base]) return v2 === variants ? c : `${v2}${lead}${base}${trail}`;
    notes.renamed++;
    return TW4_RENAMES[base].split(" ").map((b) => `${v2}${lead}${b}${trail}`).join(" ");
  };
  const renamedOf = new Map([...twSourceClasses].map((c) => [c, renameTw(c)]));
  const valid = opts.validator ? opts.validator([...new Set([...renamedOf.values()].flatMap((c) => c.split(" ")))]) : null;

  // ---- per-element class + attribute cleanup
  const externalCss = meta.externalCss.length > 0;
  for (const el of elements) {
    const a = el.attribs || (el.attribs = {});
    const out = [];
    for (const c of classesOf(el)) {
      if (cssClasses.has(c)) {
        if (styling === "css" || tw?.hookClasses.has(c) || stateClasses.has(c)) out.push(c);
        continue; // converted into utilities
      }
      if (twSource) {
        const { base } = splitClass(c);
        if (TW_NOOP_CLASSES.has(base)) continue;
        const r = renamedOf.get(c).split(" ");
        if (!valid || r.every((x) => valid.has(x))) {
          out.push(...r);
          continue;
        }
        if (jsClasses.has(c)) bump(notes.jsHookClasses, c);
        else if (isIconElement(el) && el.name !== "svg") out.push(c); // icon-font classes (fa-*, bi-*)
        else bump(notes.unknownClasses, c);
        continue;
      }
      if (externalCss) {
        out.push(c); // may be styled by a stylesheet we do not have locally
        continue;
      }
      if (jsClasses.has(c)) bump(notes.jsHookClasses, c);
      else bump(notes.droppedClasses, c);
    }
    if (tw) {
      const marks = tw.marks.get(el);
      if (marks) out.unshift(...marks);
      out.push(...(tw.classesByEl.get(el) || []));
    }
    // Tailwind <=3 -> v4: default border/divide/ring colors changed.
    if (tw4 && twSource && twSource.version < 4) {
      const bases = out.map((c) => splitClass(c).base);
      const has = (re) => bases.some((b) => re.test(b));
      if (has(/^border(-[trblxyse])?(-\d+)?$/) && !has(/^border(-[trblxyse])?-(\[#|\[rgb|\[color|[a-z]+-\d{2,3}|white|black|transparent|current|inherit)/)) {
        out.push("border-gray-200");
        notes.borderFixes++;
      }
      if (has(/^divide-[xy](-\d+)?$/) && !has(/^divide-([a-z]+-\d{2,3}|white|black|transparent|current)/)) out.push("divide-gray-200");
      if (has(/^ring(-\d+)?$/) && !has(/^ring-([a-z]+-\d{2,3}|white|black|transparent|current)/)) out.push("ring-blue-500/50");
    }
    const uniq = [...new Set(out)];
    if (uniq.length) a.class = uniq.join(" ");
    else delete a.class;
    if (styling === "tailwind" && a.style !== undefined) delete a.style;

    for (const k of Object.keys(a)) {
      if (DROP_ATTRS.has(k) || /^data-(aos|wow|sr|scroll|parallax|bs-|toggle|target|dismiss|ride|slide|spy|offset)/.test(k)) {
        bump(notes.droppedAttrs, k.replace(/-[^-]+$/, "-*"));
        delete a[k];
        continue;
      }
      if (k.startsWith("data-") && !cssAttrs.has(k)) {
        bump(notes.droppedAttrs, "data-*");
        delete a[k];
      }
    }
  }

  // ---- ids: keep only those something still points at
  const linked = new Set();
  $("a[href^='#']").each((_, e) => linked.add(e.attribs.href.slice(1)));
  $("label[for]").each((_, e) => linked.add(e.attribs.for));
  $("[aria-controls],[aria-labelledby],[aria-describedby],[aria-owns]").each((_, e) => {
    for (const k of ["aria-controls", "aria-labelledby", "aria-describedby", "aria-owns"]) (e.attribs[k] || "").split(/\s+/).forEach((x) => linked.add(x));
  });
  $("[form],[list]").each((_, e) => (linked.add(e.attribs.form), linked.add(e.attribs.list)));
  const hookIds = new Set();
  if (tw) for (const l of tw.leftovers) for (const m of l.rule.selector.matchAll(/#([\w-]+)/g)) hookIds.add(m[1]);
  const jsIdEls = new Map();
  for (const el of elements) {
    const id = el.attribs?.id;
    if (!id) continue;
    const keep = linked.has(id) || hookIds.has(id) || (styling === "css" && cssIds.has(id)) || el.name === "svg" || el.parent?.name === "svg";
    if (!keep) {
      if (behavior.jsIds.has(id)) jsIdEls.set(el, id);
      delete el.attribs.id;
      notes.droppedIds++;
    }
  }

  // ---- structure cleanup: empty attribute-less divs/spans, pass-through wrappers
  const handlers = src.handlers;
  const keepEl = (el) => handlers.has(el) || behavior.touched.has(el) || jsIdEls.has(el);
  const removeEmpty = (el) => {
    for (const c of elementChildren(el)) removeEmpty(c);
    if ((el.name === "div" || el.name === "span") && !Object.keys(el.attribs).length && !keepEl(el) && !(el.children || []).some((c) => isTag(c) || (isText(c) && c.data.trim()))) {
      $(el).remove();
      notes.emptied++;
    }
  };
  elementChildren(body).forEach(removeEmpty);
  const flatten = (el) => {
    for (const c of elementChildren(el)) flatten(c);
    if (el === body || !["div", "span"].includes(el.name) || Object.keys(el.attribs).length || keepEl(el)) return;
    const kids = elementChildren(el);
    if (kids.length !== 1 || (el.children || []).some((c) => isText(c) && c.data.trim())) return;
    const child = kids[0];
    const sameFlow = el.name === "div" ? BLOCKISH.has(child.name) : INLINE_ELEMENTS.has(child.name) && child.name !== "img";
    if (!sameFlow) return;
    $(el).replaceWith(child);
    notes.flattened++;
  };
  elementChildren(body).forEach(flatten);

  // ---- ids for the outline / plan
  const ids = new Map(); // el -> "n12"
  const byId = new Map();
  let n = 0;
  const icons = new Map(); // svg key -> {id, els[], size, title, currentColor}
  const svgOf = new Map(); // svg el -> icon id
  let iconSeq = 0;
  const number = (el) => {
    for (const c of elementChildren(el)) {
      if (c.name === "svg") {
        const inner = $.html(c.children || []).replace(/>\s+</g, "><").replace(/\s+/g, " ");
        const rootAttrs = Object.entries(c.attribs).filter(([k]) => !["class", "width", "height", "style", "id", "aria-hidden", "focusable", "role", "aria-label"].includes(k)).sort();
        const key = sha(JSON.stringify(rootAttrs) + inner);
        if (!icons.has(key)) {
          iconSeq++;
          const title = $(c).find("title").first().text().trim() || c.attribs["aria-label"] || null;
          icons.set(key, { id: `i${iconSeq}`, key, els: [], size: inner.length, title, currentColor: /currentColor/i.test(inner + JSON.stringify(c.attribs)) || /(fill|stroke)-current|text-/.test(c.attribs.class || "") });
        }
        icons.get(key).els.push(c);
        svgOf.set(c, icons.get(key).id);
        continue;
      }
      const id = `n${++n}`;
      ids.set(c, id);
      byId.set(id, c);
      number(c);
    }
  };
  ids.set(body, "n0");
  byId.set("n0", body);
  number(body);

  setHintClasses((el) => (origClasses.get(el) || "").split(/\s+/).filter((c) => c && cssClasses.has(c)), (c) => stateClasses.has(c) || (styling === "css" && cssClasses.has(c)));
  const groups = detectGroups(body);
  const duplicates = findDuplicates(body, groups, ids);

  // ---- behavior notes keyed by element
  const elNotes = new Map();
  const addNote = (el, t) => {
    if (!el) return;
    if (!elNotes.has(el)) elNotes.set(el, []);
    if (!elNotes.get(el).includes(t)) elNotes.get(el).push(t);
  };
  for (const [el, hs] of handlers) hs.forEach((h) => addNote(el, `on${h.event}: ${h.code}`));
  for (const [el, set] of behavior.touched) set.forEach((t) => addNote(el, t));
  for (const [el, id] of jsIdEls) addNote(el, `js id #${id}`);

  const iconFonts = new Map(); // identifier -> count
  for (const el of elements) {
    if (!el.parent) continue;
    const ident = iconIdentifier(el);
    if (ident) iconFonts.set(ident, (iconFonts.get(ident) || 0) + 1);
  }
  const customElements = new Set(elements.filter((e) => e.parent && e.name.includes("-") && e.name !== "ion-icon").map((e) => e.name));

  return {
    $, body, meta, styling, tw4, twSource, parsed, behavior, notes, tw, cssOut, recipes,
    ids, byId, groups, duplicates, icons, svgOf, elNotes, iconFonts, customElements, assets, origClasses, cssClasses,
    scriptSources: src.scriptSources, stateClasses,
    globalsCss: styling === "tailwind" ? buildGlobalCss(parsed, tw, tw4) : null,
    stats: { elements: ids.size, rules: parsed.rules.length },
  };
}

/** "ion:mail-outline", "fa:envelope", "bi:github", "material:home" */
export function iconIdentifier(el) {
  if (!isTag(el)) return null;
  if (el.name === "ion-icon") return el.attribs.name ? `ion:${el.attribs.name}` : null;
  const cls = el.attribs?.class || "";
  let m = cls.match(/(?:^|\s)fa-(?!solid|regular|brands|light|duotone|thin|fw|lg|xs|sm|\dx|spin|pulse|border|pull|stack|inverse|flip|rotate)([a-z0-9-]+)/);
  if (m && /(^|\s)(fa[srlbd]?|fa-solid|fa-regular|fa-brands)(\s|$)/.test(cls)) return `fa:${m[1]}`;
  m = cls.match(/(?:^|\s)bi-([a-z0-9-]+)/);
  if (m) return `bi:${m[1]}`;
  if (/(^|\s)material-(icons|symbols)/.test(cls)) return `material:${(el.children || []).map((c) => c.data || "").join("").trim()}`;
  return null;
}

function ruleCss(selector, decls, ctx) {
  let css = `${selector} { ${decls.map((d) => `${d.prop}: ${d.value}${d.important ? " !important" : ""};`).join(" ")} }`;
  for (const s of [...(ctx.supports || [])].reverse()) css = `@supports ${s} { ${css} }`;
  for (const m of [...(ctx.media || [])].reverse()) css = `@media ${m} { ${css} }`;
  return css;
}

/** Global CSS that has to stay CSS in tailwind mode (resets, @font-face, keyframes, leftovers). */
function buildGlobalCss(parsed, tw, tw4) {
  const parts = [];
  if (parsed.imports.length) parts.push(...parsed.imports.map((i) => `@import ${i};`));
  const base = tw.globals.map((r) => ruleCss(r.selector, r.decls, r.ctx));
  const atRules = parsed.globals.map((g) => g.node.toString());
  const leftovers = tw.leftovers.map((l) => `/* kept as CSS: ${l.reason} */\n${ruleCss(l.rule.selector, l.rule.decls, l.rule.ctx)}`);
  if (base.length) parts.push(tw4 ? `@layer base {\n${base.map((b) => "  " + b).join("\n")}\n}` : base.join("\n"));
  if (atRules.length) parts.push(...atRules);
  if (leftovers.length) parts.push(...leftovers);
  return parts.join("\n\n").trim();
}

/**
 * "css" styling: the purged stylesheet, scoped to the page root so it cannot
 * leak into the rest of the app (`body` -> the root, everything else is
 * prefixed with `:where(.scope)`, which adds no specificity). When the host
 * project runs Tailwind, Preflight's resets are undone inside the scope first.
 */
/**
 * The page was written against browser defaults, but the host app loads
 * Tailwind's Preflight. With Tailwind v4 (native cascade layers) a rule in
 * @layer base can undo Preflight exactly: `all: revert-layer` falls back to
 * the browser's own styles, while utilities (a higher layer) and unlayered
 * page CSS still win. It needs class specificity (.scope *), because
 * Preflight's own selectors (h1, a, pre) beat a zero-specificity :where().
 *  - "all": css styling - the page keeps its original CSS, so revert everything.
 *  - "forms": tailwind styling - converted utilities assume Preflight's
 *    `border: 0 solid` etc., so only form controls (whose browser look a
 *    table cannot reproduce) are reverted; UA_DEFAULTS covers the rest.
 */
export function preflightUndo(scope, { mode = "all", minHeight = false } = {}) {
  const s = `.${scope}`;
  if (mode === "forms") {
    return `/* form controls: browser look, as in the original page (Tailwind Preflight removes it) */\n@layer base {\n  ${s} :is(input, button, select, textarea, fieldset, legend, optgroup, option, progress, meter), ${s} ::file-selector-button { all: revert-layer; }\n}`;
  }
  const page = `${s} { display: flow-root; margin: 8px; line-height: normal; font-family: initial;${minHeight ? " min-height: 100vh;" : ""} }`;
  return `/* undo Tailwind Preflight inside this page: it was written against browser defaults */\n@layer base {\n  ${s}, ${s} *, ${s} ::before, ${s} ::after { all: revert-layer; }\n  ${page}\n}`;
}

export function cssModeText(model, scope, { preflight = false } = {}) {
  if (!model.cssOut) return "";
  const root = `:where(.${scope})`;
  const parts = [];
  if (model.parsed.imports.length) parts.push(...model.parsed.imports.map((i) => `@import ${i};`));
  let bodyBackground = false;
  for (const r of model.cssOut.roots) {
    r.root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
      rule.selectors = rule.selectors.flatMap((sel) => {
        sel = sel.trim();
        if (/^(html|:root)(?![\w-])/.test(sel)) return [sel];
        if (/^body(?![\w-])/.test(sel)) {
          if (/^body\s*$/.test(sel)) rule.walkDecls(/^background/, () => (bodyBackground = true));
          return [sel.replace(/^body/, root)];
        }
        if (/^\*(?![\w-])/.test(sel)) return [`${root}${sel.slice(1)}`, `${root} ${sel}`];
        return [`${root} ${sel}`];
      });
    });
  }
  if (preflight) parts.push(preflightUndo(scope, { mode: "all", minHeight: bodyBackground }));
  for (const r of model.cssOut.roots) {
    const t = r.root.toString().trim();
    if (t) parts.push(`/* from ${path.basename(r.origin)} */\n${t}`);
  }
  return parts.join("\n\n");
}

export { isGlobalSelector };

/**
 * Breakpoints from an inline `tailwind.config = {...}` script (Play CDN pages).
 * Returns {name: {min?, max?}} in px including the defaults it keeps, or null
 * when the config defines no screens.
 */
export function customScreens(cfg) {
  if (!cfg) return null;
  const at = cfg.search(/\bscreens\s*:\s*\{/);
  if (at < 0) return null;
  let i = cfg.indexOf("{", at), depth = 0, end = i;
  for (; end < cfg.length; end++) {
    if (cfg[end] === "{") depth++;
    else if (cfg[end] === "}" && --depth === 0) break;
  }
  const body = cfg.slice(i + 1, end);
  const inExtend = (() => {
    const e = cfg.search(/\bextend\s*:\s*\{/);
    if (e < 0 || e > at) return false;
    let d = 0;
    for (let k = cfg.indexOf("{", e); k < cfg.length; k++) {
      if (cfg[k] === "{") d++;
      else if (cfg[k] === "}" && --d === 0) return k > at;
    }
    return false;
  })();
  const px = (v) => {
    const m = String(v).match(/([\d.]+)\s*(px|rem|em)/);
    return m ? (m[2] === "px" ? +m[1] : +m[1] * 16) : null;
  };
  const out = inExtend ? { sm: { min: 640 }, md: { min: 768 }, lg: { min: 1024 }, xl: { min: 1280 }, "2xl": { min: 1536 } } : {};
  let found = false;
  for (const m of body.matchAll(/(['"]?)([\w-]+)\1\s*:\s*(['"])([^'"]+)\3/g)) {
    if (m[2] === "min" || m[2] === "max" || m[2] === "raw") continue;
    if (px(m[4]) != null) (out[m[2]] = { min: px(m[4]) }), (found = true);
  }
  for (const m of body.matchAll(/(['"]?)([\w-]+)\1\s*:\s*\{([^}]*)\}/g)) {
    const min = m[3].match(/min\s*:\s*['"]([^'"]+)['"]/), max = m[3].match(/max\s*:\s*['"]([^'"]+)['"]/);
    if (min || max) (out[m[2]] = { min: min ? px(min[1]) : null, max: max ? px(max[1]) : null }), (found = true);
  }
  return found ? out : null;
}
