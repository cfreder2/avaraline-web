// Stage dist/: exactly what the game loads, the same bytes for GitHub Pages and itch.io.
//
//   1. make -f Makefile.emscripten (unless --no-make): the wasm, its data, the level packs
//   2. copy into dist/: index.html (the built avara.html), avara.{js,wasm,data}, the page
//      scripts js/*.js, the level packs levels/*, LICENSE.txt, CONTRIBUTORS.md
//   3. stamp the build: js/build.js names it, and every URL the page loads gets ?v=<it>,
//      so a browser can never pair a cached avara.wasm with a newer avara.js. The stamp
//      is also how the lobby keeps players of different builds out of each other's games
//      (lockstep needs the same engine on every machine).
//   4. check what is fatal inside itch's iframe and fine on Pages: no absolute paths (itch
//      serves from html-classic.itch.zone, where /x resolves to the wrong place), and
//      itch's limits on the upload.
//
// usage: node tools/build.mjs [--label "#12 · abc1234"] [--no-make]
//   The label defaults to the git commit, with "-dirty" and the time when the tree has
//   uncommitted changes. Emscripten must be on PATH for the make step
//   (source ../emsdk/emsdk_env.sh).
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const BUILD = path.join(ROOT, 'build_web');
const DIST = path.join(ROOT, 'dist');
// The site's page (web/site): its shell, scripts, images and online.html; the shared
// scripts (mesh, levels, latency) come from web/js.
const PAGE = 'web/site';
// itch extracts the upload and enforces these
const MAX_FILES = 1000, MAX_TOTAL = 500 * 2 ** 20, MAX_FILE = 200 * 2 ** 20, MAX_PATH = 240;

const fail = msg => { console.error(`\nbuild stopped: ${msg}`); process.exit(1); };
const arg = n => process.argv.includes(n);

function label() {
  const i = process.argv.indexOf('--label');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const dirty = execSync('git status --porcelain -- src web levels vendor rsrc Makefile.emscripten', { cwd: ROOT }).toString().trim();
    if (!dirty) return sha;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${sha}-dirty-${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  } catch { return 'local'; }
}

if (!arg('--no-make')) {
  const jobs = String(Math.max(2, (await import('node:os')).cpus().length));
  // the version header first, on its own: make decides what to rebuild before running any
  // rule, so a header rewritten during the same run would not reach the objects until next time
  spawnSync('make', ['-f', 'Makefile.emscripten', 'NODE=' + process.execPath, 'PAGE=' + PAGE, 'version'], { cwd: ROOT, stdio: 'inherit' });
  const r = spawnSync('make', ['-f', 'Makefile.emscripten', 'NODE=' + process.execPath, 'PAGE=' + PAGE, '-j' + jobs], { cwd: ROOT, stdio: 'inherit' });
  if (r.status) fail('make failed. Is emscripten on PATH? (source ../emsdk/emsdk_env.sh)');
}
for (const f of ['avara.html', 'avara.js', 'avara.wasm', 'avara.data', 'levels/index.json']) {
  if (!fs.existsSync(path.join(BUILD, f))) fail(`build_web/${f} is missing`);
}

