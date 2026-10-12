// Low-level JSX printing: attribute names/values, style objects, text escaping.
// The rules here are the ones LLMs most often get subtly wrong by hand
// (whitespace between inline elements, entities, defaultValue vs value,
// SVG attribute casing), which is why they live in code, not in the prompt.
import { ATTR_RENAME, BOOLEAN_ATTRS, NUMERIC_ATTRS } from "./maps.mjs";

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function attrName(name, inSvg) {
  if (ATTR_RENAME[name]) return ATTR_RENAME[name];
  if (name.startsWith("data-") || name.startsWith("aria-")) return name;
  if (inSvg && name.includes("-")) return camel(name);
  if (inSvg && name.includes(":")) return camel(name.replace(":", "-"));
  return name;
}

export function jsString(s) {
  return JSON.stringify(s);
}

/** Value for a JSX attribute: `"text"`, `{expr}`, or null for boolean true. */
export function attrValue(name, value) {
  const lower = name.toLowerCase();
  if (BOOLEAN_ATTRS.has(lower) && (value === "" || value.toLowerCase() === lower || value === "true")) return null;
  if (NUMERIC_ATTRS.has(lower) && /^-?\d+$/.test(value)) return `{${Number(value)}}`;
  if (/["\\]|&[a-zA-Z#][a-zA-Z0-9]*;|[{}]|\n/.test(value)) return `{${jsString(value)}}`;
  return `"${value}"`;
}

export function styleObject(style, ts) {
  const decls = [];
  // split on ; not inside parentheses or quotes
  let depth = 0, quote = null, cur = "";
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      decls.push(cur);
      cur = "";
    } else cur += ch;
  }
  decls.push(cur);
  let custom = false;
  const entries = decls
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      if (i < 0) return null;
      const prop = d.slice(0, i).trim();
      const value = d.slice(i + 1).trim().replace(/\s*!important$/, "");
      if (prop.startsWith("--")) {
        custom = true;
        return `${jsString(prop)}: ${jsString(value)}`;
      }
      const key = camel(prop.toLowerCase().replace(/^-ms-/, "ms-"));
      // values stay strings: React appends "px" to bare numbers for some props
      return `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : jsString(key)}: ${jsString(value)}`;
    })
    .filter(Boolean);
  if (!entries.length) return null;
  const obj = `{ ${entries.join(", ")} }`;
  return custom && ts ? `{${obj} as React.CSSProperties}` : `{${obj}}`;
}

/** Escape text for a JSX text position (react/no-unescaped-entities safe). */
export function escapeText(s) {
  return s
    .replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;")
    .replace(/\u00a0/g, "&nbsp;");
}

export function templateLiteral(s) {
  return "{`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`}";
}

/**
 * Normalize form controls to uncontrolled React equivalents.
 * Mutates and returns a shallow copy of attribs.
 */
export function formAttrs(el, attribs) {
  const a = { ...attribs };
  if (el.name === "input") {
    const type = (a.type || "text").toLowerCase();
    if ("checked" in a && (type === "checkbox" || type === "radio")) {
      a.defaultChecked = "";
      delete a.checked;
    }
    if ("value" in a && !["submit", "button", "reset", "hidden", "checkbox", "radio", "image"].includes(type)) {
      a.defaultValue = a.value;
      delete a.value;
    }
  }
  if (el.name === "option" && "selected" in a) delete a.selected; // moved to <select defaultValue>
  return a;
}

export function selectDefault(el) {
  const opts = [];
  const walk = (n) => (n.children || []).forEach((c) => (c.name === "option" ? opts.push(c) : c.children && walk(c)));
  walk(el);
  const sel = opts.find((o) => o.attribs && "selected" in o.attribs);
  if (!sel) return null;
  return sel.attribs.value ?? (sel.children || []).map((c) => c.data || "").join("").trim();
}
