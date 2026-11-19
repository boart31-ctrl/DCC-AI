// Campaign-owned art stored in snapshots and exports, outside role projections.
export const CONTENT_MEDIA_LIMIT = 4 * 1024 * 1024;
export const CONTENT_IMAGE_LIMIT = 1536 * 1024;
export const CONTENT_MEDIA_PATH = /^\/pack\/content\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})\.png$/;
const HASH = /^[a-f0-9]{64}$/;

export function mediaBytes(value) {
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

export function normalizeContentMedia(raw) {
  const media = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return media;
  let total = 0;
  for (const [id, data] of Object.entries(raw)) {
    if (!HASH.test(id) || typeof data !== 'string' || data.length > Math.ceil(CONTENT_IMAGE_LIMIT / 3) * 4 ||
        data.length % 4 || !/^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const bytes = mediaBytes(data);
    if (bytes > CONTENT_IMAGE_LIMIT || total + bytes > CONTENT_MEDIA_LIMIT) continue;
    media[id] = data;
    total += bytes;
  }
  return media;
}

export function contentImage(state, path) {
  const match = CONTENT_MEDIA_PATH.exec(path);
  if (!match || match[1] !== state.campaign.id) return null;
  const base64 = state.contentMedia?.[match[2]];
  if (!base64) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
