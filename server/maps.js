// Maps with fog of war: an image, hand-drawn zones the GM reveals with one tap, a coarse fog grid for
// brush reveals, and (optional, for online play) tokens. Pure + browser-safe.
//
// state.maps = { list: [Map] }
//   Map   = { id, name, image, aspect, phones, tokensOn, cols, rows, fog, zones: [Zone], tokens: [Token], createdAt }
//     image     URL (https://… or /pack/…), e.g. a map from the content pack or a location picture
//     aspect    width / height of the image (the client measures it)
//     phones    the revealed part is visible on the players' phones ("from the GM" materials)
//     tokensOn  token layer on (online play); players may drag their own crawler's token
//     fog       revealed grid cells, base64 bitmap of cols × rows (row-major, LSB first)
//   Zone  = { id, name, shape: { x, y, w, h } | { points: [[x, y], …] } (0..1 of the image), text, notes,
//             revealed, links: [{ kind, id }] }   text = read-aloud (players see it once revealed), notes = GM only
//   Token = { id, kind: 'pc'|'mob'|'mark', ref, label, color, x, y, hidden }
//
// The TV shows a map through scene kind `map` ({ mapId }); its content is view.maps (role-filtered here):
// the GM gets everything, the TV and phones only revealed zones (no notes), the fog bits and visible tokens.
import { bad, notFound } from './errors.js';

export const MAX_MAPS = 40;
export const MAX_ZONES = 80;
export const MAX_TOKENS = 60;
export const MAX_POINTS = 40;
export const FOG_COLS = 48;
export const TOKEN_KINDS = ['pc', 'mob', 'mark'];
export const ZONE_LINK_KINDS = ['monster', 'boss', 'npc', 'location', 'item', 'card'];
const IMAGE_RE = /^(https?:\/\/|\/pack\/|\/art\/)[^\s"'<>]{1,700}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

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
    x: fin(t.x) ? clamp01(t.x) : 0.5, y: fin(t.y) ? clamp01(t.y) : 0.5, hidden: t.hidden === true,
  };
}
function normMap(m) {
  if (!isObj(m) || typeof m.id !== 'string' || !ID_RE.test(m.id)) return null;
  const aspect = fin(m.aspect) && m.aspect >= 0.2 && m.aspect <= 5 ? m.aspect : 1.5;
  const cols = FOG_COLS;
  const rows = fogRows(aspect);
  const fog = Number.isInteger(m.rows) && m.rows === rows && m.cols === cols ? encode(decodeFog(m.fog, cols, rows)) : encode(emptyFog(cols, rows));
  return {
    id: m.id, name: text(m.name, 80) || 'Map', image: typeof m.image === 'string' && IMAGE_RE.test(m.image) ? m.image : '',
    aspect, phones: m.phones === true, tokensOn: m.tokensOn === true, cols, rows, fog,
    zones: (Array.isArray(m.zones) ? m.zones : []).map(normZone).filter(Boolean).slice(0, MAX_ZONES),
    tokens: (Array.isArray(m.tokens) ? m.tokens : []).map(normToken).filter(Boolean).slice(0, MAX_TOKENS),
    createdAt: fin(m.createdAt) ? m.createdAt : 0,
  };
}
export function normalizeMaps(raw) {
  if (!isObj(raw)) return initMaps();
  return { list: (Array.isArray(raw.list) ? raw.list : []).map(normMap).filter(Boolean).slice(0, MAX_MAPS) };
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
  /** `{ name, image, aspect? }` → result `{ id }` */
  'map.add'(st, a, ctx, out) {
    const maps = ensure(st);
    if (maps.list.length >= MAX_MAPS) throw bad(`max ${MAX_MAPS} maps`);
    const aspect = a.aspect === undefined ? 1.5 : aspectArg(a.aspect);
    const rows = fogRows(aspect);
    const m = { id: ctx.genId('map'), name: nameArg(a.name), image: imageArg(a.image), aspect, phones: false, tokensOn: false, cols: FOG_COLS, rows, fog: encode(emptyFog(FOG_COLS, rows)), zones: [], tokens: [], createdAt: ctx.now };
    maps.list.push(m);
    out.result = { id: m.id };
  },

  /** `{ id, name?, image?, aspect?, phones?, tokensOn? }` — a new aspect resets the fog grid. */
  'map.update'(st, a) {
    const m = mapOf(st, a.id);
    if (a.name !== undefined) m.name = nameArg(a.name);
    if (a.image !== undefined) m.image = imageArg(a.image);
    if (a.aspect !== undefined) {
      const aspect = aspectArg(a.aspect);
      if (fogRows(aspect) !== m.rows) { m.rows = fogRows(aspect); m.fog = encode(emptyFog(m.cols, m.rows)); }
      m.aspect = aspect;
    }
    if (a.phones !== undefined) m.phones = a.phones === true;
    if (a.tokensOn !== undefined) m.tokensOn = a.tokensOn === true;
  },

  'map.remove'(st, a) {
    const maps = ensure(st);
    const m = mapOf(st, a.id);
    maps.list = maps.list.filter((x) => x !== m);
  },

  /** Brush / rectangle reveal: `{ id, rect: {x,y,w,h}, reveal }` or `{ id, all: true|false }` (reveal / cover everything). */
  'map.fog'(st, a, ctx, out) {
    const m = mapOf(st, a.id);
    const bits = decodeFog(m.fog, m.cols, m.rows);
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
    const z = zoneOf(m, a.zoneId);
    z.revealed = a.on !== false;
    if (z.revealed && (onTv(st, m.id) || m.phones)) out.emit({ type: 'map.reveal', mapId: m.id, zoneId: z.id, name: z.name });
  },

  /** `{ id, kind, ref?, label, color?, x?, y? }` → result `{ tokenId }`. One token per crawler (ref = player id). */
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
  },

  'map.token.remove'(st, a) {
    const m = mapOf(st, a.id);
    tokenOf(m, a.tokenId);
    m.tokens = m.tokens.filter((x) => x.id !== a.tokenId);
  },
};

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

/** What the TV and phones may see of one map: revealed zones without GM notes, fog bits, visible tokens. */
export function publicMap(m) {
  return {
    id: m.id, name: m.name, image: m.image, aspect: m.aspect, cols: m.cols, rows: m.rows, fog: m.fog,
    tokensOn: m.tokensOn, phones: m.phones,
    zones: m.zones.filter((z) => z.revealed).map(({ id, name, shape, text: t }) => ({ id, name, shape, text: t })),
    tokens: m.tokensOn ? m.tokens.filter((t) => !t.hidden).map(({ id, kind, ref, label, color, x, y }) => ({ id, kind, ref, label, color, x, y })) : [],
  };
}

/** GM: every map in full. TV: the map on air. Player: maps shared to phones (+ the one on air). */
export function mapsView(state, role) {
  const list = state.maps?.list ?? [];
  if (role === 'gm') return list;
  const live = state.scene?.kind === 'map' ? state.scene.data?.mapId : null;
  if (role === 'stage') return list.filter((m) => m.id === live).map(publicMap);
  return list.filter((m) => m.phones || m.id === live).map(publicMap);
}
