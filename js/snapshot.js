// Snapshots: the scene at twice screen resolution, with its labels, a title
// band and the legend, saved as PNG or as a one-page PDF.

const SCALE = 2;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// opts: { renderer, scene, camera, stage, title, lines: [string], legend: [{label, color, kind}], ink }
export function compose(o) {
  const w = o.stage.clientWidth, h = o.stage.clientHeight;
  const ratio = o.renderer.getPixelRatio();
  o.renderer.setPixelRatio(SCALE);
  o.renderer.setSize(w, h, false);
  o.renderer.render(o.scene, o.camera);
  const cv = document.createElement("canvas");
  const head = 74, foot = 46;
  cv.width = w * SCALE; cv.height = (h + head + foot) * SCALE;
  const g = cv.getContext("2d");
  g.scale(SCALE, SCALE);
  g.fillStyle = o.ink.bg; g.fillRect(0, 0, w, h + head + foot);
  g.drawImage(o.renderer.domElement, 0, head, w, h);
  o.renderer.setPixelRatio(ratio);
  o.renderer.setSize(w, h, false);

  // Labels, where the page shows them.
  const box = o.stage.getBoundingClientRect();
  g.font = `500 12px ${FONT}`;
  g.textBaseline = "middle";
  for (const el of o.stage.querySelectorAll(".label")) {
    if (el.style.display === "none" || el.closest('[style*="display: none"]')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
    const x = r.left - box.left, y = r.top - box.top + head;
    g.fillStyle = o.ink.labelBg; roundRect(g, x, y, r.width, r.height, 4); g.fill();
    const dot = el.dataset.color;
    if (dot) { g.fillStyle = dot; g.beginPath(); g.arc(x + 9, y + r.height / 2, 3.5, 0, 2 * Math.PI); g.fill(); }
    g.fillStyle = el.classList.contains("planet") ? o.ink.muted : o.ink.text;
    g.fillText(el.textContent, x + (dot ? 17 : 6), y + r.height / 2 + 0.5);
  }

  // Title band.
  g.fillStyle = o.ink.bg; g.fillRect(0, 0, w, head);
  g.fillStyle = o.ink.text; g.textBaseline = "alphabetic";
  g.font = `700 20px ${FONT}`; g.fillText(o.title, 18, 32);
  g.font = `400 13px ${FONT}`; g.fillStyle = o.ink.muted;
  o.lines.forEach((t, i) => g.fillText(t, 18, 52 + i * 17));

  // Legend and credit.
  const y0 = head + h;
  g.fillStyle = o.ink.bg; g.fillRect(0, y0, w, foot);
  g.font = `400 12.5px ${FONT}`; g.textBaseline = "middle";
  let x = 18;
  for (const it of o.legend) {
    g.fillStyle = it.color;
    if (it.kind === "swatch") { roundRect(g, x, y0 + foot / 2 - 6, 12, 12, 3); g.fill(); }
    else g.fillRect(x, y0 + foot / 2 - 1.5, 18, 3);
    x += it.kind === "swatch" ? 18 : 24;
    g.fillStyle = o.ink.text; g.fillText(it.label, x, y0 + foot / 2);
    x += g.measureText(it.label).width + 18;
  }
  g.fillStyle = o.ink.muted; g.textAlign = "right";
  g.fillText("sr-dash.github.io/heliofield", w - 18, y0 + foot / 2);
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
