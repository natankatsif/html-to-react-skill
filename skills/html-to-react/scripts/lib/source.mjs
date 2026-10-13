// Loads an HTML page and everything it pulls in locally (CSS, JS), then strips
// the parts that must never reach React: head boilerplate, scripts, comments,
// inline handlers, analytics attributes. Deterministic: the same input always
// yields the same cleaned DOM, which is what lets node ids stay stable between
// `analyze` and `generate`.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import postcss from "postcss";
import nested from "postcss-nested";

export const isTag = (n) => n && (n.type === "tag" || n.type === "script" || n.type === "style");
export const isText = (n) => n && n.type === "text";
export const elementChildren = (n) => (n.children || []).filter(isTag);
export const isSvg = (n) => isTag(n) && n.name === "svg";

export function sha(s, len = 10) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, len);
}

function isRemote(url) {
  return /^(https?:)?\/\//i.test(url) || /^data:/i.test(url);
}

function readLocal(baseDir, ref) {
  if (!ref || isRemote(ref)) return null;
  const clean = ref.split("#")[0].split("?")[0];
  const p = path.resolve(baseDir, decodeURIComponent(clean));
  try {
    return { path: p, text: fs.readFileSync(p, "utf8") };
  } catch {
    return null;
  }
}

function detectTailwindSource($, scripts, links) {
  const cdn = [...scripts.external, ...links.map((l) => l.href)].find((u) => /tailwind/i.test(u));
  if (cdn) {
    const v = cdn.match(/tailwindcss@?(\d)/i) || cdn.match(/@tailwindcss\/browser@(\d)/i);
    if (/@tailwindcss\/browser/i.test(cdn)) return { version: 4, via: cdn };
    if (v) return { version: Number(v[1]), via: cdn };
    if (/cdn\.tailwindcss\.com/i.test(cdn)) return { version: 3, via: cdn };
    return { version: 3, via: cdn };
  }
  // No CDN: guess from class vocabulary (pages exported from a Tailwind build).
  const classes = ($("[class]").map((_, el) => el.attribs.class).get().join(" ").match(/\S+/g)) || [];
  if (!classes.length) return null;
  const twLike = classes.filter((c) => /^(-?[a-z0-9]+:)*-?(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|min-h|text|bg|flex|grid|gap|items|justify|rounded|border|shadow|font|leading|tracking|space-[xy]|col-span|inset|top|left|right|bottom|z|opacity|hidden|block|inline|absolute|relative|fixed|sticky)(-|$)/.test(c));
  return twLike.length / classes.length > 0.5 ? { version: 3, via: "class vocabulary" } : null;
}

const MEDIA_ALL = /^\s*(only\s+)?(all|screen)?\s*$/i;

/**
 * Normalize one stylesheet so the rest of the pipeline sees plain, flat CSS
 * and keeps every responsive rule:
 *  - CSS nesting (`.card { @media (...) { ... } & h3 {...} }`) is flattened
 *  - local `@import "x.css" (max-width: 700px)` is inlined, wrapped in its media
 *  - a `media="..."` attribute on <link>/<style> wraps the whole sheet
 * Remote @imports (web fonts) stay as they are.
 */
export function prepareCss(text, { baseDir, media = null, from = null, seen = new Set() }) {
  if (media && /^\s*print\s*$/i.test(media)) return ""; // print-only sheet
  let root;
  try {
    root = postcss([nested]).process(text, { from: from || undefined }).root;
  } catch {
    try {
      root = postcss.parse(text);
    } catch {
      return text;
    }
  }
  root.walkAtRules("import", (at) => {
    const m = at.params.match(/^\s*(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?\s*(.*)$/);
    if (!m || isRemote(m[2])) return;
    const f = readLocal(baseDir, m[2]);
    if (!f || seen.has(f.path)) {
      at.remove();
      return;
    }
    seen.add(f.path);
    const innerDir = path.dirname(f.path);
    const inner = postcss.parse(prepareCss(f.text, { baseDir: innerDir, from: f.path, seen }));
    // url()s in the imported file are relative to that file: re-anchor them
    if (innerDir !== baseDir) {
      inner.walkDecls((d) => {
        if (!/url\(/.test(d.value)) return;
        d.value = d.value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, u) => (isRemote(u) || u.startsWith("/") || u.startsWith("#") ? all : `url(${q}${path.relative(baseDir, path.resolve(innerDir, u)).split(path.sep).join("/")}${q})`));
      });
    }
    const mq = m[3].replace(/^layer(\([^)]*\))?\s*/, "").replace(/^supports\([^)]*\)\s*/, "").trim();
    let nodes = inner.nodes.slice();
    if (mq && !MEDIA_ALL.test(mq)) {
      const wrap = postcss.atRule({ name: "media", params: mq });
      wrap.append(nodes);
      nodes = [wrap];
    }
    at.replaceWith(nodes);
  });
  if (media && !MEDIA_ALL.test(media)) {
    const imports = root.nodes.filter((n) => n.type === "atrule" && n.name === "import");
    const rest = root.nodes.filter((n) => !imports.includes(n));
    const wrap = postcss.atRule({ name: "media", params: media.trim() });
    wrap.append(rest);
    root.removeAll();
    root.append(imports);
    root.append(wrap);
  }
  return root.toString();
}

