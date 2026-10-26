/*
 * render.js - draw a whole PureRef board into one image, like it looks in PureRef.
 *
 * A board is { images: Map(id -> { data, mime, width, height }), items: [...] } where each item, in drawing
 * order, is { image, transform, imageTransform, clip, opacity }. Transforms are [a, b, c, d, e, f] like
 * canvas transforms: imageTransform places the image's pixels in the item, transform places the item on
 * the board. clip is the crop shape in item coordinates, as QPainterPath elements [[type, x, y], ...].
 *
 * Works as a plain <script> (exposes `BoardRenderer` on window) or as a CommonJS module (Node, for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BoardRenderer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const determinant = (m) => m[0] * m[3] - m[1] * m[2];

  // The corners of an item in its own coordinates: its crop shape, or else the whole image
  function outline(item, image) {
    if (item.clip) return item.clip.map(([, x, y]) => [x, y]);
    if (!image || !image.width || !image.height) return [];
    return [[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]]
      .map(([x, y]) => apply(item.imageTransform, x, y));
  }

  // The part of the board with images on it, and how many pixels per board unit show most images at
  // their own resolution. Returns null for an empty board.
  function layout(board) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const scales = [];
    for (const item of board.items) {
      for (const [x, y] of outline(item, board.images.get(item.image))) {
        const [bx, by] = apply(item.transform, x, y);
        left = Math.min(left, bx);
        top = Math.min(top, by);
        right = Math.max(right, bx);
        bottom = Math.max(bottom, by);
      }
      const area = Math.abs(determinant(item.transform) * determinant(item.imageTransform));
      if (area > 0) scales.push(1 / Math.sqrt(area));
    }
    if (!(right > left && bottom > top)) return null;
    scales.sort((a, b) => a - b);
    const scale = scales.length > 0 ? scales[Math.floor(scales.length / 2)] : 1;
    return { x: left, y: top, width: right - left, height: bottom - top, scale };
  }

  // The output size in pixels for a board: its own resolution, but at most maxSide pixels on the long
  // side and maxPixels in total
  function outputSize(box, { maxSide = 8192, maxPixels = 40e6, padding = 0 } = {}) {
    const margin = Math.max(box.width, box.height) * padding;
    const width = box.width + margin * 2;
    const height = box.height + margin * 2;
    const scale = Math.min(box.scale, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
      offsetX: (margin - box.x) * scale,
      offsetY: (margin - box.y) * scale,
    };
  }

  function tracePath(context, elements) {
    context.beginPath();
    for (let i = 0; i < elements.length; i++) {
      const [type, x, y] = elements[i];
      if (type === 0) {
        context.moveTo(x, y);
      } else if (type === 2 && i + 2 < elements.length) {
        context.bezierCurveTo(x, y, elements[i + 1][1], elements[i + 1][2], elements[i + 2][1], elements[i + 2][2]);
        i += 2;
      } else {
        context.lineTo(x, y);
      }
    }
    context.closePath();
  }

  async function decode(image) {
    const blob = new Blob([image.data], { type: image.mime });
    let bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    // If PureRef didn't apply the photo's rotation, neither should we
    if (image.width && image.height && bitmap.width === image.height && bitmap.height === image.width && image.width !== image.height) {
      try {
        const unrotated = await createImageBitmap(blob, { imageOrientation: "none" });
        bitmap.close();
        bitmap = unrotated;
      } catch (error) {
        // Keep the rotated one
      }
    }
    return bitmap;
  }

  // Draw the board on a new canvas. Options: background (a CSS colour, or null for transparent),
  // maxSide, maxPixels, padding (a fraction of the long side) and onProgress(done, total).
  // Resolves to { canvas, failed } where failed counts images this browser couldn't open.
  async function render(board, options = {}) {
    const box = layout(board);
    if (!box) throw new Error("There are no images on this board");
    const size = outputSize(box, options);

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The board is too large to draw in this browser");
    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, size.width, size.height);
    }

    let failed = 0;
    for (let i = 0; i < board.items.length; i++) {
      if (options.onProgress) options.onProgress(i, board.items.length);
      const item = board.items[i];
      const image = board.images.get(item.image);
      let bitmap;
      try {
        bitmap = await decode(image);
      } catch (error) {
        failed++;
        continue;
      }

      context.save();
      context.setTransform(size.scale, 0, 0, size.scale, size.offsetX, size.offsetY);
      context.transform(...item.transform);
      if (item.clip) {
        tracePath(context, item.clip);
        context.clip();
      }
      context.transform(...item.imageTransform);
      context.globalAlpha = item.opacity;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, image.width || bitmap.width, image.height || bitmap.height);
      context.restore();
      bitmap.close();
    }
    return { canvas, failed };
  }

  return { layout, outputSize, render };
});
