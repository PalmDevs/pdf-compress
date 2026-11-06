/** Document-level rewrites applied to the copy being saved. */
import type * as mupdf from "mupdf";

/**
 * Visits every dictionary and array reachable inside every object (not following references).
 *
 * Note: objects are accessed through their indirect references, never `.resolve()`d.
 * Holding resolved handles while mupdf later renumbers objects (garbage=compact)
 * produced broken references in testing; PdfSession.save also compacts in a
 * separate pass for the same reason.
 */
export function forEachContainer(doc: mupdf.PDFDocument, fn: (container: mupdf.PDFObject) => void) {
  const visit = (o: mupdf.PDFObject) => {
    if (!o.isDictionary() && !o.isArray()) return;
    fn(o);
    const children: mupdf.PDFObject[] = [];
    o.forEach((v) => {
      if (!v.isIndirect() && (v.isDictionary() || v.isArray())) children.push(v);
    });
    children.forEach(visit);
  };
  const count = doc.countObjects();
  for (let num = 1; num < count; num++) {
    try {
      visit(doc.newIndirect(num));
    } catch {
      // Broken or free object.
    }
  }
}

function entries(o: mupdf.PDFObject): [string | number, mupdf.PDFObject][] {
  const out: [string | number, mupdf.PDFObject][] = [];
  o.forEach((v, k) => out.push([k, v]));
  return out;
}

/** Points every reference to a key of `map` at its value instead. */
export function replaceReferences(doc: mupdf.PDFDocument, map: Map<number, number>) {
  if (map.size === 0) return;
  forEachContainer(doc, (o) => {
    for (const [key, value] of entries(o)) {
      if (value.isIndirect() && map.has(value.asIndirect())) {
        o.put(key, doc.newIndirect(map.get(value.asIndirect())!));
      }
    }
  });
}

/** Deletes a dictionary key; a no-op on anything that isn't a dictionary. */
function deleteKey(o: mupdf.PDFObject, key: string) {
  if (o.isDictionary()) o.delete(key);
}

function catalogOf(doc: mupdf.PDFDocument): mupdf.PDFObject {
  return doc.getTrailer().get("Root");
}

/** PDF/A, PDF/UA, PDF/X and friends require the document's XMP metadata. */
function claimsConformance(metadata: mupdf.PDFObject): boolean {
  if (!metadata.isStream()) return false;
  const xmp = metadata.readStream().asString();
  return /pdfa(id)?:part|pdfuaid:|pdfxid:|pdfvtid:|pdfeid:/i.test(xmp);
}

/** Removes editor private data (/PieceInfo), page thumbnails and XMP metadata. */
export function removeLeftovers(doc: mupdf.PDFDocument) {
  const keepDocumentXmp = claimsConformance(catalogOf(doc).get("Metadata"));
  forEachContainer(doc, (o) => {
    if (!o.isDictionary()) return;
    o.delete("PieceInfo");
    const type = o.get("Type").asName();
    if (type === "Page") o.delete("Thumb");
    if (o.get("Metadata").isStream() && !(type === "Catalog" && keepDocumentXmp)) o.delete("Metadata");
  });
}

export function removeAttachments(doc: mupdf.PDFDocument) {
  const catalog = catalogOf(doc);
  deleteKey(catalog.get("Names"), "EmbeddedFiles");
  deleteKey(catalog, "Collection");
  forEachContainer(doc, (o) => {
    if (!o.isDictionary()) return;
    o.delete("AF");
    if (o.get("Type").asName() !== "Page") return;
    const annots = o.get("Annots");
    if (!annots.isArray()) return;
    for (let i = annots.length - 1; i >= 0; i--) {
      const annot = annots.get(i);
      if (annot.isDictionary() && annot.get("Subtype").asName() === "FileAttachment") annots.delete(i);
    }
  });
}

function isJavaScriptAction(o: mupdf.PDFObject): boolean {
  return o.isDictionary() && o.get("S").asName() === "JavaScript";
}

export function removeJavaScript(doc: mupdf.PDFDocument) {
  deleteKey(catalogOf(doc).get("Names"), "JavaScript");
  forEachContainer(doc, (o) => {
    const doomed = entries(o)
      .filter(([, v]) => isJavaScriptAction(v))
      .map(([k]) => k);
    // Array indices are deleted from the end so earlier ones stay valid.
    for (const key of doomed.reverse()) o.delete(key);
  });
}

export function removeAlternateImages(doc: mupdf.PDFDocument) {
  forEachContainer(doc, (o) => {
    if (o.isDictionary() && o.get("Subtype").asName() === "Image") o.delete("Alternates");
  });
}

function destinationKey(o: mupdf.PDFObject): string | null {
  if (o.isName()) return o.asName();
  if (o.isString()) return String.fromCharCode(...o.asByteString());
  return null;
}

/** Drops named destinations that nothing in the document links to. */
export function removeUnusedDestinations(doc: mupdf.PDFDocument) {
  const used = new Set<string>();
  forEachContainer(doc, (o) => {
    if (!o.isDictionary()) return;
    for (const key of ["Dest", "D"]) {
      const name = destinationKey(o.get(key));
      if (name !== null) used.add(name);
    }
  });

  const catalog = catalogOf(doc);
  const dests = catalog.get("Dests");
  if (dests.isDictionary()) {
    for (const [key] of entries(dests)) if (!used.has(String(key))) dests.delete(key);
  }

  const names = catalog.get("Names");
  if (!names.isDictionary()) return;
  const tree = names.get("Dests");
  if (!tree.isDictionary()) return;
  const kept = doc.newArray();
  const collect = (node: mupdf.PDFObject, depth: number) => {
    if (depth > 32) return;
    const pairs = node.get("Names");
    if (pairs.isArray()) {
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const key = destinationKey(pairs.get(i));
        if (key !== null && used.has(key)) {
          kept.push(pairs.get(i));
          kept.push(pairs.get(i + 1));
        }
      }
    }
    const kids = node.get("Kids");
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) collect(kids.get(i), depth + 1);
  };
  collect(tree, 0);
  if (kept.length === 0) {
    names.delete("Dests");
    return;
  }
  // Leaves were visited in key order, so a single flat node stays sorted.
  const root = doc.newDictionary();
  root.put("Names", kept);
  names.put("Dests", doc.addObject(root));
}

/**
 * Turns image object `obj` into a Form XObject that draws `image` (the cropped
 * pixels) into the part of the unit square they came from. The object number is
 * unchanged, so every page that draws the image keeps working without edits.
 */
export function wrapAsCroppedForm(
  doc: mupdf.PDFDocument,
  obj: mupdf.PDFObject,
  image: mupdf.PDFObject,
  unit: { x0: number; y0: number; x1: number; y1: number },
) {
  const optionalContent = obj.get("OC");
  for (const [key] of entries(obj)) obj.delete(key);
  const n = (v: number) => Number(v.toFixed(6));
  obj.writeStream(`q ${n(unit.x1 - unit.x0)} 0 0 ${n(unit.y1 - unit.y0)} ${n(unit.x0)} ${n(unit.y0)} cm /I Do Q`);
  obj.put("Type", doc.newName("XObject"));
  obj.put("Subtype", doc.newName("Form"));
  const bbox = doc.newArray();
  [0, 0, 1, 1].forEach((v) => bbox.push(v));
  obj.put("BBox", bbox);
  const xobjects = doc.newDictionary();
  xobjects.put("I", image);
  const resources = doc.newDictionary();
  resources.put("XObject", xobjects);
  obj.put("Resources", resources);
  if (!optionalContent.isNull()) obj.put("OC", optionalContent);
}
