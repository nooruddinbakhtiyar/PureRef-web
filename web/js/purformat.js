/*
 * purformat.js - read and write PureRef (1.10 / 1.11.1) .pur files in the browser.
 *
 * JavaScript port of the Python `purformat` module (purformat/*.py). Given the same PurFile,
 * writePurFile() produces exactly the same bytes as purformat/write.py, except that text attached to
 * images and nested text get their own IDs (see PurFile.countTextItems).
 *
 * Works as a plain <script> (exposes `PurFormat` on window) or as a CommonJS module (Node, for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PurFormat = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GRAPHICS_IMAGE_ITEM = 34; // byte length of "GraphicsImageItem" in UTF-16
  const GRAPHICS_TEXT_ITEM = 32; // byte length of "GraphicsTextItem" in UTF-16
  const HEADER_SIZE = 224;
  const MAX_HEADER_COUNT = 0xffff; // item counts are stored as u16 in the header

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Items (purformat/items.py)
  ////////////////////////////////////////////////////////////////////////////////////////////////

  // Abstract item class
  class Item {
    constructor() {
      this.id = 0;
      this.zLayer = 1.0;
      this.matrix = [1.0, 0.0, 0.0, 1.0];
      this.x = 0.0;
      this.y = 0.0;
      this.textChildren = []; // both text and image items can have text children
    }
  }

  // Similar to an image transform, but this carries its own content (text)
  class PurGraphicsTextItem extends Item {
    constructor() {
      super();
      this.text = "";
      this.opacity = 65535;
      this.rgb = [65535, 65535, 65535];
      this.opacityBackground = 5000;
      this.rgbBackground = [0, 0, 0];
    }
  }

  // Part of a PurImage. Be aware: PureRef transforms have an alternative second format for
  // rotated cropping where the image is no longer a rectangle
  class PurGraphicsImageItem extends Item {
    constructor() {
      super();
      this.source = "BruteForceLoaded";
      this.name = "image";
      this.matrixBeforeCrop = [1.0, 0.0, 0.0, 1.0];
      this.xCrop = 0.0;
      this.yCrop = 0.0;
      this.scaleCrop = 1.0;
      this.points = [
        [-1000, 1000, 1000, -1000, -1000],
        [-1000, -1000, 1000, 1000, -1000],
      ];
    }

    get width() {
      return (this.points[0][2] - this.points[0][0]) * this.matrix[0];
    }

    set width(value) {
      this.matrix[0] = value / (this.points[0][2] - this.points[0][0]);
    }

    get height() {
      return (this.points[1][2] - this.points[1][0]) * this.matrix[3];
    }

    set height(value) {
      this.matrix[3] = value / (this.points[1][2] - this.points[1][0]);
    }

    scale(factor) {
      this.matrix[0] *= factor;
      this.matrix[3] *= factor;
    }

    scaleToWidth(width) {
      const ratio = this.height / this.width;
      this.width = width;
      this.height = width * ratio;
    }

    scaleToHeight(height) {
      const ratio = this.width / this.height;
      this.width = height * ratio;
      this.height = height;
    }

    resetCrop(width, height) {
      const w = width / 2;
      const h = height / 2;
      this.xCrop = -w;
      this.yCrop = -h;
      this.points = [
        [-w, w, w, -w, -w],
        [-h, -h, h, h, -h],
      ];
    }
  }

  // Holds an image and its transform(s) (usually only one)
  class PurImage {
    constructor() {
      this.address = [0, 0]; // original location for identification
      // Image data: a Uint8Array or a Blob. Can also be a 4 byte reference to another image's transform
      this.pngBinary = new Uint8Array(0);
      this.transforms = []; // the first transform is the original, the rest are duplicates
    }
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // PurFile (purformat/purformat.py)
  ////////////////////////////////////////////////////////////////////////////////////////////////

  class PurFile {
    constructor() {
      this.canvas = [-10000.0, -10000.0, 10000.0, 10000.0]; // Canvas width and height
      this.zoom = 1.0; // View zoom level
      this.xCanvas = 0; // View location
      this.yCanvas = 0;
      this.folderLocation = "/"; // The Python version uses the working directory, a browser has none
      this.images = [];
      this.text = [];
    }

    // Count the amount of image transforms and assign their IDs
    countImageItems() {
      let count = 0;
      for (const image of this.images) {
        for (const transform of image.transforms) transform.id = count++;
      }
      return count;
    }

    // Assign IDs to all text items, starting after the image IDs (offset). Returns how many there are,
    // including children. The Python version only numbers top level text trees; the extra text attached
    // to image items is numbered after those, so files without it get exactly the same IDs.
    countTextItems(idOffset) {
      let count = 0;
      const assign = (textItem) => {
        textItem.id = idOffset + count++;
        textItem.textChildren.forEach(assign);
      };
      this.text.forEach(assign);
      for (const image of this.images) {
        for (const transform of image.transforms) transform.textChildren.forEach(assign);
      }
      return count;
    }
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Binary helpers
  ////////////////////////////////////////////////////////////////////////////////////////////////

  // Growable big-endian byte buffer
  class ByteWriter {
    constructor(capacity = 1 << 16) {
      this.bytes = new Uint8Array(capacity);
      this.view = new DataView(this.bytes.buffer);
      this.length = 0;
    }

    reserve(n) {
      const needed = this.length + n;
      if (needed <= this.bytes.length) return;
      let capacity = this.bytes.length * 2;
      while (capacity < needed) capacity *= 2;
      const bytes = new Uint8Array(capacity);
      bytes.set(this.bytes.subarray(0, this.length));
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer);
    }

    i8(v) { this.reserve(1); this.view.setInt8(this.length, v); this.length += 1; }
    u16(v) { this.reserve(2); this.view.setUint16(this.length, v); this.length += 2; }
    u32(v) { this.reserve(4); this.view.setUint32(this.length, v); this.length += 4; }
    u64(v) { this.reserve(8); this.view.setBigUint64(this.length, BigInt(v)); this.length += 8; }
    i64(v) { this.reserve(8); this.view.setBigInt64(this.length, BigInt(v)); this.length += 8; }
    f64(v) { this.reserve(8); this.view.setFloat64(this.length, v); this.length += 8; }

    utf16(string) {
      for (let i = 0; i < string.length; i++) this.u16(string.charCodeAt(i));
    }

    // Qt QString: byte length followed by UTF-16 BE
    string(string) {
      this.u32(string.length * 2);
      this.utf16(string);
    }

    matrix(m) {
      this.f64(m[0]);
      this.f64(m[1]);
      this.f64(0.0);
      this.f64(m[2]);
      this.f64(m[3]);
      this.f64(0.0);
    }

    rgb(rgb) {
      for (const value of rgb) this.u16(value);
    }

    setU64(position, v) {
      this.view.setBigUint64(position, BigInt(v));
    }

    toUint8Array() {
      return this.bytes.subarray(0, this.length);
    }
  }

  function byteLength(data) {
    return typeof data.byteLength === "number" ? data.byteLength : data.size;
  }

  // Feed a list of Uint8Array/Blob parts to fn in chunks, without loading whole Blobs into memory at once
  async function forEachChunk(parts, fn, chunkSize = 8 << 20) {
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        fn(part);
        continue;
      }
      for (let offset = 0; offset < part.size; offset += chunkSize) {
        fn(new Uint8Array(await part.slice(offset, offset + chunkSize).arrayBuffer()));
      }
    }
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // MD5 - PureRef stores an MD5 checksum in the header and WebCrypto has no MD5
  ////////////////////////////////////////////////////////////////////////////////////////////////

  const MD5_K = new Int32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]);
  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  class MD5 {
    constructor() {
      this.state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
      this.block = new Uint8Array(64);
      this.blockView = new DataView(this.block.buffer);
      this.blockLength = 0;
      this.total = 0;
      this.words = new Int32Array(16);
    }

    processBlock(view, offset) {
      const m = this.words;
      for (let i = 0; i < 16; i++) m[i] = view.getInt32(offset + i * 4, true);
      const s = this.state;
      let a = s[0], b = s[1], c = s[2], d = s[3];
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const x = (a + f + MD5_K[i] + m[g]) | 0;
        a = d;
        d = c;
        c = b;
        b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      }
      s[0] = (s[0] + a) | 0;
      s[1] = (s[1] + b) | 0;
      s[2] = (s[2] + c) | 0;
      s[3] = (s[3] + d) | 0;
    }

    update(data) {
      let offset = 0;
      this.total += data.length;
      if (this.blockLength > 0) {
        const n = Math.min(64 - this.blockLength, data.length);
        this.block.set(data.subarray(0, n), this.blockLength);
        this.blockLength += n;
        offset = n;
        if (this.blockLength < 64) return this;
        this.processBlock(this.blockView, 0);
        this.blockLength = 0;
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (; offset + 64 <= data.length; offset += 64) this.processBlock(view, offset);
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
      return this;
    }

    hexDigest() {
      const bits = this.total * 8;
      const padding = new Uint8Array(((this.blockLength < 56 ? 56 : 120) - this.blockLength) + 8);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      view.setUint32(padding.length - 8, bits % 0x100000000, true);
      view.setUint32(padding.length - 4, Math.floor(bits / 0x100000000), true);
      this.update(padding);
      let hex = "";
      for (const word of this.state) {
        for (let i = 0; i < 4; i++) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
      }
      return hex;
    }
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Writer (purformat/write.py)
  ////////////////////////////////////////////////////////////////////////////////////////////////

  // Export a PurFile to a .pur file. Resolves to a Blob.
  // Image data stays in its own parts so large boards don't need one giant buffer.
  async function writePurFile(purFile) {
    // Images without transforms are not referenced by anything, the Python version crashes on them
    const images = purFile.images.filter((image) => image.transforms.length > 0);

    const imageItems = purFile.countImageItems();
    const textItems = purFile.countTextItems(imageItems);
    const totalItems = imageItems + purFile.text.length; // the header only counts top level items
    if (totalItems > MAX_HEADER_COUNT) {
      throw new Error(`A .pur file can hold at most ${MAX_HEADER_COUNT} items, this one has ${totalItems}`);
    }

    // Header, the checksum and file length are filled in at the end
    const header = new Uint8Array(HEADER_SIZE);
    const h = new DataView(header.buffer);
    h.setUint32(0, 8); // Needed to recognize the file as a PureRef file
    "1.10".split("").forEach((c, i) => h.setUint16(4 + i * 2, c.charCodeAt(0))); // 1.11.1 still uses 1.10
    h.setUint16(12, totalItems); // GraphicsImageItem + GraphicsTextItem count
    h.setUint16(14, imageItems); // GraphicsImageItem count
    h.setUint32(24, 12); // Unknown, needed for valid header
    h.setUint32(40, 64); // Unknown, needed for valid header
    h.setUint32(108, imageItems + textItems); // ID counter, we discard unused transform IDs
    purFile.canvas.forEach((v, i) => h.setFloat64(112 + i * 8, v)); // Canvas width and height
    h.setFloat64(144, purFile.zoom); // Canvas view zoom
    h.setFloat64(176, purFile.zoom); // you want x and y zoom to be the same
    h.setFloat64(208, 1.0); // Zoom multiplier, should always be 1.0
    h.setInt32(216, purFile.xCanvas); // View X Y
    h.setInt32(220, purFile.yCanvas);

    // Images, saving their addresses for the references. Duplicates are the parent's ID after its PNG
    const parts = [header];
    let offset = HEADER_SIZE;
    for (const image of images) {
      image.address[0] = offset;
      parts.push(image.pngBinary);
      offset += byteLength(image.pngBinary);
      image.address[1] = offset;
      if (image.transforms.length > 1) {
        const duplicates = new ByteWriter((image.transforms.length - 1) * 4);
        for (let i = 1; i < image.transforms.length; i++) duplicates.u32(image.transforms[0].id);
        parts.push(duplicates.toUint8Array());
        offset += duplicates.length;
      }
    }

    // Everything after the images
    const w = new ByteWriter();
    const base = offset;

    function writeText(text) {
      const start = w.length;
      w.u64(0); // End address of this item, filled in below
      w.u32(GRAPHICS_TEXT_ITEM);
      w.utf16("GraphicsTextItem");
      w.string(text.text);
      w.matrix(text.matrix);
      w.f64(text.x); // Location
      w.f64(text.y);
      w.f64(1.0); // Mysterious 1.0 double
      w.u32(text.id);
      w.f64(text.zLayer);
      w.i8(1); // Weird meaningless byte
      w.u16(text.opacity); // Foreground color
      w.rgb(text.rgb);
      w.u16(0); // Mysterious values that count something about the background
      w.i8(1);
      w.u16(text.opacityBackground); // Background color
      w.rgb(text.rgbBackground);
      w.u16(0);
      w.u32(text.textChildren.length);
      w.setU64(start, base + w.length);
      text.textChildren.forEach(writeText);
    }

    function writeImage(transform) {
      const start = w.length;
      w.u64(0); // End address of this item, filled in below
      const bruteForceLoaded = transform.source === "BruteForceLoaded";
      w.u32(GRAPHICS_IMAGE_ITEM);
      w.utf16("GraphicsImageItem");
      if (bruteForceLoaded) w.u32(0); // Brute force loaded images have an extra empty 4 bytes
      w.string(transform.source);
      if (!bruteForceLoaded) w.string(transform.name); // Name is skipped if brute force loaded
      w.f64(1.0); // Mysterious 1.0 double
      w.matrix(transform.matrix); // Scaling matrix
      w.f64(transform.x); // Location
      w.f64(transform.y);
      w.f64(1.0); // Mysterious 1.0 double
      w.u32(transform.id);
      w.f64(transform.zLayer);
      w.matrix(transform.matrixBeforeCrop);
      w.f64(transform.xCrop); // Location before crop
      w.f64(transform.yCrop);
      w.f64(transform.scaleCrop);
      w.u32(transform.points[0].length); // Crop points
      for (let i = 0; i < transform.points[0].length; i++) {
        w.u32(i === 0 ? 0 : 1);
        w.f64(transform.points[0][i]);
        w.f64(transform.points[1][i]);
      }
      // Always the same, no idea if this actually holds information
      w.f64(0.0);
      w.u32(1);
      w.i8(0);
      w.i64(-1);
      w.u32(transform.textChildren.length);
      w.setU64(start, base + w.length);
      transform.textChildren.forEach(writeText);
    }

    for (const image of images) image.transforms.forEach(writeImage);
    purFile.text.forEach(writeText); // Unparented text

    w.string(purFile.folderLocation);
    h.setBigUint64(16, BigInt(base + w.length)); // File length, which is where the references begin

    // References couple image addresses to transform IDs
    for (const image of images) {
      image.transforms.forEach((transform, i) => {
        w.u32(transform.id);
        if (i === 0) {
          w.u64(image.address[0]);
          w.u64(image.address[1]);
        } else {
          const duplicate = image.address[1] + (i - 1) * 4;
          w.u64(duplicate);
          w.u64(duplicate + 4);
        }
      });
    }
    parts.push(w.toUint8Array());

    // Checksum: MD5 hex digest of everything after it, as UTF-16
    const md5 = new MD5();
    await forEachChunk([header.subarray(108), ...parts.slice(1)], (chunk) => md5.update(chunk));
    md5.hexDigest().split("").forEach((c, i) => h.setUint16(44 + i * 2, c.charCodeAt(0)));

    return new Blob(parts, { type: "application/octet-stream" });
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Reader (purformat/read.py)
  ////////////////////////////////////////////////////////////////////////////////////////////////

  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const PNG_FOOTER = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]; // empty IEND chunk
  const IEND = 0x49454e44;

  function hsvToRgb(hsv) {
    // colorsys.hsv_to_rgb with PureRef's scaling
    const h = hsv[0] / 35900, s = hsv[1] / 65535, v = hsv[2] / 65535;
    let rgb;
    if (s === 0) {
      rgb = [v, v, v];
    } else {
      const i = Math.trunc(h * 6.0);
      const f = h * 6.0 - i;
      const p = v * (1.0 - s);
      const q = v * (1.0 - s * f);
      const t = v * (1.0 - s * (1.0 - f));
      rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
    }
    return rgb.map((c) => Math.trunc(c * 65535));
  }

  // Import a .pur file. Accepts an ArrayBuffer or Uint8Array; PNG data is returned as views into it.
  function readPurFile(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder("utf-16be", { ignoreBOM: true }); // keep a leading BOM, like Python
    const purFile = new PurFile();
    const imageItems = [];
    let pos = 0;

    const fail = (message) => {
      throw new Error(message);
    };
    const need = (n, at = pos) => {
      if (at + n > bytes.length) fail("The file is truncated or corrupt");
    };
    const u8 = () => { need(1); return view.getUint8(pos++); };
    const u32At = (at) => { need(4, at); return view.getUint32(at); };
    const u32 = () => { const v = u32At(pos); pos += 4; return v; };
    const u16 = () => { need(2); const v = view.getUint16(pos); pos += 2; return v; };
    const u64At = (at) => { need(8, at); return Number(view.getBigUint64(at)); };
    const u64 = () => { const v = u64At(pos); pos += 8; return v; };
    const f64 = () => { need(8); const v = view.getFloat64(pos); pos += 8; return v; };
    const skip = (n) => { need(n); pos += n; };
    const string = () => {
      const length = u32();
      need(length);
      const s = decoder.decode(bytes.subarray(pos, pos + length));
      pos += length;
      return s;
    };
    const matrix = () => {
      const m = [f64(), f64()];
      skip(8);
      m.push(f64(), f64());
      skip(8);
      return m;
    };
    const rgb = () => [u16(), u16(), u16()];
    const matchesAt = (at, sequence) => at + sequence.length <= bytes.length && sequence.every((b, i) => bytes[at + i] === b);

    // Header
    if (bytes.length < HEADER_SIZE || u32At(0) !== 8 || decoder.decode(bytes.subarray(4, 12)) !== "1.10") {
      fail("This is not a PureRef 1.10/1.11 file");
    }
    purFile.canvas = [112, 120, 128, 136].map((at) => view.getFloat64(at));
    purFile.zoom = view.getFloat64(144);
    purFile.xCanvas = view.getInt32(216);
    purFile.yCanvas = view.getInt32(220);
    const fileLength = u64At(16); // Where the references begin, after the items and the folder location
    const fileLengthValid = fileLength >= HEADER_SIZE && fileLength <= bytes.length;
    const itemsEnd = fileLengthValid ? fileLength : bytes.length;
    pos = HEADER_SIZE;

    const isItemAt = (at) =>
      at + 14 <= itemsEnd &&
      (view.getUint32(at + 8) === GRAPHICS_IMAGE_ITEM || view.getUint32(at + 8) === GRAPHICS_TEXT_ITEM) &&
      bytes[at + 12] === 0 && bytes[at + 13] === 0x47; // "G"raphics

    const pngEnd = (start) => {
      // Walk the PNG chunks up to IEND
      let at = start + PNG_SIGNATURE.length;
      while (at + 12 <= bytes.length) {
        const length = view.getUint32(at);
        const type = view.getUint32(at + 4);
        at += 12 + length;
        if (type === IEND) return Math.min(at, bytes.length);
      }
      // Malformed, fall back to searching for the footer like the Python version
      for (let i = start; i + PNG_FOOTER.length <= bytes.length; i++) {
        if (matchesAt(i, PNG_FOOTER)) return i + PNG_FOOTER.length;
      }
      return fail("The file contains a broken image");
    };

    // Images: a PNG, or 4 bytes which are the ID of the transform of a duplicated image (or FFFFFFFF, a link)
    while (pos < itemsEnd && !isItemAt(pos)) {
      const image = new PurImage();
      const end = matchesAt(pos, PNG_SIGNATURE) ? pngEnd(pos) : pos + 4;
      need(end - pos);
      image.address = [pos, end];
      image.pngBinary = bytes.subarray(pos, end);
      purFile.images.push(image);
      pos = end;
    }

    function readTextItem() {
      const itemEnd = u64At(pos);
      const text = new PurGraphicsTextItem();
      skip(12 + u32At(pos + 8)); // Remove textItem standard text
      text.text = string();
      text.matrix = matrix();
      text.x = f64();
      text.y = f64();
      skip(8); // Unknown permanent 1.0 double
      text.id = u32();
      text.zLayer = f64();
      const isHsv = u8() === 2; // byte indicating RGB or HSV
      text.opacity = u16();
      text.rgb = rgb();
      if (isHsv) text.rgb = hsvToRgb(text.rgb);
      skip(2);
      const isBackgroundHsv = u8() === 2;
      text.opacityBackground = u16();
      text.rgbBackground = rgb();
      if (isBackgroundHsv) text.rgbBackground = hsvToRgb(text.rgbBackground);
      const children = u32At(pos + 2);
      pos = itemEnd;
      addTextChildren(text, children);
      return text;
    }

    function readImageItem() {
      const itemEnd = u64At(pos);
      const transform = new PurGraphicsImageItem();
      skip(12 + u32At(pos + 8)); // Remove imageItem standard text
      let bruteForceLoaded = false;
      if (u32At(pos) === 0) {
        bruteForceLoaded = true;
        skip(4);
      }
      if (u32At(pos) === 0xffffffff) skip(4); // No source
      else transform.source = string();
      if (!bruteForceLoaded) {
        if (u32At(pos) === 0xffffffff) skip(4); // No name
        else transform.name = string();
      }
      skip(8); // Unknown permanent 1.0 double
      transform.matrix = matrix(); // Scaling and rotation
      transform.x = f64();
      transform.y = f64();
      skip(8); // Second unknown permanent 1.0 double
      transform.id = u32();
      transform.zLayer = f64();
      transform.matrixBeforeCrop = matrix();
      transform.xCrop = f64();
      transform.yCrop = f64();
      transform.scaleCrop = f64();
      // Crop points, the first seems to be a copy of the last
      const pointCount = u32();
      transform.points = [[], []];
      for (let i = 0; i < pointCount; i++) {
        skip(4);
        transform.points[0].push(f64());
        transform.points[1].push(f64());
      }
      const children = u32At(pos + 21);
      pos = itemEnd;
      addTextChildren(transform, children);
      return transform;
    }

    function addTextChildren(parent, count) {
      for (let i = 0; i < count; i++) {
        if (!isItemAt(pos)) fail("The file is corrupt");
        parent.textChildren.push(readTextItem());
      }
    }

    // All GraphicsImageItems and GraphicsTextItems, in the order they were added
    while (isItemAt(pos)) {
      if (view.getUint32(pos + 8) === GRAPHICS_IMAGE_ITEM) imageItems.push(readImageItem());
      else purFile.text.push(readTextItem());
    }

    purFile.folderLocation = string();
    if (fileLengthValid) pos = fileLength;

    // The rest of the file couples transform IDs with the address of the image they use
    const itemsById = new Map(imageItems.map((item) => [item.id, item]));
    const imagesByAddress = new Map(purFile.images.map((image) => [image.address[0], image]));
    for (let i = 0; i < imageItems.length; i++) {
      const id = u32();
      const address = u64();
      skip(8);
      const item = itemsById.get(id);
      const image = imagesByAddress.get(address);
      if (item && image) image.transforms = [item];
    }

    // Duplicates have 4 bytes (the original's transform ID) instead of a PNG, all 0xFF is a link instead.
    // Remove them and add their transform to the original image.
    const isDuplicate = (image) => image.pngBinary.length === 4 && !image.pngBinary.every((b) => b === 0xff);
    const parentId = (image) => new DataView(image.pngBinary.buffer, image.pngBinary.byteOffset, 4).getUint32(0);
    const byTransformId = new Map();
    for (const image of purFile.images) {
      if (image.transforms.length > 0) byTransformId.set(image.transforms[0].id, image);
    }
    for (const image of purFile.images) {
      if (!isDuplicate(image)) continue;
      let original = byTransformId.get(parentId(image));
      for (let hops = 0; original && isDuplicate(original) && hops < purFile.images.length; hops++) {
        original = byTransformId.get(parentId(original)); // a duplicate of a duplicate
      }
      if (original && !isDuplicate(original)) original.transforms.push(...image.transforms);
    }
    purFile.images = purFile.images.filter((image) => !isDuplicate(image));

    return purFile;
  }

  return {
    Item,
    PurGraphicsTextItem,
    PurGraphicsImageItem,
    PurImage,
    PurFile,
    MD5,
    readPurFile,
    writePurFile,
    forEachChunk,
  };
});
