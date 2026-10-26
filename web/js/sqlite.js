/*
 * sqlite.js - minimal read-only SQLite reader, enough to read PureRef 2 scenes.
 *
 * Reads whole tables by walking their b-trees (https://www.sqlite.org/fileformat.html).
 * No SQL, indexes, WAL or writing.
 *
 * Works as a plain <script> (exposes `SQLite` on window) or as a CommonJS module (Node, for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SQLite = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAGIC = "SQLite format 3\u0000";
  const LEAF_TABLE = 0x0d;
  const INTERIOR_TABLE = 0x05;
  const MAX_DEPTH = 64;

  const corrupt = () => new Error("The database is corrupt");
  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Returns [value, length in bytes]
  function varint(bytes, at) {
    let value = 0;
    for (let i = 0; i < 8; i++) {
      const byte = bytes[at + i];
      if (byte === undefined) throw corrupt();
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return [value, i + 1];
    }
    if (bytes[at + 8] === undefined) throw corrupt();
    return [value * 256 + bytes[at + 8], 9];
  }

  function decodeRecord(payload, decoder) {
    const [headerSize, n] = varint(payload, 0);
    const types = [];
    for (let at = n; at < headerSize;) {
      const [type, m] = varint(payload, at);
      types.push(type);
      at += m;
    }

    const data = view(payload);
    const values = [];
    let at = headerSize;
    for (const type of types) {
      let size = 0;
      let value;
      switch (type) {
        case 0: value = null; break;
        case 1: size = 1; value = data.getInt8(at); break;
        case 2: size = 2; value = data.getInt16(at); break;
        case 3: size = 3; value = ((data.getInt8(at) * 65536) + data.getUint16(at + 1)); break;
        case 4: size = 4; value = data.getInt32(at); break;
        case 5: size = 6; value = data.getInt16(at) * 0x100000000 + data.getUint32(at + 2); break;
        case 6: size = 8; value = Number(data.getBigInt64(at)); break;
        case 7: size = 8; value = data.getFloat64(at); break;
        case 8: value = 0; break;
        case 9: value = 1; break;
        default: {
          if (type < 12) throw corrupt();
          size = Math.floor((type - 12) / 2);
          if (at + size > payload.length) throw corrupt();
          const bytes = payload.subarray(at, at + size);
          value = type % 2 === 0 ? bytes : decoder.decode(bytes);
        }
      }
      if (at + size > payload.length) throw corrupt();
      values.push(value);
      at += size;
    }
    return values;
  }

  // Column names from a CREATE TABLE statement, and which one is an alias of the rowid
  function parseColumns(sql) {
    const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
    const definitions = [];
    let current = "";
    let depth = 0;
    let quote = null;
    for (const c of body) {
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "[") {
        quote = "]";
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      } else if (c === "," && depth === 0) {
        definitions.push(current.trim());
        current = "";
        continue;
      }
      current += c;
    }
    definitions.push(current.trim());

    return definitions
      .filter((definition) => definition && !/^(constraint|primary|unique|check|foreign)\b/i.test(definition))
      .map((definition) => {
        const token = definition.match(/^("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|\S+)/)[0];
        const name = /^["[`]/.test(token) ? token.slice(1, -1).replace(/""/g, '"') : token;
        return { name, rowid: /^\s+integer\s+primary\s+key\b(?!\s+desc)/i.test(definition.slice(token.length)) };
      });
  }

  // read(offset, length) returns that part of the database as a Uint8Array; size is the database size
  function open(read, size) {
    if (size < 100) throw new Error("Not a SQLite database");
    const header = read(0, 100);
    if (String.fromCharCode(...header.subarray(0, 16)) !== MAGIC) throw new Error("Not a SQLite database");
    let pageSize = view(header).getUint16(16);
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw corrupt();
    const usable = pageSize - header[20];
    const encoding = view(header).getUint32(56);
    const decoder = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8", { ignoreBOM: true });
    const pageCount = Math.floor(size / pageSize);

    function page(number) {
      if (!Number.isInteger(number) || number < 1 || number > pageCount) throw corrupt();
      return read((number - 1) * pageSize, pageSize);
    }

    // The payload of a table leaf cell, following overflow pages when it doesn't fit
    function leafCell(bytes, at) {
      const [payloadSize, n] = varint(bytes, at);
      const [rowid, m] = varint(bytes, at + n);
      at += n + m;

      const maxLocal = usable - 35;
      if (payloadSize <= maxLocal) {
        if (at + payloadSize > bytes.length) throw corrupt();
        return { rowid, payload: bytes.subarray(at, at + payloadSize) };
      }
      const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
      let local = minLocal + ((payloadSize - minLocal) % (usable - 4));
      if (local > maxLocal) local = minLocal;

      const payload = new Uint8Array(payloadSize);
      payload.set(bytes.subarray(at, at + local));
      let filled = local;
      let next = view(bytes).getUint32(at + local);
      const seen = new Set();
      while (filled < payloadSize) {
        if (seen.has(next)) throw corrupt();
        seen.add(next);
        const overflow = page(next);
        const chunk = Math.min(usable - 4, payloadSize - filled);
        payload.set(overflow.subarray(4, 4 + chunk), filled);
        filled += chunk;
        next = view(overflow).getUint32(0);
      }
      return { rowid, payload };
    }

    function walk(number, cells, depth = 0) {
      if (depth > MAX_DEPTH) throw corrupt();
      const bytes = page(number);
      const data = view(bytes);
      const start = number === 1 ? 100 : 0; // page 1 starts with the database header
      const type = bytes[start];
      const count = data.getUint16(start + 3);

      if (type === LEAF_TABLE) {
        for (let i = 0; i < count; i++) cells.push(leafCell(bytes, data.getUint16(start + 8 + i * 2)));
      } else if (type === INTERIOR_TABLE) {
        for (let i = 0; i < count; i++) walk(data.getUint32(data.getUint16(start + 12 + i * 2)), cells, depth + 1);
        walk(data.getUint32(start + 8), cells, depth + 1);
      } else {
        throw new Error("Unsupported database table");
      }
      return cells;
    }

    const tables = new Map();
    for (const { payload } of walk(1, [])) {
      const [type, name, , rootPage, sql] = decodeRecord(payload, decoder);
      if (type === "table" && rootPage > 0 && typeof sql === "string") tables.set(name, { rootPage, columns: parseColumns(sql) });
    }

    return {
      tables: () => [...tables.keys()],

      // All rows of a table as objects keyed by column name, or [] if there is no such table
      rows(name) {
        const table = tables.get(name);
        if (!table) return [];
        return walk(table.rootPage, []).map(({ rowid, payload }) => {
          const values = decodeRecord(payload, decoder);
          const row = {};
          table.columns.forEach((column, i) => {
            row[column.name] = column.rowid ? rowid : i < values.length ? values[i] : null;
          });
          return row;
        });
      },
    };
  }

  return { open };
});
