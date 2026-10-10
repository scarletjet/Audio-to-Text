// Builds a single self-contained page from index.html for publishing on
// claude.ai as an Artifact: inlines the CSS and JS and drops the
// document wrapper, manifest and service worker (the host provides those).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('<!-- build:page-start -->');
const end = html.indexOf('<!-- build:page-end -->');
if (start < 0 || end < 0) throw new Error('index.html is missing the build markers');

let page = html.slice(start + '<!-- build:page-start -->'.length, end).trim();
const read = (rel) => readFileSync(join(root, rel), 'utf8');

page = page.replace(/<link rel="stylesheet" href="(src\/[^"]+)">/g, (_, rel) => `<style>\n${read(rel)}</style>`);
page = page.replace(/<script src="(src\/[^"]+)"><\/script>/g, (_, rel) => {
  const js = read(rel);
  if (/<\/script/i.test(js)) throw new Error(`${rel} contains a closing script tag`);
  return `<script>\n${js}</script>`;
});

const out = join(root, 'dist', 'thought-sorter.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page + '\n');
console.log(`Wrote ${out} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KB)`);
