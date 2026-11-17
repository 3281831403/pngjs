"use strict";

let test = require("tape");
let zlib = require("zlib");
let stream = require("stream");
let PNG = require("../lib/png").PNG;

// ---------------------------------------------------------------------------
// Fixture builders: minimal valid/corrupt PNG buffers constructed by hand so
// the tests do not depend on external binary fixtures.
// ---------------------------------------------------------------------------

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  let length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  let typeBuf = Buffer.from(type, "ascii");
  let crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

let SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width, height, colorType, depth) {
  colorType = colorType === undefined ? 6 : colorType;
  depth = depth === undefined ? 8 : depth;
  let data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth; // bit depth
  data[9] = colorType;
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return chunk("IHDR", data);
}

function idat(rawRaster) {
  return chunk("IDAT", zlib.deflateSync(rawRaster));
}

function iend() {
  return chunk("IEND", Buffer.alloc(0));
}

// RGBA (color type 6, 8-bit) raw raster: filter byte + width*4 bytes per row.
function rgbaRaster(width, height, fillByte) {
  let rowSize = width * 4 + 1;
  let buf = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    buf[y * rowSize] = 0; // filter: none
    for (let x = 0; x < width * 4; x++) {
      buf[y * rowSize + 1 + x] = fillByte;
    }
  }
  return buf;
}

function validPng() {
  return Buffer.concat([
    SIGNATURE,
    ihdr(8, 8, 6, 8),
    idat(rgbaRaster(8, 8, 0xab)),
    iend(),
  ]);
}

// 8x8 header but the IDAT only carries 3 of the 8 scanlines.
function truncatedRasterPng() {
  return Buffer.concat([
    SIGNATURE,
    ihdr(8, 8, 6, 8),
    idat(rgbaRaster(8, 3, 0xab)),
    iend(),
  ]);
}

// A complete image whose compressed zlib stream is cut in half.
function cutStreamPng() {
  let compressed = zlib.deflateSync(rgbaRaster(8, 8, 0xab));
  return Buffer.concat([
    SIGNATURE,
    ihdr(8, 8, 6, 8),
    chunk("IDAT", compressed.slice(0, Math.floor(compressed.length / 2))),
    iend(),
  ]);
}

// First scanline declares filter type 5, which is not defined by the spec.
function invalidFilterPng() {
  let raster = rgbaRaster(8, 8, 0xab);
  raster[0] = 5;
  return Buffer.concat([SIGNATURE, ihdr(8, 8, 6, 8), idat(raster), iend()]);
}

// Two IHDR chunks; the second one claims smaller dimensions.
function duplicateIhdrPng() {
  return Buffer.concat([
    SIGNATURE,
    ihdr(8, 8, 6, 8),
    ihdr(4, 4, 6, 8),
    idat(rgbaRaster(8, 8, 0xab)),
    iend(),
  ]);
}

function zeroWidthPng() {
  return Buffer.concat([
    SIGNATURE,
    ihdr(0, 8, 6, 8),
    idat(Buffer.alloc(0)),
    iend(),
  ]);
}

// color type 6 (RGBA) already has alpha, so a tRNS chunk is illegal.
function rgbaWithTrnsPng() {
  return Buffer.concat([
    SIGNATURE,
    ihdr(8, 8, 6, 8),
    chunk("tRNS", Buffer.alloc(6)),
    idat(rgbaRaster(8, 8, 0xab)),
    iend(),
  ]);
}

function parseAsync(buffer, cb) {
  let bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  let png = new PNG({});
  png.on("error", function (err) {
    cb(err);
  });
  png.on("parsed", function () {
    cb(null, png);
  });
  bufferStream.pipe(png);
}

function parseSync(buffer) {
  return PNG.sync.read(buffer);
}

