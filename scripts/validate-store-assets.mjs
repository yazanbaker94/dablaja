import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function inspectPng(buffer, label = 'PNG') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a valid PNG file`);
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${label} is missing the PNG IHDR header`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28]
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function inspectRgbaAlphaBounds(buffer, label = 'PNG') {
  const info = inspectPng(buffer, label);
  if (info.bitDepth !== 8 || info.colorType !== 6 || info.interlace !== 0) {
    throw new Error(`${label} must be a non-interlaced 8-bit RGBA PNG for padding validation`);
  }

  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`${label} has a truncated PNG chunk`);
    if (type === 'IDAT') idat.push(buffer.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (idat.length === 0) throw new Error(`${label} has no PNG image data`);

  const bytesPerPixel = 4;
  const rowBytes = info.width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = info.height * (rowBytes + 1);
  if (raw.length !== expected) throw new Error(`${label} has unexpected PNG scanline data`);

  let previous = Buffer.alloc(rowBytes);
  let sourceOffset = 0;
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[sourceOffset];
    sourceOffset += 1;
    const encoded = raw.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    const row = Buffer.allocUnsafe(rowBytes);
    for (let i = 0; i < rowBytes; i += 1) {
      const x = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const above = previous[i] || 0;
      const upperLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = x;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((x + above) / 2);
      else if (filter === 4) predictor = paeth(x, above, upperLeft);
      else if (filter !== 0) throw new Error(`${label} uses an unknown PNG filter`);
      row[i] = (encoded[i] + predictor) & 0xff;
    }
    for (let x = 0; x < info.width; x += 1) {
      if (row[(x * bytesPerPixel) + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    previous = row;
  }
  if (right < left || bottom < top) throw new Error(`${label} contains no visible pixels`);
  return { left, top, right: right + 1, bottom: bottom + 1, width: right - left + 1, height: bottom - top + 1 };
}

async function inspectFile(root, relative) {
  const absolute = path.join(root, relative);
  return inspectPng(await readFile(absolute), relative);
}

function requireDimensions(info, width, height, label) {
  if (info.width !== width || info.height !== height) {
    throw new Error(`${label} must be ${width}x${height}; found ${info.width}x${info.height}`);
  }
}

export async function validateStoreAssets(root, { release = false } = {}) {
  const warnings = [];
  const icons = [16, 32, 48, 128];
  for (const size of icons) {
    const relative = `icons/icon-${size}.png`;
    requireDimensions(await inspectFile(root, relative), size, size, relative);
  }
  const storeIconRelative = 'icons/icon-128.png';
  const storeIconBounds = inspectRgbaAlphaBounds(
    await readFile(path.join(root, storeIconRelative)),
    storeIconRelative
  );
  if (
    storeIconBounds.left < 16 || storeIconBounds.top < 16 ||
    storeIconBounds.right > 112 || storeIconBounds.bottom > 112
  ) {
    throw new Error(
      `${storeIconRelative} artwork must fit inside the centered 96x96 Store safe area; ` +
      `found alpha bounds ${storeIconBounds.left},${storeIconBounds.top}–${storeIconBounds.right},${storeIconBounds.bottom}`
    );
  }

  requireDimensions(
    await inspectFile(root, 'store-assets/small-promo-440x280.png'),
    440,
    280,
    'small promotional tile'
  );

  try {
    requireDimensions(
      await inspectFile(root, 'store-assets/marquee-1400x560.png'),
      1400,
      560,
      'marquee promotional image'
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      warnings.push('Optional 1400x560 marquee promotional image is missing.');
    } else {
      throw error;
    }
  }

  const screenshotsDir = path.join(root, 'store-assets', 'screenshots');
  let screenshots = [];
  try {
    screenshots = (await readdir(screenshotsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (screenshots.length > 5) {
    throw new Error(`Chrome Web Store accepts at most 5 screenshots; found ${screenshots.length}`);
  }
  for (const filename of screenshots) {
    const relative = path.posix.join('store-assets/screenshots', filename);
    const info = await inspectFile(root, relative);
    const allowed = (info.width === 1280 && info.height === 800) || (info.width === 640 && info.height === 400);
    if (!allowed) {
      throw new Error(`${relative} must be 1280x800 or 640x400; found ${info.width}x${info.height}`);
    }
  }

  if (screenshots.length === 0) {
    const message = 'No submission screenshot exists yet; capture at least one real 1280x800 extension experience before release.';
    if (release) throw new Error(message);
    warnings.push(message);
  }

  return { icons: icons.length, screenshots: screenshots.length, warnings };
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const result = await validateStoreAssets(root, { release: process.env.DABLAJA_RELEASE === '1' });
  for (const warning of result.warnings) process.stdout.write(`WARNING: ${warning}\n`);
  process.stdout.write(
    `Store assets valid: ${result.icons} extension icons, ${result.screenshots} submission screenshot(s), small promo and marquee.\n`
  );
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`Store asset validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
