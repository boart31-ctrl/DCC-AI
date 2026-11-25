// Maps with fog of war: an image, hand-drawn zones the GM reveals with one tap, a coarse fog grid for
// brush reveals, and (optional, for online play) tokens. Pure + browser-safe.
//
// state.maps = { list: [Map] }
//   Map   = { id, name, image, aspect, phones, tokensOn, cols, rows, fog, zones: [Zone], tokens: [Token], createdAt, camera? }
//     image     URL (https://… or /pack/…), e.g. a map from the content pack or a location picture
//     aspect    width / height of the image (the client measures it)
//     phones    the revealed part is visible on the players' phones ("from the GM" materials)
//     tokensOn  token layer on (online play); players may drag their own crawler's token
//     fog       revealed grid cells, base64 bitmap of cols × rows (row-major, LSB first)
//   Zone  = { id, name, shape: { x, y, w, h } | { points: [[x, y], …] } (0..1 of the image), text, notes,
//             revealed, links: [{ kind, id }] }   text = read-aloud (players see it once revealed), notes = GM only
//   Token = { id, kind: 'pc'|'mob'|'mark', ref, label, color, x, y, hidden, enc?, slot? }
//     ref       pc: the player id · mob: the combatant uid once its encounter runs (then the fight decides
//               whether it is hidden or down) · enc/slot: the prepared encounter (prep card id) and which
//               of its mobs this token stands for (0-based, in the encounter's order)
//   Stroke = { id, pts: [[x, y], …], color, gm }   pen drawing on the map; gm = only the GM sees it
//
// Tokens are always part of the map (the GM moves them at the table; the TV shows the visible ones).
// `tokensOn` only lets the players drag their own crawler's token on their phones (online play).
//
// The TV shows a map through scene kind `map` ({ mapId }); its content is view.maps (role-filtered here):
// the GM gets everything, the TV and phones only revealed zones (no notes), the fog bits and visible tokens.
import { publicMarks } from './marks.js';
import { bad, notFound } from './errors.js';
import { libraryOf } from './character.js';

export const MAX_MAPS = 40;
export const MAX_ZONES = 80;
export const MAX_TOKENS = 60;
export const MAX_POINTS = 40;
export const MAX_STROKES = 150;
export const MAX_STROKE_POINTS = 300;
export const FOG_COLS = 48;
const MAX_MOB_STARTS = 40;
export const TOKEN_KINDS = ['pc', 'mob', 'mark'];
export const ZONE_LINK_KINDS = ['monster', 'boss', 'npc', 'location', 'item', 'card'];
const IMAGE_RE = /^(https?:\/\/|\/pack\/|\/art\/)[^\s"'<>]{1,700}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizeCamera(value) {
  if (!isObj(value) || !fin(value.zoom) || value.zoom <= 1) return null;
  const zoom = Math.min(4, value.zoom);
  const edge = 0.5 / zoom;
  const coord = (n) => Math.min(1 - edge, Math.max(edge, fin(n) ? n : 0.5));
  return { zoom, x: coord(value.x), y: coord(value.y) };
}

// ---------- fog bitmap ----------

export function fogRows(aspect) {
  return Math.max(6, Math.min(96, Math.round(FOG_COLS / (aspect || 1.5))));
}
function emptyFog(cols, rows) {
  return new Uint8Array(Math.ceil((cols * rows) / 8));
}
function encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function decodeFog(b64, cols, rows) {
  const out = emptyFog(cols, rows);
  if (typeof b64 !== 'string' || !b64) return out;
  try {
    const s = atob(b64);
    for (let i = 0; i < Math.min(s.length, out.length); i++) out[i] = s.charCodeAt(i);
  } catch {}
  return out;
}
export const cellOn = (bits, cols, c, r) => !!(bits[(r * cols + c) >> 3] & (1 << ((r * cols + c) & 7)));
function setCell(bits, cols, c, r, on) {
  const i = r * cols + c;
  if (on) bits[i >> 3] |= 1 << (i & 7);
  else bits[i >> 3] &= ~(1 << (i & 7));
}

/** Sample the old bitmap at each new cell's normalized center. The brush remains at the same map location. */
function resizedFog(fog, cols, oldRows, rows) {
  if (!Number.isInteger(oldRows) || oldRows < 6 || oldRows > 96) return encode(emptyFog(cols, rows));
  const before = decodeFog(fog, cols, oldRows);
  if (oldRows === rows) return encode(before);
  const after = emptyFog(cols, rows);
  for (let r = 0; r < rows; r++) {
    const source = Math.min(oldRows - 1, Math.floor((r + 0.5) * oldRows / rows));
    for (let c = 0; c < cols; c++) if (cellOn(before, cols, c, source)) setCell(after, cols, c, r, true);
  }
  return encode(after);
}

