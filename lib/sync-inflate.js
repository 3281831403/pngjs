"use strict";

let assert = require("assert").ok;
let zlib = require("zlib");
let util = require("util");

let kMaxLength = require("buffer").kMaxLength;

function Inflate(opts) {
  if (!(this instanceof Inflate)) {
    return new Inflate(opts);
  }

  if (opts && opts.chunkSize < zlib.Z_MIN_CHUNK) {
    opts.chunkSize = zlib.Z_MIN_CHUNK;
  }

  zlib.Inflate.call(this, opts);

  // Node 8 --> 9 compatibility check
  this._offset = this._offset === undefined ? this._outOffset : this._offset;
  this._buffer = this._buffer || this._outBuffer;

  if (opts && opts.maxLength != null) {
    this._maxLength = opts.maxLength;
  }

  // Modern Node versions report native zlib failures through a private
  // symbol rather than the legacy _hadError flag this wrapper used to
  // rely on. The native handle's onerror still fires synchronously inside
  // writeSync, so capture it here to keep the sync API able to throw.
  // The no-op listener stops the default handler from turning the same
  // failure into an unhandled "error" event on a later tick.
  this._syncError = null;
  this.on("error", function (err) {
    this._syncError = err;
  });
  if (this._handle && this._handle.onerror) {
    let nativeOnError = this._handle.onerror;
    let engine = this;
    this._handle.onerror = function (message, errno, code) {
      engine._syncError = new Error(message);
      engine._syncError.errno = errno;
      engine._syncError.code = code;
      if (typeof nativeOnError === "function") {
        nativeOnError.apply(this, arguments);
      }
    };
  }
}

function createInflate(opts) {
  return new Inflate(opts);
}

function _close(engine, callback) {
  if (callback) {
    process.nextTick(callback);
  }

  // Caller may invoke .close after a zlib error (which will null _handle).
  if (!engine._handle) {
    return;
  }

  engine._handle.close();
  engine._handle = null;
}

Inflate.prototype._processChunk = function (chunk, flushFlag, asyncCb) {
  if (typeof asyncCb === "function") {
    return zlib.Inflate._processChunk.call(this, chunk, flushFlag, asyncCb);
  }

  let self = this;

  let availInBefore = chunk && chunk.length;
  let availOutBefore = this._chunkSize - this._offset;
  let leftToInflate = this._maxLength;
  let inOff = 0;

  let buffers = [];
  let nread = 0;

  function handleChunk(availInAfter, availOutAfter) {
    if (self._hadError || self._syncError) {
      return;
    }

    // Normally have is the output space consumed by this write. However
    // the native binding signals an early stream end (truncated deflate
    // input) by returning a non-zero first state value while the second
    // is zero: that non-zero value is then the amount of *output* space
    // left unused, not remaining input. Using it blindly would count the
    // untouched, zero-filled tail of the buffer as inflated data.
    let have = availOutBefore - availOutAfter;
    let streamEndedEarly = availOutAfter === 0 && availInAfter > 0;
    if (streamEndedEarly) {
      have = availOutBefore - availInAfter;
    }
    assert(have >= 0, "have should not go down");

    if (have > 0) {
      let out = self._buffer.slice(self._offset, self._offset + have);
      self._offset += have;

      if (out.length > leftToInflate) {
        out = out.slice(0, leftToInflate);
      }

      buffers.push(out);
      nread += out.length;
      leftToInflate -= out.length;

      if (leftToInflate === 0) {
        return false;
      }
    }

    if (availOutAfter === 0 || self._offset >= self._chunkSize) {
      availOutBefore = self._chunkSize;
      self._offset = 0;
      self._buffer = Buffer.allocUnsafe(self._chunkSize);
    }

    if (availOutAfter === 0) {
      // Stream ended with output space to spare: no real input remains to
      // reprocess, so stop and let the caller validate the output length.
      if (streamEndedEarly) {
        return false;
      }

      inOff += availInBefore - availInAfter;
      availInBefore = availInAfter;

      return true;
    }

    // availOutAfter > 0: the stream stopped with output space to spare.
    return false;
  }

  assert(this._handle, "zlib binding closed");
  let res;
  do {
    res = this._handle.writeSync(
      flushFlag,
      chunk, // in
      inOff, // in_off
      availInBefore, // in_len
      this._buffer, // out
      this._offset, //out_off
      availOutBefore
    ); // out_len
    // Node 8 --> 9 compatibility check
    res = res || this._writeState;

    // Native failures (e.g. a cut-off deflate stream) are reported
    // synchronously by the handle and captured in the constructor.
    if (this._syncError || this._hadError) {
      throw this._syncError || new Error("unexpected end of file");
    }
  } while (handleChunk(res[0], res[1]));

  if (this._syncError || this._hadError) {
    throw this._syncError || new Error("unexpected end of file");
  }

  if (nread >= kMaxLength) {
    _close(this);
    throw new RangeError(
      "Cannot create final Buffer. It would be larger than 0x" +
        kMaxLength.toString(16) +
        " bytes"
    );
  }

  // Buffer.concat would grow the result back up to the last chunk buffer's
  // size; when the stream ends before maxLength is reached the unused tail
  // is just zero-filled memory, not inflated data. Slice down to the bytes
  // that were actually produced so callers can detect truncated input by
  // length instead of silently decoding zero-filled scanlines.
  let buf = Buffer.concat(buffers, nread).slice(0, nread);
  _close(this);

  return buf;
};

util.inherits(Inflate, zlib.Inflate);

function zlibBufferSync(engine, buffer) {
  if (typeof buffer === "string") {
    buffer = Buffer.from(buffer);
  }
  if (!(buffer instanceof Buffer)) {
    throw new TypeError("Not a string or buffer");
  }

  let flushFlag = engine._finishFlushFlag;
  if (flushFlag == null) {
    flushFlag = zlib.Z_FINISH;
  }

  return engine._processChunk(buffer, flushFlag);
}

function inflateSync(buffer, opts) {
  return zlibBufferSync(new Inflate(opts), buffer);
}

module.exports = exports = inflateSync;
exports.Inflate = Inflate;
exports.createInflate = createInflate;
exports.inflateSync = inflateSync;
