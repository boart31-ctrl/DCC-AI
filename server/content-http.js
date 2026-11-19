// Shared response rules for the binary ZIP route and its generated media.
import { contentImage } from './content-media.js';
import { ActionError } from './errors.js';

const shapes = {
  monster: 'M44 49 74 26 88 55h64l14-29 30 23 5 74-27 42H66l-27-42z M68 86l34 15-33 12z M172 86l-34 15 33 12z',
  boss: 'M45 51l39 39 36-59 36 59 39-39-13 108H58z M81 127h78v12H81z',
  npc: 'M120 37a40 40 0 1 1 0 80 40 40 0 1 1 0-80z M52 173c4-74 132-74 136 0z',
  item: 'M65 72l55-33 55 33v82l-55 27-55-27z M65 72l55 31 55-31 M120 104v76',
};

export function contentArtResponse(state, pathname, head) {
  const kind = /^\/pack\/content\/placeholder\/(monster|boss|npc|item)\.svg$/.exec(pathname)?.[1];
  const headers = {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
  };
  if (kind) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 210"><rect width="240" height="210" fill="#23152e"/><path d="${shapes[kind]}" fill="#9f72c8" stroke="#dfbaef" stroke-width="5" fill-rule="evenodd" stroke-linejoin="round"/></svg>`;
    return new Response(head ? null : svg, { headers: { ...headers, 'content-type': 'image/svg+xml' } });
  }
  const bytes = contentImage(state, pathname);
  if (!bytes) return new Response(null, { status: 404, headers });
  return new Response(head ? null : bytes, { headers: { ...headers, 'content-type': 'image/png', 'content-length': bytes.length } });
}

const status = { bad_request: 400, conflict: 409, too_big: 413, internal: 500, unsupported_media: 415 };

export async function importContentResponse(host, { body, campaignId, contentType }) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  try {
    if (contentType !== 'application/zip') throw new ActionError('unsupported_media', 'expected application/zip');
    return new Response(JSON.stringify(await host.importContent(body, campaignId)), { status: 201, headers });
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    return new Response(JSON.stringify({ error: err.code, msg: err.message }), { status: status[err.code] ?? 500, headers });
  }
}

export async function importMapImageResponse(host, { body, campaignId, contentType, search }) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  try {
    if (contentType !== 'image/png') throw new ActionError('unsupported_media', 'expected image/png');
    const id = search.get('mapId');
    const name = search.get('name');
    const result = await host.importMapImage(body, campaignId, { id, name });
    return new Response(JSON.stringify(result), { status: id ? 200 : 201, headers });
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    return new Response(JSON.stringify({ error: err.code, msg: err.message }), { status: status[err.code] ?? (err.code === 'not_found' ? 404 : 500), headers });
  }
}