function changeAspect(map, aspect) {
  const rows = fogRows(aspect);
  if (rows !== map.rows) {
    map.fog = resizedFog(map.fog, map.cols, map.rows, rows);
    map.rows = rows;
  }
  map.aspect = aspect;
}

// Zone Zero uses the complement of all zones, including their overlaps. Only the derived fog grid goes to viewers.
function outsideFog(m) {
  if (typeof m.zoneZero !== 'boolean') return m.fog;
  const { cols, rows } = m;
  const inside = emptyFog(cols, rows);
  for (const { shape: s } of m.zones) {
    if (!s.points) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) / cols, y = (r + 0.5) / rows;
        if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) setCell(inside, cols, c, r, true);
      }
      continue;
    }
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) / rows;
      const crossings = [];
      for (let i = 0, j = s.points.length - 1; i < s.points.length; j = i++) {
        const [a, b] = s.points[j], [x, v] = s.points[i];
        if ((b > y) !== (v > y)) crossings.push(a + (x - a) * (y - b) / (v - b));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) / cols;
        if (x >= crossings[i] && x <= crossings[i + 1]) setCell(inside, cols, c, r, true);
      }
    }
  }
  const bits = decodeFog(m.fog, cols, rows);
  for (let i = 0; i < bits.length; i++) bits[i] = m.zoneZero ? (bits[i] | ~inside[i]) : (bits[i] & inside[i]);
  return encode(bits);
}

// ---------- validation ----------

function shapeArg(v) {
  if (!isObj(v)) throw bad('shape must be { x, y, w, h } or { points: [[x, y], …] }');
  if (Array.isArray(v.points)) {
    const pts = v.points.filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])).slice(0, MAX_POINTS).map(([x, y]) => [round4(clamp01(x)), round4(clamp01(y))]);
    if (pts.length < 3) throw bad('a polygon needs at least 3 points');
    return { points: pts };
  }
  if (![v.x, v.y, v.w, v.h].every(fin)) throw bad('shape needs numbers x, y, w, h (0..1)');
  const x = clamp01(Math.min(v.x, v.x + v.w));
  const y = clamp01(Math.min(v.y, v.y + v.h));
  const w = clamp01(Math.abs(v.w));
  const h = clamp01(Math.abs(v.h));
  if (w < 0.005 || h < 0.005) throw bad('zone is too small');
  return { x: round4(x), y: round4(y), w: round4(Math.min(w, 1 - x)), h: round4(Math.min(h, 1 - y)) };
}
const round4 = (v) => Math.round(v * 10000) / 10000;

function normShape(v) {
  try { return shapeArg(v); } catch { return null; }
}

