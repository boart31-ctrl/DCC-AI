// Where content comes from (R17): a short label the GM sees as a badge in the Library, the Prep picker and on
// mob cards, plus a note / licence attribution. Monsters, bosses, NPCs and items may carry `origin: "<id>"`.
// Built-in ids below; a pack adds or overrides its own in pack.json "origins": { id: { label, note } }.

export const SRD51_ATTRIBUTION = 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

export const ORIGINS = {
  srd51: { label: '5e SRD', note: 'Fifth-edition monster from the SRD 5.1, stats as printed.', attribution: SRD51_ATTRIBUTION, license: 'CC-BY-4.0' },
  srd51_dcc: { label: '5e SRD → crawler', note: 'Converted from the SRD 5.1 to crawler-style numbers (tools/build_srd5.mjs). Not official.', attribution: SRD51_ATTRIBUTION, license: 'CC-BY-4.0' },
};

const ID = /^[a-z0-9_-]{1,40}$/;
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');

/** pack.json "origins" → { id: { label, note, attribution?, url?, license? } }. Never throws. */
export function normalizeOrigins(raw, warnings = []) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) { warnings.push('pack.json "origins": expected an object, ignored'); return out; }
  for (const [id, v] of Object.entries(raw).slice(0, 40)) {
    if (!ID.test(id) || !v || typeof v !== 'object' || !str(v.label, 40)) { warnings.push(`pack.json "origins".${id}: needs a label`); continue; }
    out[id] = { label: str(v.label, 40), note: str(v.note, 400), ...(str(v.attribution, 800) ? { attribution: str(v.attribution, 800) } : {}),
      ...(str(v.url, 300) ? { url: str(v.url, 300) } : {}), ...(str(v.license, 40) ? { license: str(v.license, 40) } : {}) };
  }
  return out;
}

/** Built-in origins + the pack's own (pack wins). */
export function originsFor(pack) {
  return { ...ORIGINS, ...(pack?.origins ?? {}) };
}
