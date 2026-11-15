"use strict";

let test = require("tape");
let zlib = require("zlib");
let PNG = require("../lib/png").PNG;

const WIDTH = 5;
const HEIGHT = 3;

function buildPalette(alphaAt) {
  let palette = [];
  for (let i = 0; i < 16; i++) {
    palette.push([i * 17, 255 - i * 17, (i * 37) & 0xff, alphaAt(i)]);
  }
  return palette;
}

// every pixel takes a palette colour, cycling so all 16 entries are used
function buildData(palette) {
  let data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    let color = palette[(i * 7) % palette.length];
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = color[3];
  }
  return data;
}

function chunksOf(buffer) {
  let chunks = [];
  let pos = 8;
  while (pos < buffer.length) {
    let length = buffer.readUInt32BE(pos);
    let type = buffer.toString("ascii", pos + 4, pos + 8);
    chunks.push({
      type: type,
      length: length,
      data: buffer.slice(pos + 8, pos + 8 + length),
    });
    pos += 12 + length;
  }
  return chunks;
}

function inflateIDAT(chunks) {
  return zlib.inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data))
  );
}

test("palette pack: sync writes IHDR/PLTE/tRNS/IDAT/IEND", function (t) {
  let palette = buildPalette(() => 255);
  let data = buildData(palette);

  let buffer = PNG.sync.write(
    { width: WIDTH, height: HEIGHT, data: data },
    { colorType: 3, bitDepth: 4, palette: palette, filterType: 0 }
  );

  let chunks = chunksOf(buffer);
  t.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "PLTE", "IDAT", "IEND"],
    "chunk order with an opaque palette"
  );
  t.equal(chunks[0].data[8], 4, "IHDR bit depth is 4");
  t.equal(chunks[0].data[9], 3, "IHDR color type is 3");
  t.equal(chunks[1].length, 3 * palette.length, "PLTE is exactly 3 * N bytes");
  t.end();
});

test("palette pack: filter 0 rows are padded to whole bytes", function (t) {
  [1, 2, 4, 8].forEach(function (bitDepth) {
    let palette = buildPalette(() => 255).slice(
      0,
      Math.min(16, Math.pow(2, bitDepth))
    );
    let data = buildData(palette);

    let buffer = PNG.sync.write(
      { width: WIDTH, height: HEIGHT, data: data },
      { colorType: 3, bitDepth: bitDepth, palette: palette, filterType: 0 }
    );
    let raw = inflateIDAT(chunksOf(buffer));
    let byteWidth = Math.ceil((WIDTH * bitDepth) / 8);

    t.equal(
      raw.length,
      (byteWidth + 1) * HEIGHT,
      "bit depth " + bitDepth + " size"
    );
    for (let y = 0; y < HEIGHT; y++) {
      t.equal(raw[y * (byteWidth + 1)], 0, "row " + y + " filter type 0");
    }
    if (bitDepth < 8) {
      let paddingBits = byteWidth * 8 - WIDTH * bitDepth;
      let rowStart = (HEIGHT - 1) * (byteWidth + 1) + 1;
      let lastByte = raw[rowStart + byteWidth - 1];
      t.equal(
        lastByte & ((1 << paddingBits) - 1),
        0,
        "bit depth " + bitDepth + " pads row end with zeros"
      );
    }
  });
  t.end();
});

test("palette pack: tRNS omitted when every entry is opaque", function (t) {
  let palette = buildPalette(() => 255);
  let data = buildData(palette);

  let buffer = PNG.sync.write(
    { width: WIDTH, height: HEIGHT, data: data },
    { colorType: 3, bitDepth: 4, palette: palette }
  );
  t.equal(
    chunksOf(buffer).filter((c) => c.type === "tRNS").length,
    0,
    "no tRNS chunk"
  );
  t.end();
});

