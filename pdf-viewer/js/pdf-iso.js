/* ═══════════════════════════════════════════════════════════════
   pdf-iso.js — Volt.ISO
   ISO PDF-standard exports. Ships PDF/A-1b (ISO 19005-1, the archival
   standard) — the same standard-family machinery a PDF/A-2b, PDF/X or
   PDF/UA export needs (XMP metadata with the standard's identifier,
   an OutputIntent with an ICC profile, embedded fonts, a file
   identifier, classic xref, no encryption), so more standards are one
   small step from here.

   Conformance is best-effort and honest about it: the export carries
   every PDF/A-1b REQUIRED element — /Metadata with the pdfaid
   part/conformance pair (uncompressed, as the standard demands), a
   /OutputIntents entry with a valid sRGB ICC v2 profile, Info + XMP
   title/producer/creator/dates, an /ID pair, embedded fonts
   (pdf-lib subsets every drawn font), and no /Encrypt. The one thing a
   strict validator may still flag is semi-transparent annotation
   overlays (highlights draw with opacity) — PDF/A-1 forbids
   transparency, so run a validator before shipping an audit file.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};

  Volt.ISO = {
    /** Convert PDF bytes (pdf-lib output or any readable PDF) to a
        PDF/A-1b-structured export (ISO 19005-1, conformance B).
        opts: { title, producer, creator } — defaults from the source
        document's own Info when omitted. Returns a NEW Uint8Array. */
    async toPdfA1b(bytes, opts) {
      const o = opts || {};
      const { PDFDocument, PDFName } = global.PDFLib;
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });

      const title = o.title || pdf.getTitle() || "Volt document";
      const producer = o.producer || pdf.getProducer() || this._producerName();
      const creator = o.creator || pdf.getCreator() || "Volt";
      const now = new Date();
      pdf.setTitle(title);
      pdf.setProducer(producer);
      pdf.setCreator(creator);
      pdf.setCreationDate(o.created || now);
      pdf.setModificationDate(o.modified || now);

      // /Metadata stream — MUST be uncompressed in PDF/A-1, and MUST be
      // UTF-8 (XMP is XML): TextEncoder turns the packet's \uFEFF BOM into
      // the required EF BB BF bytes
      const xmp = global.Utils.pdfA1bXmp({
        title, producer, creator,
        created: o.created || now,
        modified: o.modified || now,
      });
      const metaRef = pdf.context.register(pdf.context.stream(new TextEncoder().encode(xmp), {
        Type: PDFName.of("Metadata"),
        Subtype: PDFName.of("XML"),
      }));
      pdf.catalog.set(PDFName.of("Metadata"), metaRef);

      // /OutputIntents with an sRGB ICC v2 profile (required for PDF/A-1)
      const iccRef = pdf.context.register(pdf.context.stream(global.Utils.buildSrgbIcc(), {}));
      const intentRef = pdf.context.register(pdf.context.obj({
        Type: PDFName.of("OutputIntent"),
        S: PDFName.of("GTS_PDFA1"),
        OutputConditionIdentifier: "sRGB IEC61966-2.1",
        Info: "sRGB IEC61966-2.1",
        DestOutputProfile: iccRef,
      }));
      pdf.catalog.set(PDFName.of("OutputIntents"), pdf.context.obj([intentRef]));

      // classic xref (PDF/A-1 is PDF 1.4: no object streams) + trailer /ID
      const saved = await pdf.save({ useObjectStreams: false });
      const src = this._latin1(saved);
      const out = global.Utils.injectPdfTrailerId(src, "RANDOM");
      return out === src ? saved : this._latin1Bytes(out);
    },

    _producerName() {
      const v = global.Volt && global.Volt.VERSION ? global.Volt.VERSION : "";
      return "Volt" + (v ? " " + v : "");
    },

    /** byte-preserving latin1 helpers (PDF strings/streams are bytes; a
        TextEncoder would mangle chars > U+00FF). */
    _latin1Bytes(str) {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    },
    _latin1(bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return s;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
