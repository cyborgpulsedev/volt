// Unit tests for office-export.js pure logic: CRC32, the store-only ZIP
// writer (round-tripped through a tiny reader), DOCX/XLSX structure, and
// table/line detection. Usage: node scripts/test-office.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const src = readFileSync(join(__dirname, "..", "js", "office-export.js"), "utf8");
const fn = new Function("window", src);
fn(globalThis);
const OE = globalThis.OfficeExport;

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
const utf8 = (s) => new TextEncoder().encode(s);
const str = (b) => new TextDecoder().decode(b);

// ── CRC32 ──
t("crc32 known vector 123456789", OE.crc32(utf8("123456789")) === 0xCBF43926);
t("crc32 differs on content", OE.crc32(utf8("abc")) !== OE.crc32(utf8("abd")));

// ── ZIP round-trip (store-only reader) ──
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  const cdStart = dv.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdStart;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const nameLen = dv.getUint16(p + 28, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = str(bytes.slice(p + 46, p + 46 + nameLen));
    // local header at localOff
    const lnameLen = dv.getUint16(localOff + 26, true);
    const data = bytes.slice(localOff + 30 + lnameLen, localOff + 30 + lnameLen + size);
    entries.push({ name, method, crc, size, data });
    p += 46 + nameLen;
  }
  return entries;
}

const zipBytes = OE.zip([
  { name: "a.txt", bytes: utf8("hello world") },
  { name: "sub/b.txt", bytes: utf8("second file 123") },
]);
const z = readZip(zipBytes);
t("zip: EOCD + both entries parse", !!z && z.length === 2);
t("zip: entry names + order", !!z && z[0].name === "a.txt" && z[1].name === "sub/b.txt");
t("zip: stored (no compression) with matching sizes", !!z && z.every((e) => e.method === 0 && e.size === e.data.length));
t("zip: CRC of stored data matches", !!z && z[0].crc === OE.crc32(utf8("hello world")) && z[1].crc === OE.crc32(utf8("second file 123")));
t("zip: data round-trips exactly", !!z && str(z[0].data) === "hello world" && str(z[1].data) === "second file 123");

