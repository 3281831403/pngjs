"use strict";

module.exports = {
  PNG_SIGNATURE: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],

  TYPE_IHDR: 0x49484452,
  TYPE_IEND: 0x49454e44,
  TYPE_IDAT: 0x49444154,
  TYPE_PLTE: 0x504c5445,
  TYPE_tRNS: 0x74524e53, // eslint-disable-line camelcase
  TYPE_gAMA: 0x67414d41, // eslint-disable-line camelcase

  // color-type bits
  COLORTYPE_GRAYSCALE: 0,
  COLORTYPE_PALETTE: 1,
  COLORTYPE_COLOR: 2,
  COLORTYPE_ALPHA: 4, // e.g. grayscale and alpha

  // color-type combinations
  COLORTYPE_PALETTE_COLOR: 3,
  COLORTYPE_COLOR_ALPHA: 6,

  COLORTYPE_TO_BPP_MAP: {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  },

  GAMMA_DIVISION: 100000,

  // PNG scanline filters, see https://www.w3.org/TR/png/#table-selection
  FILTER_NONE: 0,
  FILTER_SUB: 1,
  FILTER_UP: 2,
  FILTER_AVERAGE: 3,
  FILTER_PAETH: 4,

  // Shared error messages so the sync and async code paths stay identical
  ERROR_UNRECOGNISED_FILTER:
    "Unrecognised filter type - only filter types 0-4 are allowed",
  ERROR_INCOMPLETE_DATA:
    "bad png - uncompressed IDAT data is shorter than the image dimensions require",
};
