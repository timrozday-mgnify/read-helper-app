import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = 1024;
const outDir = "build";
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

mkdirSync(outDir, { recursive: true });

const rgba = Buffer.alloc(size * size * 4);

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const t = (x + y) / (size * 2);
    rgba[i] = Math.round(24 + 24 * t);
    rgba[i + 1] = Math.round(74 + 74 * (1 - t));
    rgba[i + 2] = Math.round(95 + 60 * t);
    rgba[i + 3] = 255;
  }
}

roundedRect(150, 176, 724, 672, 74, [246, 249, 241, 255]);
roundedRect(214, 256, 596, 118, 42, [31, 122, 77, 255]);
roundedRect(214, 452, 596, 118, 42, [53, 107, 140, 255]);
roundedRect(214, 648, 596, 118, 42, [31, 122, 77, 255]);

for (const y of [315, 511, 707]) {
  triangle(724, y - 46, 724, y + 46, 808, y, [246, 249, 241, 255]);
}

const png = encodePng(size, size, rgba);
writeFileSync(`${outDir}/icon.png`, png);
writeFileSync(`${outDir}/icon.ico`, encodeIco(png, size));
writeFileSync(`${outDir}/icon.icns`, encodeIcns(png));
writeFileSync(
  `${outDir}/icon.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#184a5f"/><stop offset="1" stop-color="#305e83"/></linearGradient></defs>
  <rect width="1024" height="1024" rx="180" fill="url(#g)"/>
  <rect x="150" y="176" width="724" height="672" rx="74" fill="#f6f9f1"/>
  <rect x="214" y="256" width="596" height="118" rx="42" fill="#1f7a4d"/><path d="M724 269v92l84-46z" fill="#f6f9f1"/>
  <rect x="214" y="452" width="596" height="118" rx="42" fill="#356b8c"/><path d="M724 465v92l84-46z" fill="#f6f9f1"/>
  <rect x="214" y="648" width="596" height="118" rx="42" fill="#1f7a4d"/><path d="M724 661v92l84-46z" fill="#f6f9f1"/>
</svg>
`
);

function roundedRect(x, y, w, h, r, color) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const dx = xx < x + r ? x + r - xx : xx >= x + w - r ? xx - (x + w - r - 1) : 0;
      const dy = yy < y + r ? y + r - yy : yy >= y + h - r ? yy - (y + h - r - 1) : 0;
      if (dx * dx + dy * dy <= r * r) setPixel(xx, yy, color);
    }
  }
}

function triangle(x1, y1, x2, y2, x3, y3, color) {
  const minX = Math.min(x1, x2, x3);
  const maxX = Math.max(x1, x2, x3);
  const minY = Math.min(y1, y2, y3);
  const maxY = Math.max(y1, y2, y3);
  const area = edge(x1, y1, x2, y2, x3, y3);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w1 = edge(x2, y2, x3, y3, x, y);
      const w2 = edge(x3, y3, x1, y1, x, y);
      const w3 = edge(x1, y1, x2, y2, x, y);
      if ((w1 >= 0 && w2 >= 0 && w3 >= 0) || (w1 <= 0 && w2 <= 0 && w3 <= 0)) {
        if (area !== 0) setPixel(x, y, color);
      }
    }
  }
}

function edge(ax, ay, bx, by, cx, cy) {
  return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
}

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = color[3];
}

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function encodeIco(pngData, width) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = width >= 256 ? 0 : width;
  header[7] = width >= 256 ? 0 : width;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngData.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngData]);
}

function encodeIcns(pngData) {
  const chunkLength = 8 + pngData.length;
  return Buffer.concat([
    Buffer.from("icns"),
    u32(8 + chunkLength),
    Buffer.from("ic10"),
    u32(chunkLength),
    pngData
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const body = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
