// Snapshots: the scene at twice screen resolution, with its labels, a title
// band and the legend, saved as PNG or as a one-page PDF.

const SCALE = 2;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Type sizes in CSS pixels; the image is drawn at twice that.
const TYPE = { title: 28, line: 16, label: 14, legend: 15 };

// Break text into lines that fit `width` at the context's current font.
function wrap(g, text, width) {
  const out = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const t = cur ? `${cur} ${word}` : word;
    if (cur && g.measureText(t).width > width) { out.push(cur); cur = word; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

// opts: { renderer, scene, camera, stage, title, lines: [string], legend: [{label, color, kind}], ink }
export function compose(o) {
  const w = o.stage.clientWidth, h = o.stage.clientHeight, pad = 22;
  const probe = document.createElement("canvas").getContext("2d");

  // Title band: as tall as its wrapped lines need.
  probe.font = `400 ${TYPE.line}px ${FONT}`;
  const lines = o.lines.flatMap((t) => wrap(probe, t, w - 2 * pad));
  const head = pad + TYPE.title + 10 + lines.length * (TYPE.line + 7) + 12;

  // Legend rows: items flow and wrap; the credit goes last.
  probe.font = `400 ${TYPE.legend}px ${FONT}`;
  const items = o.legend.map((it) => ({ ...it, w: (it.kind === "swatch" ? 22 : 30) + probe.measureText(it.label).width + 22 }));
  const credit = "sr-dash.github.io/heliofield", creditW = probe.measureText(credit).width;
  const rows = [[]];
  let used = 0;
  for (const it of items) {
    if (used + it.w > w - 2 * pad && rows[rows.length - 1].length) { rows.push([]); used = 0; }
    rows[rows.length - 1].push(it); used += it.w;
  }
  const creditOwnRow = used + creditW + 20 > w - 2 * pad;
  const rowH = TYPE.legend + 16, foot = 12 + (rows.length + (creditOwnRow ? 1 : 0)) * rowH + 8;

  const ratio = o.renderer.getPixelRatio();
  o.renderer.setPixelRatio(SCALE);
  o.renderer.setSize(w, h, false);
  o.renderer.render(o.scene, o.camera);
  const cv = document.createElement("canvas");
  cv.width = w * SCALE; cv.height = (h + head + foot) * SCALE;
  const g = cv.getContext("2d");
  g.scale(SCALE, SCALE);
  g.fillStyle = o.ink.bg; g.fillRect(0, 0, w, h + head + foot);
  g.drawImage(o.renderer.domElement, 0, head, w, h);
  o.renderer.setPixelRatio(ratio);
  o.renderer.setSize(w, h, false);

  // Labels where the page shows them, sized for the snapshot's own type
  // rather than copied from the screen.
  const box = o.stage.getBoundingClientRect();
  g.font = `500 ${TYPE.label}px ${FONT}`;
  g.textBaseline = "middle";
  for (const el of o.stage.querySelectorAll(".label")) {
    if (el.style.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
    const dot = el.dataset.color, text = el.textContent;
    const lw = g.measureText(text).width + (dot ? 26 : 14), lh = TYPE.label + 10;
    const x = r.left - box.left, y = r.top - box.top + r.height / 2 - lh / 2 + head;
    g.fillStyle = o.ink.labelBg; roundRect(g, x, y, lw, lh, 5); g.fill();
    if (dot) { g.fillStyle = dot; g.beginPath(); g.arc(x + 10, y + lh / 2, 4.5, 0, 2 * Math.PI); g.fill(); }
    g.fillStyle = el.classList.contains("planet") ? o.ink.muted : o.ink.text;
    g.fillText(text, x + (dot ? 20 : 7), y + lh / 2 + 0.5);
  }

  // Title band.
  g.fillStyle = o.ink.bg; g.fillRect(0, 0, w, head);
  g.textBaseline = "alphabetic";
  g.fillStyle = o.ink.text; g.font = `700 ${TYPE.title}px ${FONT}`;
  g.fillText(o.title, pad, pad + TYPE.title - 4);
  g.font = `400 ${TYPE.line}px ${FONT}`; g.fillStyle = o.ink.muted;
  lines.forEach((t, i) => g.fillText(t, pad, pad + TYPE.title + 10 + (i + 1) * (TYPE.line + 7) - 6));

  // Legend and credit.
  const y0 = head + h;
  g.fillStyle = o.ink.bg; g.fillRect(0, y0, w, foot);
  g.font = `400 ${TYPE.legend}px ${FONT}`; g.textBaseline = "middle";
  rows.forEach((row, k) => {
    const cy = y0 + 12 + k * rowH + rowH / 2;
    let x = pad;
    for (const it of row) {
      g.fillStyle = it.color;
      if (it.kind === "swatch") { roundRect(g, x, cy - 7, 14, 14, 3); g.fill(); x += 22; }
      else { g.fillRect(x, cy - 2, 22, 4); x += 30; }
      g.fillStyle = o.ink.text; g.fillText(it.label, x, cy);
      x += it.w - (it.kind === "swatch" ? 22 : 30);
    }
  });
  g.fillStyle = o.ink.muted; g.textAlign = "right";
  const cRow = creditOwnRow ? rows.length : rows.length - 1;
  g.fillText(credit, w - pad, y0 + 12 + cRow * rowH + rowH / 2);
  g.textAlign = "left";
  return cv;
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export async function savePNG(cv, base) {
  save(await new Promise((r) => cv.toBlob(r, "image/png")), `${base}.png`);
}

// The PDF library loads the first time someone asks for a PDF.
const PDF_LIB = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
let pdfLib = null;
function loadPdfLib() {
  if (window.jspdf) return Promise.resolve();
  pdfLib ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDF_LIB; s.onload = resolve;
    s.onerror = () => { pdfLib = null; reject(new Error("The PDF library did not load. Check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return pdfLib;
}
export async function savePDF(cv, base, title) {
  await loadPdfLib();
  const { jsPDF } = window.jspdf;
  const w = (cv.width / SCALE) * 0.75, h = (cv.height / SCALE) * 0.75;
  const pdf = new jsPDF({ orientation: w > h ? "landscape" : "portrait", unit: "pt", format: [w, h] });
  pdf.setProperties({ title, creator: "HelioField" });
  // JPEG at high quality: a 2x PNG embedded by jsPDF is ~20 MB; this is ~1 MB
  // with no visible loss on lines. The PNG download stays lossless.
  pdf.addImage(cv.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, w, h);
  pdf.save(`${base}.pdf`);
}
