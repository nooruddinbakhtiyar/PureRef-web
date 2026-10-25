/*
 * zip.js - minimal ZIP writer (no compression; .pur files and PNGs are already compressed).
 * Works as a plain <script> (exposes `Zip` on window) or as a CommonJS module (Node, for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./purformat.js"));
  else root.Zip = factory(root.PurFormat);
})(typeof self !== "undefined" ? self : this, function (PurFormat) {
  "use strict";

  const CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }

  function crc32(data, crc = 0) {
    crc = ~crc;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return ~crc >>> 0;
  }

  function dosDateTime(date) {
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: (Math.max(date.getFullYear() - 1980, 0) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  // entries: [{ name, data: Uint8Array|Blob }]. Resolves to a Blob.
  async function createZip(entries, onProgress) {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (let index = 0; index < entries.length; index++) {
      const { name, data } = entries[index];
      const nameBytes = encoder.encode(name);
      const size = data instanceof Uint8Array ? data.length : data.size;
      let crc = 0;
      await PurFormat.forEachChunk([data], (chunk) => (crc = crc32(chunk, crc)));
      if (offset + 30 + nameBytes.length + size > 0xffffffff) {
        throw new Error("The ZIP file would be larger than 4 GB, download the files one by one instead");
      }

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header signature
      local.setUint16(4, 20, true); // version needed to extract
      local.setUint16(6, 0x0800, true); // flags: UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true); // central directory header signature
      record.setUint16(4, 20, true); // version made by
      record.setUint16(6, 20, true); // version needed to extract
      record.setUint16(8, 0x0800, true);
      record.setUint16(10, 0, true);
      record.setUint16(12, time, true);
      record.setUint16(14, date, true);
      record.setUint32(16, crc, true);
      record.setUint32(20, size, true);
      record.setUint32(24, size, true);
      record.setUint16(28, nameBytes.length, true);
      record.setUint32(42, offset, true); // local header offset
      central.push(new Uint8Array(record.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
      if (onProgress) onProgress(index + 1, entries.length);
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory signature
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  return { crc32, createZip };
});
