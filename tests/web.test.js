// Tests for the web version. Run with: node --test tests/*.test.js
// The parity test compares against the Python generator and is skipped when Python/Pillow are missing.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const PurFormat = require("../web/js/purformat.js");
const PureRefGen = require("../web/js/pureref_gen.js");
const PureRef2 = require("../web/js/pureref2.js");
const BoardRenderer = require("../web/js/render.js");
const SQLite = require("../web/js/sqlite.js");
const Zip = require("../web/js/zip.js");

const ROOT = path.join(__dirname, "..");

// Minimal RGB PNG encoder
function makePng(width, height, seed = 0) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) raw[y * (width * 3 + 1) + 1 + x] = (x * 7 + y * 13 + seed * 31) & 0xff;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function textItem(text, children = []) {
  const item = new PurFormat.PurGraphicsTextItem();
  item.text = text;
  item.x = 12.5;
  item.y = -3;
  item.zLayer = 4;
  item.rgb = [1, 2, 3];
  item.textChildren = children;
  return item;
}

function sampleFile() {
  const purFile = PureRefGen.generate([
    { png: makePng(30, 20, 1), width: 30, height: 20, name: "a", source: "folder/a.png" },
    { png: new Blob([makePng(10, 40, 2)]), width: 10, height: 40, name: "b", source: "folder/b.png" },
    { png: makePng(50, 50, 3), width: 50, height: 50, name: "ünïcødé 🖼", source: "BruteForceLoaded" },
  ], "C:/Users/someone/Pictures");

  // A duplicate of the first image, with a note attached
  const duplicate = new PurFormat.PurGraphicsImageItem();
  duplicate.resetCrop(30, 20);
  duplicate.name = "a copy";
  duplicate.source = "folder/a.png";
  duplicate.x = 5000;
  duplicate.textChildren = [textItem("attached")];
  purFile.images[0].transforms.push(duplicate);

  purFile.text = [textItem("Hello"), textItem("Parent", [textItem("Child", [textItem("Grandchild")])])];
  purFile.zoom = 0.25;
  purFile.xCanvas = -120;
  purFile.yCanvas = 42;
  return purFile;
}

test("MD5 matches node:crypto", () => {
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 100003]) {
    const data = crypto.randomBytes(size);
    const expected = crypto.createHash("md5").update(data).digest("hex");
    assert.strictEqual(new PurFormat.MD5().update(new Uint8Array(data)).hexDigest(), expected, `size ${size}`);

    // Same result when fed in uneven pieces
    const md5 = new PurFormat.MD5();
    for (let i = 0; i < size; i += 37) md5.update(new Uint8Array(data.subarray(i, i + 37)));
    assert.strictEqual(md5.hexDigest(), expected, `chunked size ${size}`);
  }
});

test("written files have a valid header and checksum", async () => {
  const bytes = await bytesOf(await PurFormat.writePurFile(sampleFile()));
  const view = new DataView(bytes.buffer);
  assert.strictEqual(view.getUint32(0), 8);
  assert.strictEqual(new TextDecoder("utf-16be").decode(bytes.subarray(4, 12)), "1.10");
  assert.strictEqual(view.getUint16(12), 4 + 2); // 4 image items + 2 top level text items
  assert.strictEqual(view.getUint16(14), 4);
  assert.strictEqual(view.getUint32(108), 4 + 5); // IDs used by images and all text items
  const checksum = new TextDecoder("utf-16be").decode(bytes.subarray(44, 108));
  assert.strictEqual(checksum, crypto.createHash("md5").update(bytes.subarray(108)).digest("hex"));
});

test("read and write round trip to identical bytes", async () => {
  const original = await bytesOf(await PurFormat.writePurFile(sampleFile()));
  const read = PurFormat.readPurFile(original);

  assert.strictEqual(read.images.length, 3);
  assert.deepStrictEqual(read.images.map((image) => image.transforms.length), [2, 1, 1]);
  assert.deepStrictEqual(read.images[1].pngBinary, makePng(10, 40, 2));
  assert.strictEqual(read.images[2].transforms[0].source, "BruteForceLoaded");
  assert.strictEqual(read.images[0].transforms[1].textChildren[0].text, "attached");
  assert.strictEqual(read.text[1].textChildren[0].textChildren[0].text, "Grandchild");
  assert.strictEqual(read.folderLocation, "C:/Users/someone/Pictures");
  assert.strictEqual(read.zoom, 0.25);
  assert.deepStrictEqual([read.xCanvas, read.yCanvas], [-120, 42]);

  const rewritten = await bytesOf(await PurFormat.writePurFile(read));
  assert.deepStrictEqual(rewritten, original);
});

