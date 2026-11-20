// Bounded readers shared by the Node and Workers HTTP adapters.
import { ActionError, bad } from './errors.js';
import { CONTENT_IMAGE_LIMIT, CONTENT_MEDIA_LIMIT } from './content-media.js';

export const ARCHIVE_LIMIT = 5 * 1024 * 1024;
const MANIFEST_LIMIT = 256 * 1024;
const PIXEL_BYTES_LIMIT = 32 * 1024 * 1024;
const MAX_FILES = 33;
// Chromium writes canvas PNGs in 4 KiB IDAT chunks: a full-size allowed upload can contain nearly 384.
const MAX_PNG_DATA_CHUNKS = 512;
const MAX_PNG_OTHER_CHUNKS = 128;
export const IMAGE_PATH = /^images\/[a-z0-9][a-z0-9_-]{0,63}\.png$(?![\s\S])/;
const PNG_MAGIC = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const checksumTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0);
  return i;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ checksumTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function join(parts, size) {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export async function boundedBytes(stream, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new ActionError('too_big', 'upload exceeds the archive byte limit');
    parts.push(chunk);
  }
  return join(parts, size);
}

async function inflate(bytes, format, expected, path) {
  try {
    // Feed a bounded compressed chunk at a time so a single inflate step cannot spool a large archive.
    let offset = 0;
    const input = new ReadableStream({
      pull(controller) {
        const end = Math.min(offset + 4096, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        if (offset === bytes.length) controller.close();
      },
    }).pipeThrough(new DecompressionStream(format));
    const decoded = await boundedBytes(input, expected);
    if (decoded.length === expected) return decoded;
  } catch {
    // Includes corrupt streams and streams that exceed their declared size.
  }
  throw bad(`${path}: invalid compressed data or uncompressed length`);
}

const dataView = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const matchesAt = (b, offset, expected) => expected.every((byte, i) => b[offset + i] === byte);

/** Single-disk ZIP with a central directory, regular entries, and explicit local sizes. */
function readZip(bytes) {
  if (bytes.length < 22 || bytes.length > ARCHIVE_LIMIT) throw bad('expected a non-empty ZIP within the archive limit');
  const view = dataView(bytes);
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);
  const end = bytes.length - 22;
  if (u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 20)) {
    throw bad('ZIP must be single-disk and have no archive comment');
  }
  const count = u16(end + 10);
  const start = u32(end + 16);
  if (!count || count > MAX_FILES || u16(end + 8) !== count || start + u32(end + 12) !== end) {
    throw bad('invalid ZIP directory or file count');
  }

  const entries = new Map();
  let offset = start;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw bad('truncated ZIP directory');
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressed = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const nameEnd = offset + 46 + nameLength;
    const mode = (u32(offset + 38) >>> 16) & 0xf000;
    if ((flags & ~0x0800) || ![0, 8].includes(method) || (mode && mode !== 0x8000) ||
        (u32(offset + 38) & 0x10) || u16(offset + 30) || u16(offset + 32) || u16(offset + 34) ||
        !nameLength || nameLength > 75 || nameEnd > end) {
      throw bad('unsupported ZIP entry flags, metadata or file type');
    }
    const nameBytes = bytes.subarray(offset + 46, nameEnd);
    const name = String.fromCharCode(...nameBytes);
    if (name !== 'manifest.json' && !IMAGE_PATH.test(name)) throw bad('ZIP entries must be manifest.json or images/<id>.png');
    if (entries.has(name)) throw bad(`${name}: duplicate ZIP path`);
    const limit = name === 'manifest.json' ? MANIFEST_LIMIT : CONTENT_IMAGE_LIMIT;
    total += size;
    if (!size || size > limit || total > CONTENT_MEDIA_LIMIT + MANIFEST_LIMIT ||
        !compressed || (method === 0 && compressed !== size) || size > compressed * 200) {
      throw bad(`${name}: file size or compression ratio exceeds the limit`);
    }
    entries.set(name, { nameBytes, flags, method, crc, compressed, size, local: u32(offset + 42) });
    offset = nameEnd;
  }
  if (offset !== end || !entries.has('manifest.json')) throw bad('ZIP requires exactly one manifest.json');

  let next = 0;
  for (const [name, e] of [...entries].sort((a, b) => a[1].local - b[1].local)) {
    const o = e.local;
    const body = o + 30 + e.nameBytes.length;
    if (o !== next || body + e.compressed > start || u32(o) !== 0x04034b50 || u16(o + 6) !== e.flags ||
        u16(o + 8) !== e.method || u32(o + 14) !== e.crc || u32(o + 18) !== e.compressed ||
        u32(o + 22) !== e.size || u16(o + 26) !== e.nameBytes.length || u16(o + 28) ||
        !matchesAt(bytes, o + 30, e.nameBytes)) throw bad(`${name}: ZIP headers disagree or overlap`);
    next = body + e.compressed;
    e.bytes = bytes.subarray(body, next);
  }
  if (next !== start) throw bad('unexpected bytes before ZIP directory');
  return entries;
}

