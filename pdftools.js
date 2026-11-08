// Thin wrappers around qpdf / poppler command line tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const run = promisify(execFile);

// qpdf exit code 3 = success with warnings
export async function qpdf(args) {
  try {
    return await run('qpdf', args, { maxBuffer: 1 << 20 });
  } catch (err) {
    if (err.code === 3) return err;
    throw err;
  }
}

// Per-page geometry. w/h are the *displayed* size in pt (rotation applied).
export async function pageInfo(file) {
  const { stdout } = await run('pdfinfo', ['-f', '1', '-l', '100000', file], { maxBuffer: 16 << 20 });
  const pages = [];
  for (const line of stdout.split('\n')) {
    let m = line.match(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/);
    if (m) pages[m[1] - 1] = { ...pages[m[1] - 1], w: +m[2], h: +m[3] };
    m = line.match(/^Page\s+(\d+)\s+rot:\s+(\d+)/);
    if (m) pages[m[1] - 1] = { ...pages[m[1] - 1], rot: +m[2] };
  }
  return pages.map((p) => (p.rot % 180 ? { w: p.h, h: p.w, rot: p.rot } : { w: p.w, h: p.h, rot: p.rot || 0 }));
}

// Rotate pages in place. pages: array of 1-based numbers, or null for all.
export async function rotate(file, angle, pages = null) {
  const sign = angle < 0 ? '-' : '+';
  const range = pages ? ':' + pages.join(',') : '';
  await qpdf([file, '--replace-input', `--rotate=${sign}${Math.abs(angle)}${range}`]);
}

// Highest image resolution (ppi) per page, from embedded scan images.
export async function imagePpi(file) {
  const ppi = {};
  try {
    const { stdout } = await run('pdfimages', ['-list', file], { maxBuffer: 16 << 20 });
    for (const line of stdout.split('\n').slice(2)) {
      const c = line.trim().split(/\s+/);
      const page = +c[0], x = +c[12];
      if (page && x) ppi[page] = Math.max(ppi[page] || 0, x);
    }
  } catch {}
  return ppi;
}

// Render the top or bottom half of a page as JPEG. Returns the output path.
export async function renderHalf(file, page, pos, geom, dpi, outBase, quality = 85) {
  const W = Math.round((geom.w * dpi) / 72);
  const full = Math.round((geom.h * dpi) / 72);
  const H = Math.floor(full / 2);
  const y = pos === 'top' ? 0 : full - H;
  await run('pdftoppm', [
    '-jpeg', '-jpegopt', `quality=${quality}`, '-r', String(dpi),
    '-f', String(page), '-l', String(page),
    '-x', '0', '-y', String(y), '-W', String(W), '-H', String(H),
    '-singlefile', file, outBase,
  ]);
  return outBase + '.jpg';
}
