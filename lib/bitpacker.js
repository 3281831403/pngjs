"use strict";

let constants = require("./constants");

function packPalette(dataIn, width, height, options) {
  let palette = options.palette;
  let depth = options.bitDepth;

  // map each palette colour to its index, keeping the first occurrence
  let lookup = new Map();
  for (let i = 0; i < palette.length; i++) {
    let entry = palette[i];
    let alpha = entry.length > 3 && entry[3] != null ? entry[3] : 255;
    let key =
      ((entry[0] << 24) | (entry[1] << 16) | (entry[2] << 8) | alpha) >>> 0;
    if (!lookup.has(key)) {
      lookup.set(key, i);
    }
  }

  let inputColorType = options.inputColorType;
  let inBpp = constants.COLORTYPE_TO_BPP_MAP[inputColorType];
  if (inBpp === 4 && !options.inputHasAlpha) {
    inBpp = 3;
  }
  let inputHasAlpha =
    options.inputHasAlpha &&
    (inputColorType === constants.COLORTYPE_COLOR_ALPHA ||
      inputColorType === constants.COLORTYPE_ALPHA);

  let rowBytes = Math.ceil((width * depth) / 8);
  let outData = Buffer.alloc(rowBytes * height);

  let inIndex = 0;
  for (let y = 0; y < height; y++) {
    let bitOffset = 0;
    for (let x = 0; x < width; x++) {
      let red, green, blue;
      let alpha = 255;
      switch (inputColorType) {
        case constants.COLORTYPE_COLOR_ALPHA:
          red = dataIn[inIndex];
          green = dataIn[inIndex + 1];
          blue = dataIn[inIndex + 2];
          if (inputHasAlpha) {
            alpha = dataIn[inIndex + 3];
          }
          break;
        case constants.COLORTYPE_COLOR:
          red = dataIn[inIndex];
          green = dataIn[inIndex + 1];
          blue = dataIn[inIndex + 2];
          break;
        case constants.COLORTYPE_ALPHA:
          red = dataIn[inIndex];
          green = red;
          blue = red;
          alpha = dataIn[inIndex + 1];
          break;
        case constants.COLORTYPE_GRAYSCALE:
          red = dataIn[inIndex];
          green = red;
          blue = red;
          break;
        default:
          throw new Error(
            "input color type:" +
              inputColorType +
              " is not supported at present"
          );
      }

      let key = ((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0;
      let index = lookup.get(key);
      if (index === undefined) {
        throw new Error(
          "color rgba(" +
            red +
            "," +
            green +
            "," +
            blue +
            "," +
            alpha +
            ") not found in palette"
        );
      }

      let bytePos = y * rowBytes + (bitOffset >> 3);
      let shift = 8 - depth - (bitOffset & 7);
      outData[bytePos] |= index << shift;

      inIndex += inBpp;
      bitOffset += depth;
    }
  }

  return outData;
}

module.exports = function (dataIn, width, height, options) {
  if (options.colorType === constants.COLORTYPE_PALETTE_COLOR) {
    return packPalette(dataIn, width, height, options);
  }

  let outHasAlpha =
    [constants.COLORTYPE_COLOR_ALPHA, constants.COLORTYPE_ALPHA].indexOf(
      options.colorType
    ) !== -1;
  if (options.colorType === options.inputColorType) {
    let bigEndian = (function () {
      let buffer = new ArrayBuffer(2);
      new DataView(buffer).setInt16(0, 256, true /* littleEndian */);
      // Int16Array uses the platform's endianness.
      return new Int16Array(buffer)[0] !== 256;
    })();
    // If no need to convert to grayscale and alpha is present/absent in both, take a fast route
    if (options.bitDepth === 8 || (options.bitDepth === 16 && bigEndian)) {
      return dataIn;
    }
  }

  // map to a UInt16 array if data is 16bit, fix endianness below
  let data = options.bitDepth !== 16 ? dataIn : new Uint16Array(dataIn.buffer);

  let maxValue = 255;
  let inBpp = constants.COLORTYPE_TO_BPP_MAP[options.inputColorType];
  if (inBpp === 4 && !options.inputHasAlpha) {
    inBpp = 3;
  }
  let outBpp = constants.COLORTYPE_TO_BPP_MAP[options.colorType];
  if (options.bitDepth === 16) {
    maxValue = 65535;
    outBpp *= 2;
  }
  let outData = Buffer.alloc(width * height * outBpp);

  let inIndex = 0;
  let outIndex = 0;

  let bgColor = options.bgColor || {};
  if (bgColor.red === undefined) {
    bgColor.red = maxValue;
  }
  if (bgColor.green === undefined) {
    bgColor.green = maxValue;
  }
  if (bgColor.blue === undefined) {
    bgColor.blue = maxValue;
  }

  function getRGBA() {
    let red;
    let green;
    let blue;
    let alpha = maxValue;
    switch (options.inputColorType) {
      case constants.COLORTYPE_COLOR_ALPHA:
        alpha = data[inIndex + 3];
        red = data[inIndex];
        green = data[inIndex + 1];
        blue = data[inIndex + 2];
        break;
      case constants.COLORTYPE_COLOR:
        red = data[inIndex];
        green = data[inIndex + 1];
        blue = data[inIndex + 2];
        break;
      case constants.COLORTYPE_ALPHA:
        alpha = data[inIndex + 1];
        red = data[inIndex];
        green = red;
        blue = red;
        break;
      case constants.COLORTYPE_GRAYSCALE:
        red = data[inIndex];
        green = red;
        blue = red;
        break;
      default:
        throw new Error(
          "input color type:" +
            options.inputColorType +
            " is not supported at present"
        );
    }

    if (options.inputHasAlpha) {
      if (!outHasAlpha) {
        alpha /= maxValue;
        red = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
          maxValue
        );
        green = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
          maxValue
        );
        blue = Math.min(
          Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
          maxValue
        );
      }
    }
    return { red: red, green: green, blue: blue, alpha: alpha };
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgba = getRGBA(data, inIndex);

      switch (options.colorType) {
        case constants.COLORTYPE_COLOR_ALPHA:
        case constants.COLORTYPE_COLOR:
          if (options.bitDepth === 8) {
            outData[outIndex] = rgba.red;
            outData[outIndex + 1] = rgba.green;
            outData[outIndex + 2] = rgba.blue;
            if (outHasAlpha) {
              outData[outIndex + 3] = rgba.alpha;
            }
          } else {
            outData.writeUInt16BE(rgba.red, outIndex);
            outData.writeUInt16BE(rgba.green, outIndex + 2);
            outData.writeUInt16BE(rgba.blue, outIndex + 4);
            if (outHasAlpha) {
              outData.writeUInt16BE(rgba.alpha, outIndex + 6);
            }
          }
          break;
        case constants.COLORTYPE_ALPHA:
        case constants.COLORTYPE_GRAYSCALE: {
          // Convert to grayscale and alpha
          let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
          if (options.bitDepth === 8) {
            outData[outIndex] = grayscale;
            if (outHasAlpha) {
              outData[outIndex + 1] = rgba.alpha;
            }
          } else {
            outData.writeUInt16BE(grayscale, outIndex);
            if (outHasAlpha) {
              outData.writeUInt16BE(rgba.alpha, outIndex + 2);
            }
          }
          break;
        }
        default:
          throw new Error("unrecognised color Type " + options.colorType);
      }

      inIndex += inBpp;
      outIndex += outBpp;
    }
  }

  return outData;
};
