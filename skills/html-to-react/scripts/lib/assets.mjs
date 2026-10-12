// Local asset bookkeeping: every relative URL found in markup or CSS is
// resolved against the file that referenced it, copied under the project's
// public dir, and rewritten to its public URL. Remote URLs are left alone.
import fs from "node:fs";
import path from "node:path";
import { sha } from "./source.mjs";

const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "font/woff2": "woff2", "font/woff": "woff" };

export class Assets {
  constructor({ htmlDir, publicDir = null, publicUrl = "", dryRun = true }) {
    this.htmlDir = htmlDir;
    this.publicDir = publicDir;
    this.publicUrl = publicUrl.replace(/\/$/, "");
    this.dryRun = dryRun || !publicDir;
    this.copies = new Map(); // abs src -> rel dest
    this.writes = new Map(); // rel dest -> Buffer (data: URIs)
    this.missing = new Set();
  }

  rewrite(url, fromDir = this.htmlDir) {
    if (!url) return url;
    const raw = url.trim();
    if (/^data:/i.test(raw)) return this.inlineData(raw);
    if (/^(https?:|\/\/|#|mailto:|tel:|sms:|javascript:|\{)/i.test(raw)) return url;
    const [clean, suffix = ""] = raw.split(/(?=[?#])/);
    let abs = clean.startsWith("/") ? path.join(this.htmlDir, clean) : path.resolve(fromDir, decodeURIComponent(clean));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      this.missing.add(clean);
      return url;
    }
    let rel = path.relative(this.htmlDir, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) rel = `external/${path.basename(abs)}`;
    this.copies.set(abs, rel);
    return `${this.publicUrl}/${rel}${suffix.startsWith("#") ? suffix : ""}`;
  }

  rewriteSrcset(srcset, fromDir) {
    return srcset
      .split(",")
      .map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return [this.rewrite(u, fromDir), ...rest].join(" ");
      })
      .join(", ");
  }

  rewriteCssUrls(value, fromDir) {
    return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => `url(${q || "'"}${this.rewrite(u, fromDir)}${q || "'"})`);
  }

  inlineData(uri) {
    const m = uri.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m || uri.length < 2048) return uri; // tiny data URIs stay inline
    const ext = MIME_EXT[m[1]] || "bin";
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    const rel = `inline/${sha(uri, 12)}.${ext}`;
    this.writes.set(rel, buf);
    return `${this.publicUrl}/${rel}`;
  }

  writeFile(rel, content) {
    this.writes.set(rel, Buffer.from(content));
    return `${this.publicUrl}/${rel}`;
  }

  flush() {
    if (this.dryRun) return;
    for (const [abs, rel] of this.copies) {
      const dest = path.join(this.publicDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    for (const [rel, buf] of this.writes) {
      const dest = path.join(this.publicDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
  }

  summary() {
    return { copied: this.copies.size, written: this.writes.size, missing: [...this.missing] };
  }
}
