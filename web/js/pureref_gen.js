/*
 * pureref_gen.js - create a neatly organised PureRef board from a list of images.
 *
 * JavaScript port of pureref_gen.py. Decoding images into PNGs happens in app.js;
 * this file only orders and places them, so it can be tested in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./purformat.js"));
  else root.PureRefGen = factory(root.PurFormat);
})(typeof self !== "undefined" ? self : this, function (PurFormat) {
  "use strict";

  // Natural sort https://stackoverflow.com/a/341745
  // For example: 0.jpg, 2.jpg, 10.jpg, 100.jpg instead of: 0.jpg, 10.jpg, 100.jpg, 2.jpg
  // Same ordering as Python's sorted(key=natural_keys): numbers by value, everything else by code point.
  function naturalKeys(text) {
    return text.split(/(\d+)/); // odd indices are numbers
  }

  function compareNumbers(a, b) {
    a = a.replace(/^0+/, "");
    b = b.replace(/^0+/, "");
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function naturalCompare(a, b) {
    const ka = naturalKeys(a);
    const kb = naturalKeys(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      const order = i % 2 ? compareNumbers(ka[i], kb[i]) : ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
      if (order !== 0) return order;
    }
    return ka.length - kb.length;
  }

  // Python's sum() of floats, which uses Neumaier summation since Python 3.12
  function sum(values) {
    if (values.length === 0) return 0;
    let total = values[0];
    let compensation = 0.0;
    for (let i = 1; i < values.length; i++) {
      const x = values[i];
      const t = total + x;
      compensation += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
      total = t;
    }
    return compensation && Number.isFinite(compensation) ? total + compensation : total;
  }

  const sumWidths = (transforms) => sum(transforms.map((transform) => transform.width));

  // Place the transforms in rows that form a rectangle, keeping their order
  function arrange(transforms) {
    transforms.forEach((transform) => transform.scaleToHeight(1000)); // normalize all images to height 1000

    let totalWidth = sumWidths(transforms);

    // Divide into rows by cutting in half until it is rectangular enough
    let rows = [transforms];
    while (rows.length * 2000.0 < totalWidth) { // while more wide than tall, eventually making a decent rectangle
      totalWidth /= 2.0;
      const newRows = [];

      for (const row of rows) {
        // get the index of the middle transform by summing widths until it exceeds half of the total width
        let rowLength = totalWidth;
        let middleIndex = 0;
        while (rowLength > 0 && middleIndex < row.length) { // the Python version crashes on short rows here
          rowLength -= row[middleIndex].width;
          middleIndex += 1;
        }

        // split the row in half
        newRows.push(row.slice(0, middleIndex));
        newRows.push(row.slice(middleIndex));
      }

      rows = newRows;
    }

    // Normalize row widths and actually place images, this makes everything line up perfectly.
    let placementY = 0;

    for (const row of rows.filter((row) => row.length > 0)) {
      const rowWidth = sumWidths(row);
      const scaleFactor = 1000 / rowWidth; // the entire row is normalized to 1000 width

      let placementX = 0;
      for (const transform of row) {
        transform.scale(scaleFactor);

        transform.x = placementX + transform.width / 2;
        placementX += transform.width;
        transform.y = placementY + transform.height / 2;
      }

      placementY += 1000 * scaleFactor; // images are 1000 height and scaled to row width
    }

    return { width: 1000, height: placementY };
  }

  // images: [{ png: Uint8Array|Blob, width, height, name, source }] in the order they should appear.
  // Returns a PurFile ready for PurFormat.writePurFile().
  function generate(images, folderLocation) {
    const purFile = new PurFormat.PurFile();
    if (folderLocation !== undefined) purFile.folderLocation = folderLocation;

    purFile.images = images.map((image) => {
      const purImage = new PurFormat.PurImage();
      purImage.pngBinary = image.png;

      const transform = new PurFormat.PurGraphicsImageItem();
      transform.resetCrop(image.width, image.height);
      transform.name = image.name;
      transform.source = image.source;
      purImage.transforms = [transform];

      return purImage;
    });

    arrange(purFile.images.map((image) => image.transforms[0]));
    return purFile;
  }

  return { naturalCompare, arrange, generate };
});
