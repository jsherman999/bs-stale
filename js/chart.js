// Sorted column chart: one column per account, height = time since last
// activity on a log scale, stalest on the left. Columns past the threshold
// are drawn in the accent color.

const SVG = 'http://www.w3.org/2000/svg';
const DAY = 864e5;
const TICKS = [
  [1, '1d'], [7, '1w'], [30, '1mo'], [91, '3mo'], [182, '6mo'],
  [365, '1y'], [730, '2y'], [1461, '4y'],
];
const HEIGHT = 208;
const M = { top: 10, right: 12, bottom: 22, left: 36 };

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

export class ActivityChart {
  constructor(root, { onSelect, describe }) {
    this.root = root;
    this.onSelect = onSelect;
    this.describe = describe;
    this.points = [];
    this.threshold = 365;
    this.active = -1;

    this.svg = el('svg', { class: 'chart-svg', role: 'img', height: HEIGHT });
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    root.append(this.svg, this.tip);

    new ResizeObserver(() => this.render()).observe(root);
  }

  // points: [{ key, ageDays (number | null for "no activity found"), stale }]
  update(points, threshold) {
    this.points = points;
    this.threshold = threshold;
    this.active = -1;
    this.tip.hidden = true;
    this.render();
  }

  render() {
    const width = Math.floor(this.svg.getBoundingClientRect().width);
    if (width < 120) return;
    const svg = this.svg;
    svg.replaceChildren();
    svg.setAttribute('width', width);
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);

    const n = this.points.length;
    const plotW = width - M.left - M.right;
    const plotH = HEIGHT - M.top - M.bottom;
    const base = M.top + plotH;

    const finite = this.points.map(p => p.ageDays).filter(a => a != null);
    const maxAge = Math.max(this.threshold * 1.25, ...finite.map(a => a * 1.1), 30);
    const minAge = 0.5;
    const lmin = Math.log(minAge), lmax = Math.log(maxAge);
    const y = days => base - ((Math.log(Math.min(Math.max(days, minAge), maxAge)) - lmin) / (lmax - lmin)) * plotH;
    this.geom = { plotW, plotH, base, n };

    svg.setAttribute('aria-label',
      `${n} accounts sorted by time since last activity; ${this.points.filter(p => p.stale).length} past the threshold.`);

