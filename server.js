import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, qpdf, pageInfo, rotate } from './pdftools.js';
import { halvesRoutes } from './halves.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA = process.env.DATA_DIR || join(tmpdir(), 'pdfold');
const MAX_BYTES = (Number(process.env.MAX_MB) || 200) * 1024 * 1024;
const TTL_MS = (Number(process.env.TTL_MIN) || 60) * 60 * 1000;
const ID_RE = /^[0-9a-f-]{36}$/;
const INDEX = await readFile(new URL('./public/index.html', import.meta.url));
const PKG = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
const toolVersion = async (cmd, args) => {
  try {
    const { stdout, stderr } = await run(cmd, args);
    return (stdout + stderr).match(/version\s+([\d.]+)/i)?.[1] || '';
  } catch {
    return '';
  }
};
const ABOUT = {
  name: 'PDFold',
  version: PKG.version,
  description: PKG.description,
  qpdf: await toolVersion('qpdf', ['--version']),
  poppler: await toolVersion('pdftoppm', ['-v']),
  node: process.versions.node,
};
const OS = new URL('./node_modules/overlayscrollbars/', import.meta.url);
const VENDOR = {
  '/vendor/overlayscrollbars.css': ['text/css', await readFile(new URL('styles/overlayscrollbars.min.css', OS))],
  '/vendor/overlayscrollbars.js': ['text/javascript', await readFile(new URL('browser/overlayscrollbars.browser.es6.min.js', OS))],
  '/PDFold.svg': ['image/svg+xml', await readFile(new URL('./PDFold.svg', import.meta.url))],
  '/vendor/sortable.js': ['text/javascript', await readFile(new URL('./node_modules/sortablejs/Sortable.min.js', import.meta.url))],
};

await mkdir(DATA, { recursive: true });

const pdfPath = (id) => join(DATA, `${id}.pdf`);
const pngPath = (id) => join(DATA, `${id}.png`);
const bigPath = (id) => join(DATA, `${id}-big.png`);

async function sendPng(res, file) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
  createReadStream(file).on('error', () => res.end()).pipe(res);
}

// large first-page render, created on first request
async function handlePreview(res, id) {
  const big = bigPath(id);
  try {
    await stat(big);
  } catch {
    try {
      await run('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '1600', pdfPath(id), join(DATA, `${id}-big`)]);
    } catch {
      return json(res, 404, { error: 'Vorschau nicht verfügbar' });
    }
  }
  return sendPng(res, big);
}

async function makeThumb(id) {
  await rm(bigPath(id), { force: true });
  try {
    await run('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '400', pdfPath(id), join(DATA, id)]);
  } catch {}
}

async function docInfo(id) {
  const file = pdfPath(id);
  let info = {};
  try {
    info = parsePdfinfo((await run('pdfinfo', [file])).stdout);
  } catch {}
  return {
    pages: Number(info.Pages) || Number((await qpdf(['--show-npages', file])).stdout.trim()),
    bytes: (await stat(file)).size,
    title: info.Title || '',
    pageSize: info['Page size'] || '',
    version: info['PDF version'] || '',
    encrypted: (info.Encrypted || 'no').startsWith('yes'),
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Datei zu groß'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parsePdfinfo(out) {
  const info = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return info;
}

async function handleUpload(req, res) {
  const name = decodeURIComponent(req.headers['x-filename'] || 'dokument.pdf');
  const buf = await readBody(req, MAX_BYTES);
  if (buf.subarray(0, 1024).indexOf('%PDF') === -1) {
    return json(res, 400, { error: `${name} ist keine PDF-Datei` });
  }
  const id = randomUUID();
  const file = pdfPath(id);
  await writeFile(file, buf);
  try {
    await qpdf(['--show-npages', file]); // throws if unreadable
    // PDFold works in portrait: turn landscape pages upright
    const landscape = (await pageInfo(file)).flatMap((p, i) => (p.w > p.h ? [i + 1] : []));
    if (landscape.length) await rotate(file, 90, landscape);
    await makeThumb(id);
    json(res, 200, { id, name, rev: 0, autoRotated: landscape.length, ...(await docInfo(id)) });
  } catch (err) {
    await rm(file, { force: true });
    const msg = (err.stderr || err.message || '').toString().trim().split('\n').pop();
    json(res, 422, { error: `${name}: ${msg || 'konnte nicht gelesen werden'}` });
  }
}

async function handleMerge(req, res) {
  const { ids, name } = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => ID_RE.test(id))) {
    return json(res, 400, { error: 'Keine gültigen Dateien' });
  }
  const out = join(DATA, `merged-${randomUUID()}.pdf`);
  try {
    await qpdf(['--empty', '--pages', ...ids.map(pdfPath), '--', out]);
    const { size } = await stat(out);
    const fname = (String(name || 'zusammengefuegt').replace(/[^\w.\- äöüÄÖÜß]/g, '_').replace(/\.pdf$/i, '') || 'zusammengefuegt') + '.pdf';
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="merged.pdf"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    });
    const s = createReadStream(out);
    s.pipe(res);
    s.on('close', () => rm(out, { force: true }));
  } catch (err) {
    await rm(out, { force: true });
    json(res, 500, { error: (err.stderr || err.message || 'Fehler').toString().trim() });
  }
}

async function handleRotate(req, res, id) {
  const { angle } = JSON.parse((await readBody(req, 1024)).toString() || '{}');
  if (![90, -90, 180].includes(angle)) return json(res, 400, { error: 'Ungültiger Winkel' });
  await stat(pdfPath(id));
  await rotate(pdfPath(id), angle);
  await makeThumb(id);
  json(res, 200, await docInfo(id));
}

async function cleanup() {
  const now = Date.now();
  for (const f of await readdir(DATA)) {
    const p = join(DATA, f);
    try {
      if (now - (await stat(p)).mtimeMs > TTL_MS) await rm(p, { recursive: true, force: true });
    } catch {}
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

const halves = halvesRoutes({ DATA, pdfPath, json, readBody });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/');
  const [, a, b, id] = parts;
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && VENDOR[url.pathname]) {
      const [type, body] = VENDOR[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'max-age=86400' });
      return res.end(body);
    }
    if (a === 'api') {
      if (req.method === 'GET' && b === 'about') return json(res, 200, ABOUT);
      if (req.method === 'POST' && b === 'upload') return await handleUpload(req, res);
      if (req.method === 'POST' && b === 'merge') return await handleMerge(req, res);
      if (b === 'halves' && (await halves(req, res, parts.slice(3)))) return;
      if (ID_RE.test(id || '')) {
        if (req.method === 'GET' && b === 'thumb') return sendPng(res, pngPath(id));
        if (req.method === 'GET' && b === 'preview') return await handlePreview(res, id);
        if (req.method === 'POST' && b === 'rotate') return await handleRotate(req, res, id);
        if (req.method === 'DELETE' && b === 'file') {
          await Promise.all([pdfPath(id), pngPath(id), bigPath(id)].map((p) => rm(p, { force: true })));
          return json(res, 200, { ok: true });
        }
      }
    }
    json(res, 404, { error: 'Nicht gefunden' });
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`PDFold läuft auf http://localhost:${PORT}`));
