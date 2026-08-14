// Generates pdf-viewer/samples/sample.pdf + pdf-viewer/js/sample-data.js (base64, so the
// "sample" button works even from file://)
// Usage: node scripts/make-sample.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Use the vendored UMD build (works in Node too, no npm install needed)
const pdfLib = require(join(__dirname, "..", "pdf-viewer", "vendor", "pdf-lib.min.js"));
const { PDFDocument, StandardFonts, rgb } = pdfLib;

const content = [
  {
    title: "The Quiet Engine",
    subtitle: "A field guide to building software that stays out of the way",
    paragraphs: [
      "Every piece of software makes a promise to its user. Most promises are broken quietly: the app that claims to be fast but takes four seconds to render a settings page; the reader that offers 'a distraction-free experience' and then spends a third of the screen selling upgrades. This guide is about a different kind of tool — the quiet engine. A quiet engine does its one job so well that you stop noticing it's there.",
      "The first principle of a quiet engine is respect for attention. Attention is the only resource the user is spending, and every dialog box, every notification badge, every animated banner is a withdrawal. When a product team asks 'how do we get the user to engage more?', they are really asking 'how do we make the user spend more of their attention on us?' The better question is: how do we return the user's attention to them, faster and more completely than we found it?",
      "The second principle is locality. Data should live where the user does. A document on your hard drive should not require a round trip to a server in another hemisphere to be rendered. Local processing is not just about privacy — although privacy is a fine reason — it is about latency, about predictability, and about the tool working exactly the same on a plane, a train, or a Tuesday.",
      "The third principle is composability. A quiet engine exposes simple, stable interfaces and then gets out of the way. It does not force the user into a single workflow; it leaves seams — export formats, open APIs, plain-text storage — through which other tools can reach in. The most durable software is not the software with the most features; it is the software that plays well with the ecosystem around it.",
    ],
  },
  {
    title: "On Maintenance and Smallness",
    paragraphs: [
      "Small software stays honest. A codebase of ten thousand lines can be held in one person's head; a codebase of a million cannot be held in anyone's. Every feature added is a surface for bugs, a demand for documentation, and a tax on every future change. This is not an argument for minimalism as an aesthetic — it is an argument for minimalism as a survival strategy.",
      "Maintenance is where quiet engines are made or unmade. The moment a project is released, entropy begins. Dependencies drift, platforms change, users find edge cases the author never imagined. The teams that survive are the ones that treat the bug tracker as a garden: they weed aggressively, they prune features that no longer earn their keep, and they are ruthless about deleting code. Unused code is not neutral; it is a liability that charges interest.",
      "There is a well-known rule of thumb that the cost of fixing a bug grows roughly tenfold for each stage it survives: a mistake caught while writing the code costs seconds; one caught in review costs minutes; one that ships costs hours; one that ships and gets reported costs days. The implication is uncomfortable but clear — the cheapest moment to make software correct and simple is the very first moment it is written.",
      "And yet simplicity is not the same as easiness. Writing small, correct, deliberate software is harder than writing sprawling software. It demands taste, restraint, and the willingness to say no. Saying no is the highest-leverage engineering activity there is.",
    ],
  },
  {
    title: "A Closing Note on Tools",
    paragraphs: [
      "Tools shape their users. A hammer teaches you to see nails; a search engine teaches you to see queries. The reading tools we choose quietly train us to read differently — to skim where we once lingered, to trust highlights where we once trusted memory. It is worth choosing them with intention.",
      "The best reading tool does not compete with the page. It disappears into the act of reading, available in the half-second between thought and action, never before. It remembers what you marked without being asked, finds what you need without being summoned, and answers a question about what you are reading without pausing the reading.",
      "That is the quiet engine's final promise: not to be the most impressive tool in the room, but to be the one you stop noticing. When the tool disappears, what remains is the work — and the work is yours.",
    ],
  },
];

async function main() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvItal = await doc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_W = 612, PAGE_H = 792, M = 64;

  for (const section of content) {
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - M;

    const drawTitle = (text) => {
      page.drawText(text, { x: M, y: y - 24, size: 22, font: helvBold, color: rgb(0.12, 0.13, 0.2) });
      y -= 48;
    };
    const drawSub = (text) => {
      page.drawText(text, { x: M, y: y - 14, size: 12, font: helvItal, color: rgb(0.4, 0.42, 0.5) });
      y -= 30;
    };
    const drawPara = (text) => {
      const words = text.split(" ");
      let line = "";
      const size = 11.5;
      const leading = 17;
      for (const w of words) {
        const test = line ? line + " " + w : w;
        const wpx = helv.widthOfTextAtSize(test, size);
        if (wpx > PAGE_W - 2 * M && line) {
          if (y < M + 20) {
            page = doc.addPage([PAGE_W, PAGE_H]);
            y = PAGE_H - M;
          }
          page.drawText(line, { x: M, y, size, font: helv, color: rgb(0.15, 0.16, 0.22) });
          y -= leading;
          line = w;
        } else {
          line = test;
        }
      }
      if (line) {
        if (y < M + 20) {
          page = doc.addPage([PAGE_W, PAGE_H]);
          y = PAGE_H - M;
        }
        page.drawText(line, { x: M, y, size, font: helv, color: rgb(0.15, 0.16, 0.22) });
        y -= leading + 6;
      }
    };

    drawTitle(section.title);
    if (section.subtitle) drawSub(section.subtitle);
    for (const p of section.paragraphs) drawPara(p);
  }

  const bytes = await doc.save();
  const dir = join(__dirname, "..", "pdf-viewer", "samples");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sample.pdf"), bytes);

  // embed base64 for offline "sample" button (Uint8Array needs a Buffer for base64)
  const b64 = Buffer.from(bytes).toString("base64");
  const js = `// Auto-generated by scripts/make-sample.mjs — base64 of samples/sample.pdf\nwindow.SAMPLE_PDF_B64 = ${JSON.stringify(b64)};\n`;
  writeFileSync(join(__dirname, "..", "pdf-viewer", "js", "sample-data.js"), js);

  console.log(`Sample PDF written: ${bytes.length} bytes (${(bytes.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