const v = label();
const q = '?v=' + encodeURIComponent(v);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });
for (const f of ['avara.js', 'avara.wasm', 'avara.data']) fs.copyFileSync(path.join(BUILD, f), path.join(DIST, f));
for (const f of ['LICENSE.txt', 'CONTRIBUTORS.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');   // Pages: serve files as they are
// the scripts index.html and online.html load, from web/site/js or else web/js
const pageHtml = fs.readFileSync(path.join(BUILD, 'avara.html'), 'utf8') + fs.readFileSync(path.join(ROOT, PAGE, 'online.html'), 'utf8');
const scripts = [...new Set([...pageHtml.matchAll(/src="js\/([\w-]+\.js)"/g)].map(m => m[1]))].filter(f => f !== 'build.js');
for (const f of scripts) {
  const from = [path.join(ROOT, PAGE, 'js', f), path.join(ROOT, 'web', 'js', f)].find(p => fs.existsSync(p));
  if (!from) fail(`the page loads js/${f}, which is in neither ${PAGE}/js nor web/js`);
  fs.copyFileSync(from, path.join(DIST, 'js', f));
}
fs.writeFileSync(path.join(DIST, 'js', 'build.js'), `window.AVARA_BUILD = ${JSON.stringify(v)};\n`);
fs.cpSync(path.join(BUILD, 'levels'), path.join(DIST, 'levels'), { recursive: true });
fs.cpSync(path.join(ROOT, PAGE, 'img'), path.join(DIST, 'img'), { recursive: true });   // logo, icons

// the page, with every script it loads stamped
let html = fs.readFileSync(path.join(BUILD, 'avara.html'), 'utf8');
html = html.replace(/(<script[^>]*\ssrc=")((?:js\/[\w-]+|avara)\.js)(")/g, (m, a, src, b) => a + src + q + b);
fs.writeFileSync(path.join(DIST, 'index.html'), html);
// the site's other pages (online.html: who is playing, live; credits.html), scripts stamped the same way
for (const f of fs.readdirSync(path.join(ROOT, PAGE)).filter(f => f.endsWith('.html') && f !== 'shell.html')) {
  const page = fs.readFileSync(path.join(ROOT, PAGE, f), 'utf8')
    .replace(/(<script[^>]*\ssrc=")(js\/[\w-]+\.js)(")/g, (m, a, src, b) => a + src + q + b);
  fs.writeFileSync(path.join(DIST, f), page);
}

// every image the page names is there
const imgs = [...html.matchAll(/(?:src|href)="(img\/[^"?]+)/g)].map(m => m[1]).filter(f => !fs.existsSync(path.join(DIST, f)));
if (imgs.length) fail('index.html names images that are not there: ' + imgs.join(', '));

// every page script the page names is there, and every one there is named
const named = [...html.matchAll(/src="js\/([\w-]+\.js)\?/g)].map(m => m[1]);
const missing = named.filter(f => !fs.existsSync(path.join(DIST, 'js', f)));
if (missing.length) fail('index.html loads scripts that are not there: ' + missing.join(', '));
const siteScripts = fs.readdirSync(path.join(ROOT, PAGE, 'js')).filter(f => f.endsWith('.js'));
const unused = siteScripts.filter(f => !scripts.includes(f));
if (unused.length) fail(`${PAGE}/js has scripts no page loads: ` + unused.join(', '));

// no absolute paths
const bad = [];
for (const f of ['index.html', ...scripts.map(s => 'js/' + s)]) {
  const text = fs.readFileSync(path.join(DIST, f), 'utf8');
  for (const m of text.matchAll(/(?:src|href)\s*=\s*['"](\/[^/'"][^'"]*)['"]/g)) bad.push(`${f}: ${m[1]}`);
  for (const m of text.matchAll(/fetch\(\s*['"](\/[^/'"][^'"]*)['"]/g)) bad.push(`${f}: fetch ${m[1]}`);
}
if (bad.length) fail('absolute paths, which itch serves from the wrong origin:\n  ' + bad.join('\n  '));

// what ships, and itch's limits
const files = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push([path.relative(DIST, p), fs.statSync(p).size]); } };
walk(DIST);
const total = files.reduce((s, [, n]) => s + n, 0);
if (files.length > MAX_FILES) fail(`${files.length} files; itch extracts at most ${MAX_FILES}`);
if (total > MAX_TOTAL) fail(`${(total / 2 ** 20).toFixed(0)} MB; itch allows ${MAX_TOTAL / 2 ** 20}`);
for (const [f, n] of files) {
  if (n > MAX_FILE) fail(`${f} is ${(n / 2 ** 20).toFixed(0)} MB`);
  if (f.length > MAX_PATH) fail(`${f}: path too long for itch`);
}
const first = ['index.html', 'avara.js', 'avara.wasm', 'avara.data', ...scripts.map(s => 'js/' + s)]
  .reduce((s, f) => s + (fs.existsSync(path.join(DIST, f)) ? fs.statSync(path.join(DIST, f)).size : 0), 0);
const mb = n => (n / 2 ** 20).toFixed(1) + ' MB';
console.log(`dist/ ok: ${files.length} files, ${mb(total)} in all, ${mb(first)} to start playing; stamped ${v}`);