/**
 * @returns {{ $, doc, meta, cssSources, scriptSources, handlers }}
 */
export function loadSource(htmlPath, { extraCss = [] } = {}) {
  const abs = path.resolve(htmlPath);
  const baseDir = path.dirname(abs);
  const html = fs.readFileSync(abs, "utf8");
  const $ = cheerio.load(html, { scriptingEnabled: false, sourceCodeLocationInfo: false });

  const meta = {
    source: abs,
    baseDir,
    sourceHash: sha(html + extraCss.join("|")),
    rawChars: html.length,
    title: $("title").first().text().trim() || null,
    description: $('meta[name="description"]').attr("content") || null,
    lang: $("html").attr("lang") || null,
    fonts: [],
    externalCss: [],
    externalJs: [],
    tailwind: null,
    tailwindConfig: null,
    bodyAttrs: { ...($("body")[0]?.attribs || {}) },
    htmlAttrs: { ...($("html")[0]?.attribs || {}) },
  };

  // ---- stylesheets (in document order, so cascade order is preserved)
  const cssSources = [];
  const links = [];
  $('link[rel~="stylesheet"], style').each((_, el) => {
    if (el.name === "style") {
      cssSources.push({ origin: "inline <style>", text: prepareCss($(el).text(), { baseDir, media: el.attribs.media }), baseDir });
      return;
    }
    const href = el.attribs.href || "";
    links.push({ href });
    if (/fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|fonts\.cdnfonts\.com|api\.fontshare\.com/i.test(href)) meta.fonts.push(href);
    else if (/tailwind/i.test(href)) return; // the framework itself, handled via meta.tailwind
    else if (isRemote(href)) meta.externalCss.push(href);
    else {
      const f = readLocal(baseDir, href);
      if (f) cssSources.push({ origin: path.relative(process.cwd(), f.path), text: prepareCss(f.text, { baseDir: path.dirname(f.path), media: el.attribs.media, from: f.path }), path: f.path, baseDir: path.dirname(f.path) });
      else meta.externalCss.push(`${href} (not found locally)`);
    }
  });
  for (const extra of extraCss) {
    const p = path.resolve(extra);
    cssSources.push({ origin: path.relative(process.cwd(), p), text: prepareCss(fs.readFileSync(p, "utf8"), { baseDir: path.dirname(p), from: p }), path: p, baseDir: path.dirname(p) });
  }

  // ---- scripts
  const scriptSources = [];
  const scripts = { external: [] };
  $("script").each((_, el) => {
    const src = el.attribs.src;
    const type = (el.attribs.type || "").toLowerCase();
    if (type && !/javascript|module|babel|jsx/.test(type)) {
      if (type.includes("json") || type.includes("template")) return;
    }
    if (src) {
      scripts.external.push(src);
      const f = readLocal(baseDir, src);
      if (f) scriptSources.push({ origin: path.relative(process.cwd(), f.path), text: f.text });
      else meta.externalJs.push(src);
      return;
    }
    const text = $(el).text();
    if (/tailwind(\.config)?\s*=\s*\{/.test(text)) {
      meta.tailwindConfig = text.trim();
      // exports designed with Preflight off rely on browser defaults
      if (/preflight\s*:\s*false/.test(text)) meta.preflightOff = true;
      return;
    }
    if (text.trim()) scriptSources.push({ origin: "inline <script>", text });
  });
  meta.tailwind = detectTailwindSource($, scripts, links);

  // ---- inline event handlers: remember them (for behavior notes), then drop
  const handlers = new Map(); // element -> [{event, code}]
  $("*").each((_, el) => {
    for (const [k, v] of Object.entries(el.attribs || {})) {
      if (/^on[a-z]+$/.test(k)) {
        if (!handlers.has(el)) handlers.set(el, []);
        handlers.get(el).push({ event: k.slice(2), code: v.trim().slice(0, 160) });
        delete el.attribs[k];
      }
    }
    // javascript: links carry behavior, not navigation
    if (el.attribs?.href && /^\s*javascript:/i.test(el.attribs.href)) {
      if (!handlers.has(el)) handlers.set(el, []);
      handlers.get(el).push({ event: "click", code: el.attribs.href.trim().slice(0, 160) });
      el.attribs.href = "#";
    }
  });

  // ---- strip what never belongs in a component
  $("head").remove();
  $("script, noscript, style, link, meta, base, template").remove();
  $("*")
    .contents()
    .filter((_, n) => n.type === "comment" || n.type === "directive" || n.type === "cdata")
    .remove();
  // 1x1 tracking pixels
  $("img").each((_, el) => {
    const w = el.attribs.width, h = el.attribs.height;
    if ((w === "1" || w === "0") && (h === "1" || h === "0")) $(el).remove();
  });

  const body = $("body")[0];
  return { $, body, meta, cssSources, scriptSources, handlers };
}
