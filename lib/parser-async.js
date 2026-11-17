"use strict";

let util = require("util");
let zlib = require("zlib");
let ChunkStream = require("./chunkstream");
let FilterAsync = require("./filter-parse-async");
let Parser = require("./parser");
let bitmapper = require("./bitmapper");
let formatNormaliser = require("./format-normaliser");
let constants = require("./constants");

function getByteWidth(width, bpp, depth) {
  let byteWidth = width * bpp;
  if (depth !== 8) {
    byteWidth = Math.ceil(byteWidth / (8 / depth));
  }
  return byteWidth;
}

function getExpectedDataSize(bitmapInfo) {
  if (!bitmapInfo.interlace) {
    return (
      (getByteWidth(bitmapInfo.width, bitmapInfo.bpp, bitmapInfo.depth) + 1) *
      bitmapInfo.height
    );
  }

  let interlaceUtils = require("./interlace");
  let passes = interlaceUtils.getImagePasses(
    bitmapInfo.width,
    bitmapInfo.height
  );
  let size = 0;
  for (let i = 0; i < passes.length; i++) {
    size +=
      (getByteWidth(passes[i].width, bitmapInfo.bpp, bitmapInfo.depth) + 1) *
      passes[i].height;
  }
  return size;
}

let ParserAsync = (module.exports = function (options) {
  ChunkStream.call(this);

  this._parser = new Parser(options, {
    read: this.read.bind(this),
    error: this._handleError.bind(this),
    metadata: this._handleMetaData.bind(this),
    gamma: this.emit.bind(this, "gamma"),
    palette: this._handlePalette.bind(this),
    transColor: this._handleTransColor.bind(this),
    finished: this._finished.bind(this),
    inflateData: this._inflateData.bind(this),
    simpleTransparency: this._simpleTransparency.bind(this),
    headersFinished: this._headersFinished.bind(this),
  });
  this._options = options;
  this.writable = true;

  this._parser.start();
});
util.inherits(ParserAsync, ChunkStream);

ParserAsync.prototype._handleError = function (err) {
  this.emit("error", err);

  this.writable = false;

  this.destroy();

  if (this._inflate && this._inflate.destroy) {
    this._inflate.destroy();
  }

  if (this._filter) {
    this._filter.destroy();
    // For backward compatibility with Node 7 and below.
    // Suppress errors due to _inflate calling write() even after
    // it's destroy()'ed.
    this._filter.on("error", function () {});
  }

  this.errord = true;
};

ParserAsync.prototype._inflateData = function (data) {
  if (!this._inflate) {
    let imageSize = getExpectedDataSize(this._bitmapInfo);
    this._inflateBytes = 0;

    if (this._bitmapInfo.interlace) {
      this._inflate = zlib.createInflate();

      this._inflate.on("error", this.emit.bind(this, "error"));
      this._filter.on("complete", this._complete.bind(this));

      let filterWrite = this._filter.write.bind(this._filter);
      this._inflate.on("data", (chunk) => {
        if (this.errord) {
          return;
        }
        this._inflateBytes += chunk.length;
        filterWrite(chunk);
      });

      // A truncated zlib stream still ends; check how much raster data
      // was actually inflated instead of decoding zero-filled passes.
      this._inflate.on("end", () => {
        if (this.errord) {
          return;
        }
        if (this._inflateBytes !== imageSize) {
          this._handleError(new Error(constants.ERROR_INCOMPLETE_DATA));
          return;
        }
        this._filter.end();
      });
    } else {
      let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);

      this._inflate = zlib.createInflate({ chunkSize: chunkSize });
      let leftToInflate = imageSize;

      let emitError = this.emit.bind(this, "error");
      this._inflate.on("error", function (err) {
        if (!leftToInflate) {
          return;
        }

        emitError(err);
      });
      this._filter.on("complete", this._complete.bind(this));

      let filterWrite = this._filter.write.bind(this._filter);
      this._inflate.on("data", (chunk) => {
        if (!leftToInflate) {
          return;
        }

        if (chunk.length > leftToInflate) {
          chunk = chunk.slice(0, leftToInflate);
        }

        leftToInflate -= chunk.length;

        filterWrite(chunk);
      });

      // The inflate stream can end cleanly even when the upload was
      // truncated: the remaining rows simply never arrive. Surface that
      // as an error on the PNG rather than an unhandled stream error or
      // a half-decoded image.
      this._inflate.on("end", () => {
        if (this.errord) {
          return;
        }
        if (leftToInflate) {
          this._handleError(new Error(constants.ERROR_INCOMPLETE_DATA));
          return;
        }
        this._filter.end();
      });
    }
  }
  this._inflate.write(data);
};

ParserAsync.prototype._handleMetaData = function (metaData) {
  this._metaData = metaData;
  this._bitmapInfo = Object.create(metaData);

  this._filter = new FilterAsync(this._bitmapInfo);
  // Filter errors (e.g. an invalid scanline filter byte or an
  // unexpected end of input) must be delivered on the PNG stream,
  // never as an uncaughtException.
  this._filter.on("error", this._handleError.bind(this));
};

ParserAsync.prototype._handleTransColor = function (transColor) {
  this._bitmapInfo.transColor = transColor;
};

ParserAsync.prototype._handlePalette = function (palette) {
  this._bitmapInfo.palette = palette;
};

ParserAsync.prototype._simpleTransparency = function () {
  this._metaData.alpha = true;
};

ParserAsync.prototype._headersFinished = function () {
  // Up until this point, we don't know if we have a tRNS chunk (alpha)
  // so we can't emit metadata any earlier
  this.emit("metadata", this._metaData);
};

ParserAsync.prototype._finished = function () {
  if (this.errord) {
    return;
  }

  if (!this._inflate) {
    this.emit("error", "No Inflate block");
  } else {
    // no more data to inflate
    this._inflate.end();
  }
};

ParserAsync.prototype._complete = function (filteredData) {
  if (this.errord) {
    return;
  }

  let normalisedBitmapData;

  try {
    let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);

    normalisedBitmapData = formatNormaliser(
      bitmapData,
      this._bitmapInfo,
      this._options.skipRescale
    );
    bitmapData = null;
  } catch (ex) {
    this._handleError(ex);
    return;
  }

  this.emit("parsed", normalisedBitmapData);
};
