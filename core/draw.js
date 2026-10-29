// Canvas helpers for technical drawings
const TOKEN_NAMES = ["table", "vellum", "vellum-deep", "grid", "graphite", "graphite-soft", "ink",
  "hairline", "red-pencil", "draft-blue", "check-green"];

export const FONT_UI = '"B612", ui-monospace, monospace';
export const FONT_LETTER = '"Vellum Digits", "Routed Gothic", "B612", ui-monospace, monospace';

export function readColors(el = document.documentElement) {
  const cs = getComputedStyle(el);
  const out = {};
  for (const n of TOKEN_NAMES) out[n.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = cs.getPropertyValue(`--${n}`).trim();
  return out;
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function alpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Diverging map blue to vellum to red, t in [-1, 1]
export function divergingRgb(t, colors) {
  const v = hexToRgb(colors.vellum);
  const end = hexToRgb(t >= 0 ? colors.redPencil : colors.draftBlue);
  const k = Math.min(1, Math.abs(t));
  return v.map((c, i) => Math.round(c + (end[i] - c) * k));
}

// Single hue map vellum to graphite, t in [0, 1]
export function rampRgb(t, colors) {
  const v = hexToRgb(colors.vellum), g = hexToRgb(colors.graphite);
  const k = Math.min(1, Math.max(0, t));
  return v.map((c, i) => Math.round(c + (g[i] - c) * k));
}

export function rgbCss([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`;
}

// Canvas sizing for device pixel ratio
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

// View transform, model y up
export function createView() {
  return { scale: 100, ox: 0, oy: 0, w: 1, h: 1 };
}

export function toScreen(view, x, y) {
  return [view.ox + x * view.scale, view.oy - y * view.scale];
}

export function toModel(view, sx, sy) {
  return [(sx - view.ox) / view.scale, (view.oy - sy) / view.scale];
}

export function fitView(view, b, w, h, pad = 40) {
  const bw = Math.max(b.maxX - b.minX, 1e-9), bh = Math.max(b.maxY - b.minY, 1e-9);
  const sx = (w - 2 * pad) / bw, sy = (h - 2 * pad) / bh;
  let scale = Math.min(sx, sy);
  if (!Number.isFinite(scale) || scale <= 0) scale = 100;
  view.scale = scale;
  view.w = w;
  view.h = h;
  view.ox = w / 2 - ((b.minX + b.maxX) / 2) * scale;
  view.oy = h / 2 + ((b.minY + b.maxY) / 2) * scale;
  return view;
}

export function zoomAt(view, sx, sy, factor) {
  const [mx, my] = toModel(view, sx, sy);
  view.scale *= factor;
  view.ox = sx - mx * view.scale;
  view.oy = sy + my * view.scale;
}

// Pan, zoom and pinch on a canvas
export function attachPanZoom(canvas, view, handlers = {}) {
  const pointers = new Map();
  let panning = null, pinch = null, owned = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      owned = null;
      panning = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      handlers.onCancel?.();
      return;
    }
    if (handlers.onDown && handlers.onDown(e, p, toModel(view, p[0], p[1]))) {
      owned = e.pointerId;
      return;
    }
    panning = { id: e.pointerId, last: p, moved: false, start: p };
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.ox += c[0] - pinch.c[0];
      view.oy += c[1] - pinch.c[1];
      if (pinch.d > 0) zoomAt(view, c[0], c[1], d / pinch.d);
      pinch = { d, c };
      handlers.onView?.();
      return;
    }
    if (owned === e.pointerId) {
      handlers.onMove?.(e, p, toModel(view, p[0], p[1]));
      return;
    }
    if (panning && panning.id === e.pointerId) {
      const dx = p[0] - panning.last[0], dy = p[1] - panning.last[1];
      if (Math.hypot(p[0] - panning.start[0], p[1] - panning.start[1]) > 4) panning.moved = true;
      if (panning.moved) {
        view.ox += dx;
        view.oy += dy;
        handlers.onView?.();
      }
      panning.last = p;
      return;
    }
    handlers.onHover?.(e, p, toModel(view, p[0], p[1]));
  });
  const end = (e) => {
    const p = local(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (owned === e.pointerId) {
      owned = null;
      handlers.onUp?.(e, p, toModel(view, p[0], p[1]));
      return;
    }
    if (panning && panning.id === e.pointerId) {
      if (!panning.moved && e.type === "pointerup") handlers.onClick?.(e, p, toModel(view, p[0], p[1]));
      panning = null;
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", (e) => {
    if (!pointers.has(e.pointerId)) handlers.onLeave?.();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(view, p[0], p[1], Math.exp(-e.deltaY * 0.0015));
    handlers.onView?.();
  }, { passive: false });
}

// Primitives in screen pixels
export function line(ctx, x1, y1, x2, y2, color, width = 1, dash = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function polyline(ctx, pts, color, width = 1, dash = null, close = false) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function circle(ctx, x, y, r, stroke, fill = null, width = 1) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}

export function text(ctx, str, x, y, opts = {}) {
  const size = opts.size || 11;
  ctx.save();
  ctx.translate(x, y);
  if (opts.rotate) ctx.rotate(opts.rotate);
  ctx.font = `${size}px ${opts.font || FONT_UI}`;
  ctx.textAlign = opts.align || "left";
  ctx.textBaseline = opts.baseline || "alphabetic";
  if (opts.bg) {
    const w = ctx.measureText(str).width + 6, h = size + 4;
    let bx = -3, by = -h + 3;
    if (ctx.textAlign === "center") bx = -w / 2;
    else if (ctx.textAlign === "right") bx = -w + 3;
    if (ctx.textBaseline === "middle") by = -h / 2;
    else if (ctx.textBaseline === "top") by = -2;
    ctx.fillStyle = opts.bg;
    ctx.fillRect(bx, by, w, h);
  }
  ctx.fillStyle = opts.color || "#3B3E42";
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

export function lettering(ctx, str, x, y, opts = {}) {
  text(ctx, str.toUpperCase(), x, y, { font: FONT_LETTER, ...opts });
}

export function arrowHead(ctx, x, y, angle, color, size = 8) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - 0.32), y - size * Math.sin(angle - 0.32));
  ctx.lineTo(x - size * Math.cos(angle + 0.32), y - size * Math.sin(angle + 0.32));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function arrow(ctx, x1, y1, x2, y2, color, width = 1.5, head = 8) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  line(ctx, x1, y1, x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6, color, width);
  arrowHead(ctx, x2, y2, ang, color, head);
}

// Curved arrow for applied moments
export function momentArrow(ctx, x, y, r, ccw, color, width = 1.5) {
  const a0 = -Math.PI * 0.75, a1 = Math.PI * 0.75;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, a0, a1, false);
  ctx.stroke();
  ctx.restore();
  const end = ccw ? a0 : a1;
  const tx = x + r * Math.cos(end), ty = y + r * Math.sin(end);
  const tang = ccw ? end - Math.PI / 2 : end + Math.PI / 2;
  arrowHead(ctx, tx, ty, tang, color, 8);
}

// Dimension line with extension lines and text
export function dimension(ctx, x1, y1, x2, y2, offset, label, color, textColor) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const nx = -Math.sin(ang) * offset, ny = Math.cos(ang) * offset;
  const ax = x1 + nx, ay = y1 + ny, bx = x2 + nx, by = y2 + ny;
  const ext = Math.sign(offset) * 4;
  line(ctx, x1 + nx * 0.15, y1 + ny * 0.15, ax - Math.sin(ang) * ext, ay + Math.cos(ang) * ext, color, 0.75);
  line(ctx, x2 + nx * 0.15, y2 + ny * 0.15, bx - Math.sin(ang) * ext, by + Math.cos(ang) * ext, color, 0.75);
  line(ctx, ax, ay, bx, by, color, 0.75);
  arrowHead(ctx, ax, ay, ang + Math.PI, color, 6);
  arrowHead(ctx, bx, by, ang, color, 6);
  let rot = ang;
  if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  text(ctx, label, mx, my, { align: "center", baseline: "middle", color: textColor, rotate: rot, size: 11, bg: "#F4F1E8" });
}

// Hatching in a rectangle
export function hatchRect(ctx, x, y, w, h, color, spacing = 6, width = 0.75) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let t = -h; t < w + h; t += spacing) {
    ctx.moveTo(x + t, y + h);
    ctx.lineTo(x + t + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

// Hatching inside an arbitrary path
export function hatchPath(ctx, pathFn, bounds, color, spacing = 6, width = 0.75) {
  ctx.save();
  ctx.beginPath();
  pathFn(ctx);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  const { x, y, w, h } = bounds;
  for (let t = -h; t < w + h; t += spacing) {
    ctx.moveTo(x + t, y + h);
    ctx.lineTo(x + t + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

// Ground line with hatch, angle is outward normal direction
export function ground(ctx, x, y, len, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  line(ctx, -len / 2, 0, len / 2, 0, color, 1.25);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (let t = -len / 2 + 2; t <= len / 2; t += 5) {
    ctx.moveTo(t, 0);
    ctx.lineTo(t - 5, 6);
  }
  ctx.stroke();
  ctx.restore();
}

// Supports, angle 0 means support below the node
export function pinSupport(ctx, x, y, color, size = 14, angle = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.6, size);
  ctx.lineTo(size * 0.6, size);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ground(ctx, 0, size, size * 1.8, 0, color);
  ctx.restore();
  circle(ctx, x, y, 2.5, color, "#F4F1E8", 1.25);
}

export function rollerSupport(ctx, x, y, color, size = 14, angle = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.6, size * 0.7);
  ctx.lineTo(size * 0.6, size * 0.7);
  ctx.closePath();
  ctx.stroke();
  const r = size * 0.13;
  for (const dx of [-size * 0.35, 0, size * 0.35]) circle(ctx, dx, size * 0.7 + r, r, color, null, 1);
  ground(ctx, 0, size * 0.7 + 2 * r + 1, size * 1.8, 0, color);
  ctx.restore();
  circle(ctx, x, y, 2.5, color, "#F4F1E8", 1.25);
}

export function fixedSupport(ctx, x, y, color, size = 18, angle = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  line(ctx, -size / 2, 0, size / 2, 0, color, 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (let t = -size / 2 + 2; t <= size / 2 + 1; t += 4) {
    ctx.moveTo(t, 0);
    ctx.lineTo(t - 5, 6);
  }
  ctx.stroke();
  ctx.restore();
}

// Distributed load row of arrows with top line
export function distLoad(ctx, x1, y1, x2, y2, q1, q2, color, maxLen = 30) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const nx = Math.sin(ang), ny = -Math.cos(ang);
  const n = Math.max(3, Math.round(Math.hypot(x2 - x1, y2 - y1) / 22));
  const qmax = Math.max(Math.abs(q1), Math.abs(q2)) || 1;
  const top = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const q = q1 + (q2 - q1) * t;
    const len = (Math.abs(q) / qmax) * maxLen;
    const bx = x1 + (x2 - x1) * t, by = y1 + (y2 - y1) * t;
    const sgn = q >= 0 ? 1 : -1;
    const tx = bx + nx * len * sgn, ty = by + ny * len * sgn;
    top.push([tx, ty]);
    if (len > 3) arrow(ctx, tx, ty, bx, by, color, 1, 6);
  }
  polyline(ctx, top, color, 1);
}
