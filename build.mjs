// Builds dist/chrome and dist/firefox (unpacked) plus a .zip of each.
// Usage: node build.mjs [--test]
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { build } from 'esbuild';

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = join(root, 'src');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// neshan.org's map and Google Maps (google.com; the panel picks the site itself)
const SITES = ['https://neshan.org/maps*', 'https://www.google.com/maps*'];
const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 96: 'icons/icon-96.png', 128: 'icons/icon-128.png' };
const base = {
  manifest_version: 3,
  name: 'مسیرها و محل قرار (برای نقشهٔ نشان و گوگل‌مپ)',
  short_name: 'مسیرها و قرار',
  version: pkg.version,
  description: 'چند مسیر هم‌زمان روی نقشهٔ نشان و گوگل‌مپ، مقایسهٔ آن‌ها و پیدا کردن محل قراری سر راه همه. افزونهٔ غیررسمی؛ وابسته به نشان یا گوگل نیست.',
  icons,
  action: { default_title: 'مسیرها و محل قرار', default_icon: { 16: icons[16], 32: icons[32], 48: icons[48] } },
  permissions: ['storage'],
  content_scripts: [
    // storage bridge (isolated world) first, then the panel inside the page's own world
    { matches: SITES, js: ['bridge.js'], run_at: 'document_start' },
    { matches: SITES, js: ['inpage.js'], run_at: 'document_idle', world: 'MAIN' },
  ],
};
const manifests = {
  chrome: { ...base, background: { service_worker: 'background.js' }, minimum_chrome_version: '116' },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'neshan-routes@vahidbaghi.ir',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
};

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Minimal ZIP writer (deflate), enough for browser extension packages.
function zip(dir, outFile) {
  const files = walk(dir);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(relative(dir, f).split(sep).join('/'), 'utf8');
    const data = readFileSync(f);
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...chunks, cd, end]));
}

// The in-page script is one IIFE (MAIN-world content scripts cannot be modules).
// `--test` also writes dist-test/<target>, whose inpage.js additionally contains the
// fake Neshan used by the browser tests (switched on by localStorage 'nr-fake' = '1').
const bundle = (entry, outfile) => build({
  entryPoints: [entry], outfile, bundle: true, format: 'iife', target: ['chrome116', 'firefox128'],
  loader: { '.css': 'text' }, charset: 'utf8', legalComments: 'none', logLevel: 'warning',
});

const withTest = process.argv.includes('--test');
rmSync(dist, { recursive: true, force: true });
for (const [target, manifest] of Object.entries(manifests)) {
  const variants = [[join(dist, target), join(src, 'inpage', 'main.js')]];
  if (withTest) variants.push([join(root, 'dist-test', target), join(root, 'tests', 'e2e', 'inpage-test.js')]);
  for (const [out, entry] of variants) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(src, 'icons'), join(out, 'icons'), { recursive: true });
    cpSync(join(src, 'background.js'), join(out, 'background.js'));
    cpSync(join(src, 'content', 'bridge.js'), join(out, 'bridge.js'));
    await bundle(entry, join(out, 'inpage.js'));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`built ${relative(root, out)}`);
  }
  zip(join(dist, target), join(dist, `neshan-routes-${target}-${pkg.version}.zip`));
}