test("reader rejects files that are not .pur files", () => {
  assert.throws(() => PurFormat.readPurFile(new Uint8Array(10)), /not a PureRef/);
  assert.throws(() => PurFormat.readPurFile(makePng(4, 4)), /not a PureRef/);
});

test("natural sort orders numbers by value", () => {
  const names = ["10.jpg", "2.jpg", "1.jpg", "b.png", "a10.png", "a9.png", "A.png", "100.jpg", "02.jpg"];
  assert.deepStrictEqual(
    [...names].sort(PureRefGen.naturalCompare),
    ["1.jpg", "2.jpg", "02.jpg", "10.jpg", "100.jpg", "A.png", "a9.png", "a10.png", "b.png"],
  );
});

test("layout makes a rectangle of rows 1000 wide", () => {
  const sizes = Array.from({ length: 40 }, (_, i) => [300 + ((i * 97) % 900), 200 + ((i * 53) % 700)]);
  const purFile = PureRefGen.generate(sizes.map(([width, height]) => ({ png: makePng(1, 1), width, height, name: "", source: "" })));
  const transforms = purFile.images.map((image) => image.transforms[0]);
  const rows = new Map();
  for (const t of transforms) {
    const top = (t.y - t.height / 2).toFixed(6);
    rows.set(top, (rows.get(top) || 0) + t.width);
  }
  assert.ok(rows.size > 1);
  for (const width of rows.values()) assert.ok(Math.abs(width - 1000) < 1e-9);
});

test("layout handles a very wide image in a short row", () => {
  // The Python version raises IndexError on this one
  const sizes = [[100, 1000], [10000, 1000], [100, 1000]];
  const purFile = PureRefGen.generate(sizes.map(([width, height]) => ({ png: makePng(1, 1), width, height, name: "", source: "" })));
  for (const image of purFile.images) assert.ok(Number.isFinite(image.transforms[0].x));
});

test("zip contains the files unchanged", async () => {
  const files = [
    { name: "one.pur", data: new Uint8Array(crypto.randomBytes(1000)) },
    { name: "földer/two.png", data: new Blob([crypto.randomBytes(70000)]) },
  ];
  const zip = Buffer.from(await bytesOf(await Zip.createZip(files)));

  const end = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(end), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(end + 10), files.length);
  let record = zip.readUInt32LE(end + 16);
  for (const file of files) {
    const expected = Buffer.from(file.data instanceof Blob ? await bytesOf(file.data) : file.data);
    assert.strictEqual(zip.readUInt32LE(record), 0x02014b50);
    const nameLength = zip.readUInt16LE(record + 28);
    assert.strictEqual(zip.toString("utf8", record + 46, record + 46 + nameLength), file.name);
    assert.strictEqual(zip.readUInt32LE(record + 16), zlib.crc32(expected));
    const local = zip.readUInt32LE(record + 42);
    assert.strictEqual(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    assert.deepStrictEqual(zip.subarray(start, start + expected.length), expected);
    record += 46 + nameLength;
  }
});

function havePython() {
  const result = spawnSync("python3", ["-c", "import PIL"], { encoding: "utf8" });
  return result.status === 0;
}

