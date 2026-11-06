# pdf-compress

Recompresses the images inside a PDF, in the browser. Every image is listed with its
size, format, colour space and effective DPI; pick a preset for all of them or set
mode / quality / DPI limit / colour per image, compare before and after, and save.
Nothing leaves the machine.

```sh
bun install
bun run dev        # http://localhost:5173
bun run build      # static site in dist/
bun test           # PDF + codec round-trip tests
bun run typecheck
bun run fixture    # writes fixture.pdf, a test PDF with assorted image types
bun scripts/corpus.ts <dir>             # run the image pipeline over a folder of PDFs
bun scripts/doc-options-check.ts <dir>  # check document options keep rendering + text identical
```

## Deploy (Cloudflare Pages)

`wrangler.jsonc` configures a static Pages project serving `dist/`; `public/_headers`
gives the hashed assets in `/assets/` a one-year immutable cache.

```sh
bunx wrangler login                                                       # once
bunx wrangler pages project create pdf-compress --production-branch main  # once
bun run deploy           # build + deploy to production (branch "main")
bun run deploy:preview   # build + deploy a preview (branch "preview")
bun run pages:dev        # build + serve locally through the Pages runtime
```

## Modes

| Mode     | Output                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- |
| Keep     | Image is left untouched.                                                                      |
| JPEG     | MozJPEG (RGB/gray); mupdf's libjpeg for CMYK.                                                 |
| Lossless | OxiPNG, embedded as Flate with PNG predictors (no recompression); own Flate encoder for CMYK. |
| Palette  | libimagequant (2–256 colours, dithering) → lossless → PDF `Indexed` colour space.             |

- **Max DPI** downsamples (Lanczos3) images whose _effective_ DPI — pixel size over the
  largest size the image is drawn at on any page — is above the limit. The page layout is
  unaffected.
- **Colour**: _Keep_ (default) re-encodes in the image's own colour space — ICC profiles,
  CMYK, Separation and Indexed bases are preserved. _Convert to RGB_ / _Grayscale_ convert
  with mupdf's colour management.
- A re-encoded image is only used if it is smaller than the original stream.

## Document options

| Option                                                                       | Default | What it does                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subset fonts                                                                 | on      | Keeps only the glyphs embedded fonts actually use (mupdf `subsetFonts`).                                                                                                                                                    |
| Remove editor leftovers                                                      | on      | Drops `/PieceInfo` (Illustrator/InDesign private data), page thumbnails and XMP metadata. Document XMP is kept when it declares PDF/A, PDF/UA, PDF/X, PDF/VT or PDF/E.                                                      |
| Clean content streams                                                        | on      | Rewrites page drawing commands without redundant operators (mupdf `sanitize`).                                                                                                                                              |
| Merge similar images                                                         | off     | Stores one copy of images that look alike and points every page at it. The slider (80–100 %) is the similarity of the _most different_ 12×12 block, so local changes (a label, different text) prevent merging.             |
| Crop to visible area                                                         | off     | Re-encoded images keep only the part visible on any page (from the clip regions seen while rendering). The cropped image is wrapped in a small form XObject under the original object number, so page content is unchanged. |
| Remove: attachments, JavaScript, alternate images, unused named destinations | off     | Opt-in removals. Removing named destinations breaks links into this file from _other_ documents.                                                                                                                            |

The size estimate only counts image changes; the other options apply when saving.

## Architecture

```
main thread (SolidJS 2 UI, src/lib/engine.ts)
 ├─ pdf worker (mupdf.js) ─ one instance, owns the document
 │    open + scan, decode pixels, thumbnails/previews, CMYK JPEG, save
 └─ codec pool (2–4 workers) ─ stateless: resize → MozJPEG / OxiPNG / libimagequant
```

- **Scan** (`src/lib/pdf-core.ts`): every `/Subtype /Image` stream that isn't used as a mask
  is listed. Each page is run through a mupdf device whose `fillImage` callback receives
  the same `fz_image` that `loadImage` returned, which maps placements (and so effective
  DPI) back to PDF objects.
- **Encode** (`src/lib/codec.ts`): pixels travel as RGBA-packed buffers (CMYK packed as
  C,M,Y,K). Results are cached per image by an options key, so switching settings back is
  instant. Changing settings aborts the running job by terminating its worker (Squoosh's
  approach).
- **Preview** decodes the encoded stream through mupdf exactly as a PDF reader would.
- **Save** opens a fresh copy of the original, merges references, swaps image streams
  (wrapping cropped ones), applies removals, and writes it without renumbering. A fresh
  parse of that is then font-subset and written with `garbage=deduplicate,compress,objstms`
  (+ `sanitize`). Two passes because compacting a document while mupdf.js still holds
  resolved object handles produced broken references in testing.
- **Merge** signatures (16×16 RGB means + a 384×384 gray copy) are computed once per image
  in the PDF worker; moving the slider only re-runs the comparison. Groups are formed
  greedily from the largest image, so every merged image is directly similar to the one
  that replaces it. The surviving image is encoded for the lowest DPI and the union of
  visible areas of everything it replaces.

## Limitations

- Soft masks (alpha) are kept as they are; they aren't recompressed. Images with masks
  are merged only when their masks are similar too, and aren't cropped.
- Inline images (`BI … ID … EI` inside content streams) aren't touched.
- Left as is: images with colour-key masks, and JPEG 2000 images with embedded alpha.
- Password-protected PDFs can't be opened.
- Pixels are decoded at full resolution; very large images (hundreds of megapixels) need
  a lot of memory.

## Licence

AGPL-3.0-or-later (mupdf.js is AGPL; libimagequant is GPL-3.0).
