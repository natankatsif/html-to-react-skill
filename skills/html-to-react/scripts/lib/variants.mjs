// Several exports of the same page (e.g. a 390px mobile frame and a 1278px
// desktop frame) merged into ONE responsive tree instead of two component sets.
//
//  - elements are matched across variants by layer name, text, svg content
//  - a matched pair becomes one element: base (mobile-first) classes plus
//    `lg:` overrides for what differs, `lg:[prop:revert-layer]` for what only
//    the small variant sets
//  - a wrapper that exists in only one variant stays, but turns into
//    `display: contents` in the other one, so its children line up with the
//    other variant's siblings
//  - only content that really differs is kept twice, with `lg:hidden` /
//    `max-lg:hidden`
import crypto from "node:crypto";
import { isTag, isText, elementChildren } from "./source.mjs";
import { splitClass } from "./pipeline.mjs";

const MATCH = 0.55; // minimum score to treat two elements as the same thing
const UNWRAP_GAIN = 0.5; // an unwrap must improve the alignment by this much

export const LAYER_ATTRS = ["data-pencil-name", "data-framer-name", "data-name", "data-layer", "data-layer-name", "data-figma-name", "data-node-name"];

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const words = (s) => new Set(norm(s).split(/[^\p{L}\p{N}$]+/u).filter((w) => w.length > 1));
function textOf(n) {
  if (isText(n)) return n.data;
  if (n.name === "svg") return "";
  return (n.children || []).map(textOf).join(" ");
}
const ownText = (el) => norm((el.children || []).filter(isText).map((c) => c.data).join(" "));
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

export function makeMatcher(ctxA, ctxB) {
  const cache = new Map();
  const info = (el, ctx) => {
    if (cache.has(el)) return cache.get(el);
    const name = ctx.layerNames.get(el) || null;
    const v = {
      name: name && norm(name.replace(/\(.*?\)/g, "")),
      nameWords: name ? words(name.replace(/\(.*?\)/g, "")) : new Set(),
      text: norm(textOf(el)),
      textWords: words(textOf(el)),
      svg: el.name === "svg" ? crypto.createHash("sha1").update(ctx.$.html(el.children || []).replace(/\s+/g, "")).digest("hex") : null,
      size: elementChildren(el).length,
    };
    cache.set(el, v);
    return v;
  };
  return (a, b) => {
    if (!isTag(a) || !isTag(b) || a.name !== b.name) return 0;
    const A = info(a, ctxA), B = info(b, ctxB);
    if (A.svg || B.svg) return A.svg === B.svg ? 1 : 0;
    let s = 0;
    if (A.name && B.name) s = A.name === B.name ? 1 : 0.8 * jaccard(A.nameWords, B.nameWords);
    if (A.text && B.text) s = Math.max(s, A.text === B.text ? 0.95 : 0.85 * jaccard(A.textWords, B.textWords));
    else if (!A.text && !B.text && !A.name && !B.name) s = Math.max(s, 0.4); // two anonymous empty boxes
    return s;
  };
}

/** Weighted LCS: order-preserving pairing that maximizes the summed score. */
function align(as, bs, score) {
  const n = as.length, m = bs.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const sc = as.map((a) => bs.map((b) => score(a.node, b.node)));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const s = sc[i][j];
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], s >= MATCH ? s + dp[i + 1][j + 1] : -1);
    }
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && sc[i][j] >= MATCH && dp[i][j] === sc[i][j] + dp[i + 1][j + 1]) out.push({ a: as[i++], b: bs[j++], s: sc[i - 1][j - 1] });
    else if (j >= m || (i < n && dp[i][j] === dp[i + 1][j])) out.push({ a: as[i++], b: null });
    else out.push({ a: null, b: bs[j++] });
  }
  return { pairs: out, total: dp[0][0] };
}

const items = (el, chain = []) => elementChildren(el).map((node) => ({ node, chain }));