test("matches the Python generator byte for byte", { skip: !havePython() && "python3 with Pillow not available" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pureref-parity-"));
  try {
    const input = path.join(dir, "Artist");
    fs.mkdirSync(input);
    // No panoramas, the Python version can crash on those (see the layout test above). Makes 4 rows.
    const sizes = [[640, 480], [300, 900], [1920, 1080], [500, 500], [1200, 400], [333, 777], [800, 600],
      [1600, 900], [450, 1300], [1000, 1000], [720, 1280], [640, 360]];
    const names = sizes.map((_, i) => `${[10, 2, 1, 33, 4, 5, 100, 7, 8, 9, 11, 0][i]}.png`);
    sizes.forEach(([w, h], i) => fs.writeFileSync(path.join(input, names[i]), makePng(w, h, i)));
    fs.writeFileSync(path.join(input, "notes.txt"), "not an image");

    const output = path.join(dir, "Artist.pur");
    const script = "import sys, pureref_gen; pureref_gen.generate(sys.argv[1], sys.argv[2])";
    const result = spawnSync("python3", ["-c", script, input, output], { cwd: ROOT, encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    const python = new Uint8Array(fs.readFileSync(output));

    // Build the same board in JS, using the PNGs Pillow made and the names the Python version gives
    const fromPython = PurFormat.readPurFile(python);
    const sorted = [...names].sort(PureRefGen.naturalCompare);
    const images = fromPython.images.map((image, i) => {
      const filePath = path.join(input, sorted[i]);
      assert.strictEqual(image.transforms[0].source, filePath);
      return { png: image.pngBinary, width: sizes[names.indexOf(sorted[i])][0], height: sizes[names.indexOf(sorted[i])][1], name: filePath, source: filePath };
    });
    const js = await bytesOf(await PurFormat.writePurFile(PureRefGen.generate(images, fromPython.folderLocation)));

    assert.strictEqual(js.length, python.length);
    assert.ok(Buffer.from(js).equals(Buffer.from(python)), "JS output differs from Python output");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Python reads and rewrites JS files to identical bytes", { skip: !havePython() && "python3 with Pillow not available" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pureref-parity-"));
  try {
    const purFile = sampleFile();
    // Python doesn't number text attached to images, and leaves nested text out of the header's ID counter
    purFile.images[0].transforms[1].textChildren = [];
    purFile.text = [textItem("Hello"), textItem("World")];
    const file = path.join(dir, "js.pur");
    fs.writeFileSync(file, await bytesOf(await PurFormat.writePurFile(purFile)));

    const script = "import sys; from purformat import PurFile; f = PurFile(); f.read(sys.argv[1]); f.write(sys.argv[2])";
    const result = spawnSync("python3", ["-c", script, file, path.join(dir, "py.pur")], { cwd: ROOT, encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(path.join(dir, "py.pur")).equals(fs.readFileSync(file)), "Python output differs from JS output");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// PureRef 2 (SQLite). These build databases with node:sqlite and are skipped when it's not available.
////////////////////////////////////////////////////////////////////////////////////////////////////

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  // Node older than 22.5
}
const noSqlite = !DatabaseSync && "node:sqlite not available";

function withDatabase(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pureref-sqlite-"));
  try {
    const file = path.join(dir, "test.db");
    const db = new DatabaseSync(file);
    setup(db);
    db.close();
    return new Uint8Array(fs.readFileSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readAll = (bytes) => SQLite.open((offset, length) => bytes.subarray(offset, offset + length), bytes.length);
const hex = (value) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value);
const plain = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, hex(value)]));

for (const [pageSize, encoding] of [[512, "UTF-8"], [4096, "UTF-8"], [65536, "UTF-8"], [1024, "UTF-16le"], [4096, "UTF-16be"]]) {
  test(`SQLite reader matches node:sqlite (${pageSize} byte pages, ${encoding})`, { skip: noSqlite }, () => {
    const integers = [0, 1, -1, 127, -128, 255, 32767, -32768, 8388607, -8388608, 2 ** 31 - 1, -(2 ** 31), 2 ** 40, -(2 ** 40),
      2 ** 47 - 1, -(2 ** 47), Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
    let expected;
    const bytes = withDatabase((db) => {
      db.exec(`PRAGMA page_size = ${pageSize}; PRAGMA encoding = '${encoding}';`);
      db.exec('CREATE TABLE things (a INTEGER, "b c" TEXT, d BLOB, e REAL, f, id INTEGER PRIMARY KEY)');
      db.exec("CREATE TABLE empty (x TEXT, y INTEGER PRIMARY KEY)");
      const insert = db.prepare('INSERT INTO things (a, "b c", d, e, f, id) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 400; i++) {
        const blobSize = [0, 1, 100, pageSize - 40, pageSize * 3 + 17, 70000][i % 6];
        insert.run(
          i % 19 === 18 ? null : BigInt(integers[i % integers.length]),
          i % 13 === 0 ? null : `row ${i} ünïcødé 🖼 `.repeat(1 + (i % 50)),
          new Uint8Array(crypto.randomBytes(blobSize)),
          i / 7,
          i % 2 ? "loose" : 1.5,
          BigInt(i * 3 + 1),
        );
      }
      expected = db.prepare("SELECT * FROM things ORDER BY id").all().map(plain);
    });

    const db = readAll(bytes);
    assert.deepStrictEqual(db.tables().sort(), ["empty", "things"]);
    assert.deepStrictEqual(db.rows("things").map(plain), expected);
    assert.deepStrictEqual(db.rows("empty"), []);
    assert.deepStrictEqual(db.rows("missing"), []);
  });
}

test("SQLite reader rejects other files", () => {
  assert.throws(() => readAll(new Uint8Array(200)), /Not a SQLite database/);
});

// The tables of a PureRef 2.1 scene
const PUREREF2_SCHEMA = `
  CREATE TABLE items_groups (lock_mode INTEGER,background_color TEXT,id INTEGER PRIMARY KEY);
  CREATE TABLE images (width INTEGER,source_type INTEGER,source TEXT,checksum TEXT,origin TEXT,data BLOB,format TEXT,height INTEGER,id INTEGER PRIMARY KEY);
  CREATE TABLE metadata (last_save_path TEXT,last_load_checksum TEXT,thumbnail BLOB,saved INTEGER,vertical_scroll INTEGER,last_load_path TEXT,horizontal_scroll INTEGER,scene_rect TEXT,view_transform TEXT,application_version TEXT,id INTEGER PRIMARY KEY);
  CREATE TABLE items (comment INTEGER,opacity REAL,z REAL,locked INTEGER,sort_order BLOB,parent INTEGER,transform BLOB,name TEXT,id INTEGER PRIMARY KEY);
  CREATE TABLE items_drawings (strokes BLOB,id INTEGER PRIMARY KEY);
  CREATE TABLE items_images (playback_frame INTEGER,playback_state INTEGER,flags INTEGER,image_bounds BLOB,playback_speed REAL,image_transform BLOB,image INTEGER,id INTEGER PRIMARY KEY);
  CREATE TABLE items_notes (fixed_size TEXT,background_color TEXT,text TEXT,style INTEGER,text_color TEXT,id INTEGER PRIMARY KEY);
`;

// Wrap a database the way PureRef 2 does: header and thumbnail in front, the database bytes they replace at the end
function makePur2(database, thumbnail) {
  const qstring = (s) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(s.length * 2);
    return Buffer.concat([length, Buffer.from(s, "utf16le").swap16()]);
  };
  const numbers = Buffer.alloc(12);
  numbers.writeBigUInt64BE(BigInt(database.length), 4);
  const thumbnailLength = Buffer.alloc(4);
  thumbnailLength.writeUInt32BE(thumbnail.length);
  const beforeChecksum = Buffer.concat([qstring("2.1"), numbers, qstring("2.1.3")]);
  const afterChecksum = Buffer.concat([thumbnailLength, thumbnail]);
  const headerLength = beforeChecksum.length + 68 + afterChecksum.length;
  const rest = Buffer.concat([afterChecksum, database.subarray(headerLength), database.subarray(0, headerLength)]);
  const checksum = qstring(crypto.createHash("md5").update(rest).digest("hex"));
  return new Uint8Array(Buffer.concat([beforeChecksum, checksum, rest]));
}

for (const thumbnailSize of [200, 10000]) {
  test(`reads images and notes from a PureRef 2 scene (${thumbnailSize} byte thumbnail)`, { skip: noSqlite }, () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...crypto.randomBytes(3000), 0xff, 0xd9]);
    const webp = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 "), ...crypto.randomBytes(500)]);
    const big = makePng(300, 300, 9);
    const images = [
      { data: makePng(40, 30, 1), format: "PNG", source: "/Users/someone/a.png" },
      { data: big, format: "PNG", source: "/Users/someone/big picture.png" },
      { data: jpeg, format: "JPG", source: "/Users/someone/photo.jpg" },
      { data: webp, format: "WEBP", source: "C:\\Users\\someone\\no item.webp" },
    ];
    const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, ...crypto.randomBytes(thumbnailSize - 3)]);

    const database = withDatabase((db) => {
      db.exec("PRAGMA page_size = 4096; PRAGMA auto_vacuum = 1; PRAGMA user_version = 200101; PRAGMA application_id = 940753918;");
      db.exec(PUREREF2_SCHEMA);
      const addImage = db.prepare("INSERT INTO images (width, source_type, source, checksum, origin, data, format, height, id) VALUES (10, 1, ?, ?, ?, ?, ?, 10, ?)");
      images.forEach((image, id) => addImage.run(image.source, crypto.createHash("md5").update(image.data).digest("hex"), image.source, image.data, image.format, BigInt(id)));
      const addItem = db.prepare("INSERT INTO items (opacity, z, locked, parent, name, id) VALUES (1.0, ?, 0, -1, ?, ?)");
      const addPlacement = db.prepare("INSERT INTO items_images (playback_frame, playback_state, flags, playback_speed, image, id) VALUES (0, 0, 1, 1.0, ?, ?)");
      [["first", 0], ["big picture", 1], ["photo", 2], ["photo copy", 2]].forEach(([name, image], id) => {
        addItem.run(BigInt(id), name, BigInt(id));
        addPlacement.run(BigInt(image), BigInt(id));
      });
      const addNote = db.prepare("INSERT INTO items_notes (text, style, id) VALUES (?, 0, ?)");
      addNote.run("Hello from a note", 10n);
      addNote.run("   ", 11n);
      db.prepare("INSERT INTO metadata (thumbnail, application_version, id) VALUES (?, '2.1.3', 0)").run(thumbnail);
    });
    const file = makePur2(database, thumbnail);

    assert.strictEqual(PureRef2.formatVersion(file), "2.1");
    const scene = PureRef2.readScene(file);
    assert.strictEqual(scene.applicationVersion, "2.1.3");
    assert.deepStrictEqual(scene.thumbnail, thumbnail);
    assert.strictEqual(scene.placements, 4);
    assert.deepStrictEqual(scene.notes, ["Hello from a note"]);
    assert.deepStrictEqual(scene.images.map((image) => [image.name, image.extension, image.mime]), [
      ["first", "png", "image/png"],
      ["big picture", "png", "image/png"],
      ["photo", "jpg", "image/jpeg"],
      ["", "webp", "image/webp"],
    ]);
    scene.images.forEach((image, i) => {
      assert.deepStrictEqual(image.data, images[i].data);
      assert.strictEqual(image.source, images[i].source);
      assert.strictEqual(crypto.createHash("md5").update(image.data).digest("hex"), image.checksum);
    });
  });
}

