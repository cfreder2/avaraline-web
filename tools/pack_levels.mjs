// Pack the level library for the browser: a little up front, the rest when it is played.
//
// The whole library is ~80 MB of maps, shapes and sounds across 142 sets, and a player
// needs one set at a time. So:
//
//   <out>/levels-stub/<set>/set.json   every set's manifest (its level list), preloaded
//                                      into the wasm's file system so the Levels window
//                                      lists every level from the start; plus the whole
//                                      of the sets in PRELOAD (the one the game boots into)
//   <out>/levels/<set>.<hash>.packz    the rest of each set, one gzipped file, fetched by the page
//                                      (web/js/levels.js) the first time a level from that
//                                      set is loaded. The hash is of the contents, so a
//                                      browser or CDN may cache a pack forever.
//   <out>/levels/index.json            set -> { pack, bytes, deps } for the page
//
// Pack format, inside the gzip: [u32 LE header length][header JSON][file bytes...]; the
// header is { "files": [[path relative to the set, offset from the end of the header,
// length], ...] }. Gzipped by us rather than left to the host: GitHub Pages and itch do
// not compress binary files, and the shapes (BSP JSON) shrink 4x. The extension is not
// .gz so that no server takes it upon itself to send it Content-Encoding: gzip.
//
// The original Mac resource files (levels/*.r) are conversion sources, not read by the
// engine, and are skipped.
//
//   node tools/pack_levels.mjs [levelsDir] [outDir]     defaults: levels build_web
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SRC = path.resolve(process.argv[2] || path.join(ROOT, 'levels'));
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'build_web'));
const PRELOAD = new Set(['single-player']);   // the set the game boots into

// Outputs are rewritten only when their contents change, so that make relinks the page
// only when the preloaded files really did (the build runs this every time).
const stub = path.join(OUT, 'levels-stub'), packs = path.join(OUT, 'levels');
const stubNew = stub + '.new';
fs.rmSync(stubNew, { recursive: true, force: true });
fs.mkdirSync(stubNew, { recursive: true });
fs.mkdirSync(packs, { recursive: true });
const keep = new Set(['index.json']);
const stubHash = crypto.createHash('sha256');
function stubCopy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const b = fs.readFileSync(from);
  fs.writeFileSync(to, b);
  stubHash.update(path.relative(stubNew, to)).update(b);
  return b.length;
}

function walk(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name), r = rel ? rel + '/' + name : name;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, r));
    else out.push(r);
  }
  return out;
}

const index = { v: 1, sets: {} };
let total = 0, preloaded = 0;
for (const set of fs.readdirSync(SRC).sort()) {
  const dir = path.join(SRC, set);
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'set.json'))) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'set.json'), 'utf8'));
  const deps = (manifest.REQD || []).map(r => r.Package).filter(Boolean);
  stubCopy(path.join(dir, 'set.json'), path.join(stubNew, set, 'set.json'));

  const files = walk(dir).filter(f => f !== 'set.json');
  if (PRELOAD.has(set)) {
    for (const f of files) preloaded += stubCopy(path.join(dir, f), path.join(stubNew, set, f));
    index.sets[set] = { preloaded: true, deps, levels: (manifest.LEDI || []).length };
    continue;
  }

  const header = { files: [] };
  const bodies = [];
  let off = 0;
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f));
    header.files.push([f, off, b.length]);
    bodies.push(b);
    off += b.length;
  }
  const head = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  const raw = Buffer.concat([len, head, ...bodies]);
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
  const name = `${set}.${hash}.packz`;
  const out = path.join(packs, name);
  let bytes;
  if (fs.existsSync(out)) bytes = fs.statSync(out).size;          // same contents as last build
  else { const z = zlib.gzipSync(raw, { level: 9 }); fs.writeFileSync(out, z); bytes = z.length; }
  keep.add(name);
  index.sets[set] = { pack: 'levels/' + encodeURIComponent(name), bytes, raw: raw.length, deps, levels: (manifest.LEDI || []).length };
  total += bytes;
}
// packs from earlier builds whose contents have changed
for (const f of fs.readdirSync(packs)) if (!keep.has(f)) fs.rmSync(path.join(packs, f));
index.stub = stubHash.digest('hex').slice(0, 16);
const indexPath = path.join(packs, 'index.json'), text = JSON.stringify(index);
const old = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
if (old !== text || !fs.existsSync(stub)) {
  fs.rmSync(stub, { recursive: true, force: true });
  fs.renameSync(stubNew, stub);
  fs.writeFileSync(indexPath, text);
} else {
  fs.rmSync(stubNew, { recursive: true, force: true });
}

const sets = Object.keys(index.sets).length;
const mb = n => (n / 1048576).toFixed(1) + ' MB';
console.log(`levels: ${sets} sets; ${mb(total)} of gzipped packs, fetched when played; ${mb(preloaded)} of whole sets preloaded (${[...PRELOAD].join(', ')})`);
