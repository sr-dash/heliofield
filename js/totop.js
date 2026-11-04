// A "back to top" button for the long pages (not the 3D viewer). It shows
// once the reader has scrolled a screen down, sits above the page in the
// corner, and returns focus to the page heading, so keyboard and screen-reader
// users land where sighted readers do.

const CSS = `
.to-top { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(18px, env(safe-area-inset-bottom)); z-index: 40;
  width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  color: var(--text, var(--ink, #e8eaf0)); background: var(--card, var(--surface, #0f141f)); border: 1px solid var(--line, rgba(127,127,127,.35));
  box-shadow: 0 6px 18px rgba(0, 0, 0, .3); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .2s, transform .2s; }
.to-top.on { opacity: 1; transform: none; pointer-events: auto; }
.to-top:hover { color: var(--accent, #9cc0ff); border-color: var(--accent, #9cc0ff); }
.to-top:focus-visible { outline: 3px solid var(--accent, #9cc0ff); outline-offset: 2px; }
.to-top svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { .to-top { transition: none; } }
.embed .to-top { display: none; }
`;

export function backToTop() {
  if (document.querySelector(".to-top")) return;
  const style = document.createElement("style"); style.textContent = CSS; document.head.append(style);
  const b = document.createElement("button");
  b.type = "button"; b.className = "to-top"; b.setAttribute("aria-label", "Back to top"); b.title = "Back to top";
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  document.body.append(b);
  const update = () => {
    // Only where the page is long enough to need it, and once a screen down.
    const long = document.documentElement.scrollHeight > innerHeight * 1.8;
    b.classList.toggle("on", long && scrollY > innerHeight * 0.8);
  };
  addEventListener("scroll", update, { passive: true }); addEventListener("resize", update); update();
  b.onclick = () => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    const h = document.querySelector("h1");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  };
}
// Importing the module is enough: pages load it with their own script.
if (document.readyState === "loading") addEventListener("DOMContentLoaded", backToTop); else backToTop();
