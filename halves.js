// A5 half-page mode: split A4 pages into top/bottom halves, let the user pick,
// then stack the kept halves two per A4 page. Halves are rasterised, so the
// content of discarded halves is really gone from the output.
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { run, qpdf, pageInfo, imagePpi, renderHalf } from './pdftools.js';

const SID_RE = /^[0-9a-f-]{36}$/;
const A4 = { w: 595.28, h: 841.89 };
const BLANK_RATIO = 0.002; // < 0.2 % "ink" pixels => half counts as empty

// Estimate how much of each half is printed, from a low-res grayscale render (PGM).
function analyzePgm(buf) {
  const m = buf.toString('latin1', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) return null;
  const w = +m[1], h = +m[2];
  const px = buf.subarray(m[0].length);

  // paper brightness = value that the brightest 30 % of pixels reach (robust for grey scans)
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i++) hist[px[i]]++;
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= px.length * 0.3) { paper = v; break; }
  }
  const inkBelow = Math.max(0, paper - 60);

  // ignore scanner borders / punch holes at the edges and the fold in the middle
  const mx = Math.round(w * 0.06), my = Math.round(h * 0.05), mc = Math.round(h * 0.02);
  const half = (y0, y1) => {
    let ink = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = mx; x < w - mx; x++, n++) if (px[row + x] < inkBelow) ink++;
    }
    return n ? ink / n : 0;
  };
  const mid = Math.floor(h / 2);
  return [half(my, mid - mc), half(mid + mc, h - my)];
}

const pageNo = (name) => Number(name.match(/-(\d+)\.\w+$/)?.[1]);

export function halvesRoutes({ DATA, pdfPath, json, readBody }) {
  const dirOf = (sid) => join(DATA, `halves-${sid}`);
  const metaOf = async (sid) => JSON.parse(await readFile(join(dirOf(sid), 'meta.json'), 'utf8'));

  function sendFile(res, file, type) {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  }

  async function prepare(req, res) {
    const { ids } = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => SID_RE.test(id))) {
      return json(res, 400, { error: 'Keine gültigen Dateien' });
    }
    const sid = randomUUID();
    const dir = dirOf(sid);
    await mkdir(dir, { recursive: true });
    const src = join(dir, 'src.pdf');
    try {
      await qpdf(['--empty', '--pages', ...ids.map(pdfPath), '--', src]);
      const [pages, ppi] = await Promise.all([
        pageInfo(src),
        imagePpi(src),
        run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=75', '-r', '60', src, join(dir, 't')]),
        run('pdftoppm', ['-gray', '-r', '30', src, join(dir, 'g')]),
      ]);
      const ink = {};
      for (const f of await readdir(dir)) {
        if (f.startsWith('g-') && f.endsWith('.pgm')) ink[pageNo(f)] = analyzePgm(await readFile(join(dir, f)));
      }
      await writeFile(join(dir, 'meta.json'), JSON.stringify({ pages, ppi }));
      const halves = pages.flatMap((_, i) =>
        ['top', 'bottom'].map((pos, k) => {
          const r = ink[i + 1]?.[k] ?? 1;
          return { page: i + 1, pos, ink: Math.round(r * 10000) / 10000, blank: r < BLANK_RATIO };
        })
      );
      json(res, 200, { sid, pages: pages.length, halves });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      json(res, 500, { error: (err.stderr || err.message || 'Fehler').toString().trim() });
    }
  }

  async function tile(res, sid, page) {
    const f = (await readdir(dirOf(sid))).find((n) => n.startsWith('t-') && pageNo(n) === page);
    if (!f) return json(res, 404, { error: 'Nicht gefunden' });
    sendFile(res, join(dirOf(sid), f), 'image/jpeg');
  }

  async function halfPreview(res, sid, page, pos) {
    const { pages } = await metaOf(sid);
    const g = pages[page - 1];
    if (!g || !['top', 'bottom'].includes(pos)) return json(res, 404, { error: 'Nicht gefunden' });
    const base = join(dirOf(sid), `h-${page}-${pos}`);
    try {
      await stat(base + '.jpg');
    } catch {
      await renderHalf(join(dirOf(sid), 'src.pdf'), page, pos, g, Math.round((1600 * 72) / g.w), base);
    }
    sendFile(res, base + '.jpg', 'image/jpeg');
  }

  async function build(req, res, sid) {
    const { halves, name } = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
    const { pages, ppi } = await metaOf(sid);
    const valid = Array.isArray(halves) && halves.length > 0 &&
      halves.every((h) => Number.isInteger(h.page) && pages[h.page - 1] && ['top', 'bottom'].includes(h.pos));
    if (!valid) return json(res, 400, { error: 'Keine Halbseiten ausgewählt' });

    const dir = dirOf(sid);
    const src = join(dir, 'src.pdf');
    // render with the scan's own resolution (150–300 dpi), 4 at a time
    const files = new Array(halves.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < halves.length) {
        const i = next++;
        const { page, pos } = halves[i];
        const dpi = Math.min(300, Math.max(150, Math.round(ppi[page] || 200)));
        files[i] = await renderHalf(src, page, pos, pages[page - 1], dpi, join(dir, `b-${i}`));
      }
    }));

    const doc = await PDFDocument.create();
    doc.setProducer('PDFold');
    const slotH = A4.h / 2;
    let sheet;
    for (let i = 0; i < files.length; i++) {
      if (i % 2 === 0) sheet = doc.addPage([A4.w, A4.h]);
      const img = await doc.embedJpg(await readFile(files[i]));
      const s = Math.min(A4.w / img.width, slotH / img.height);
      const w = img.width * s, h = img.height * s;
      const slotY = i % 2 === 0 ? slotH : 0;
      sheet.drawImage(img, { x: (A4.w - w) / 2, y: slotY + (slotH - h) / 2, width: w, height: h });
    }
    const bytes = await doc.save();
    await Promise.all(files.map((f) => rm(f, { force: true })));

    const fname = (String(name || 'halbseiten').replace(/[^\w.\- äöüÄÖÜß]/g, '_').replace(/\.pdf$/i, '') || 'halbseiten') + '.pdf';
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': bytes.length,
      'Content-Disposition': `attachment; filename="halbseiten.pdf"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    });
    res.end(Buffer.from(bytes));
  }

  // returns true when the request was handled
  return async function handle(req, res, parts) {
    const [sid, action, p1, p2] = parts;
    const m = req.method;
    if (m === 'POST' && sid === 'prepare') {
      await prepare(req, res);
      return true;
    }
    if (!SID_RE.test(sid || '')) return false;
    try {
      await stat(dirOf(sid));
    } catch {
      json(res, 410, { error: 'Sitzung abgelaufen – bitte neu starten' });
      return true;
    }
    if (m === 'GET' && action === 'tile') await tile(res, sid, Number(p1));
    else if (m === 'GET' && action === 'half') await halfPreview(res, sid, Number(p1), p2);
    else if (m === 'POST' && action === 'build') await build(req, res, sid);
    else if (m === 'DELETE' && !action) {
      await rm(dirOf(sid), { recursive: true, force: true });
      json(res, 200, { ok: true });
    } else return false;
    return true;
  };
}
