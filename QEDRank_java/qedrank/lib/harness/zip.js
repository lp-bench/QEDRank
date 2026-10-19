// Minimal zip reader and writer for Inspect AI's `.eval` logs (a zip of JSON members).
// Reads stored and deflated entries, with zip64 records when a log is large; writes stored
// entries (tests and small fixtures). No dependency beyond node:zlib.

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/** [{ name, method, compressedSize, size, offset }] from the central directory. */
export function listZipEntries(buf) {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === SIG_EOCD64_LOC) {
      const rec = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(rec) !== SIG_EOCD64) throw new Error('bad zip64 end-of-central-directory record');
      count = Number(buf.readBigUInt64LE(rec + 32));
      cdSize = Number(buf.readBigUInt64LE(rec + 40));
      cdOffset = Number(buf.readBigUInt64LE(rec + 48));
    }
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error(`bad central directory entry at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extra field: the 0xffffffff fields above are given here, in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry. */
export function readZipEntry(buf, entry) {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== SIG_LOC) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  // Inspect AI writes its members with Zstandard (method 93); Node 22.15+/24 decompresses it.
  if (entry.method === 93) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error(`${entry.name}: zstd-compressed zip member needs Node 22.15 or newer (or convert the log with \`inspect log convert --to json\`)`);
    return zlib.zstdDecompressSync(data);
  }
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Map name -> () => Buffer for every entry. */
export function openZip(buf) {
  const entries = listZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name) => { const e = byName.get(name); if (!e) throw new Error(`no entry ${name}`); return readZipEntry(buf, e); };
  return { names: entries.map((e) => e.name), has: (name) => byName.has(name), read, text: (name) => read(name).toString('utf8') };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with the given entries ({ name, data: Buffer|string, deflate?: boolean }). */
export function writeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate = false } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(deflate ? 8 : 0, 8);
    loc.writeUInt16LE(0, 10); loc.writeUInt16LE(0, 12); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26); loc.writeUInt16LE(0, 28);
    parts.push(loc, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += loc.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