test("detects the .pur format version", async () => {
  const pur1 = await bytesOf(await PurFormat.writePurFile(sampleFile()));
  assert.strictEqual(PureRef2.formatVersion(pur1), "1.10");
  assert.strictEqual(PureRef2.formatVersion(makePng(4, 4)), null);
  assert.strictEqual(PureRef2.formatVersion(new Uint8Array(2)), null);
  assert.throws(() => PureRef2.readScene(pur1), /not a PureRef 2 file/);
});

// PureRef 2 stores QVariants as text with one character per byte
function qtTransform([a, b, c, d, e, f]) {
  const bytes = Buffer.alloc(5 + 72);
  bytes.writeUInt32BE(80, 0); // QTransform
  [a, b, 0, c, d, 0, e, f, 1].forEach((value, i) => bytes.writeDoubleBE(value, 5 + i * 8));
  return bytes.toString("latin1");
}

function qtPath(elements) {
  const name = Buffer.from("QPainterPath\0", "latin1");
  const head = Buffer.alloc(9);
  head.writeUInt32BE(1024, 0); // user type, followed by its name
  head.writeUInt32BE(name.length, 5);
  const body = Buffer.alloc(4 + elements.length * 20 + 8);
  body.writeUInt32BE(elements.length, 0);
  elements.forEach(([type, x, y], i) => {
    body.writeInt32BE(type, 4 + i * 20);
    body.writeDoubleBE(x, 8 + i * 20);
    body.writeDoubleBE(y, 16 + i * 20);
  });
  return Buffer.concat([head, name, body]).toString("latin1");
}

