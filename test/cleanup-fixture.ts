/** A PDF exercising the document-level options. Object numbers are returned in `ids`. */
import * as mupdf from "mupdf";

function photo(w: number, h: number, mark = false): mupdf.Pixmap {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(128 + 100 * Math.sin((x * (c + 2)) / 41 + y / (29 + c * 5)));
      // A small black label: same picture otherwise.
      if (mark && x >= 150 && x < 190 && y >= 120 && y < 135) px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return pix;
}

const xmp = (extra = "") =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"${extra}>${"<dc:x>padding</dc:x>".repeat(200)}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

export function makeCleanupFixture(options: { pdfa?: boolean } = {}) {
  const doc = new mupdf.PDFDocument();
  const name = (n: string) => doc.newName(n);

  // An embedded (CID, Identity-H) font: text is written as 2-byte glyph ids.
  const times = new mupdf.Font("Times-Roman");
  const font = doc.addFont(times);
  const glyphs = (text: string) =>
    "<" + [...text].map((c) => times.encodeCharacter(c).toString(16).padStart(4, "0")).join("") + ">";
  const photoA = doc.addImage(new mupdf.Image(photo(400, 300).asJPEG(95, false)));
  const photoACopy = doc.addImage(new mupdf.Image(photo(400, 300).asJPEG(70, false)));
  const photoMarked = doc.addImage(new mupdf.Image(photo(400, 300, true).asJPEG(95, false)));
  const clipped = doc.addImage(new mupdf.Image(photo(400, 400)));
  const thumb = doc.addImage(new mupdf.Image(photo(40, 50)));
  const alternate = doc.addImage(new mupdf.Image(photo(200, 150).asJPEG(80, false)));
  // JPEG + soft mask, like a logo with transparency embedded on several pages.
  const alphaJpeg = (quality: number, invertMask = false) => {
    const w = 300;
    const h = 340;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = (x - w / 2) ** 2 / (w / 2) ** 2 + (y - h / 2) ** 2 / (h / 2) ** 2 < 1;
        mask[y * w + x] = inside !== invertMask ? 255 : 0;
      }
    }
    const smask = doc.addStream(mask, {
      Type: name("XObject"),
      Subtype: name("Image"),
      Width: w,
      Height: h,
      BitsPerComponent: 8,
      ColorSpace: name("DeviceGray"),
    });
    const dict = doc.newDictionary();
    dict.put("Type", name("XObject"));
    dict.put("Subtype", name("Image"));
    dict.put("Width", w);
    dict.put("Height", h);
    dict.put("BitsPerComponent", 8);
    dict.put("ColorSpace", name("DeviceRGB"));
    dict.put("Filter", name("DCTDecode"));
    dict.put("SMask", smask);
    return doc.addRawStream(photo(w, h).asJPEG(quality, false), dict);
  };
  const alphaA = alphaJpeg(95);
  const alphaB = alphaJpeg(75);
  const alphaOtherMask = alphaJpeg(95, true);

  const alternates = doc.newArray();
  const alt = doc.newDictionary();
  alt.put("Image", alternate);
  alternates.push(alt);
  photoA.put("Alternates", alternates);

  const resources = doc.addObject({});
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  resources.put("Font", fonts);
  const xobjects = doc.newDictionary();
  xobjects.put("A", photoA);
  xobjects.put("B", photoACopy);
  xobjects.put("M", photoMarked);
  xobjects.put("C", clipped);
  xobjects.put("L1", alphaA);
  xobjects.put("L2", alphaB);
  xobjects.put("L3", alphaOtherMask);
  resources.put("XObject", xobjects);

  const page1 = doc.addPage(
    [0, 0, 612, 792],
    0,
    resources,
    [
      `BT /F1 24 Tf 72 720 Td ${glyphs("Hello subset fonts")} Tj ET`,
      `BT 3 Tr /F1 12 Tf 72 700 Td ${glyphs("invisible ocr text")} Tj ET`,
      "q 200 0 0 150 72 500 cm /A Do Q",
      // Only the top-left quarter of C is inside the clip.
      "q 50 150 100 100 re W n 200 0 0 200 50 50 cm /C Do Q",
      "q 1 0 0 1 0 0 cm 0 0 1 rg 300 300 50 50 re f Q",
    ].join("\n"),
  );
  const pieceInfo = doc.newDictionary();
  const illustrator = doc.newDictionary();
  illustrator.put("Private", doc.addStream("x".repeat(20000), {}));
  pieceInfo.put("Illustrator", illustrator);
  page1.put("PieceInfo", pieceInfo);
  page1.put("Thumb", thumb);
  page1.put("Metadata", doc.addStream(xmp(), { Type: name("Metadata"), Subtype: name("XML") }));
  const page2 = doc.addPage(
    [0, 0, 612, 792],
    0,
    resources,
    [
      "q 200 0 0 150 72 500 cm /B Do Q",
      "q 200 0 0 150 300 500 cm /M Do Q",
      "q 60 0 0 68 72 300 cm /L1 Do Q",
      "q 90 0 0 102 172 300 cm /L2 Do Q",
      "q 60 0 0 68 300 300 cm /L3 Do Q",
    ].join("\n"),
  );
  doc.insertPage(-1, page1);
  doc.insertPage(-1, page2);

  const catalog = doc.getTrailer().get("Root");
  const conformance = options.pdfa ? ` xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2"` : "";
  catalog.put("Metadata", doc.addStream(xmp(conformance), { Type: name("Metadata"), Subtype: name("XML") }));

  // JavaScript: an open action and a document-level script.
  const js = doc.newDictionary();
  js.put("S", name("JavaScript"));
  js.put("JS", doc.newString("app.alert('hi')"));
  catalog.put("OpenAction", js);
  const names = doc.newDictionary();
  const jsTree = doc.newDictionary();
  const jsNames = doc.newArray();
  jsNames.push(doc.newString("init"));
  jsNames.push(doc.addObject(js));
  jsTree.put("Names", jsNames);
  names.put("JavaScript", jsTree);

  // Named destinations: "used" is the target of a link, "unused" isn't.
  const pageRef = doc.findPage(0);
  const dest = () => {
    const d = doc.newArray();
    d.push(pageRef);
    d.push(name("Fit"));
    return d;
  };
  const destTree = doc.newDictionary();
  const destNames = doc.newArray();
  destNames.push(doc.newString("unused"));
  destNames.push(dest());
  destNames.push(doc.newString("used"));
  destNames.push(dest());
  destTree.put("Names", destNames);
  names.put("Dests", destTree);
  catalog.put("Names", names);

  const link = doc.newDictionary();
  link.put("Type", name("Annot"));
  link.put("Subtype", name("Link"));
  const rect = doc.newArray();
  [72, 72, 144, 96].forEach((v) => rect.push(v));
  link.put("Rect", rect);
  link.put("Dest", doc.newString("used"));
  const annots = doc.newArray();
  annots.push(doc.addObject(link));
  doc.findPage(1).put("Annots", annots);

  doc.insertEmbeddedFile(
    "notes.txt",
    doc.addEmbeddedFile("notes.txt", "text/plain", "y".repeat(30000), new Date(0), new Date(0)),
  );

  const bytes = new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
  const ids = {
    photoA: photoA.asIndirect(),
    photoACopy: photoACopy.asIndirect(),
    photoMarked: photoMarked.asIndirect(),
    clipped: clipped.asIndirect(),
    thumb: thumb.asIndirect(),
    alternate: alternate.asIndirect(),
    alphaA: alphaA.asIndirect(),
    alphaB: alphaB.asIndirect(),
    alphaOtherMask: alphaOtherMask.asIndirect(),
  };
  doc.destroy();
  return { bytes, ids };
}