async function zipBody(entries, path) {
  const e = entries.get(path);
  const body = e.method === 0 ? e.bytes : await inflate(e.bytes, 'deflate-raw', e.size, path);
  if (crc32(body) !== e.crc) throw bad(`${path}: ZIP checksum mismatch`);
  return body;
}

/** Validate a static RGB/RGBA PNG, then publish only its checked core chunks. */
async function cleanPng(bytes, path, reservePixels) {
  const off = dataView(bytes);
  const badImage = () => bad(`${path}: expected a static 8-bit RGB/RGBA PNG up to 2048×2048`);
  if (!matchesAt(bytes, 0, PNG_MAGIC)) throw badImage();
  let pos = 8;
  let stride;
  let height;
  let otherChunks = 0;
  let dataChunks = 0;
  let dataSize = 0;
  let dataEnded = false;
  const chunksToKeep = [PNG_MAGIC];
  const pixels = [];
  while (pos + 12 <= bytes.length) {
    const length = off.getUint32(pos);
    const end = pos + 12 + length;
    if (end > bytes.length) throw badImage();
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === 'IDAT' ? ++dataChunks > MAX_PNG_DATA_CHUNKS : ++otherChunks > MAX_PNG_OTHER_CHUNKS) throw badImage();
    const data = bytes.subarray(pos + 8, end - 4);
    if (crc32(bytes.subarray(pos + 4, end - 4)) !== off.getUint32(end - 4)) throw badImage();
    if (pos === 8 && type !== 'IHDR') throw badImage();
    if (type === 'IHDR') {
      if (pos !== 8 || length !== 13) throw badImage();
      const w = off.getUint32(pos + 8);
      height = off.getUint32(pos + 12);
      const channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!w || !height || w > 2048 || height > 2048 || !channels || data[8] !== 8 || data[10] || data[11] || data[12]) throw badImage();
      stride = w * channels + 1;
    } else if (type === 'IDAT') {
      if (dataEnded) throw badImage();
      pixels.push(data);
      dataSize += length;
    } else if (type === 'IEND') {
      if (length || !dataSize || end !== bytes.length) throw badImage();
      reservePixels(stride * height);
      const scanlines = await inflate(join(pixels, dataSize), 'deflate', stride * height, path);
      for (let i = 0; i < scanlines.length; i += stride) if (scanlines[i] > 4) throw badImage();
      chunksToKeep.push(bytes.subarray(pos, end));
      return join(chunksToKeep, chunksToKeep.reduce((n, b) => n + b.length, 0));
    } else {
      // Ignore common, non-executable metadata. Reject unknown critical chunks and animated PNG.
      if (!['sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP', 'eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'sBIT', 'bKGD'].includes(type)) throw badImage();
      if (dataChunks) dataEnded = true;
    }
    if (type === 'IHDR' || type === 'IDAT') chunksToKeep.push(bytes.subarray(pos, end));
    pos = end;
  }
  throw badImage();
}

function strictJson(text) {
  const scopes = [];
  const pieces = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g;
  const colon = /\s*:/y;
  for (const match of text.matchAll(pieces)) {
    const value = match[0];
    if (value === '{' || value === '[') {
      if (scopes.length >= 24) throw bad('manifest.json: excessive JSON nesting');
      scopes.push(value === '{' ? new Set() : null);
    } else if (value === '}' || value === ']') {
      scopes.pop();
    } else if (scopes.at(-1)) {
      colon.lastIndex = match.index + value.length;
      if (!colon.test(text)) continue;
      const key = JSON.parse(value);
      if (scopes.at(-1).has(key)) throw bad('manifest.json: duplicate object key');
      scopes.at(-1).add(key);
    }
  }
  return JSON.parse(text);
}

export async function readContentArchive(bytes, validate) {
  try {
    const entries = readZip(bytes);
    const raw = await zipBody(entries, 'manifest.json');
    let manifest;
    try {
      manifest = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw bad('manifest.json: invalid UTF-8 JSON');
    }
    const refs = validate(manifest);
    const assets = new Map();
    let pixels = 0;
    const reservePixels = (bytes) => {
      pixels += bytes;
      if (pixels > PIXEL_BYTES_LIMIT) throw bad('package exceeds the 32 MiB decoded PNG limit');
    };
    for (const path of entries.keys()) {
      if (path === 'manifest.json') continue;
      if (!refs.has(path)) throw bad(`${path}: image is not referenced by the manifest`);
      const { id, data } = await readPngAsset(await zipBody(entries, path), path, reservePixels);
      assets.set(path, { id, data });
    }
    return { manifest, assets };
  } catch (err) {
    if (err instanceof RangeError) throw bad('invalid or truncated ZIP');
    throw err;
  }
}

/** The map upload and the ZIP use the same validated, canonical PNG representation. */
export async function readPngAsset(bytes, path, reservePixels = () => {}) {
  if (bytes.length > CONTENT_IMAGE_LIMIT) throw new ActionError('too_big', 'PNG exceeds the image byte limit');
  const clean = await cleanPng(bytes, path, reservePixels);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clean));
  const id = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (let i = 0; i < clean.length; i += 8192) binary += String.fromCharCode(...clean.subarray(i, i + 8192));
  const header = dataView(clean);
  return { id, data: btoa(binary), aspect: header.getUint32(16) / header.getUint32(20) };
}
