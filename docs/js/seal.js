// Draws a wax-seal impression unique to a public key.
// The outline, colour and engraving all come from the key bytes, so two
// different keys never look alike — which is exactly what a seal is for.
// state: "intact" | "cracked" | "blank" | "torn"

const NS = "http://www.w3.org/2000/svg";

function bytesOf(pubHex) {
  const out = [];
  for (let i = 0; i + 1 < (pubHex || "").length; i += 2) out.push(parseInt(pubHex.substr(i, 2), 16));
  while (out.length < 32) out.push(128);
  return out;
}

export function sealHue(pubHex) {
  const b = bytesOf(pubHex);
  return Math.round(((b[0] << 8) | b[1]) / 65536 * 360);
}

function el(name, attrs) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// Seals are redrawn on every render, so each distinct seal is built once and cloned.
const cache = new Map();
let built = 0;
export function drawSeal(opts) {
  const { pub = "", initial = "?", state = "intact", size = 44, title = "" } = opts;
  const key = `${pub}|${initial}|${state}|${size}|${title}`;
  let svg = cache.get(key);
  if (!svg) {
    svg = buildSeal({ pub, initial, state, size, title });
    if (cache.size >= 400) cache.delete(cache.keys().next().value);
    cache.set(key, svg);
  }
  return svg.cloneNode(true);
}

function buildSeal({ pub, initial, state, size, title }) {
  const b = bytesOf(pub);
  const svg = el("svg", { viewBox: "-50 -50 100 100", width: size, height: size, class: `seal seal-${state}`, role: "img" });
  if (title) {
    const t = el("title", {});
    t.textContent = title;
    svg.appendChild(t);
  }

  const hue = sealHue(pub);
  const wax = state === "blank" ? "hsl(210 8% 62%)" : state === "cracked" ? "hsl(2 68% 38%)" : `hsl(${hue} 46% 34%)`;
  const waxLight = state === "blank" ? "hsl(210 8% 74%)" : state === "cracked" ? "hsl(2 60% 50%)" : `hsl(${hue} 40% 46%)`;

  // Irregular wax outline: 28 lobes, radius jittered by key bytes.
  const pts = [];
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 42 + (b[i % 32] / 255) * 6;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < N; i++) {
    const p = pts[i], q = pts[(i + 1) % N];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    d += ` Q ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  d += " Z";

  const g = el("g", {});
  svg.appendChild(g);
  g.appendChild(el("path", { d, fill: wax }));
  g.appendChild(el("circle", { r: 31, fill: "none", stroke: waxLight, "stroke-width": 2.5 }));

  if (state !== "blank" && state !== "torn") {
    // Engraving: 12 rays whose lengths encode key bytes.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + (b[20] / 255) * 0.5;
      const len = 6 + (b[8 + i] / 255) * 9;
      const r0 = 28 - len;
      g.appendChild(el("line", {
        x1: (Math.cos(a) * r0).toFixed(1), y1: (Math.sin(a) * r0).toFixed(1),
        x2: (Math.cos(a) * 27).toFixed(1), y2: (Math.sin(a) * 27).toFixed(1),
        stroke: waxLight, "stroke-width": 2.2, "stroke-linecap": "round",
      }));
    }
    const letter = el("text", {
      x: 0, y: 1, "text-anchor": "middle", "dominant-baseline": "central",
      "font-family": "Alegreya, Georgia, serif", "font-weight": 700, "font-size": 30, fill: waxLight,
    });
    letter.textContent = (initial || "?").slice(0, 1).toUpperCase();
    g.appendChild(letter);
  } else if (state === "blank") {
    const q = el("text", {
      x: 0, y: 2, "text-anchor": "middle", "dominant-baseline": "central",
      "font-family": "Alegreya, Georgia, serif", "font-size": 34, fill: waxLight,
    });
    q.textContent = "?";
    g.appendChild(q);
  }

  if (state === "cracked") {
    // A jagged crack across the seal, with the right half knocked out of place.
    const crack = "M -4 -50 L 3 -28 L -6 -12 L 5 4 L -3 20 L 6 34 L 0 50";
    const uid = "seal" + ++built; // clones share it; their clip paths are identical
    const clipR = el("clipPath", { id: `r-${uid}` });
    clipR.appendChild(el("path", { d: crack + " L 60 50 L 60 -50 Z" }));
    const clipL = el("clipPath", { id: `l-${uid}` });
    clipL.appendChild(el("path", { d: crack + " L -60 50 L -60 -50 Z" }));
    svg.appendChild(clipR);
    svg.appendChild(clipL);
    const right = g.cloneNode(true);
    g.setAttribute("clip-path", `url(#${clipL.id})`);
    right.setAttribute("clip-path", `url(#${clipR.id})`);
    right.setAttribute("transform", "translate(4 3) rotate(6)");
    svg.appendChild(right);
    svg.appendChild(el("path", { d: crack, fill: "none", style: "stroke: var(--paper, #f7f8f6)", "stroke-width": 3.5, "stroke-linejoin": "round" }));
  }
  if (state === "torn") {
    svg.appendChild(el("path", { d: "M -50 8 L -30 -2 L -12 10 L 6 -4 L 22 9 L 50 -3 L 50 50 L -50 50 Z", style: "fill: var(--paper, #f7f8f6)" }));
  }
  return svg;
}
