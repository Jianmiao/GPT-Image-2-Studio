'use strict';
/** 极简 PNG 编码器（仅供本地测试伪造图片用） */
const zlib = require('zlib');

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 生成一张带渐变、网格与编号的测试图（可当"假成片"看） */
function makePng(width = 64, height = 64, opts = {}) {
  const seed = opts.seed || 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1 || 1);
      const v = y / (height - 1 || 1);
      const glow = Math.max(0, 1 - Math.hypot(u - 0.35 - 0.1 * (seed % 3), v - 0.4) * 1.6);
      raw[o++] = Math.round(20 + 235 * glow * (0.55 + 0.45 * u));
      raw[o++] = Math.round(18 + 180 * glow * (0.4 + 0.5 * v) + 30 * u);
      raw[o++] = Math.round(30 + 150 * glow * (0.7 - 0.3 * v) + 40 * (1 - u));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { makePng };
