// A one-time card for first visits. After the page has been in view for 10 seconds, it suggests
// bookmarking (browsers do not let a page bookmark itself, so it shows the keyboard shortcut, or
// the home-screen route on touch devices), installing HelioField as an app where the browser
// offers that, and starring the repository. It appears once per browser, never in embeds, frames
// or the installed app, does not take focus, and closes with Escape.

const KEY = 'hf.nudge';
const DELAY_MS = 10000;
const REPO = 'https://github.com/sr-dash/heliofield';

const CSS = `
.nudge { position: fixed; left: max(16px, env(safe-area-inset-left)); bottom: max(18px, env(safe-area-inset-bottom)); z-index: 60;
  width: min(360px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px 16px; border-radius: 12px;
  color: var(--text, #e8eaf0); background: var(--card, var(--panel, #0f141f)); border: 1px solid var(--line, rgba(127,127,127,.35));
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35); font-size: 14px; line-height: 1.45;
  opacity: 0; transform: translateY(10px); transition: opacity .25s, transform .25s; }
.nudge.on { opacity: 1; transform: none; }
.nudge p { margin: 0 0 8px; }
.nudge .nudge-h { margin-right: 24px; font-weight: 600; font-size: 15px; }
.nudge .nudge-sub { color: var(--muted, #9aa3b5); font-size: 13px; }
.nudge kbd { font: inherit; font-weight: 600; padding: 0 5px; border: 1px solid var(--line, rgba(127,127,127,.35)); border-radius: 4px; }
.nudge-b { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.nudge-b a, .nudge-b button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; cursor: pointer; text-decoration: none;
  color: var(--text, #e8eaf0); background: transparent; border: 1px solid var(--line, rgba(127,127,127,.35)); }
.nudge-b .nudge-star { color: var(--bg, #080b14); background: var(--accent, var(--link, #9cc0ff)); border-color: var(--accent, var(--link, #9cc0ff)); font-weight: 600; }
.nudge-b a:hover, .nudge-b button:hover { border-color: var(--accent, var(--link, #9cc0ff)); }
.nudge-x { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; font-size: 20px; line-height: 1; cursor: pointer;
  color: var(--muted, #9aa3b5); background: transparent; border: 0; border-radius: 50%; }
.nudge-x:hover { color: var(--text, #e8eaf0); }
.nudge a:focus-visible, .nudge button:focus-visible { outline: 3px solid var(--accent, var(--link, #9cc0ff)); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .nudge { transition: none; } }
@media print { .nudge { display: none; } }
.embed .nudge { display: none; }
`;

const seen = () => {
  try { return localStorage.getItem(KEY) !== null; } catch { return true; } // no storage: never nag on every visit
};
const mark = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };
const track = (action) => { if (typeof window.gtag === 'function') window.gtag('event', 'first_visit_card', { action }); };

const el = (tag, props = {}, kids = []) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) e.append(k);
  return e;
};

let installEvent = null;

function show() {
  if (seen() || document.querySelector('.nudge')) return;
  mark('shown');
  document.head.append(el('style', { textContent: CSS }));

  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const touch = matchMedia('(pointer: coarse)').matches;
  const tip = el('p');
  if (touch) {
    tip.textContent = 'Add it to your home screen from the browser menu, so it is one tap away next time.';
  } else {
    tip.append('Bookmark it with ', el('kbd', { textContent: mac ? '⌘ D' : 'Ctrl + D' }), ', so it is one click away next time.');
  }

  const card = el('aside', { className: 'nudge' });
  card.setAttribute('aria-label', 'Find HelioField useful?');
  const close = (action) => {
    track(action);
    card.classList.remove('on');
    removeEventListener('keydown', onKey);
    setTimeout(() => card.remove(), 300);
  };
  const onKey = (e) => { if (e.key === 'Escape') close('escape'); };

  const x = el('button', { type: 'button', className: 'nudge-x', textContent: '×', title: 'Close' });
  x.setAttribute('aria-label', 'Close');
  x.onclick = () => close('close');

  const star = el('a', { className: 'nudge-star', href: REPO, target: '_blank', rel: 'noopener' },
    [el('span', { textContent: '☆ ' }), 'Star it on GitHub']);
  star.firstChild.setAttribute('aria-hidden', 'true');
  star.onclick = () => { mark('starred'); close('star'); };

  const buttons = [star];
  if (installEvent) {
    const install = el('button', { type: 'button', textContent: 'Install as app' });
    install.onclick = async () => {
      const ev = installEvent; installEvent = null;
      ev.prompt();
      const choice = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
      close(choice.outcome === 'accepted' ? 'installed' : 'install_dismissed');
    };
    buttons.push(install);
  }
  const later = el('button', { type: 'button', textContent: 'Not now' });
  later.onclick = () => close('later');
  buttons.push(later);

  card.append(
    x,
    el('p', { className: 'nudge-h', textContent: 'Find HelioField useful?' }),
    tip,
    el('p', { className: 'nudge-sub', textContent: 'A star helps other researchers find HelioField.' }),
    el('div', { className: 'nudge-b' }, buttons),
  );
  document.body.append(card);
  addEventListener('keydown', onKey);
  requestAnimationFrame(() => card.classList.add('on'));
  track('shown');
}

const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (!seen() && !framed && !standalone && !document.documentElement.classList.contains('embed')) {
  // Keep the browser's install offer for the card's button (only on visits that may show the card).
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

  // Count only time the page is actually in view.
  let since = document.visibilityState === 'visible' ? performance.now() : null;
  let spent = 0;
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    if (since !== null) timer = setTimeout(show, Math.max(0, DELAY_MS - spent));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      since = performance.now();
    } else if (since !== null) {
      spent += performance.now() - since;
      since = null;
    }
    arm();
  });
  arm();
}