    // Grid + y ticks
    const grid = el('g', { class: 'chart-grid' }, svg);
    let lastTick = Infinity;
    for (const [days, label] of TICKS) {
      if (days > maxAge) break;
      const ty = Math.round(y(days)) + 0.5;
      if (lastTick - ty < 14) continue; // keep labels from colliding on short charts
      lastTick = ty;
      el('line', { x1: M.left, x2: width - M.right, y1: ty, y2: ty }, grid);
      el('text', { x: M.left - 8, y: ty, class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid)
        .textContent = label;
    }
    const baseline = Math.round(base) + 0.5;
    el('line', { x1: M.left, x2: width - M.right, y1: baseline, y2: baseline, class: 'chart-base' }, svg);

    if (!n) {
      el('text', { x: M.left + plotW / 2, y: M.top + plotH / 2, class: 'chart-empty', 'text-anchor': 'middle' }, svg)
        .textContent = 'No accounts to chart yet';
      return;
    }

    // Columns: one path per color for speed with thousands of accounts.
    const step = plotW / n;
    const gap = step >= 4 ? 2 : 0;
    const w = Math.min(24, gap ? step - gap : step + 0.35);
    const offset = (step - w) / 2;
    const paths = { stale: [], other: [] };
    this.points.forEach((p, i) => {
      const top = Math.min(p.ageDays == null ? M.top : y(p.ageDays), base - 1.5);
      paths[p.stale ? 'stale' : 'other'].push(column(M.left + i * step + offset, top, w, base));
    });
    el('path', { d: paths.other.join(''), class: 'bar' }, svg);
    el('path', { d: paths.stale.join(''), class: 'bar bar-stale' }, svg);

    // Threshold rule
    const thy = Math.round(y(this.threshold)) + 0.5;
    el('line', { x1: M.left, x2: width - M.right, y1: thy, y2: thy, class: 'chart-threshold' }, svg);

    // Axis captions
    el('text', { x: M.left, y: HEIGHT - 6, class: 'chart-tick' }, svg).textContent = 'Longest inactive';
    el('text', { x: width - M.right, y: HEIGHT - 6, class: 'chart-tick', 'text-anchor': 'end' }, svg).textContent = 'Most recent';

    // Hover highlight + hit layer
    this.hl = el('g', { class: 'chart-hl' }, svg);
    const hit = el('rect', {
      x: M.left, y: M.top, width: plotW, height: plotH + 2, class: 'chart-hit', tabindex: 0,
      'aria-label': 'Account activity chart. Use arrow keys to move between accounts, Enter to jump to one.',
    }, svg);
    hit.addEventListener('pointermove', e => this.hover(this.indexAt(e)));
    hit.addEventListener('pointerleave', () => this.hover(-1));
    hit.addEventListener('click', e => {
      const i = this.indexAt(e);
      if (i >= 0) this.onSelect?.(this.points[i].key);
    });
    hit.addEventListener('focus', () => { if (this.active < 0) this.hover(0); });
    hit.addEventListener('blur', () => this.hover(-1));
    hit.addEventListener('keydown', e => {
      const jump = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight') this.hover(Math.min(n - 1, this.active + jump));
      else if (e.key === 'ArrowLeft') this.hover(Math.max(0, this.active - jump));
      else if (e.key === 'Home') this.hover(0);
      else if (e.key === 'End') this.hover(n - 1);
      else if (e.key === 'Enter' && this.active >= 0) this.onSelect?.(this.points[this.active].key);
      else if (e.key === 'Escape') this.hover(-1);
      else return;
      e.preventDefault();
    });
    this.y = y;
    this.step = step;
    this.colW = w;
    this.colOffset = offset;
  }

  indexAt(e) {
    const rect = this.svg.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.left) / this.step);
    return i >= 0 && i < this.points.length ? i : -1;
  }

  hover(i) {
    this.active = i;
    this.hl.replaceChildren();
    if (i < 0) { this.tip.hidden = true; return; }
    const p = this.points[i];
    const { base, plotH } = this.geom;
    const x = M.left + i * this.step;
    const band = Math.max(this.step, 6);
    el('rect', { x: x + this.step / 2 - band / 2, y: M.top, width: band, height: plotH, class: 'chart-band' }, this.hl);
    const top = Math.min(p.ageDays == null ? M.top : this.y(p.ageDays), base - 1.5);
    const w = Math.max(this.colW, 2);
    el('path', { d: column(x + this.step / 2 - w / 2, top, w, base), class: 'bar bar-hover' }, this.hl);

    const { value, label, detail } = this.describe(p.key);
    const tip = this.tip;
    tip.replaceChildren();
    const v = document.createElement('div'); v.className = 'tip-value'; v.textContent = value;
    const l = document.createElement('div'); l.className = 'tip-label'; l.textContent = label;
    const d = document.createElement('div'); d.className = 'tip-detail'; d.textContent = detail;
    tip.append(v, l, d);
    tip.hidden = false;

    const cx = x + this.step / 2;
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max(cx - tw / 2, 0), this.svg.getBoundingClientRect().width - tw);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(top - tip.offsetHeight - 10, 0)}px`;
  }
}

// Column path with a rounded data end when wide enough, square at the baseline.
function column(x, top, w, base) {
  const h = base - top;
  const r = w >= 6 ? Math.min(4, w / 2, h) : 0;
  if (!r) return `M${x.toFixed(2)} ${base}V${top.toFixed(2)}h${w.toFixed(2)}V${base}Z`;
  return `M${x.toFixed(2)} ${base}V${(top + r).toFixed(2)}q0 ${-r} ${r} ${-r}h${(w - 2 * r).toFixed(2)}q${r} 0 ${r} ${r}V${base}Z`;
}

export { DAY };