// Run the same malformed buffer through both code paths and assert the
// thrown/emitted error messages are byte-for-byte identical.
function assertRejectsBoth(t, buffer, label) {
  let syncMessage;
  try {
    parseSync(buffer);
    t.fail(label + " (sync): expected an error but the image decoded");
    syncMessage = null;
  } catch (err) {
    t.ok(err instanceof Error, label + " (sync): throws an Error");
    syncMessage = err.message;
  }

  parseAsync(buffer, function (err) {
    t.ok(err instanceof Error, label + " (async): emits an Error");
    t.equal(
      err.message,
      syncMessage,
      label + ": sync and async messages are identical"
    );
  });
}

test("malformed PNGs are rejected by sync and async with the same message", function (t) {
  let cases = [
    ["truncated raster (3 of 8 rows)", truncatedRasterPng()],
    ["cut-off zlib stream", cutStreamPng()],
    ["invalid scanline filter type 5", invalidFilterPng()],
    ["duplicate IHDR chunk", duplicateIhdrPng()],
    ["zero-width IHDR", zeroWidthPng()],
    ["tRNS chunk on RGBA (color type 6)", rgbaWithTrnsPng()],
  ];

  t.plan(cases.length * 3);
  cases.forEach(function (entry) {
    assertRejectsBoth(t, entry[1], entry[0]);
  });
});

test("a truncated raster never comes back zero-padded", function (t) {
  t.throws(
    function () {
      parseSync(truncatedRasterPng());
    },
    /shorter than the image dimensions require/,
    "sync decoding refuses the short raster"
  );

  parseAsync(truncatedRasterPng(), function (err) {
    t.ok(err, "async decoding refuses the short raster");
    t.match(
      err.message,
      /shorter than the image dimensions require/,
      "async reports the same short-data error"
    );
    t.end();
  });
});

test("only scanline filter types 0-4 are accepted", function (t) {
  t.throws(
    function () {
      parseSync(invalidFilterPng());
    },
    /filter types 0-4/,
    "sync rejects filter type 5"
  );

  parseAsync(invalidFilterPng(), function (err) {
    t.match(err.message, /filter types 0-4/, "async rejects filter type 5");
    t.end();
  });
});

test("a valid 8x8 RGBA PNG decodes to the exact expected bytes", function (t) {
  let buffer = validPng();

  let syncResult = parseSync(buffer);
  t.equal(syncResult.width, 8, "sync width");
  t.equal(syncResult.height, 8, "sync height");
  t.equal(
    syncResult.data.length,
    8 * 8 * 4,
    "sync produces one RGBA byte per channel"
  );

  parseAsync(buffer, function (err, asyncResult) {
    t.error(err, "async decoding succeeds");
    t.equal(asyncResult.width, 8, "async width");
    t.equal(asyncResult.height, 8, "async height");
    t.ok(
      asyncResult.data.equals(syncResult.data),
      "sync and async produce identical pixel data"
    );

    // every source byte was 0xab, so R/G/B/A are 0xab everywhere
    let expectedPixel = Buffer.from([0xab, 0xab, 0xab, 0xab]);
    let pixelOk = true;
    for (let i = 0; i < syncResult.data.length; i += 4) {
      if (!syncResult.data.slice(i, i + 4).equals(expectedPixel)) {
        pixelOk = false;
        break;
      }
    }
    t.ok(pixelOk, "every pixel matches the source bytes exactly");
    t.end();
  });
});

test("async decoding never crashes the process on malformed input", function (t) {
  let uncaught = [];
  function onUncaught(err) {
    uncaught.push(err);
  }
  process.on("uncaughtException", onUncaught);

  let buffers = [
    truncatedRasterPng(),
    cutStreamPng(),
    invalidFilterPng(),
    duplicateIhdrPng(),
    zeroWidthPng(),
    rgbaWithTrnsPng(),
  ];

  let remaining = buffers.length;
  buffers.forEach(function (buffer) {
    parseAsync(buffer, function (err) {
      t.ok(err instanceof Error, "error delivered as an event, not a throw");
      remaining -= 1;
      if (remaining === 0) {
        process.removeListener("uncaughtException", onUncaught);
        t.equal(
          uncaught.length,
          0,
          "no uncaughtException escaped from the decoder"
        );
        t.end();
      }
    });
  });
});
