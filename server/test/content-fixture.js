import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

function chunk(name, bytes) {
  const out = Buffer.alloc(12 + bytes.length);
  out.writeUInt32BE(bytes.length);
  out.write(name, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}

export function fixturePng(width, height, scanlines, { rgba = false, chunkSize = Infinity, comment } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = rgba ? 6 : 2;
  const pieces = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (comment) pieces.push(chunk('tEXt', Buffer.from(`Comment\0${comment}`)));
  const data = deflateSync(scanlines);
  for (let i = 0; i < data.length; i += chunkSize) pieces.push(chunk('IDAT', data.subarray(i, i + chunkSize)));
  pieces.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(pieces);
}

/** Tiny, structurally valid RGB PNG for transport tests. */
export function samplePng(red, green, blue) {
  return fixturePng(1, 1, Buffer.from([0, red, green, blue]), { comment: 'Discard this metadata' });
}

/** Produces the two V1 compression methods, without relying on an external ZIP CLI. */
export function zipEntries(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, source, deflate = false] of entries) {
    const path = Buffer.from(name);
    const bytes = Buffer.from(source);
    const payload = deflate ? deflateRawSync(bytes) : bytes;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, payload);
    directory.push(central, path);
    offset += local.length + path.length + payload.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((n, x) => n + x.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

export const sampleManifest = () => ({
  format: 'THE_SYSTEM_CONTENT_V1',
  entities: [
    { type: 'monster', id: 'zip_lantern_guard', name: 'Lantern Guard', hpSlots: 4, evade: 1, dr: 0,
      attacks: [{ name: 'Lantern Bash', toHit: 9, damage: '1d4' }],
      image: 'images/guard.png', variants: ['images/guard_echo.png', 'images/guard_silver.png'], lootItems: ['zip_salve'] },
    { type: 'boss', id: 'zip_clockwork_keeper', name: 'Clockwork Keeper', hpSlots: 15, evade: 3, dr: 0,
      attacks: [{ name: 'Pendulum', toHit: 35, damage: '2' }, { name: 'Overwind', toHit: 30, damage: '1d6' }],
      phases: [{ name: 'Measured stance', image: 'images/guard_silver.png' }, { name: 'Overwound', atHp: 7, image: 'images/keeper_absent.png' }] },
    { type: 'npc', id: 'zip_scavenger', name: 'The Clock Scavenger' },
    { type: 'item', id: 'zip_salve', name: 'Copper Salve', rarity: 'common', stackable: true },
  ],
});
export const sampleZip = (manifest = sampleManifest(), extra = []) => zipEntries([
  ['manifest.json', JSON.stringify(manifest), true],
  ['images/guard.png', samplePng(190, 127, 29)],
  ['images/guard_echo.png', samplePng(35, 180, 170), true],
  ['images/guard_silver.png', samplePng(180, 180, 200)],
  ...extra,
]);