// ── DOCX ──
const docxBytes = OE.docx({
  title: "Test Document",
  pages: [
    { num: 1, paragraphs: [{ text: "Hello & <World>" }, { text: "" }], tables: [[["Item", "Qty"], ["Apple", "3"]]], images: [{ bytes: utf8("FAKE"), mime: "image/png", wPts: 100, hPts: 50 }] },
  ],
});
const dz = readZip(docxBytes);
const names = dz ? dz.map((e) => e.name) : [];
t("docx: required parts present", !!dz && ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels"].every((n) => names.includes(n)));
t("docx: media part present", !!dz && names.some((n) => n.startsWith("word/media/image1.")));
const docXml = dz ? str(dz.find((e) => e.name === "word/document.xml").data) : "";
t("docx: title text in document.xml", docXml.includes("Test Document"));
t("docx: xml-escaped paragraph", docXml.includes("Hello &amp; &lt;World&gt;"));
t("docx: table cells in document.xml", docXml.includes("Apple") && docXml.includes("<w:tbl>"));
t("docx: image rels + drawing", docXml.includes("<a:blip r:embed=") && str(dz.find((e) => e.name === "word/_rels/document.xml.rels").data).includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"'));
t("docx: page break between pages", (() => { const two = OE.docx({ title: "", pages: [{ num: 1, paragraphs: [{ text: "p1" }], tables: [], images: [] }, { num: 2, paragraphs: [{ text: "p2" }], tables: [], images: [] }] }); return str(readZip(two).find((e) => e.name === "word/document.xml").data).includes('w:type="page"'); })());

// ── XLSX ──
const xlsxBytes = OE.xlsx({ sheets: [{ name: "Table 1", rows: [["Name", "Qty"], ["Apples", 3], ["Total", "7.5"]] }] });
const xz = readZip(xlsxBytes);
const xnames = xz ? xz.map((e) => e.name) : [];
t("xlsx: required parts present", !!xz && ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"].every((n) => xnames.includes(n)));
const sheetXml = xz ? str(xz.find((e) => e.name === "xl/worksheets/sheet1.xml").data) : "";
t("xlsx: inline string cell", sheetXml.includes('t="inlineStr"') && sheetXml.includes("Apples"));
t("xlsx: numeric cell", sheetXml.includes("<v>3</v>") && sheetXml.includes("<v>7.5</v>"));
t("xlsx: workbook references the sheet", str(xz.find((e) => e.name === "xl/workbook.xml").data).includes('name="Table 1"'));

// ── PPTX ──
const TABLE_STYLE_NEEDLE = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";
const pptxBytes = OE.pptx({
  title: "Q3 Report",
  pages: [
    {
      num: 1,
      paragraphs: [{ text: "Intro line" }, { text: "" }],
      tables: [[["Item", "Qty"], ["Apples", "3"], ["Pears", "7"]]],
      images: [{ bytes: utf8("FAKE"), mime: "image/png", wPts: 100, hPts: 50 }],
    },
  ],
});
const pz = readZip(pptxBytes);
const pnames = pz ? pz.map((e) => e.name) : [];
t("pptx: builder reports the real slide count", pptxBytes.slideCount === 4 &&
  pnames.filter((n) => n.startsWith("ppt/slides/slide")).length === 4);
t("pptx: required parts present", !!pz && ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "docProps/app.xml", "ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/theme/theme1.xml"].every((n) => pnames.includes(n)));
t("pptx: slide count = title+page+table+image (4)", !!pz && [1, 2, 3, 4].every((i) => pnames.includes("ppt/slides/slide" + i + ".xml")) && !pnames.includes("ppt/slides/slide5.xml"));
t("pptx: every slide has a rels part", !!pz && [1, 2, 3, 4].every((i) => pnames.includes("ppt/slides/_rels/slide" + i + ".xml.rels")));
t("pptx: 16:9 slide size", str(pz.find((e) => e.name === "ppt/presentation.xml").data).includes('cx="12192000" cy="6858000"'));
t("pptx: 4 slides listed in presentation.xml", (str(pz.find((e) => e.name === "ppt/presentation.xml").data).match(/<p:sldId /g) || []).length === 4);
t("pptx: title slide carries the title", str(pz.find((e) => e.name === "ppt/slides/slide1.xml").data).includes("Q3 Report"));
t("pptx: page slide carries prose", str(pz.find((e) => e.name === "ppt/slides/slide2.xml").data).includes("Intro line") && str(pz.find((e) => e.name === "ppt/slides/slide2.xml").data).includes("Page 1"));
t("pptx: table slide has <a:tbl> + cell text + style ref", (() => { const s = str(pz.find((e) => e.name === "ppt/slides/slide3.xml").data); return s.includes("<a:tbl>") && s.includes("Apples") && s.includes(TABLE_STYLE_NEEDLE); })());
t("pptx: image slide has <p:pic> + r:embed + media part", (() => { const s = str(pz.find((e) => e.name === "ppt/slides/slide4.xml").data); return s.includes("<p:pic>") && s.includes('r:embed="rId2"') && pnames.some((n) => n.startsWith("ppt/media/image1.")); })());
t("pptx: image slide rels target the media", str(pz.find((e) => e.name === "ppt/slides/_rels/slide4.xml.rels").data).includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"'));
t("pptx: theme defines the referenced table style", str(pz.find((e) => e.name === "ppt/theme/theme1.xml").data).includes(TABLE_STYLE_NEEDLE) && str(pz.find((e) => e.name === "ppt/theme/theme1.xml").data).includes("<a:fmtScheme"));
t("pptx: content types cover slides + docProps", (() => { const c = str(pz.find((e) => e.name === "[Content_Types].xml").data); return c.includes('/ppt/slides/slide4.xml"') && c.includes('docProps/core.xml"') && c.includes('presentationml.presentation.main+xml'); })());
t("pptx: long tables chunk into extra slides", (() => {
  const big = OE.pptx({ title: "T", pages: [{ num: 1, paragraphs: [], tables: [Array.from({ length: 30 }, (_r, ri) => ["r" + ri, "x"])], images: [] }] });
  const n = readZip(big);
  const names = n ? n.map((e) => e.name) : [];
  // title + 1 page slide + 3 table slides (13/13/4 rows)
  return names.includes("ppt/slides/slide5.xml") && !names.includes("ppt/slides/slide6.xml");
})());

// ── vector grid detection (linesToGrids + gridTables) ──
// synthesize the operator list the way pdf-lib/pdF.js emits it: a cm translate
// (the CTM), a constructPath(91) with local coords + bbox, then a stroke
function gridOps(cells, opts = {}) {
  const fnArray = [], argsArray = [];
  for (const c of cells) {
    fnArray.push(10); argsArray.push([]); // save — real producers wrap each draw in q/Q
    fnArray.push(12); argsArray.push([1, 0, 0, 1, c[0], c[1]]); // cm translate
    if (opts.fill) {
      fnArray.push(91); argsArray.push([[13, 14, 14, 14, 18], [0, 0, 0, c[3], c[2], c[3], c[2], 0], [0, 0, c[2], c[3]]]);
      fnArray.push(22); argsArray.push([]); // fill — NOT a grid edge
    } else {
      fnArray.push(91); argsArray.push([[13, 14, 14, 14, 18], [0, 0, 0, c[3], c[2], c[3], c[2], 0], [0, 0, c[2], c[3]]]);
      fnArray.push(20); argsArray.push([]); // stroke
    }
    fnArray.push(11); argsArray.push([]); // restore
  }
  return { fnArray, argsArray };
}
function cellGrid(rows, cols, x0, y0, w, h) {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([x0 + c * w, y0 + r * h, w, h]);
  return cells;
}

const g1 = OE.linesToGrids(gridOps(cellGrid(2, 3, 60, 550, 160, 40)));
t("grid: 2x3 stroked cells → one 2-row x 3-col grid", g1.length === 1 && g1[0].yEdges.length === 3 && g1[0].xEdges.length === 4);
t("grid: edges land at the cm-translated positions", g1.length === 1 &&
  Math.abs(g1[0].yEdges[0] - 630) < 1e-6 && Math.abs(g1[0].yEdges[2] - 550) < 1e-6 &&
  Math.abs(g1[0].xEdges[0] - 60) < 1e-6 && Math.abs(g1[0].xEdges[3] - 540) < 1e-6);
t("grid: no paths → no grids", OE.linesToGrids({ fnArray: [10, 11], argsArray: [[], []] }).length === 0);
t("grid: a 1x1 box is not a table (needs 2 rows + 2 cols)", OE.linesToGrids(gridOps(cellGrid(1, 1, 60, 550, 160, 40))).length === 0);
t("grid: a 1-col x 2-row list is not a table (needs 2 cols)", OE.linesToGrids(gridOps(cellGrid(2, 1, 60, 550, 160, 40))).length === 0);
t("grid: FILLED cells don't make grid edges", OE.linesToGrids(gridOps(cellGrid(2, 3, 60, 550, 160, 40), { fill: true })).length === 0);
t("grid: two separate tables (disjoint x) stay separate components", (() => {
  const gs = OE.linesToGrids(gridOps([...cellGrid(2, 2, 60, 500, 100, 40), ...cellGrid(2, 2, 400, 300, 100, 40)]));
  const tops = gs.map((g) => g.yEdges[0]).sort((a, b) => b - a);
  return gs.length === 2 && tops[0] === 580 && tops[1] === 380;
})());
t("grid: stacked tables sharing columns but with a real gap stay separate", (() => {
  // a 2x2 grid above a 2x2 grid at the same x positions, 120pt apart — the
  // verticals must NOT bridge them (this is the merged-table regression)
  const gs = OE.linesToGrids(gridOps([...cellGrid(2, 2, 60, 500, 100, 40), ...cellGrid(2, 2, 60, 300, 100, 40)]));
  return gs.length === 2 && gs.every((g) => g.yEdges.length === 3);
})());
t("grid: adjacent (touching) stacked tables merge into one continuous grid", (() => {
  // the second table's top edge meets the first's bottom — they share the
  // boundary line, so they form one 4-row x 2-col grid
  const gs = OE.linesToGrids(gridOps([...cellGrid(2, 2, 60, 500, 100, 40), ...cellGrid(2, 2, 60, 580, 100, 40)]));
  return gs.length === 1 && gs[0].yEdges.length === 5 && gs[0].xEdges.length === 3;
})());

// ── gridTables: text → cells ──
const gGrid = [{ yEdges: [630, 590, 550], xEdges: [60, 220, 380, 540] }];
const gLines = [
  { y: 610, h: 12, tokens: [{ x: 65, x2: 100, text: "Item" }, { x: 225, x2: 260, text: "Qty" }, { x: 385, x2: 420, text: "Price" }] },
  { y: 570, h: 12, tokens: [{ x: 65, x2: 100, text: "Apples" }, { x: 225, x2: 260, text: "3" }, { x: 385, x2: 420, text: "2.50" }] },
  { y: 460, h: 12, tokens: [{ x: 65, x2: 200, text: "Prose below the table" }] }, // outside the grid
];
const gt = OE.gridTables(gLines, gGrid);
t("gridTables: text lands in the right cells", gt.tables.length === 1 &&
  gt.tables[0][0][0] === "Item" && gt.tables[0][0][1] === "Qty" && gt.tables[0][1][2] === "2.50");
t("gridTables: lines outside the grid are not claimed", gt.lineIndexes.size === 2 && !gt.lineIndexes.has(2));

// a merged header: one wide line of text over columns 1-2 (its middle sits in
// column 1) flattens to the first cell with empty neighbors
const mGrid = [{ yEdges: [330, 250, 210], xEdges: [60, 220, 380, 540] }];
const mLines = [
  { y: 302, h: 12, tokens: [{ x: 65, x2: 140, text: "Combined" }] },          // header row, spans cols 1-2
  { y: 232, h: 12, tokens: [{ x: 65, x2: 100, text: "Alpha" }, { x: 225, x2: 260, text: "Beta" }, { x: 385, x2: 420, text: "Gamma" }] },
];
const mt = OE.gridTables(mLines, mGrid);
t("gridTables: merged cell flattens to first column, neighbors empty", mt.tables.length === 1 &&
  mt.tables[0][0][0] === "Combined" && mt.tables[0][0][1] === "" && mt.tables[0][0][2] === "" &&
  mt.tables[0][1][0] === "Alpha" && mt.tables[0][1][2] === "Gamma" && mt.lineIndexes.size === 2);

// a textless grid stays a (blank) table when small, but a dense rule grid
// (chart-like) with no text is dropped
const emptyGrid = [{ yEdges: [400, 360, 320], xEdges: [60, 220, 380, 540] }];
const denseGrid = [{ yEdges: Array.from({ length: 12 }, (_, i) => 500 - i * 30), xEdges: Array.from({ length: 8 }, (_, i) => 60 + i * 80) }];
t("gridTables: small textless grid kept (blank form)", OE.gridTables([], emptyGrid).tables.length === 1 &&
  OE.gridTables([], emptyGrid).tables[0].every((r) => r.every((c) => c === "")));
t("gridTables: dense textless grid dropped (chart rules)", OE.gridTables([], denseGrid).tables.length === 0);

// ── line grouping ──
const lines = OE.groupLines([
  { str: "Title", transform: [1, 0, 0, 1, 60, 700] },
  { str: "A", transform: [1, 0, 0, 1, 60, 680] },
  { str: "B", transform: [1, 0, 0, 1, 200, 680] },
  { str: "C", transform: [1, 0, 0, 1, 60, 660] },
]);
t("groupLines: clusters by baseline", lines.length === 3 && lines[1].text === "A B" && lines[0].text === "Title");

// ── table detection ──
const tblLines = OE.groupLines([
  { str: "Header", transform: [1, 0, 0, 1, 60, 700] },
  { str: "Name", transform: [1, 0, 0, 1, 60, 680] }, { str: "Qty", transform: [1, 0, 0, 1, 260, 680] }, { str: "Price", transform: [1, 0, 0, 1, 400, 680] },
  { str: "Apples", transform: [1, 0, 0, 1, 60, 660] }, { str: "3", transform: [1, 0, 0, 1, 260, 660] }, { str: "2.50", transform: [1, 0, 0, 1, 400, 660] },
  { str: "Pears", transform: [1, 0, 0, 1, 60, 640] }, { str: "7", transform: [1, 0, 0, 1, 260, 640] }, { str: "1.10", transform: [1, 0, 0, 1, 400, 640] },
  { str: "A normal paragraph that just goes on and on without any columns", transform: [1, 0, 0, 1, 60, 620] },
]);
const det = OE.detectTables(tblLines);
t("detectTables: finds the 3-row table", det.tables.length === 1 && det.tables[0].length === 3 && det.tables[0][0].length === 3);
t("detectTables: header outside the run is excluded", det.tables[0][0][0] === "Name");
t("detectTables: paragraph line excluded", !det.lineIndexes.has(tblLines.length - 1));
t("detectTables: short runs (2 rows) are not tables", OE.detectTables(OE.groupLines([
  { str: "A", transform: [1, 0, 0, 1, 60, 660] }, { str: "B", transform: [1, 0, 0, 1, 260, 660] },
  { str: "C", transform: [1, 0, 0, 1, 60, 640] }, { str: "D", transform: [1, 0, 0, 1, 260, 640] },
])).tables.length === 0);
t("detectTables: accepts raw items directly", OE.detectTables([
  { str: "A", transform: [1, 0, 0, 1, 60, 660] }, { str: "B", transform: [1, 0, 0, 1, 260, 660] },
  { str: "C", transform: [1, 0, 0, 1, 60, 640] }, { str: "D", transform: [1, 0, 0, 1, 260, 640] },
  { str: "E", transform: [1, 0, 0, 1, 60, 620] }, { str: "F", transform: [1, 0, 0, 1, 260, 620] },
]).tables.length === 1);

// ── TSV ──
t("tsv: tab/newline structure + quoting", OE.tsv([["a", "b"], ['x"y', "z"]]) === 'a\tb\n"x""y"\tz');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