test("palette pack: tRNS is trimmed after the last transparent entry", function (t) {
  let palette = buildPalette((i) => ([3, 5, 9].indexOf(i) !== -1 ? 0x40 : 255));
  let data = buildData(palette);

  let buffer = PNG.sync.write(
    { width: WIDTH, height: HEIGHT, data: data },
    { colorType: 3, bitDepth: 4, palette: palette }
  );
  let trns = chunksOf(buffer).filter((c) => c.type === "tRNS")[0];
  t.ok(trns, "tRNS chunk present");
  t.equal(trns.length, 10, "tRNS ends at the last non-opaque entry");
  t.equal(trns.data[3], 0x40, "entry 3 alpha");
  t.equal(trns.data[5], 0x40, "entry 5 alpha");
  t.equal(trns.data[9], 0x40, "entry 9 alpha");
  t.end();
});

test("palette pack: sync roundtrip at every bit depth", function (t) {
  [1, 2, 4, 8].forEach(function (bitDepth) {
    let count = Math.min(16, Math.pow(2, bitDepth));
    let palette = buildPalette((i) => (i < count && i % 4 === 1 ? 0 : 255));
    palette = palette.slice(0, count);
    let data = buildData(palette);

    let buffer = PNG.sync.write(
      { width: WIDTH, height: HEIGHT, data: data },
      { colorType: 3, bitDepth: bitDepth, palette: palette }
    );
    let parsed = PNG.sync.read(buffer);
    t.equal(parsed.width, WIDTH, "width " + bitDepth);
    t.equal(parsed.height, HEIGHT, "height " + bitDepth);
    t.equal(parsed.depth, bitDepth, "bit depth " + bitDepth);
    t.equal(parsed.colorType, 3, "color type " + bitDepth);
    t.ok(Buffer.compare(parsed.data, data) === 0, "pixels " + bitDepth);
  });
  t.end();
});

test("palette pack: async roundtrip matches sync", function (t) {
  let palette = buildPalette((i) => (i % 3 === 0 ? 128 : 255));
  let data = buildData(palette);

  let png = new PNG({
    width: WIDTH,
    height: HEIGHT,
    colorType: 3,
    bitDepth: 4,
    palette: palette,
  });
  png.data = data;

  let parts = [];
  png
    .pack()
    .on("data", function (chunk) {
      parts.push(chunk);
    })
    .on("end", function () {
      let buffer = Buffer.concat(parts);
      // deflate streams may split the image data across several IDAT chunks
      let order = chunksOf(buffer)
        .map((c) => c.type)
        .filter((type, i, all) => type !== "IDAT" || all[i - 1] !== "IDAT");
      t.deepEqual(
        order,
        ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"],
        "async writes palette chunks"
      );
      let syncBuffer = PNG.sync.write(
        { width: WIDTH, height: HEIGHT, data: data },
        { colorType: 3, bitDepth: 4, palette: palette }
      );
      t.ok(
        Buffer.compare(
          inflateIDAT(chunksOf(buffer)),
          inflateIDAT(chunksOf(syncBuffer))
        ) === 0,
        "sync and async produce the same image data"
      );
      t.ok(
        Buffer.compare(PNG.sync.read(buffer).data, data) === 0,
        "async roundtrip pixels"
      );
      t.end();
    });
});

test("palette pack: rejects colours missing from the palette", function (t) {
  let palette = buildPalette(() => 255);
  let data = buildData(palette);
  data[0] = (data[0] + 1) & 0xff;

  t.throws(
    function () {
      PNG.sync.write(
        { width: WIDTH, height: HEIGHT, data: data },
        { colorType: 3, bitDepth: 4, palette: palette }
      );
    },
    /not found in palette/,
    "missing colour throws"
  );
  t.end();
});

test("palette pack: rejects a palette larger than the bit depth allows", function (t) {
  let palette = [];
  for (let i = 0; i < 17; i++) {
    palette.push([i, i, i, 255]);
  }
  let data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    data[i * 4] = 1;
    data[i * 4 + 1] = 1;
    data[i * 4 + 2] = 1;
    data[i * 4 + 3] = 255;
  }

  [1, 2, 4].forEach(function (bitDepth) {
    let tooLarge = palette.slice(0, Math.pow(2, bitDepth) + 1);
    t.throws(
      function () {
        PNG.sync.write(
          { width: WIDTH, height: HEIGHT, data: data },
          { colorType: 3, bitDepth: bitDepth, palette: tooLarge }
        );
      },
      /only allows/,
      "bit depth " + bitDepth + " rejects " + tooLarge.length + " entries"
    );
  });
  t.end();
});
