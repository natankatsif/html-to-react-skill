// Reads the target React project so generated code matches its conventions
// (TS or JS, Tailwind version, path alias, indentation, export style).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// JSONC (tsconfig) reader: strips comments outside strings and trailing commas.
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const readJson = (p) => {
  try {
    return JSON.parse(stripJsonc(fs.readFileSync(p, "utf8").replace(/^﻿/, "")));
  } catch {
    return null;
  }
};

function firstExisting(root, cands) {
  return cands.find((c) => fs.existsSync(path.join(root, c))) || null;
}

function sampleComponents(root, dir) {
  if (!dir) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || out.length > 12) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory() && f.name !== "node_modules" && !f.name.startsWith(".")) walk(path.join(d, f.name), depth + 1);
      else if (/\.(tsx|jsx)$/.test(f.name)) out.push(path.join(d, f.name));
    }
  };
  walk(path.join(root, dir), 0);
  return out;
}

// @tailwindcss/node is a transitive dependency; with pnpm it is not hoisted,
// so look for it next to whichever Tailwind integration the project uses.
function resolveTailwindNode(root) {
  const bases = [root, ...["@tailwindcss/postcss", "@tailwindcss/vite", "@tailwindcss/cli"].map((p) => {
    try {
      return fs.realpathSync(path.join(root, "node_modules", p));
    } catch {
      return null;
    }
  })].filter(Boolean);
  for (const b of bases) {
    try {
      return createRequire(path.join(b, "package.json")).resolve("@tailwindcss/node");
    } catch {
      /* try next */
    }
  }
  return null;
}

export function detectProject(root = process.cwd()) {
  root = path.resolve(root);
  const pkg = readJson(path.join(root, "package.json")) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const ver = (name) => (deps[name] ? (deps[name].match(/\d+/) || [null])[0] : null);
  const tsconfig = readJson(path.join(root, "tsconfig.json")) || readJson(path.join(root, "jsconfig.json"));
  const paths = tsconfig?.compilerOptions?.paths || {};
  const aliasKey = Object.keys(paths).find((k) => k.endsWith("/*"));
  const alias = aliasKey ? { prefix: aliasKey.slice(0, -1), target: String(paths[aliasKey][0]).replace(/\*$/, "").replace(/^\.\//, "") } : null;

  const appDir = firstExisting(root, ["src/app", "app"]);
  const pagesDir = firstExisting(root, ["src/pages", "pages"]);
  const componentsDir = firstExisting(root, ["src/components", "components", "app/components", "src/app/components"]);
  const globalsCss = firstExisting(root, ["src/app/globals.css", "app/globals.css", "src/index.css", "src/styles/globals.css", "styles/globals.css", "src/App.css"]);
  const publicDir = firstExisting(root, ["public"]);

  let indent = 2;
  let exportStyle = "default";
  const samples = sampleComponents(root, componentsDir || appDir);
  let fourSpace = 0, twoSpace = 0, defaults = 0, named = 0;
  for (const f of samples) {
    const t = fs.readFileSync(f, "utf8");
    if (/\n {4}\S/.test(t) && !/\n {2}[^\s]/.test(t)) fourSpace++;
    else twoSpace++;
    if (/export default function/.test(t)) defaults++;
    else if (/export (function|const) [A-Z]/.test(t)) named++;
  }
  if (fourSpace > twoSpace) indent = 4;
  if (named > defaults) exportStyle = "named";

  const tailwindMajor = ver("tailwindcss") ? Number(ver("tailwindcss")) : null;
  const twNodePath = tailwindMajor >= 4 ? resolveTailwindNode(root) : null;

  return {
    root,
    framework: deps.next ? `next@${ver("next")}` : deps.vite ? "vite" : deps["react-scripts"] ? "cra" : deps.react ? "react" : "unknown",
    router: deps.next ? (appDir ? "app" : "pages") : null,
    react: ver("react"),
    typescript: !!tsconfig && fs.existsSync(path.join(root, "tsconfig.json")),
    tailwind: tailwindMajor,
    twDesignSystem: twNodePath,
    alias,
    appDir,
    pagesDir,
    componentsDir,
    globalsCss,
    publicDir,
    indent,
    exportStyle,
    libs: ["lucide-react", "react-icons", "framer-motion", "motion", "clsx", "tailwind-merge", "class-variance-authority", "@radix-ui/react-slot", "next-themes", "embla-carousel-react", "swiper"].filter((l) => deps[l]),
    nodeModules: fs.existsSync(path.join(root, "node_modules")),
  };
}

/**
 * Validate class candidates against the project's real Tailwind v4 design
 * system. Returns null when unavailable (then nothing gets dropped).
 */
export async function loadTailwindValidator(project) {
  if (!project.twDesignSystem || !project.globalsCss) return null;
  try {
    const mod = await import(project.twDesignSystem);
    const css = fs.readFileSync(path.join(project.root, project.globalsCss), "utf8");
    const ds = await mod.__unstable__loadDesignSystem(css, { base: path.dirname(path.join(project.root, project.globalsCss)) });
    const cache = new Map();
    return (candidates) => {
      const todo = candidates.filter((c) => !cache.has(c));
      if (todo.length) {
        const out = ds.candidatesToCss(todo);
        todo.forEach((c, i) => cache.set(c, !!out[i]));
      }
      return new Set(candidates.filter((c) => cache.get(c)));
    };
  } catch {
    return null;
  }
}