const rect = (w, h) => [[0, -w / 2, -h / 2], [1, w / 2, -h / 2], [1, w / 2, h / 2], [1, -w / 2, h / 2], [1, -w / 2, -h / 2]];
const curvedClip = [[0, -5, -10], [1, 5, -10], [2, 8, 0], [3, 8, 5], [3, 5, 10], [1, -5, 10], [1, -5, -10]];

function boardScene() {
  const database = withDatabase((db) => {
    db.exec(PUREREF2_SCHEMA);
    const addImage = db.prepare("INSERT INTO images (width, height, data, format, id) VALUES (?, ?, ?, 'PNG', ?)");
    addImage.run(40n, 30n, makePng(40, 30, 1), 0n);
    addImage.run(10n, 20n, makePng(10, 20, 2), 1n);
    const addItem = db.prepare("INSERT INTO items (z, opacity, parent, transform, name, id) VALUES (?, ?, ?, ?, ?, ?)");
    const addPlacement = db.prepare("INSERT INTO items_images (image, image_transform, image_bounds, id) VALUES (?, ?, ?, ?)");
    // Scaled and moved
    addItem.run(2, 1.0, -1n, qtTransform([2, 0, 0, 2, 100, 50]), "big", 0n);
    addPlacement.run(0n, qtTransform([1, 0, 0, 1, -20, -15]), qtPath(rect(40, 30)), 0n);
    // A moved, half transparent group with a rotated, cropped image in it
    addItem.run(1, 0.5, -1n, qtTransform([1, 0, 0, 1, 1000, 0]), "group", 1n);
    addItem.run(0, 0.8, 1n, qtTransform([0, 1, -1, 0, 10, 20]), "rotated", 2n);
    addPlacement.run(1n, qtTransform([1, 0, 0, 1, -5, -10]), qtPath(curvedClip), 2n);
    // Damaged values fall back to no transform and no crop
    addItem.run(3, 1.0, -1n, "not a transform", "plain", 3n);
    addPlacement.run(1n, null, "garbage", 3n);
  });
  return PureRef2.readScene(makePur2(database, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])));
}