/** Align two child lists, unwrapping one-sided wrappers while that improves the match. */
function alignLevel(aEl, bEl, score) {
  let as = items(aEl), bs = items(bEl);
  let best = align(as, bs, score);
  for (let round = 0; round < 12; round++) {
    let improved = null;
    const tryUnwrap = (side) => {
      const list = side === "a" ? as : bs;
      list.forEach((it, idx) => {
        if (!elementChildren(it.node).length || it.node.name === "svg") return;
        const exp = [...list.slice(0, idx), ...items(it.node, [...it.chain, it.node]), ...list.slice(idx + 1)];
        const res = side === "a" ? align(exp, bs, score) : align(as, exp, score);
        if (res.total > best.total + UNWRAP_GAIN && (!improved || res.total > improved.res.total) && nests(res.pairs)) improved = { side, exp, res };
      });
    };
    tryUnwrap("a");
    tryUnwrap("b");
    if (!improved) break;
    if (improved.side === "a") as = improved.exp;
    else bs = improved.exp;
    best = improved.res;
  }
  return best.pairs;
}

// wrappers from both sides must form a proper tree over the merged sequence
function nests(pairs) {
  const spans = new Map();
  pairs.forEach((p, i) => {
    for (const it of [p.a, p.b]) if (it) for (const w of it.chain) {
      const s = spans.get(w) || [i, i];
      spans.set(w, [Math.min(s[0], i), Math.max(s[1], i)]);
    }
  });
  const list = [...spans.values()];
  for (const [s1, e1] of list) for (const [s2, e2] of list) if (s1 < s2 && s2 <= e1 && e1 < e2) return false;
  return true;
}

// ---------------------------------------------------------------- classes

const tokens = (el) => (el.attribs?.class || "").split(/\s+/).filter(Boolean);

/**
 * Mobile-first merge of two class lists. `propsOf(token)` returns the CSS
 * properties a utility sets (from the project's Tailwind when available).
 */
