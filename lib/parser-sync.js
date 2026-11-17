"use strict";

let hasSyncZlib = true;
let zlib = require("zlib");
let inflateSync = require("./sync-inflate");
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
let SyncReader = require("./sync-reader");
let FilterSync = require("./filter-parse-sync");
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

function getExpectedDataSize(metaData) {
  if (!metaData.interlace) {
    return (
      (getByteWidth(metaData.width, metaData.bpp, metaData.depth) + 1) *
      metaData.height
    );
  }

  let interlaceUtils = require("./interlace");
  let passes = interlaceUtils.getImagePasses(metaData.width, metaData.height);
  let size = 0;
  for (let i = 0; i < passes.length; i++) {
    size +=
      (getByteWidth(passes[i].width, metaData.bpp, metaData.depth) + 1) *
      passes[i].height;
  }
  return size;
}

module.exports = function (buffer, options) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  let err;
  function handleError(_err_) {
    err = _err_;
    reader._fatalError = _err_;
  }

  let metaData;
  function handleMetaData(_metaData_) {
    metaData = _metaData_;
  }

  function handleTransColor(transColor) {
    metaData.transColor = transColor;
  }

  function handlePalette(palette) {
    metaData.palette = palette;
  }

  function handleSimpleTransparency() {
    metaData.alpha = true;
  }

  let gamma;
  function handleGamma(_gamma_) {
    gamma = _gamma_;
  }

  let inflateDataList = [];
  function handleInflateData(inflatedData) {
    inflateDataList.push(inflatedData);
  }

  let reader = new SyncReader(buffer);

  let parser = new Parser(options, {
    read: reader.read.bind(reader),
    error: handleError,
    metadata: handleMetaData,
    gamma: handleGamma,
    palette: handlePalette,
    transColor: handleTransColor,
    inflateData: handleInflateData,
    simpleTransparency: handleSimpleTransparency,
  });

  parser.start();
  reader.process();

  if (err) {
    throw err;
  }

  //join together the inflate datas
  let inflateData = Buffer.concat(inflateDataList);
  inflateDataList.length = 0;

  let inflatedData;
  let imageSize = getExpectedDataSize(metaData);
  if (metaData.interlace) {
    inflatedData = zlib.inflateSync(inflateData);
  } else {
    inflatedData = inflateSync(inflateData, {
      chunkSize: imageSize,
      maxLength: imageSize,
    });
  }
  inflateData = null;

  if (!inflatedData || !inflatedData.length) {
    throw new Error("bad png - invalid inflate data response");
  }

  // Truncated uploads can leave the zlib stream short of a full raster.
  // The custom inflater zero-pads up to maxLength, so check the actual
  // length here instead of silently decoding transparent-black rows.
  if (inflatedData.length !== imageSize) {
    throw new Error(constants.ERROR_INCOMPLETE_DATA);
  }

  let unfilteredData = FilterSync.process(inflatedData, metaData);
  inflateData = null;

  let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
  unfilteredData = null;

  let normalisedBitmapData = formatNormaliser(
    bitmapData,
    metaData,
    options.skipRescale
  );

  metaData.data = normalisedBitmapData;
  metaData.gamma = gamma || 0;

  return metaData;
};
