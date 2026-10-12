// Cheap static reading of the page's JavaScript. We do not execute or fully
// parse it: we only need to know which elements it touches, which events it
// listens to and which classes it toggles, so the model can rebuild that
// behavior with React state instead of re-reading every script.

const LIBS = [
  [/\bjQuery\b|\$\(\s*(document|window|['"`])/, "jQuery"],
  [/\bnew\s+Swiper\b/, "Swiper (carousel) -> embla-carousel-react or swiper/react"],
  [/\bAOS\.init\b/, "AOS (scroll reveal) -> framer-motion whileInView or IntersectionObserver"],
  [/\bnew\s+WOW\b/, "WOW.js (scroll reveal) -> framer-motion whileInView"],
  [/\bgsap\b|\bTweenMax\b/, "GSAP -> @gsap/react useGSAP"],
  [/\.owlCarousel\(|\.slick\(/, "jQuery carousel -> embla-carousel-react"],
  [/\bIsotope\b|\.isotope\(/, "Isotope (filter grid) -> state + filtered map"],
  [/\bTyped\b/, "Typed.js -> small typing hook"],
  [/particlesJS|tsParticles/, "particles -> @tsparticles/react"],
  [/\bGLightbox\b|lightbox|fancybox/i, "lightbox -> dialog component"],
  [/\bnew\s+bootstrap\.|data-bs-toggle|data-toggle/, "Bootstrap JS -> state-driven components"],
  [/IntersectionObserver/, "IntersectionObserver -> useEffect with observer"],
  [/localStorage|sessionStorage/, "web storage -> useEffect (client only)"],
  [/fetch\(|XMLHttpRequest|axios/, "network calls -> server action / route handler / client fetch"],
];

function stringLiterals(code) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(code))) out.push(m[2]);
  return out;
}

export function analyzeScripts($, scriptSources) {
  const scripts = [];
  const touched = new Map(); // element -> Set(notes)
  const jsClasses = new Set(); // every class the JS mentions (lookups + toggles)
  const toggledClasses = new Set(); // classes the JS adds/removes: UI state
  const jsIds = new Set();
  const note = (el, text) => {
    if (!touched.has(el)) touched.set(el, new Set());
    touched.get(el).add(text);
  };

  scriptSources.forEach((src, i) => {
    const code = src.text;
    const lines = code.split("\n").length;
    const events = new Set();
    for (const m of code.matchAll(/addEventListener\(\s*['"`](\w+)/g)) events.add(m[1]);
    for (const m of code.matchAll(/\.on(\w+)\s*=/g)) events.add(m[1]);
    for (const m of code.matchAll(/\.(click|scroll|resize|submit|change|keyup|keydown|hover|mouseenter|mouseleave|load|ready)\(\s*function/g)) events.add(m[1]);

    const toggled = new Set();
    for (const m of code.matchAll(/classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) {
      for (const s of stringLiterals(m[1])) s.split(/\s+/).filter(Boolean).forEach((c) => toggled.add(c));
    }
    for (const m of code.matchAll(/\.(?:addClass|removeClass|toggleClass)\(([^)]*)\)/g)) {
      for (const s of stringLiterals(m[1])) s.split(/\s+/).filter(Boolean).forEach((c) => toggled.add(c));
    }
    toggled.forEach((c) => (jsClasses.add(c), toggledClasses.add(c)));

    // Selectors handed to DOM lookups. Resolve them against the cleaned page.
    const selectors = new Set();
    for (const m of code.matchAll(/(?:querySelector(?:All)?|closest|matches|\$|jQuery)\(\s*(['"`])([^'"`]+)\1/g)) selectors.add(m[2]);
    for (const m of code.matchAll(/getElementById\(\s*(['"`])([^'"`]+)\1/g)) selectors.add(`#${m[2]}`);
    for (const m of code.matchAll(/getElementsByClassName\(\s*(['"`])([^'"`]+)\1/g)) selectors.add(m[2].trim().split(/\s+/).map((c) => `.${c}`).join(""));
    for (const m of code.matchAll(/getElementsByTagName\(\s*(['"`])([^'"`]+)\1/g)) selectors.add(m[2]);

    const resolved = [];
    for (const sel of selectors) {
      for (const part of sel.split(",")) {
        for (const c of part.matchAll(/\.([\w-]+)/g)) jsClasses.add(c[1]);
        for (const c of part.matchAll(/#([\w-]+)/g)) jsIds.add(c[1]);
      }
      let els = [];
      try {
        els = $(sel).toArray();
      } catch {
        /* selector css-select cannot parse: keep it as text only */
      }
      resolved.push({ selector: sel, elements: els });
      els.forEach((el) => note(el, `script#${i + 1} uses "${sel}"`));
    }

    const libs = LIBS.filter(([re]) => re.test(code)).map(([, name]) => name);
    scripts.push({ index: i + 1, origin: src.origin, lines, events: [...events], toggled: [...toggled], selectors: resolved, libs });
  });

  // data-* driven widgets (Bootstrap, Alpine, etc.) live in markup, not scripts
  const markupWidgets = [];
  $("[data-bs-toggle],[data-toggle],[x-data],[x-show],[x-on\\:click],[\\@click]").each((_, el) => {
    const a = el.attribs;
    const kind = a["data-bs-toggle"] || a["data-toggle"] || (a["x-data"] !== undefined ? "alpine" : "alpine");
    markupWidgets.push({ el, kind, target: a["data-bs-target"] || a["data-target"] || a.href || null });
    note(el, `markup widget: ${kind}${a["data-bs-target"] || a["data-target"] ? ` -> ${a["data-bs-target"] || a["data-target"]}` : ""}`);
  });

  return { scripts, touched, jsClasses, toggledClasses, jsIds, markupWidgets };
}