export function mergeClasses(aTok, bTok, bp, propsOf) {
  const A = new Set(aTok), B = new Set(bTok);
  const out = aTok.filter((t) => true);
  const bOnly = bTok.filter((t) => !A.has(t));
  const covered = new Set(bOnly.flatMap((t) => [...propsOf(t)].map((p) => `${splitClass(t).variants}${p}`)));
  for (const t of bOnly) out.push(`${bp}:${t}`);
  for (const t of aTok) {
    if (B.has(t)) continue;
    const { variants } = splitClass(t);
    if (/^(max-|min-\[|sm:|md:|lg:|xl:|2xl:)/.test(variants)) continue; // already breakpoint-scoped
    for (const p of propsOf(t)) if (!covered.has(`${variants}${p}`)) out.push(`${bp}:${variants}[${p}:revert-layer]`), covered.add(`${variants}${p}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- tree merge

function setChildren(parent, kids) {
  parent.children = kids;
  kids.forEach((k, i) => {
    k.parent = parent;
    k.prev = kids[i - 1] || null;
    k.next = kids[i + 1] || null;
  });
}

function sameAttrs(a, b) {
  const keys = new Set([...Object.keys(a.attribs || {}), ...Object.keys(b.attribs || {})]);
  keys.delete("class");
  keys.delete("style");
  for (const k of keys) if ((a.attribs[k] ?? null) !== (b.attribs[k] ?? null)) return false;
  return true;
}

/**
 * Merge variant B (larger screen, shown from `bp` up) into A in place.
 * Returns stats + a map of elements that exist in one variant only.
 */
export function mergeVariant(ctxA, ctxB, { bp, propsOf }) {
  const score = makeMatcher(ctxA, ctxB);
  const only = new Map(); // el -> "base" | "bp" | "wrap-base" | "wrap-bp"
  const stats = { merged: 0, baseOnly: 0, bpOnly: 0, wrappers: 0 };
  const addCls = (el, extra) => (el.attribs.class = [...new Set([...tokens(el), ...extra])].join(" "));

  const mergeEl = (a, b) => {
    a.attribs.class = mergeClasses(tokens(a), tokens(b), bp, propsOf).join(" ");
    if (!a.attribs.class) delete a.attribs.class;
    stats.merged++;
    mergeChildren(a, b);
  };

  const canMerge = (a, b) => a.name === b.name && sameAttrs(a, b) && ownText(a) === ownText(b) && (a.name !== "svg" || score(a, b) === 1);

  function mergeChildren(a, b) {
    // mixed content (text + inline elements): keep A's markup, merge inline
    // elements pairwise when both sides have the same shape
    if ((a.children || []).some((c) => isText(c) && c.data.trim())) {
      const ea = elementChildren(a), eb = elementChildren(b);
      if (ea.length === eb.length && ea.every((x, i) => canMerge(x, eb[i]))) ea.forEach((x, i) => mergeEl(x, eb[i]));
      return;
    }
    const pairs = alignLevel(a, b, score);
    const out = [];
    const wrapOf = new Map(); // wrapper element -> its clone in output (A wrappers are reused, B wrappers moved)
    for (const p of pairs) {
      let node;
      if (p.a && p.b && canMerge(p.a.node, p.b.node)) {
        mergeEl(p.a.node, p.b.node);
        node = p.a.node;
      } else {
        const nodes = [];
        if (p.a) {
          addCls(p.a.node, [`${bp}:hidden`]);
          only.set(p.a.node, "base");
          stats.baseOnly++;
          nodes.push({ n: p.a.node, chain: p.a.chain });
        }
        if (p.b) {
          addCls(p.b.node, [`max-${bp}:hidden`]);
          only.set(p.b.node, "bp");
          stats.bpOnly++;
          nodes.push({ n: p.b.node, chain: p.b.chain });
        }
        for (const x of nodes) out.push({ node: x.n, chain: x.chain });
        continue;
      }
      out.push({ node, chain: [...p.a.chain, ...p.b.chain] });
    }
    // every wrapper covers the interval between its first and last item; the
    // intervals nest (checked in alignLevel), so an item belongs to every
    // wrapper whose interval contains it, ordered outer -> inner
    const range = new Map(), seen = [];
    out.forEach((o, i) => o.chain.forEach((w) => {
      const r = range.get(w);
      if (!r) range.set(w, [i, i]), seen.push(w);
      else r[1] = i;
    }));
    const rank = new Map(seen.map((w, i) => [w, i]));
    out.forEach((o, i) => {
      o.chain = seen
        .filter((w) => range.get(w)[0] <= i && i <= range.get(w)[1])
        .sort((x, y) => {
          const [xs, xe] = range.get(x), [ys, ye] = range.get(y);
          return ye - ys - (xe - xs) || rank.get(x) - rank.get(y);
        });
    });
    const build = (list, depth) => {
      const res = [];
      let i = 0;
      while (i < list.length) {
        const w = list[i].chain[depth];
        if (!w) {
          res.push(list[i].node);
          i++;
          continue;
        }
        let j = i;
        while (j < list.length && list[j].chain[depth] === w) j++;
        const isA = ctxA.owns(w);
        if (!wrapOf.has(w)) {
          // a one-sided wrapper keeps its box only in its own variant
          const own = tokens(w).map((t) => (isA ? `max-${bp}:${t}` : `${bp}:${t}`));
          w.attribs.class = [...own, isA ? `${bp}:contents` : `max-${bp}:contents`].join(" ");
          only.set(w, isA ? "wrap-base" : "wrap-bp");
          stats.wrappers++;
          wrapOf.set(w, w);
        }
        setChildren(w, build(list.slice(i, j), depth + 1));
        res.push(w);
        i = j;
      }
      return res;
    };
    setChildren(a, build(out, 0));
  }

  const merged = mergeClasses(tokens(ctxA.body), tokens(ctxB.body), bp, propsOf).join(" ");
  if (merged) ctxA.body.attribs.class = merged;
  mergeChildren(ctxA.body, ctxB.body);
  return { only, stats };
}

/** Pick the Tailwind breakpoint at which the larger design takes over. */
export function breakpointFor(smallWidth, largeWidth) {
  const bps = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];
  const fits = bps.filter(([, v]) => v > smallWidth && v <= largeWidth);
  return (fits[fits.length - 1] || bps.find(([, v]) => v > smallWidth) || ["md"])[0];
}

/** Artboard width of an export: the root frame's fixed width. */
export function artboardWidth($) {
  const root = elementChildren($("body")[0] || { children: [] })[0];
  if (!root) return null;
  const cls = root.attribs?.class || "";
  const m = cls.match(/(?:^|\s)w-\[(\d+(?:\.\d+)?)px\]/) || (root.attribs?.style || "").match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : null;
}

/**
 * Turn fixed artboard widths into fluid ones: a width equal to the artboard
 * becomes w-full (root: + max-w + mx-auto), wide fixed widths get max-w-full.
 */
export function fluidize(body, widths) {
  // widths: [{prefix: "" | "lg", w: 390}]
  const root = elementChildren(body)[0];
  // classes of the base layout may also sit behind max-<bp>: (one-sided wrappers)
  const scopes = ({ prefix }) => (prefix ? [`${prefix}:`] : ["", ...widths.filter((x) => x.prefix).map((x) => `max-${x.prefix}:`)]);
  const walk = (el, isRoot) => {
    if (el.name === "svg") return;
    let t = tokens(el);
    for (const v of widths) {
      const { prefix, w } = v;
      for (const sc of scopes(v)) {
        const fixed = `${sc}w-[${w}px]`;
        if (!t.includes(fixed)) continue;
        t = t.map((x) => (x === fixed ? `${sc}w-full` : x));
        if (isRoot) t.push(`${sc}max-w-[${w}px]`, `${sc}mx-auto`);
      }
      const abs = (sc) => t.includes(`${sc}absolute`) || t.includes("absolute");
      for (const x of t) {
        const m = splitClass(x);
        const px = m.base.match(/^w-\[(\d+(?:\.\d+)?)px\]$/);
        if (px && scopes(v).includes(m.variants) && Number(px[1]) > w * 0.5 && !abs(m.variants)) t.push(`${m.variants}max-w-full`);
      }
    }
    if (t.length) el.attribs.class = [...new Set(t)].join(" ");
    elementChildren(el).forEach((c) => walk(c, false));
  };
  if (root) walk(root, true);
}

/** Fallback property map when the project's Tailwind is not available. */
export function roughProps(token) {
  const { base } = splitClass(token);
  const arb = base.match(/^\[([a-z-]+):/);
  if (arb) return new Set([arb[1]]);
  const table = [
    [/^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|hidden|contents|table)$/, ["display"]],
    [/^(static|fixed|absolute|relative|sticky)$/, ["position"]],
    [/^(top|left|right|bottom|inset(-[xy])?)-/, null],
    [/^w-/, ["width"]], [/^h-/, ["height"]], [/^min-w-/, ["min-width"]], [/^max-w-/, ["max-width"]], [/^min-h-/, ["min-height"]], [/^max-h-/, ["max-height"]],
    [/^p-/, ["padding"]], [/^px-/, ["padding-left", "padding-right"]], [/^py-/, ["padding-top", "padding-bottom"]], [/^pt-/, ["padding-top"]], [/^pb-/, ["padding-bottom"]], [/^pl-/, ["padding-left"]], [/^pr-/, ["padding-right"]],
    [/^m-/, ["margin"]], [/^mx-/, ["margin-left", "margin-right"]], [/^my-/, ["margin-top", "margin-bottom"]], [/^mt-/, ["margin-top"]], [/^mb-/, ["margin-bottom"]], [/^ml-/, ["margin-left"]], [/^mr-/, ["margin-right"]],
    [/^gap-x-/, ["column-gap"]], [/^gap-y-/, ["row-gap"]], [/^gap-/, ["gap"]],
    [/^flex-(row|col)(-reverse)?$/, ["flex-direction"]], [/^flex-(wrap|nowrap)/, ["flex-wrap"]], [/^(items)-/, ["align-items"]], [/^justify-/, ["justify-content"]], [/^self-/, ["align-self"]],
    [/^(shrink|grow)/, null], [/^grid-cols-/, ["grid-template-columns"]], [/^col-span-/, ["grid-column"]],
    [/^text-(left|center|right|justify)$/, ["text-align"]], [/^text-\[(\d|[.\d]+(px|rem|em))/, ["font-size", "line-height"]], [/^text-(xs|sm|base|lg|[2-9]?xl)/, ["font-size", "line-height"]], [/^text-/, ["color"]],
    [/^font-(thin|light|normal|medium|semibold|bold|extrabold|black|\[\d)/, ["font-weight"]], [/^font-/, ["font-family"]], [/^leading-/, ["line-height"]], [/^tracking-/, ["letter-spacing"]],
    [/^bg-/, ["background-color", "background-image"]], [/^rounded/, ["border-radius"]], [/^border/, ["border"]], [/^shadow/, ["box-shadow"]], [/^opacity-/, ["opacity"]], [/^z-/, ["z-index"]], [/^overflow-/, ["overflow"]],
  ];
  for (const [re, props] of table) {
    if (!re.test(base)) continue;
    if (props) return new Set(props);
    const k = base.replace(/-.*$/, "");
    return new Set([{ shrink: "flex-shrink", grow: "flex-grow", inset: "inset" }[k] || k]);
  }
  return new Set();
}
