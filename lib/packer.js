"use strict";

let constants = require("./constants");
let CrcStream = require("./crc");
let bitPacker = require("./bitpacker");
let filter = require("./filter-pack");
let zlib = require("zlib");

let Packer = (module.exports = function (options) {
  this._options = options;

  options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
  options.deflateLevel =
    options.deflateLevel != null ? options.deflateLevel : 9;
  options.deflateStrategy =
    options.deflateStrategy != null ? options.deflateStrategy : 3;
  options.inputHasAlpha =
    options.inputHasAlpha != null ? options.inputHasAlpha : true;
  options.deflateFactory = options.deflateFactory || zlib.createDeflate;
  options.bitDepth = options.bitDepth || 8;
  // This is outputColorType
  options.colorType =
    typeof options.colorType === "number"
      ? options.colorType
      : constants.COLORTYPE_COLOR_ALPHA;
  options.inputColorType =
    typeof options.inputColorType === "number"
      ? options.inputColorType
      : constants.COLORTYPE_COLOR_ALPHA;

  if (
    [
      constants.COLORTYPE_GRAYSCALE,
      constants.COLORTYPE_COLOR,
      constants.COLORTYPE_PALETTE_COLOR,
      constants.COLORTYPE_COLOR_ALPHA,
      constants.COLORTYPE_ALPHA,
    ].indexOf(options.colorType) === -1
  ) {
    throw new Error(
      "option color type:" + options.colorType + " is not supported at present"
    );
  }
  if (
    [
      constants.COLORTYPE_GRAYSCALE,
      constants.COLORTYPE_COLOR,
      constants.COLORTYPE_COLOR_ALPHA,
      constants.COLORTYPE_ALPHA,
    ].indexOf(options.inputColorType) === -1
  ) {
    throw new Error(
      "option input color type:" +
        options.inputColorType +
        " is not supported at present"
    );
  }
  if (options.colorType === constants.COLORTYPE_PALETTE_COLOR) {
    if (
      options.bitDepth !== 1 &&
      options.bitDepth !== 2 &&
      options.bitDepth !== 4 &&
      options.bitDepth !== 8
    ) {
      throw new Error(
        "option bit depth:" + options.bitDepth + " is not supported at present"
      );
    }
    if (!Array.isArray(options.palette)) {
      throw new Error(
        "option palette is required and must be an array of [r,g,b,a] entries"
      );
    }
    if (options.palette.length === 0) {
      throw new Error("option palette must contain at least one entry");
    }
    if (options.palette.length > Math.pow(2, options.bitDepth)) {
      throw new Error(
        "palette has " +
          options.palette.length +
          " entries but bit depth " +
          options.bitDepth +
          " only allows " +
          Math.pow(2, options.bitDepth)
      );
    }
  } else if (options.bitDepth !== 8 && options.bitDepth !== 16) {
    throw new Error(
      "option bit depth:" + options.bitDepth + " is not supported at present"
    );
  }
});

Packer.prototype.getDeflateOptions = function () {
  return {
    chunkSize: this._options.deflateChunkSize,
    level: this._options.deflateLevel,
    strategy: this._options.deflateStrategy,
  };
};

Packer.prototype.createDeflate = function () {
  return this._options.deflateFactory(this.getDeflateOptions());
};

Packer.prototype.isPalette = function () {
  return this._options.colorType === constants.COLORTYPE_PALETTE_COLOR;
};

Packer.prototype.filterData = function (data, width, height) {
  // convert to correct format for filtering (e.g. right bpp and bit depth)
  let packedData = bitPacker(data, width, height, this._options);

  // filter pixel data
  let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
  let filteredData = filter(packedData, width, height, this._options, bpp);
  return filteredData;
};

Packer.prototype._packChunk = function (type, data) {
  let len = data ? data.length : 0;
  let buf = Buffer.alloc(len + 12);

  buf.writeUInt32BE(len, 0);
  buf.writeUInt32BE(type, 4);

  if (data) {
    data.copy(buf, 8);
  }

  buf.writeInt32BE(
    CrcStream.crc32(buf.slice(4, buf.length - 4)),
    buf.length - 4
  );
  return buf;
};

Packer.prototype.packGAMA = function (gamma) {
  let buf = Buffer.alloc(4);
  buf.writeUInt32BE(Math.floor(gamma * constants.GAMMA_DIVISION), 0);
  return this._packChunk(constants.TYPE_gAMA, buf);
};

Packer.prototype._paletteEntry = function (entry, index) {
  if (!Array.isArray(entry) || entry.length < 3) {
    throw new Error("palette entry " + index + " must be an [r,g,b,a] array");
  }
  let red = entry[0];
  let green = entry[1];
  let blue = entry[2];
  let alpha = entry.length > 3 && entry[3] != null ? entry[3] : 255;
  let values = [red, green, blue, alpha];
  for (let i = 0; i < values.length; i++) {
    if (
      typeof values[i] !== "number" ||
      values[i] < 0 ||
      values[i] > 255 ||
      values[i] !== Math.floor(values[i])
    ) {
      throw new Error(
        "palette entry " +
          index +
          " has invalid " +
          ["red", "green", "blue", "alpha"][i] +
          " value " +
          values[i]
      );
    }
  }
  return [red, green, blue, alpha];
};

Packer.prototype.packPLTE = function () {
  let entries = this._options.palette.map(this._paletteEntry);
  let buf = Buffer.alloc(entries.length * 3);
  for (let i = 0; i < entries.length; i++) {
    buf[i * 3] = entries[i][0];
    buf[i * 3 + 1] = entries[i][1];
    buf[i * 3 + 2] = entries[i][2];
  }
  return this._packChunk(constants.TYPE_PLTE, buf);
};

Packer.prototype.packTRNS = function () {
  let entries = this._options.palette.map(this._paletteEntry);
  let lastTransparent = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][3] !== 255) {
      lastTransparent = i;
    }
  }
  if (lastTransparent === -1) {
    return null;
  }
  let buf = Buffer.alloc(lastTransparent + 1);
  for (let i = 0; i <= lastTransparent; i++) {
    buf[i] = entries[i][3];
  }
  return this._packChunk(constants.TYPE_tRNS, buf);
};

Packer.prototype.packIHDR = function (width, height) {
  let buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = this._options.bitDepth; // Bit depth
  buf[9] = this._options.colorType; // colorType
  buf[10] = 0; // compression
  buf[11] = 0; // filter
  buf[12] = 0; // interlace

  return this._packChunk(constants.TYPE_IHDR, buf);
};

Packer.prototype.packIDAT = function (data) {
  return this._packChunk(constants.TYPE_IDAT, data);
};

Packer.prototype.packIEND = function () {
  return this._packChunk(constants.TYPE_IEND, null);
};
