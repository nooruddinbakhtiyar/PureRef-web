# PureRef-format  

A Python script to automatically generate organised PureRef (1.10/1.11.1) .pur files from folders of images, and a module you can use to convert .pur files to/from any other file format.

### Web version (no Python needed)
**https://nooruddinbakhtiyar.github.io/PureRef-web/**

The same generator, running entirely in your browser. Nothing is uploaded.
- **Images → .pur:** drop folders (or pick a folder/images). Each folder becomes its own organised .pur file, or switch to "All in one" for a single board. Rename boards before creating them, then download them one by one or all at once as a .zip.
- **.pur → images:** drop a .pur file to get all its images back out (plus any text notes) as a .zip. Works with files from PureRef 1.10, 1.11 and 2 (PureRef 2 files keep each image's original format).

It produces the same files as the Python script, with a few differences:
- Accepts any image your browser can open (JPG, PNG, WebP, GIF, BMP, AVIF...), not only .jpg/.jpeg/.png, and keeps transparency.
- Applies photo rotation (EXIF orientation), so phone photos aren't sideways.
- Doesn't crash on very wide images (panoramas), which can make the Python script fail with an `IndexError`.

The site is plain HTML/JS in [`web/`](web), with no build step and no dependencies. You can also download the repository and open `web/index.html` directly.

<details>
<summary>Hosting and development</summary>

The [Web workflow](.github/workflows/web.yml) runs the tests and publishes `web/` to GitHub Pages on every push to `main`. To turn on hosting, open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.

Run the tests with `node --test tests/*.test.js` (Node 18+). With Python 3.12+ and `pip install -r requirements.txt`, they also check that the web version writes exactly the same bytes as the Python version.

`web/js/purformat.js` and `web/js/pureref_gen.js` are ports of the Python modules and work in Node too, so you can use them to write your own converters in JavaScript. `web/js/pureref2.js` reads the PureRef 2 format, which is a SQLite database behind a small header (the layout is described at the top of that file).
</details>

### Video
[![Watch the video](https://img.youtube.com/vi/31lsz3JNtCU/hqdefault.jpg)](https://youtu.be/31lsz3JNtCU)

### Usage (Python)
You will need to install Python if you don't have it already (I use 3.8.10), be sure to enable the option to add it to your PATH during installation (for Windows users).  
Navigate to the PureRef-format folder, and in a command prompt type: `python pureref_gen_script.py`  
Without arguments, this will create new folders called "Artists" and "Purs", add folders with images to the "Artists" folder and run the script again.  
For each image folder in the "Artists" folder, an organised .pur file containing these images will be created in the "Purs" folder.  
Example:
```
Artists/
    Artist1/
        Image1.jpg
        Image2.jpg
        Image3.png
    Artist2/
        Image1.jpg
        Image2.jpeg
        Image3.jpeg
Purs/
    Artist1.pur
    Artist2.pur
```

You may also pass arguments to specify the input folder and output folder, for example `python pureref_gen_script.py input output`  

If your input folder does not have subfolders with images, the script will try to use images in the input folder directly.  
Already existing .pur files will be skipped, so delete them if you want to regenerate them. Empty files will not be generated.  

### Content
`pureref_gen_script.py` script to convert all folders (default Artists/) to .pur files (default Purs/)  
`pureref_gen.py` module with a function to generate an organised PureRef .pur file from a folder of images  
`purformat.py` module with a reader and writer for PureRef files, can be used to write your own converter 
`web/` the web version: `js/purformat.js` (reader/writer), `js/pureref_gen.js` (layout), `js/pureref2.js` + `js/sqlite.js` (PureRef 2 reader), `js/app.js` (the page)

### About
I was inspired to create this after making an Artstation webscraper: https://github.com/FyorUU/Artstation-webscraper  
Because I like collecting huge amounts of reference which I wanted to save time on, and wondered if the next step (putting the images in PureRef files) could be automated too.
