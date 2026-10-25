// Tests for the web version. Run with: node --test tests/
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