test("reads where images are on a PureRef 2 board", { skip: noSqlite }, () => {
  const scene = boardScene();
  assert.deepStrictEqual(scene.items, [
    { image: 1, transform: [0, 1, -1, 0, 1010, 20], imageTransform: [1, 0, 0, 1, -5, -10], clip: curvedClip, opacity: 0.4 },
    { image: 0, transform: [2, 0, 0, 2, 100, 50], imageTransform: [1, 0, 0, 1, -20, -15], clip: rect(40, 30), opacity: 1 },
    { image: 1, transform: [1, 0, 0, 1, 0, 0], imageTransform: [1, 0, 0, 1, 0, 0], clip: null, opacity: 1 },
  ]);
  assert.strictEqual(scene.drawings, 0);
});

test("works out the size of a board", { skip: noSqlite }, () => {
  const scene = boardScene();
  const board = { images: new Map(scene.images.map((image) => [image.id, image])), items: scene.items };
  // The rotated image ends at x 1020, the plain one starts at 0,0 and the big one ends at y 80
  assert.deepStrictEqual(BoardRenderer.layout(board), { x: 0, y: 0, width: 1020, height: 80, scale: 1 });
  assert.deepStrictEqual(BoardRenderer.outputSize(BoardRenderer.layout(board), { maxSide: 510 }),
    { width: 510, height: 40, scale: 0.5, offsetX: 0, offsetY: 0 });
  const padded = BoardRenderer.outputSize(BoardRenderer.layout(board), { padding: 0.1 });
  assert.deepStrictEqual([padded.width, padded.height, padded.offsetX, padded.offsetY], [1224, 284, 102, 102]);
  assert.strictEqual(BoardRenderer.layout({ images: new Map(), items: [] }), null);
});
