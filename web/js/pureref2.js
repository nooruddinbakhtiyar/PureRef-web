/*
 * pureref2.js - read PureRef 2 scenes (.pur files saved by PureRef 2.0 and later).
 *
 * A PureRef 2 .pur file is a SQLite database with a small header in front of it:
 *
 *   QString  format version, e.g. "2.1"           (u32 byte length + UTF-16 BE, like Qt's QDataStream)
 *   u16, u16 zero
 *   u64      database start: where the first bytes of the database were moved to
 *   QString  application version, e.g. "2.1.3"
 *   QString  MD5 hex digest of everything after this string
 *   u32      thumbnail length, followed by a JPEG of the scene
 *
 * To make room for the header, the database's first bytes (as many as the header takes up) are moved to
 * the end of the file. The rest of the database is at its usual place, so the database is
 * file[databaseStart:] + file[headerLength:databaseStart].
 *
 * Tables used here: images (the original image files), items (every item on the board: name, parent,
 * z order, opacity and transform), items_images (which image an item shows, how the image sits in the item
 * and its crop shape) and items_notes (text notes). Transforms and crop shapes are QVariants (QTransform,
 * QPainterPath) written with QDataStream and stored as text with one character per byte.
 *
 * Works as a plain <script> (exposes `PureRef2` on window) or as a CommonJS module (Node, for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sqlite.js"));
  else root.PureRef2 = factory(root.SQLite);
})(typeof self !== "undefined" ? self : this, function (SQLite) {
  "use strict";

  const SIGNATURES = [
    ["jpg", "image/jpeg", [0xff, 0xd8, 0xff]],
    ["png", "image/png", [0x89, 0x50, 0x4e, 0x47]],
    ["gif", "image/gif", [0x47, 0x49, 0x46, 0x38]],
    ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50]],
    ["bmp", "image/bmp", [0x42, 0x4d]],
    ["avif", "image/avif", [-1, -1, -1, -1, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]],
    ["tif", "image/tiff", [0x49, 0x49, 0x2a, 0x00]],
    ["tif", "image/tiff", [0x4d, 0x4d, 0x00, 0x2a]],
  ];

  const QT_TRANSFORM = 80; // QMetaType::QTransform in Qt 5
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  // TEXT columns hold one byte per character, BLOB columns hold the bytes themselves
  function qtBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== "string") return null;
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code > 0xff) return null;
      bytes[i] = code;
    }
    return bytes;
  }

  // A QVariant: u32 type, u8 null flag, the type name for user types, then the value
  function readVariant(value) {
    const bytes = qtBytes(value);
    if (!bytes || bytes.length < 5) return null;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = data.getUint32(0);
    let pos = 5;
    let name = "";
    if (type >= 1024) {
      if (bytes.length < pos + 4) return null;
      const length = data.getUint32(pos);
      pos += 4;
      if (bytes.length < pos + length) return null;
      name = String.fromCharCode(...bytes.subarray(pos, pos + length)).replace(/\0+$/, "");
      pos += length;
    }
    return { type, name, data: new DataView(bytes.buffer, bytes.byteOffset + pos, bytes.byteLength - pos) };
  }

  // A QTransform as [m11, m12, m21, m22, dx, dy], the order canvas transforms use
  function readTransform(value) {
    const variant = readVariant(value);
    if (!variant || variant.type !== QT_TRANSFORM || variant.data.byteLength < 72) return IDENTITY;
    const m = Array.from({ length: 9 }, (_, i) => variant.data.getFloat64(i * 8));
    const transform = [m[0], m[1], m[3], m[4], m[6], m[7]];
    return transform.every(Number.isFinite) ? transform : IDENTITY;
  }

  // A QPainterPath as [[type, x, y], ...]: type 0 moves, 1 draws a line, 2 and two 3s make a curve
  function readPath(value) {
    const variant = readVariant(value);
    if (!variant || variant.name !== "QPainterPath" || variant.data.byteLength < 4) return null;
    const count = variant.data.getUint32(0);
    if (count === 0 || variant.data.byteLength < 4 + count * 20) return null;
    const elements = [];
    for (let i = 0; i < count; i++) {
      const at = 4 + i * 20;
      elements.push([variant.data.getInt32(at), variant.data.getFloat64(at + 4), variant.data.getFloat64(at + 12)]);
    }
    return elements.every(([, x, y]) => Number.isFinite(x) && Number.isFinite(y)) ? elements : null;
  }

  // Apply transform a, then b
  function multiply(a, b) {
    return [
      b[0] * a[0] + b[2] * a[1],
      b[1] * a[0] + b[3] * a[1],
      b[0] * a[2] + b[2] * a[3],
      b[1] * a[2] + b[3] * a[3],
      b[0] * a[4] + b[2] * a[5] + b[4],
      b[1] * a[4] + b[3] * a[5] + b[5],
    ];
  }

  // The image items on the board in drawing order, with their transforms on the board
  function boardItems(itemRows, placements, imageIds) {
    const byId = new Map(itemRows.map((item) => [item.id, item]));
    const children = new Map();
    for (const item of itemRows) {
      const parent = item.parent !== item.id && byId.has(item.parent) ? item.parent : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    }
    const byZ = (a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) || a.id - b.id;
    const placementsById = new Map(placements.map((placement) => [placement.id, placement]));

    // Like Qt, children use their parent's coordinates and are drawn after it
    const items = [];
    const visit = (item, parentTransform, parentOpacity) => {
      const transform = multiply(readTransform(item.transform), parentTransform);
      const opacity = parentOpacity * (typeof item.opacity === "number" ? item.opacity : 1);
      const placement = placementsById.get(item.id);
      if (placement && imageIds.has(placement.image)) {
        items.push({
          image: placement.image,
          transform,
          imageTransform: readTransform(placement.image_transform),
          clip: readPath(placement.image_bounds),
          opacity,
        });
      }
      (children.get(item.id) || []).sort(byZ).forEach((child) => visit(child, transform, opacity));
    };
    (children.get(null) || []).sort(byZ).forEach((item) => visit(item, IDENTITY, 1));
    return items;
  }

  // The first QString of a .pur file, which is the format version ("1.10", "2.1", ...), or null
  function formatVersion(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 4) return null;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (length === 0 || length > 32 || length % 2 !== 0 || 4 + length > bytes.length) return null;
    const version = new TextDecoder("utf-16be").decode(bytes.subarray(4, 4 + length));
    return /^\d+(\.\d+)*$/.test(version) ? version : null;
  }

  // File extension and MIME type of an image, from its first bytes or else PureRef's format name
  function imageType(data, format) {
    for (const [extension, mime, signature] of SIGNATURES) {
      if (signature.every((byte, i) => byte < 0 || data[i] === byte)) return { extension, mime };
    }
    const extension = (format || "").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    return { extension, mime: "application/octet-stream" };
  }

  function readHeader(bytes) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder("utf-16be");
    let pos = 0;
    const need = (n) => {
      if (pos + n > bytes.length) throw new Error("The file is truncated or corrupt");
    };
    const string = () => {
      need(4);
      const length = data.getUint32(pos);
      pos += 4;
      if (length === 0xffffffff) return "";
      need(length);
      const value = decoder.decode(bytes.subarray(pos, pos + length));
      pos += length;
      return value;
    };

    const version = string();
    need(12);
    pos += 4;
    const databaseStart = Number(data.getBigUint64(pos));
    pos += 8;
    const applicationVersion = string();
    const checksum = string();
    need(4);
    const thumbnailLength = data.getUint32(pos);
    pos += 4;
    need(thumbnailLength);
    const thumbnail = bytes.subarray(pos, pos + thumbnailLength);
    pos += thumbnailLength;
    return { version, applicationVersion, checksum, databaseStart, headerLength: pos, thumbnail };
  }

  // Undo the moved bytes and open the database
  function openDatabase(bytes, header) {
    const size = header.databaseStart;
    const moved = bytes.length - size; // the database bytes that are at the end of the file
    if (size <= header.headerLength || moved <= 0 || moved > size) {
      throw new Error("This PureRef 2 file uses a layout this site doesn't understand yet");
    }

    function read(offset, length) {
      if (offset < 0 || offset + length > size) throw new Error("The file is truncated or corrupt");
      if (offset >= moved) return bytes.subarray(offset, offset + length);
      if (offset + length <= moved) return bytes.subarray(size + offset, size + offset + length);
      const result = new Uint8Array(length); // straddles the moved part
      result.set(bytes.subarray(size + offset, size + moved));
      result.set(bytes.subarray(moved, offset + length), moved - offset);
      return result;
    }

    try {
      return SQLite.open(read, size);
    } catch (error) {
      if (/Not a SQLite/.test(error.message)) throw new Error("This PureRef 2 file uses a layout this site doesn't understand yet");
      throw error;
    }
  }

  // Read the images and notes of a PureRef 2 scene. Accepts an ArrayBuffer or Uint8Array.
  function readScene(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const header = readHeader(bytes);
    if (!/^2\./.test(header.version)) throw new Error("This is not a PureRef 2 file");
    const database = openDatabase(bytes, header);

    const itemRows = database.rows("items");
    const itemNames = new Map(itemRows.map((item) => [item.id, item.name]));
    const placements = database.rows("items_images");
    const imageNames = new Map();
    for (const placement of placements) {
      const name = itemNames.get(placement.id);
      if (name && !imageNames.has(placement.image)) imageNames.set(placement.image, name);
    }

    const images = database.rows("images")
      .filter((image) => image.data instanceof Uint8Array && image.data.length > 0)
      .map((image) => ({
        id: image.id,
        data: image.data,
        ...imageType(image.data, image.format),
        name: imageNames.get(image.id) || "",
        source: typeof image.source === "string" ? image.source : "",
        width: image.width,
        height: image.height,
        checksum: image.checksum,
      }));

    const notes = database.rows("items_notes")
      .map((note) => note.text)
      .filter((text) => typeof text === "string" && text.trim());

    return {
      version: header.version,
      applicationVersion: header.applicationVersion,
      thumbnail: header.thumbnail.length > 0 ? header.thumbnail : null,
      images,
      items: boardItems(itemRows, placements, new Set(images.map((image) => image.id))),
      placements: placements.length,
      notes,
      drawings: database.rows("items_drawings").length,
    };
  }

  return { formatVersion, imageType, readScene };
});