function nameArg(v, field = 'name', max = 80) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} required`);
  if (v.trim().length > max) throw bad(`${field} too long (max ${max})`);
  return v.trim();
}
function imageArg(v) {
  if (typeof v !== 'string' || !IMAGE_RE.test(v.trim())) throw bad('image must be an https:// or /pack/ URL');
  return v.trim();
}
function fallbackArg(v, primary) {
  if (v == null || v === '') return null;
  const image = imageArg(v);
  return image === primary ? null : image;
}

function startsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MOB_STARTS).filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1]))
    .map(([x, y]) => [round4(clamp01(x)), round4(clamp01(y))]);
}
function aspectArg(v) {
  if (!fin(v) || v < 0.2 || v > 5) throw bad('aspect must be a number 0.2..5');
  return Math.round(v * 1000) / 1000;
}
function linksArg(v) {
  if (!Array.isArray(v)) throw bad('links must be an array');
  const out = [];
  for (const l of v.slice(0, 12)) {
    if (!isObj(l) || !ZONE_LINK_KINDS.includes(l.kind) || typeof l.id !== 'string' || !ID_RE.test(l.id)) throw bad(`links: { kind: ${ZONE_LINK_KINDS.join('|')}, id }`);
    if (!out.some((x) => x.kind === l.kind && x.id === l.id)) out.push({ kind: l.kind, id: l.id });
  }
  return out;
}

// ---------- state ----------

export function initMaps() {
  return { list: [] };
}

function normZone(z) {
  if (!isObj(z) || typeof z.id !== 'string' || !ID_RE.test(z.id)) return null;
  const shape = normShape(z.shape);
  if (!shape) return null;
  let links = [];
  try { links = linksArg(Array.isArray(z.links) ? z.links : []); } catch {}
  return { id: z.id, name: text(z.name, 80) || 'Zone', shape, text: text(z.text, 2000), notes: text(z.notes, 2000), revealed: z.revealed === true, links };
}
function normToken(t) {
  if (!isObj(t) || typeof t.id !== 'string' || !ID_RE.test(t.id) || !TOKEN_KINDS.includes(t.kind)) return null;
  return {
    id: t.id, kind: t.kind, ref: typeof t.ref === 'string' && ID_RE.test(t.ref) ? t.ref : null,
    label: text(t.label, 40) || '?', color: COLOR_RE.test(t.color ?? '') ? t.color : '#ffcc00',
    ...(t.notes ? { notes: text(t.notes, 2000) } : {}),
    x: fin(t.x) ? clamp01(t.x) : 0.5, y: fin(t.y) ? clamp01(t.y) : 0.5, hidden: t.hidden === true,
    ...(['monster', 'boss'].includes(t.sourceKind) && typeof t.sourceId === 'string' && ID_RE.test(t.sourceId)
      ? { sourceKind: t.sourceKind, sourceId: t.sourceId, artIndex: Number.isInteger(t.artIndex) ? Math.max(0, Math.min(MAX_TOKENS, t.artIndex)) : 0 } : {}),
    ...(t.combatToken === true ? { combatToken: true } : {}),
    ...(typeof t.enc === 'string' && ID_RE.test(t.enc) && Number.isInteger(t.slot) && t.slot >= 0 && t.slot < 200 ? { enc: t.enc, slot: t.slot } : {}),
  };
}
function strokePts(v) {
  if (!Array.isArray(v)) return null;
  const pts = v.filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])).slice(0, MAX_STROKE_POINTS).map(([x, y]) => [round4(clamp01(x)), round4(clamp01(y))]);
  return pts.length >= 2 ? pts : null;
}
function normStroke(k) {
  if (!isObj(k) || typeof k.id !== 'string' || !ID_RE.test(k.id)) return null;
  const pts = strokePts(k.pts);
  if (!pts) return null;
  return { id: k.id, pts, color: COLOR_RE.test(k.color ?? '') ? k.color : '#ffcc00', gm: k.gm === true };
}
function normMap(m) {
  if (!isObj(m) || typeof m.id !== 'string' || !ID_RE.test(m.id)) return null;
  const aspect = fin(m.aspect) && m.aspect >= 0.2 && m.aspect <= 5 ? m.aspect : 1.5;
  const cols = FOG_COLS;
  const rows = fogRows(aspect);
  const fog = m.cols === cols ? resizedFog(m.fog, cols, m.rows, rows) : encode(emptyFog(cols, rows));
  const image = typeof m.image === 'string' && IMAGE_RE.test(m.image) ? m.image : '';
  const fallbackImage = typeof m.fallbackImage === 'string' && m.fallbackImage !== image && IMAGE_RE.test(m.fallbackImage) ? m.fallbackImage : null;
  const mobStarts = startsOf(m.mobStarts);
  const camera = normalizeCamera(m.camera);
  return {
    id: m.id, name: text(m.name, 80) || 'Map', image,
    ...(fallbackImage ? { fallbackImage } : {}),
    ...(mobStarts.length ? { mobStarts } : {}),
    ...(camera ? { camera } : {}),
    aspect, phones: m.phones === true, tokensOn: m.tokensOn === true, cols, rows, fog,
    ...(typeof m.zoneZero === 'boolean' ? { zoneZero: m.zoneZero } : {}),
    zones: (Array.isArray(m.zones) ? m.zones : []).map(normZone).filter(Boolean).slice(0, MAX_ZONES),
    tokens: (Array.isArray(m.tokens) ? m.tokens : []).map(normToken).filter(Boolean).slice(0, MAX_TOKENS),
    strokes: (Array.isArray(m.strokes) ? m.strokes : []).map(normStroke).filter(Boolean).slice(0, MAX_STROKES),
    createdAt: fin(m.createdAt) ? m.createdAt : 0,
  };
}
export function normalizeMaps(raw) {
  if (!isObj(raw)) return initMaps();
  return { list: (Array.isArray(raw.list) ? raw.list : []).map(normMap).filter(Boolean).slice(0, MAX_MAPS) };
}

/** Refit an installed map only while its primary image is the exact published old art. */
export function upgradePreparedMap(map, seed) {
  if (typeof seed?.fallbackImage !== 'string' || !/^\/pack\/.*\.svg$/i.test(seed.fallbackImage)
    || map?.image !== seed.fallbackImage || typeof seed.image !== 'string'
    || !seed.image.startsWith('/pack/') || !IMAGE_RE.test(seed.image) || seed.image === map.image
    || !fin(seed.aspect) || seed.aspect < 0.2 || seed.aspect > 5) return false;
  const primaries = Array.isArray(seed.zones) ? seed.zones : [];
  for (const old of (Array.isArray(seed.legacyZones) ? seed.legacyZones : []).slice(0, MAX_ZONES)) {
    const shape = normShape(old?.shape);
    const replacement = primaries.find((z) => (z?.legacyName ?? z?.name) === old?.name);
    const next = normShape(replacement?.shape);
    if (!shape || !next || typeof old.name !== 'string') continue;
    const canonical = JSON.stringify(shape);
    const installed = map.zones.filter((z) => z.name === old.name.trim() && JSON.stringify(z.shape) === canonical);
    // With two exact matches their provenance is ambiguous. Keep both geometries.
    if (installed.length === 1) installed[0].shape = next;
  }
  const starts = startsOf(seed.mobStarts);
  if (starts.length && !map.mobStarts?.length) map.mobStarts = starts;
  map.fallbackImage = seed.fallbackImage;
  map.image = seed.image;
  changeAspect(map, aspectArg(seed.aspect));
  return true;
}

function mapOf(st, id) {
  const m = (st.maps?.list ?? []).find((x) => x.id === id);
  if (!m) throw notFound(`no map ${id}`);
  return m;
}
function zoneOf(m, id) {
  const z = m.zones.find((x) => x.id === id);
  if (!z) throw notFound(`no zone ${id}`);
  return z;
}
function tokenOf(m, id) {
  const t = m.tokens.find((x) => x.id === id);
  if (!t) throw notFound(`no token ${id}`);
  return t;
}
function ensure(st) {
  if (!st.maps) st.maps = initMaps();
  return st.maps;
}
const onTv = (st, mapId) => st.scene?.kind === 'map' && st.scene.data?.mapId === mapId;

// ---------- GM actions ----------

export const MAPS_GM = {
  /** `{ name, image, fallbackImage?, aspect?, mobStarts? }` → result `{ id }` */
  'map.add'(st, a, ctx, out) {
    const maps = ensure(st);
    if (maps.list.length >= MAX_MAPS) throw bad(`max ${MAX_MAPS} maps`);
    const aspect = a.aspect === undefined ? 1.5 : aspectArg(a.aspect);
    const rows = fogRows(aspect);
    const image = imageArg(a.image);
    const fallbackImage = fallbackArg(a.fallbackImage, image);
    const mobStarts = startsOf(a.mobStarts);
    const m = { id: ctx.genId('map'), name: nameArg(a.name), image, aspect, phones: false, tokensOn: false, cols: FOG_COLS, rows, fog: encode(emptyFog(FOG_COLS, rows)), zones: [], tokens: [], strokes: [], createdAt: ctx.now,
      ...(fallbackImage ? { fallbackImage } : {}), ...(mobStarts.length ? { mobStarts } : {}) };
    maps.list.push(m);
    out.result = { id: m.id };
  },

  /** Changing the image or aspect keeps normalized geometry and resamples the revealed bitmap. */
  'map.update'(st, a) {
    const m = mapOf(st, a.id);
    if (a.name !== undefined) m.name = nameArg(a.name);
    if (a.image !== undefined) {
      const image = imageArg(a.image);
      if (image !== m.image) delete m.fallbackImage;
      m.image = image;
    }
    if (a.fallbackImage !== undefined) {
      const fallback = fallbackArg(a.fallbackImage, m.image);
      if (fallback) m.fallbackImage = fallback;
      else delete m.fallbackImage;
    }
    if (a.aspect !== undefined) changeAspect(m, aspectArg(a.aspect));
    if (a.phones !== undefined) m.phones = a.phones === true;
    if (a.tokensOn !== undefined) m.tokensOn = a.tokensOn === true;
  },

  'map.camera'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    if (!fin(a.zoom) || a.zoom < 1 || a.zoom > 4) throw bad('zoom must be a number from 1 to 4');
    for (const axis of ['x', 'y']) if (a[axis] !== undefined && !fin(a[axis])) throw bad(`${axis} must be a number`);
    const camera = normalizeCamera({ ...m.camera, zoom: a.zoom, ...(a.x === undefined ? {} : { x: a.x }), ...(a.y === undefined ? {} : { y: a.y }) });
    if (camera) m.camera = camera;
    else delete m.camera;
    out.result = { camera };
  },

  'map.remove'(st, a) {
    const maps = ensure(st);
    const m = mapOf(st, a.id);
    maps.list = maps.list.filter((x) => x !== m);
    if (st.combat?.mapId === m.id) st.combat.mapId = null;
  },

  /** Brush / rectangle reveal: `{ id, rect: {x,y,w,h}, reveal }` or `{ id, all: true|false }` (reveal / cover everything). */
  'map.fog'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    const bits = decodeFog(a.all === undefined ? outsideFog(m) : m.fog, m.cols, m.rows);
    delete m.zoneZero;
    if (a.all !== undefined) {
      bits.fill(a.all === true ? 255 : 0);
      if (a.all !== true) for (const z of m.zones) z.revealed = false;
    } else {
      const r = shapeArg(a.rect);
      if (!('w' in r)) throw bad('rect must be { x, y, w, h }');
      const on = a.reveal !== false;
      const c0 = Math.floor(r.x * m.cols);
      const c1 = Math.min(m.cols - 1, Math.ceil((r.x + r.w) * m.cols) - 1);
      const r0 = Math.floor(r.y * m.rows);
      const r1 = Math.min(m.rows - 1, Math.ceil((r.y + r.h) * m.rows) - 1);
      for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) setCell(bits, m.cols, c, rr, on);
    }
    m.fog = encode(bits);
    if (onTv(st, m.id)) out.emit({ type: 'map.fog', mapId: m.id });
  },

  /** `{ id, name, shape, text?, notes? }` → result `{ zoneId }` */
  'map.zone.add'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    if (m.zones.length >= MAX_ZONES) throw bad(`max ${MAX_ZONES} zones`);
    const z = { id: ctx.genId('z'), name: nameArg(a.name), shape: shapeArg(a.shape), text: text(a.text, 2000), notes: text(a.notes, 2000), revealed: false, links: [] };
    m.zones.push(z);
    out.result = { zoneId: z.id };
  },

  /** `{ id, zoneId, name?, shape?, text?, notes?, links? }` */
  'map.zone.update'(st, a) {
    const z = zoneOf(mapOf(st, a.id), a.zoneId);
    if (a.name !== undefined) z.name = nameArg(a.name);
    if (a.shape !== undefined) z.shape = shapeArg(a.shape);
    if (a.text !== undefined) { if (typeof a.text !== 'string' || a.text.length > 2000) throw bad('text: string, max 2000'); z.text = a.text; }
    if (a.notes !== undefined) { if (typeof a.notes !== 'string' || a.notes.length > 2000) throw bad('notes: string, max 2000'); z.notes = a.notes; }
    if (a.links !== undefined) z.links = linksArg(a.links);
  },

  'map.zone.remove'(st, a) {
    const m = mapOf(st, a.id);
    zoneOf(m, a.zoneId);
    m.zones = m.zones.filter((x) => x.id !== a.zoneId);
  },

  /** One tap at the table: `{ id, zoneId, on? }` (default on). The TV animates the reveal. */
  'map.zone.reveal'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    if (a.zoneId === '0') {
      m.zoneZero = a.on !== false;
      if (m.zoneZero && (onTv(st, m.id) || m.phones)) out.emit({ type: 'map.reveal', mapId: m.id, zoneId: '0', name: 'Zone 0' });
      return;
    }
    const z = zoneOf(m, a.zoneId);
    z.revealed = a.on !== false;
    if (z.revealed && (onTv(st, m.id) || m.phones)) out.emit({ type: 'map.reveal', mapId: m.id, zoneId: z.id, name: z.name });
  },

  /** `{ id, kind, ref?, label, color?, x?, y? }` → result `{ tokenId }`. One token per crawler (ref = player id). */
  'map.bindCombat'(st, a) {
    st.combat.mapId = a.id === null ? null : mapOf(st, a.id).id;
  },

  'map.token.add'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    if (m.tokens.length >= MAX_TOKENS) throw bad(`max ${MAX_TOKENS} tokens`);
    if (!TOKEN_KINDS.includes(a.kind)) throw bad(`kind must be one of ${TOKEN_KINDS.join(', ')}`);
    let ref = null;
    if (a.kind === 'pc') {
      const p = st.players.find((x) => x.id === a.ref);
      if (!p) throw notFound(`no crawler ${a.ref}`);
      if (m.tokens.some((t) => t.kind === 'pc' && t.ref === p.id)) throw bad(`${p.name} already has a token`);
      ref = p.id;
    } else if (a.ref != null) {
      if (typeof a.ref !== 'string' || !ID_RE.test(a.ref)) throw bad('ref must be an id');
      ref = a.ref;
    }
    const p = a.kind === 'pc' ? st.players.find((x) => x.id === ref) : null;
    const t = {
      id: ctx.genId('tk'), kind: a.kind, ref,
      label: a.label !== undefined ? nameArg(a.label, 'label', 40) : (p?.name ?? 'Marker'),
      color: COLOR_RE.test(a.color ?? '') ? a.color : (p?.color ?? (a.kind === 'mob' ? '#ff3355' : '#ffcc00')),
      x: fin(a.x) ? clamp01(a.x) : 0.5, y: fin(a.y) ? clamp01(a.y) : 0.5, hidden: a.kind === 'mob' && a.hidden !== false,
    };
    if (a.kind === 'mob' && (a.sourceKind !== undefined || a.sourceId !== undefined)) {
      const entry = ['monster', 'boss'].includes(a.sourceKind) && libraryOf(st, ctx.pack).get(a.sourceKind, a.sourceId);
      if (!entry) throw notFound('unknown token library entry');
      const like = m.tokens.filter((x) => x.kind === 'mob' && x.sourceKind === a.sourceKind && x.sourceId === entry.id);
      const index = like.reduce((n, x) => Math.max(n, x.artIndex ?? 0), -1) + 1;
      Object.assign(t, { sourceKind: a.sourceKind, sourceId: entry.id, artIndex: index });
      if (a.label === undefined) {
        if (index === 1 && like[0].label === entry.name.slice(0, 40)) like[0].label = `${entry.name.slice(0, 36)} 1`;
        t.label = index ? `${entry.name.slice(0, 36)} ${index + 1}` : entry.name.slice(0, 40);
      }
    }
    m.tokens.push(t);
    out.result = { tokenId: t.id };
  },

  /** Tokens for every crawler who has none yet, in a row near the top left. */
  'map.token.party'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    let n = 0;
    for (const p of st.players) {
      if (m.tokens.some((t) => t.kind === 'pc' && t.ref === p.id) || m.tokens.length >= MAX_TOKENS) continue;
      m.tokens.push({ id: ctx.genId('tk'), kind: 'pc', ref: p.id, label: p.name, color: p.color ?? '#ffcc00', x: clamp01(0.08 + n * 0.06), y: 0.08, hidden: false });
      n++;
    }
    out.result = { added: n };
  },

  /** `{ id, tokenId, x, y }` */
  'map.token.move'(st, a) {
    const t = tokenOf(mapOf(st, a.id), a.tokenId);
    if (!fin(a.x) || !fin(a.y)) throw bad('x and y must be numbers 0..1');
    t.x = round4(clamp01(a.x));
    t.y = round4(clamp01(a.y));
  },

  /** `{ id, tokenId, label?, color?, hidden? }` */
  'map.token.update'(st, a) {
    const t = tokenOf(mapOf(st, a.id), a.tokenId);
    if (a.label !== undefined) t.label = nameArg(a.label, 'label', 40);
    if (a.color !== undefined) { if (!COLOR_RE.test(a.color)) throw bad('color must be #rgb or #rrggbb'); t.color = a.color; }
    if (a.hidden !== undefined) t.hidden = a.hidden === true;
    if (a.notes !== undefined) {
      if (typeof a.notes !== 'string' || a.notes.length > 2000) throw bad('notes must be text, max 2000 characters');
      t.notes = a.notes;
    }
  },

  'map.token.remove'(st, a) {
    const m = mapOf(st, a.id);
    tokenOf(m, a.tokenId);
    m.tokens = m.tokens.filter((x) => x.id !== a.tokenId);
  },

  /** `{ id, pts: [[x, y], …], color?, gm? }` → result `{ strokeId }`. A pen line on the map. */
  'map.stroke.add'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    m.strokes ??= [];
    if (m.strokes.length >= MAX_STROKES) throw bad(`max ${MAX_STROKES} drawings: erase some first`);
    const pts = strokePts(a.pts);
    if (!pts) throw bad('pts must be at least 2 points [x, y] (0..1)');
    const k = { id: ctx.genId('sk'), pts, color: COLOR_RE.test(a.color ?? '') ? a.color : '#ffcc00', gm: a.gm === true };
    m.strokes.push(k);
    out.result = { strokeId: k.id };
  },
  /** `{ id, strokeId }` or `{ id, all: true }` */
  'map.stroke.remove'(st, a) {
    const m = mapOf(st, a.id);
    m.strokes ??= [];
    if (a.all === true) { m.strokes = []; return; }
    if (!m.strokes.some((k) => k.id === a.strokeId)) throw notFound(`no drawing ${a.strokeId}`);
    m.strokes = m.strokes.filter((k) => k.id !== a.strokeId);
  },
};

/**
 * Mob tokens of a prepared encounter: one per mob (count expanded, encounter order), hidden like the mob,
 * laid out in a loose cluster at (cx, cy). Existing tokens of the encounter keep their place; surplus ones go.
 * `mobs` = [{ name, hidden, color? }] (already expanded). Returns how many were added.
 */
export function placeEncounterTokens(st, mapId, encId, mobs, ctx, { cx = 0.7, cy = 0.5 } = {}) {
  const m = mapOf(st, mapId);
  let added = 0;
  m.tokens = m.tokens.filter((t) => t.enc !== encId || t.slot < mobs.length);
  mobs.forEach((mob, i) => {
    const t = m.tokens.find((x) => x.enc === encId && x.slot === i);
    if (t) {
      Object.assign(t, { label: mob.name.slice(0, 40), sourceKind: mob.sourceKind, sourceId: mob.sourceId, artIndex: mob.artIndex ?? 0 });
      return;
    }
    if (m.tokens.length >= MAX_TOKENS) return;
    const col = i % 4;
    const row = Math.floor(i / 4);
    const [x, y] = m.mobStarts?.[i] ?? [round4(clamp01(cx + (col - 1.5) * 0.065)), round4(clamp01(cy + (row - 0.5) * 0.1))];
    m.tokens.push({ id: ctx.genId('tk'), kind: 'mob', ref: null, label: mob.name.slice(0, 40), color: mob.color || '#ff3355',
      x, y, hidden: mob.hidden !== false, enc: encId, slot: i,
      sourceKind: mob.sourceKind, sourceId: mob.sourceId, artIndex: mob.artIndex ?? 0 });
    added++;
  });
  return added;
}

/** When an encounter runs: its tokens now stand for the new combatants (uids in encounter order). */
export function bindEncounterTokens(st, mapId, encId, uids) {
  const m = (st.maps?.list ?? []).find((x) => x.id === mapId);
  if (!m) return 0;
  let n = 0;
  for (const t of m.tokens) if (t.enc === encId && uids[t.slot]) { t.ref = uids[t.slot]; n++; }
  return n;
}

function mapMobArt(entry, token) {
  const images = [entry?.imageSquare || entry?.image, ...(entry?.variants ?? [])].filter(Boolean);
  return images.length ? images[(token.artIndex ?? 0) % images.length] : null;
}

/** Start normal combat with exactly the revealed mob tokens on this map. */
export function startCombatOnMap(st, a, ctx, out, gm) {
  const map = mapOf(st, a.id);
  const combat = st.combat;
  if (combat.active) {
    if (combat.mapId !== map.id) throw bad('End the current fight before starting one on this map.');
    out.changed = false;
    out.result = { mapId: map.id, started: false, added: 0 };
    return;
  }

  const library = libraryOf(st, ctx.pack);
  const queued = combat.combatants.filter((x) => x.type === 'mob');
  const byUid = new Map(queued.map((x) => [x.uid, x]));
  const existing = new Set();
  const additions = [];
  const bindings = [];
  for (const token of map.tokens) {
    if (token.kind !== 'mob') continue;
    if (token.ref) {
      const mob = byUid.get(token.ref);
      if (mob && !mob.hidden && mob.hp > 0) existing.add(mob.uid);
    } else if (!token.hidden && ['monster', 'boss'].includes(token.sourceKind)) {
      const entry = library.get(token.sourceKind, token.sourceId);
      if (entry) additions.push({ token, entry });
    }
  }

  // An unbound draft entry can be reused if its source and visible name identify the map token.
  for (const { token } of additions) {
    const matches = queued.filter((mob) => !existing.has(mob.uid) && !mob.hidden && mob.hp > 0
      && mob.sourceKind === token.sourceKind && mob.sourceId === token.sourceId && mob.name === token.label);
    if (matches.length !== 1) continue;
    const [mob] = matches;
    existing.add(mob.uid);
    bindings.push({ token, uid: mob.uid });
  }

  if (queued.length && (existing.size !== queued.length || (combat.mapId && combat.mapId !== map.id))) {
    throw bad('A different lineup is already prepared. Start it normally or clear it before starting with this map’s revealed mobs.');
  }
  if (!existing.size && !additions.length) throw bad('Reveal at least one monster or boss token from the Library on this map first.');

  combat.mapId = map.id;
  for (const { token, uid } of bindings) token.ref = uid;
  const newMobs = additions.filter(({ token }) => !token.ref);
  for (const { token, entry } of newMobs) {
    // Bind before the usual combat-token sync so same-species tokens keep their identity and positions.
    const sub = { ...out, result: null };
    gm['combat.addMob'](st, { kind: token.sourceKind, sourceId: entry.id, hidden: false, intro: false }, ctx, sub,
      { name: token.label, image: mapMobArt(entry, token) });
    [token.ref] = sub.result.uids;
  }
  gm['combat.start'](st, {}, ctx, out);
  out.result = { mapId: map.id, started: true, added: newMobs.length };
}

// ---------- player actions ----------

export const MAPS_PLAYER = {
  /** A crawler drags their own token (token layer on). */
  'map.token.move'(st, a, ctx) {
    const m = mapOf(st, a.id);
    if (!m.tokensOn) throw bad('tokens are off on this map');
    const t = tokenOf(m, a.tokenId);
    if (t.kind !== 'pc' || t.ref !== ctx.actor.playerId) throw bad('you can only move your own token');
    if (!fin(a.x) || !fin(a.y)) throw bad('x and y must be numbers 0..1');
    t.x = round4(clamp01(a.x));
    t.y = round4(clamp01(a.y));
  },
};

// ---------- views ----------

/**
 * A token as the fight sees it: a mob token bound to a combatant is hidden while the mob is hidden and
 * `down` once it is down (or gone from the fight).
 */
export function syncCombatTokens(st, ctx) {
  const c = st.combat;
  const m = c?.mapId && st.maps?.list.find((map) => map.id === c.mapId);
  if (!m) return;
  const uids = new Set(c.combatants.map((x) => x.uid));
  m.tokens = m.tokens.filter((t) => !t.combatToken || uids.has(t.ref));
  MAPS_GM['map.token.party'](st, { id: m.id }, ctx, {});
  const bound = new Set(m.tokens.filter((t) => t.kind === 'mob' && t.ref).map((t) => t.ref));
  let index = 0;
  const columns = m.aspect < 1 ? 3 : 5;
  const spacing = columns === 3 ? 0.23 : 0.17;
  for (const x of c.combatants) {
    if (x.type !== 'mob' || bound.has(x.uid)) continue;
    const ready = x.sourceId && m.tokens.find((t) => t.kind === 'mob' && !t.ref && t.sourceKind === x.sourceKind && t.sourceId === x.sourceId);
    if (ready) { ready.ref = x.uid; continue; }
    if (m.tokens.length >= MAX_TOKENS) break;
    const i = index++;
    m.tokens.push({ id: ctx.genId('tk'), kind: 'mob', ref: x.uid, label: x.name.slice(0, 40),
      color: x.sourceKind === 'boss' ? '#ff9900' : '#ff3355', hidden: x.hidden !== false, combatToken: true,
      x: 0.5 + ((i % columns) - (columns - 1) / 2) * spacing, y: Math.min(0.92, 0.44 + Math.floor(i / columns) * 0.10) });
  }
}

function liveToken(st, library, combatRows, t) {
  if (t.kind === 'pc') {
    const p = st.players.find((x) => x.id === t.ref);
    if (!p) return null;
    return { ...t, marks: publicMarks(p.marks), image: p.sheet?.portrait ?? null, down: combatRows.get(p.id)?.down === true };
  }
  if (t.kind !== 'mob') return t;
  const raw = (st.combat?.combatants ?? []).find((x) => x.uid === t.ref);
  const live = raw && combatRows.get(raw.uid);
  if (raw) return { ...t, label: raw.name, sourceKind: raw.sourceKind, sourceId: raw.sourceId,
    image: live?.image ?? raw.image ?? null, hidden: raw.hidden === true, down: raw.hp <= 0 };
  if (t.combatToken) return null;
  const e = library?.get(t.sourceKind, t.sourceId);
  return { ...t, image: mapMobArt(e, t), ...(t.ref ? { hidden: true, down: true } : {}) };
}
function withLive(st, m, library, rows) {
  return { ...m, fog: outsideFog(m), tokens: m.tokens.map((t) => liveToken(st, library, rows, t)).filter(Boolean) };
}

/** What the TV and phones may see of one map: revealed zones without GM notes, fog bits, visible tokens. */
export function publicMap(m) {
  return {
    id: m.id, name: m.name, image: m.image, aspect: m.aspect, cols: m.cols, rows: m.rows, fog: m.fog,
    ...(m.fallbackImage ? { fallbackImage: m.fallbackImage } : {}),
    tokensOn: m.tokensOn, phones: m.phones,
    zones: m.zones.filter((z) => z.revealed).map(({ id, name, shape, text: t }) => ({ id, name, shape, text: t })),
    tokens: m.tokens.filter((t) => !t.hidden).map(({ id, kind, ref, label, color, x, y, down, image, marks }) => ({ ...(marks ? { marks } : {}), id, kind, ref, label, color, x, y, ...(image ? { image } : {}), ...(down ? { down: true } : {}) })),
    strokes: (m.strokes ?? []).filter((k) => !k.gm).map(({ id, pts, color }) => ({ id, pts, color })),
  };
}

/** GM: every map in full. TV: the map on air. Player: maps shared to phones (+ the one on air). */
export function mapsView(state, role, library, combat) {
  const all = state.maps?.list ?? [];
  const live = state.scene?.kind === 'map' ? state.scene.data?.mapId : null;
  const list = role === 'gm' ? all : all.filter((m) => m.id === live || (role === 'player' && m.phones));
  const rows = new Map((combat?.combatants ?? []).map((c) => [c.type === 'mob' ? c.uid : c.playerId, c]));
  return list.map((m) => {
    const view = withLive(state, m, library, rows);
    if (role === 'gm') return view;
    return { ...publicMap(view), ...(role === 'stage' && view.camera ? { camera: view.camera } : {}) };
  });
}
