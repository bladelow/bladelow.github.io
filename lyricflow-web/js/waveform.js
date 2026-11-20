// Canvas waveform: tap = seek, drag = pan, wheel / pinch / buttons = zoom. Shows word markers.
export class Waveform {
  constructor(canvas, { onSeek }) {
    this.c = canvas; this.ctx = canvas.getContext("2d"); this.onSeek = onSeek;
    this.peaks = new Float32Array(0); this.pps = 100; this.duration = 0;
    this.start = 0; this.span = 10; this.head = 0; this.events = []; this.selected = new Set(); this.region = null;
    this.pointers = new Map();
    this.w = 0; this.h = 0; this.dpr = 1;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => { this.pointers.delete(e.pointerId); });
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = Math.max(1, Math.floor(r.width)); this.h = Math.max(1, Math.floor(r.height));
    this.c.width = this.w * this.dpr; this.c.height = this.h * this.dpr;
    this.draw();
  }
  setData(peaks, pps, duration) { this.peaks = peaks; this.pps = pps; this.duration = duration; this.fit(); }
  setEvents(events, selected) { this.events = events; this.selected = selected; this.draw(); }
  setRegion(r) { this.region = r; this.draw(); }
  setHead(t, follow) {
    this.head = t;
    if (follow && (t < this.start || t > this.start + this.span * 0.95)) this.start = this.clampStart(t - this.span * 0.1);
    this.draw();
  }
  clampStart(s) { return Math.max(0, Math.min(s, Math.max(0, this.duration - this.span))); }
  fit() { this.span = Math.max(1, this.duration || 10); this.start = 0; this.draw(); }
  zoom(f, anchor = this.start + this.span / 2) {
    const span = Math.min(Math.max(this.duration || 10, 1), Math.max(1.5, this.span * f));
    const ratio = (anchor - this.start) / this.span;
    this.span = span; this.start = this.clampStart(anchor - ratio * span); this.draw();
  }
  tAt(x) { return this.start + (x / this.w) * this.span; }
  down(e) {
    this.c.setPointerCapture(e.pointerId);
    const rect = this.c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const headX = (this.head - this.start) / this.span * this.w;
    const dragHead = Math.abs(x - headX) <= Math.max(14, 22 * this.dpr);
    this.pointers.set(e.pointerId, { x, x0: x, start0: this.start, moved: false, dragHead });
    if (dragHead) { this.onSeek(Math.max(0, Math.min(this.duration, this.tAt(x)))); }
    if (this.pointers.size === 2) this.pinch0 = { d: this.pdist(), span: this.span };
  }
  pdist() { const p = [...this.pointers.values()]; return Math.abs(p[0].x - p[1].x) || 1; }
  move(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    const rect = this.c.getBoundingClientRect();
    p.x = e.clientX - rect.left;
    if (p.dragHead && this.pointers.size === 1) {
      p.moved = true;
      this.onSeek(Math.max(0, Math.min(this.duration, this.tAt(p.x))));
      return;
    }
    if (this.pointers.size === 2 && this.pinch0) {
      const mid = [...this.pointers.values()].reduce((a, q) => a + q.x, 0) / 2;
      const anchor = this.tAt(mid);
      const target = this.pinch0.span * (this.pinch0.d / this.pdist());
      this.zoom(target / this.span, anchor);
      for (const q of this.pointers.values()) q.moved = true;
      return;
    }
    if (Math.abs(p.x - p.x0) > 5) p.moved = true;
    if (p.moved && this.pointers.size === 1) { this.start = this.clampStart(p.start0 - ((p.x - p.x0) / this.w) * this.span); this.draw(); }
  }
  up(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch0 = null;
    if (p && !p.moved && this.duration) this.onSeek(Math.min(this.duration, Math.max(0, this.tAt(p.x))));
  }
  wheel(e) {
    e.preventDefault();
    if (e.shiftKey) { this.start = this.clampStart(this.start + (e.deltaY || e.deltaX) / this.w * this.span); this.draw(); }
    else this.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, this.tAt(e.offsetX));
  }
  draw() {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0d1017"; ctx.fillRect(0, 0, w, h);
    if (!this.duration) return;
    const mid = h / 2, pxPerSec = w / this.span;
    if (this.region) {
      ctx.fillStyle = "rgba(91,124,255,.18)";
      const x0 = (this.region[0] - this.start) * pxPerSec, x1 = (this.region[1] - this.start) * pxPerSec;
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
    ctx.fillStyle = "#5b7cff";
    const n = this.peaks.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((this.start + (x / w) * this.span) * this.pps);
      const b = Math.max(a + 1, Math.floor((this.start + ((x + 1) / w) * this.span) * this.pps));
      let m = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (this.peaks[i] > m) m = this.peaks[i];
      const bh = Math.max(1, m * (h * 0.42));
      ctx.fillRect(x, mid - bh, 1, bh * 2);
    }
    ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "top";
    const evs = this.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i], x = (e.time - this.start) * pxPerSec;
      if (x < -50 || x > w + 50) continue;
      const sel = this.selected.has(e.id);
      ctx.fillStyle = sel ? "#ffd45a" : e.uncertain ? "rgba(255,154,61,.7)" : "rgba(233,237,245,.28)";
      ctx.fillRect(Math.round(x), 0, sel ? 2 : 1, h);
      if (pxPerSec > 70 || sel) { ctx.fillStyle = sel ? "#ffd45a" : "#cbd3e6"; ctx.fillText(e.text, x + 3, 3 + (i % 2) * 12); }
    }
    const hx = (this.head - this.start) * pxPerSec;
    if (hx >= 0 && hx <= w) { ctx.fillStyle = "#ffffff"; ctx.fillRect(Math.round(hx) - 1, 0, 2, h); }
  }
}
