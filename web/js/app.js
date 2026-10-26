/*
 * app.js - the web page: collects images, turns them into .pur files and gets images back out of .pur files.
 */
(function () {
  "use strict";

  const { PurFormat, PureRef2, PureRefGen, Zip } = window;
  const $ = (id) => document.getElementById(id);

  const IMAGE_EXTENSION = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|webp|gif|bmp|avif|ico|tiff?|heic|heif)$/i;
  const DEFAULT_BOARD_NAME = "PureRef board";
  const PREVIEW_SIZE = 480;
  const EXTRACT_PREVIEW_LIMIT = 120;

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Helpers
  ////////////////////////////////////////////////////////////////////////////////////////////////

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
  }

  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const baseName = (path) => path.split(/[\\/]/).pop();
  const dirName = (path) => path.split("/").slice(0, -1).join("/");
  const withoutImageExtension = (name) => name.replace(IMAGE_EXTENSION, "");
  const isPur = (file) => /\.pur$/i.test(file.name);
  const isImage = (file) => file.type.startsWith("image/") || IMAGE_EXTENSION.test(file.name);
  const isHidden = (path) => path.split("/").some((part) => part.startsWith("."));

  function safeFileName(name, fallback) {
    const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^\.+/, "");
    return clean || fallback;
  }

  function uniqueName(name, used, extension) {
    let candidate = name + extension;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function showError(id, message) {
    $(id).textContent = message;
    $(id).hidden = !message;
  }

  async function withBusyButton(button, label, task) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await task();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Tabs
  ////////////////////////////////////////////////////////////////////////////////////////////////

  const tabs = [$("tab-create"), $("tab-extract")];

  function selectTab(tab) {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      $(other.getAttribute("aria-controls")).hidden = !selected;
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Getting files in: drag and drop (including folders) and file pickers. Files are { file, path }
  ////////////////////////////////////////////////////////////////////////////////////////////////

  function filesFromInput(input) {
    return [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  }

  // Must be called during the drop event, the entries are gone afterwards
  function filesFromDrop(dataTransfer) {
    const entries = [...dataTransfer.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
      .filter(Boolean);
    if (entries.length === 0) {
      return Promise.resolve([...dataTransfer.files].map((file) => ({ file, path: file.name })));
    }

    const found = [];
    const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        found.push({ file, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
    return (async () => {
      for (const entry of entries) await walk(entry, "");
      return found;
    })();
  }

  // Send .pur files to the extract tab and everything else to the create tab
  function handleIncoming(found) {
    const visible = found.filter(({ path }) => !isHidden(path));
    const purs = visible.filter(({ file }) => isPur(file));
    const images = visible.filter(({ file }) => !isPur(file) && isImage(file));

    if (images.length === 0 && purs.length > 0) {
      selectTab($("tab-extract"));
      extract(purs[0].file);
      return;
    }

    selectTab($("tab-create"));
    showError("create-error", "");
    addImages(images, visible.filter((entry) => !images.includes(entry)).map(({ path }) => path));
  }

  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes("Files");

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    document.body.classList.add("dragging");
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dragging");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    filesFromDrop(event.dataTransfer)
      .then(handleIncoming)
      .catch((error) => showError("create-error", `Couldn't read the dropped files: ${error.message}`));
  });

  for (const [buttonId, inputId] of [["pick-folder-button", "pick-folder"], ["pick-files-button", "pick-files"]]) {
    $(buttonId).addEventListener("click", () => $(inputId).click());
    $(inputId).addEventListener("change", (event) => {
      handleIncoming(filesFromInput(event.target));
      event.target.value = "";
    });
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // Images → .pur
  ////////////////////////////////////////////////////////////////////////////////////////////////

  const state = {
    files: [], // images waiting to be turned into boards
    ignored: [], // paths of dropped files that aren't images
    names: new Map(), // board key -> name typed by the user
    results: [], // { fileName, blob, url }
    busy: false,
    cancelled: false,
  };

  function addImages(images, ignored) {
    const known = new Set(state.files.map(({ file, path }) => `${path}\n${file.size}`));
    for (const image of images) {
      const key = `${image.path}\n${image.file.size}`;
      if (known.has(key)) continue;
      known.add(key);
      state.files.push(image);
    }
    state.ignored.push(...ignored);
    renderBoards();
  }

  const grouping = () => document.querySelector('input[name="grouping"]:checked').value;
  const lastSegments = (key, depth) => key.split("/").slice(-depth).join("/");

  // Like the Python script: each folder of images becomes a board, sorted by file name in natural order
  function groupBoards() {
    const single = grouping() === "single";
    const groups = new Map();
    for (const entry of state.files) {
      const key = single ? "*" : dirName(entry.path);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    const sortKey = single ? (entry) => entry.path : (entry) => baseName(entry.path);
    const boards = [...groups].map(([key, files]) => ({
      key,
      files: files.sort((a, b) => PureRefGen.naturalCompare(sortKey(a), sortKey(b))),
    }));
    boards.sort((a, b) => PureRefGen.naturalCompare(a.key, b.key));

    for (const board of boards) {
      if (single) {
        // The top folder, if everything came from one
        const tops = new Set(state.files.map(({ path }) => (path.includes("/") ? path.split("/")[0] : "")));
        board.defaultName = tops.size === 1 && !tops.has("") ? [...tops][0] : DEFAULT_BOARD_NAME;
      } else if (board.key === "") {
        board.defaultName = DEFAULT_BOARD_NAME;
      } else {
        // The folder name, with parent folders added when two folders have the same name
        const depthLimit = board.key.split("/").length;
        let depth = 1;
        const clashes = () =>
          boards.some((other) => other !== board && other.key !== "" && lastSegments(other.key, depth) === lastSegments(board.key, depth));
        while (depth < depthLimit && clashes()) depth++;
        board.defaultName = lastSegments(board.key, depth).split("/").join(" - ");
      }
      board.name = state.names.has(board.key) ? state.names.get(board.key) : board.defaultName;
    }
    return boards;
  }

  const REMOVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>';

  function renderBoards() {
    const boards = groupBoards();
    $("boards").hidden = state.busy || (boards.length === 0 && state.ignored.length === 0);

    $("board-list").replaceChildren(...boards.map((board) => {
      const item = element("li");
      const field = element("label", "board-field");
      const input = element("input", "board-name");
      input.value = board.name;
      input.placeholder = board.defaultName;
      input.spellcheck = false;
      input.setAttribute("aria-label", `File name for ${board.defaultName}`);
      input.addEventListener("input", () => state.names.set(board.key, input.value));
      field.append(input, element("span", "board-ext", ".pur"));

      const remove = element("button", "icon-button");
      remove.type = "button";
      remove.innerHTML = REMOVE_ICON;
      remove.setAttribute("aria-label", `Remove ${board.defaultName}`);
      remove.addEventListener("click", () => {
        state.files = state.files.filter((entry) => !board.files.includes(entry));
        renderBoards();
      });

      item.append(field, element("span", "count", plural(board.files.length, "image")), remove);
      return item;
    }));

    const createButton = $("create-button");
    createButton.textContent = boards.length === 1 ? "Create .pur file" : `Create ${boards.length} .pur files`;
    createButton.disabled = boards.length === 0;
    $("board-list").hidden = boards.length === 0;

    const ignored = state.ignored;
    const examples = ignored.slice(0, 3).map(baseName).join(", ");
    $("ignored").textContent = boards.length === 0
      ? `No images found. ${plural(ignored.length, "file")} skipped: ${examples}${ignored.length > 3 ? "…" : ""}`
      : `Skipped ${plural(ignored.length, "file")} that ${ignored.length === 1 ? "isn't an image" : "aren't images"}: ${examples}${ignored.length > 3 ? ` and ${ignored.length - 3} more` : ""}.`;
    $("ignored").hidden = ignored.length === 0;
  }

  document.querySelectorAll('input[name="grouping"]').forEach((radio) => radio.addEventListener("change", renderBoards));

  $("clear-button").addEventListener("click", () => {
    state.files = [];
    state.ignored = [];
    state.names.clear();
    renderBoards();
  });

  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      } catch (error) {
        // Fall back to <img>, which some browsers can open more formats with
      }
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch (error) {
      URL.revokeObjectURL(url);
      throw new Error("not an image this browser can open");
    }
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  }

  // Decode any image the browser understands and store it as a PNG, like the Python version does.
  // Also keeps a small copy for the preview.
  async function loadImage(file, path, thumbnailSize) {
    const { image, width, height, release } = await decode(file);
    try {
      if (!width || !height) throw new Error("couldn't read the image size");

      const canvas = element("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("too large to convert in this browser");
      context.drawImage(image, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0; // free the memory now
      if (!png) throw new Error("too large to convert in this browser");

      const scale = Math.min(1, thumbnailSize / Math.max(width, height));
      const thumbnail = element("canvas");
      thumbnail.width = Math.max(1, Math.round(width * scale));
      thumbnail.height = Math.max(1, Math.round(height * scale));
      const thumbnailContext = thumbnail.getContext("2d");
      thumbnailContext.imageSmoothingQuality = "high";
      thumbnailContext.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);

      return { png, width, height, name: withoutImageExtension(baseName(path)), source: path, thumbnail };
    } finally {
      release();
    }
  }

  function drawPreview(purFile, images) {
    const transforms = purFile.images.map((image) => image.transforms[0]);
    const height = transforms.reduce((bottom, t) => Math.max(bottom, t.y + t.height / 2), 0);
    const scale = Math.min(PREVIEW_SIZE / 1000, PREVIEW_SIZE / height);
    const canvas = element("canvas");
    canvas.width = Math.max(1, Math.round(1000 * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    transforms.forEach((t, i) => {
      context.drawImage(images[i].thumbnail, (t.x - t.width / 2) * scale, (t.y - t.height / 2) * scale, t.width * scale, t.height * scale);
    });
    return canvas;
  }

  function setProgress(fraction, text) {
    const percent = Math.round(fraction * 100);
    $("progress-fill").style.width = `${percent}%`;
    document.querySelector(".progress-bar").setAttribute("aria-valuenow", String(percent));
    $("progress-text").textContent = text;
  }

  function renderResult(result) {
    const item = element("li", "result");
    result.preview.setAttribute("role", "img");
    result.preview.setAttribute("aria-label", `Preview of ${result.fileName}`);

    const body = element("div", "result-body");
    const text = element("div", "result-text");
    text.append(
      element("div", "result-name", result.fileName),
      element("div", "result-meta", `${plural(result.count, "image")} · ${formatBytes(result.blob.size)}`),
    );
    const link = element("a", "button small", "Download");
    link.href = result.url;
    link.download = result.fileName;
    body.append(text, link);

    item.append(result.preview, body);
    $("result-list").append(item);
    $("results").hidden = false;
    $("download-all-button").hidden = state.results.length < 2;
  }

  function renderSkipped(skipped) {
    const details = $("skipped");
    details.hidden = skipped.length === 0;
    details.querySelector("summary").textContent = `${plural(skipped.length, "file")} couldn't be added`;
    details.querySelector("ul").replaceChildren(...skipped.map((line) => element("li", "", line)));
  }

  async function createBoards() {
    const boards = groupBoards();
    const total = boards.reduce((count, board) => count + board.files.length, 0);
    const used = new Set(state.results.map((result) => result.fileName.toLowerCase()));
    const skipped = [];
    let done = 0;

    state.busy = true;
    state.cancelled = false;
    state.files = [];
    state.ignored = [];
    state.names.clear();
    renderBoards();
    $("progress").hidden = false;

    let index = 0;
    for (; index < boards.length && !state.cancelled; index++) {
      const board = boards[index];
      const fileName = uniqueName(safeFileName(board.name, DEFAULT_BOARD_NAME), used, ".pur");
      // Thumbnails just big enough for the preview, so huge boards don't use much memory
      const thumbnailSize = Math.max(32, Math.min(PREVIEW_SIZE, Math.round(PREVIEW_SIZE / Math.sqrt(board.files.length))));
      const images = [];

      for (const { file, path } of board.files) {
        if (state.cancelled) break;
        setProgress(done / total, `Adding ${path}`);
        try {
          images.push(await loadImage(file, path, thumbnailSize));
        } catch (error) {
          skipped.push(`${path}: ${error.message}`);
        }
        done++;
      }
      if (state.cancelled) break;
      if (images.length === 0) continue;

      setProgress(done / total, `Saving ${fileName}`);
      try {
        const purFile = PureRefGen.generate(images);
        const blob = await PurFormat.writePurFile(purFile);
        const result = { fileName, blob, url: URL.createObjectURL(blob), count: images.length, preview: drawPreview(purFile, images) };
        state.results.push(result);
        renderResult(result);
      } catch (error) {
        used.delete(fileName.toLowerCase());
        skipped.push(`${fileName}: ${error.message}`);
      }
    }

    // When stopped, put the boards that weren't finished back in the list
    for (const board of boards.slice(index)) {
      state.files.push(...board.files);
      if (board.name !== board.defaultName) state.names.set(board.key, board.name);
    }

    state.busy = false;
    $("progress").hidden = true;
    setProgress(0, "");
    renderBoards();
    renderSkipped(skipped);
  }

  $("create-button").addEventListener("click", () => {
    if (!state.busy) createBoards();
  });

  $("cancel-button").addEventListener("click", () => {
    state.cancelled = true;
    $("progress-text").textContent = "Stopping…";
  });

  $("download-all-button").addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, "Zipping…", async () => {
      try {
        const zip = await Zip.createZip(state.results.map((result) => ({ name: result.fileName, data: result.blob })));
        downloadBlob(zip, "PureRef boards.zip");
      } catch (error) {
        showError("create-error", error.message);
      }
    });
  });

  $("clear-results-button").addEventListener("click", () => {
    state.results.forEach((result) => URL.revokeObjectURL(result.url));
    state.results = [];
    $("result-list").replaceChildren();
    $("results").hidden = true;
    renderSkipped([]);
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.busy) return;
    event.preventDefault();
    event.returnValue = "";
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////
  // .pur → images
  ////////////////////////////////////////////////////////////////////////////////////////////////

  let extracted = { urls: [], entries: [], zipName: "" };

  // The images (with names and file types), notes and number of placements in a PureRef 1.x or 2.x file
  function readBoard(buffer) {
    const version = PureRef2.formatVersion(buffer);

    if (version && /^2\./.test(version)) {
      const scene = PureRef2.readScene(buffer);
      return {
        images: scene.images.map((image) => ({
          name: image.name || withoutImageExtension(baseName(image.source)),
          extension: image.extension,
          mime: image.mime,
          data: image.data,
        })),
        placements: scene.placements,
        notes: scene.notes,
        thumbnail: scene.thumbnail,
        savedWith: `PureRef ${scene.applicationVersion || version}`,
      };
    }

    if (version !== "1.10") {
      throw new Error("This isn't a PureRef file this site can read. It reads files from PureRef 1.10, 1.11 and 2.");
    }
    const purFile = PurFormat.readPurFile(buffer);
    const images = [];
    for (const image of purFile.images) {
      if (image.pngBinary.length <= 4) continue; // a link to an image that isn't stored in the file
      const transform = image.transforms[0];
      let name = "";
      if (transform && transform.name && transform.name !== "image") name = transform.name;
      else if (transform && transform.source !== "BruteForceLoaded") name = transform.source;
      images.push({ name: withoutImageExtension(baseName(name)), extension: "png", mime: "image/png", data: image.pngBinary });
    }

    const notes = [];
    const collect = (text) => {
      if (text.text.trim()) notes.push(text.text);
      text.textChildren.forEach(collect);
    };
    purFile.text.forEach(collect);
    purFile.images.forEach((image) => image.transforms.forEach((t) => t.textChildren.forEach(collect)));

    const placements = purFile.images.reduce((count, image) => count + image.transforms.length, 0);
    return { images, placements, notes, thumbnail: null, savedWith: "" };
  }

  async function extract(file) {
    extracted.urls.forEach((url) => URL.revokeObjectURL(url));
    extracted = { urls: [], entries: [], zipName: `${file.name.replace(/\.pur$/i, "")} images.zip` };
    showError("extract-error", "");
    $("extract-result").hidden = true;

    let board;
    try {
      board = readBoard(await file.arrayBuffer());
    } catch (error) {
      showError("extract-error", `Couldn't read ${file.name}: ${error.message}`);
      return;
    }

    const used = new Set();
    const images = board.images.map((image, i) => ({
      name: uniqueName(safeFileName(image.name, `image ${i + 1}`), used, `.${image.extension}`),
      data: image.data,
      mime: image.mime,
    }));
    const notes = board.notes;

    extracted.entries = images.map(({ name, data }) => ({ name, data }));
    if (notes.length > 0) {
      extracted.entries.push({ name: uniqueName("notes", used, ".txt"), data: new TextEncoder().encode(`${notes.join("\n\n")}\n`) });
    }

    const summary = [images.length > 0 ? plural(images.length, "image") : "No images"];
    if (board.placements > images.length) summary.push(`${board.placements} on the board`);
    if (notes.length > 0) summary.push(plural(notes.length, "text note"));
    if (board.savedWith) summary.push(`saved with ${board.savedWith}`);
    summary.push(formatBytes(file.size));
    $("extract-name").textContent = file.name;
    $("extract-summary").textContent = summary.join(" · ");
    $("extract-download-button").hidden = extracted.entries.length === 0;

    const thumbnail = $("extract-thumbnail");
    thumbnail.hidden = !board.thumbnail;
    thumbnail.removeAttribute("src");
    if (board.thumbnail) {
      thumbnail.src = URL.createObjectURL(new Blob([board.thumbnail], { type: "image/jpeg" }));
      extracted.urls.push(thumbnail.src);
    }

    $("extract-grid").replaceChildren(...images.slice(0, EXTRACT_PREVIEW_LIMIT).map(({ name, data, mime }) => {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      extracted.urls.push(url);
      const item = element("li");
      const link = element("a");
      link.href = url;
      link.download = name;
      link.title = name;
      const img = element("img");
      img.src = url;
      img.alt = name;
      img.loading = "lazy";
      img.decoding = "async";
      link.append(img);
      item.append(link);
      return item;
    }));
    const more = images.length - EXTRACT_PREVIEW_LIMIT;
    $("extract-more").textContent = more > 0 ? `${plural(more, "more image")} ${more === 1 ? "is" : "are"} in the zip.` : "";
    $("extract-more").hidden = more <= 0;
    $("extract-result").hidden = false;
  }

  $("pick-pur-button").addEventListener("click", () => $("pick-pur").click());
  $("pick-pur").addEventListener("change", (event) => {
    if (event.target.files[0]) extract(event.target.files[0]);
    event.target.value = "";
  });

  $("extract-download-button").addEventListener("click", (event) => {
    withBusyButton(event.currentTarget, "Zipping…", async () => {
      try {
        downloadBlob(await Zip.createZip(extracted.entries), extracted.zipName);
      } catch (error) {
        showError("extract-error", error.message);
      }
    });
  });
})();
