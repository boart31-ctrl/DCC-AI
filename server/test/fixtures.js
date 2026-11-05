// Shared test helpers: a minimal on-disk pack in a temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'system-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writePack(dir, overrides = {}) {
  const files = {
    'pack.json': {
      id: 'test',
      name: 'Test Pack',
      version: '1.0.0',
      lootTiers: [
        { id: 'bronze', name: 'Bronze Box', color: '#cd7f32' },
        { id: 'gold', name: 'Gold Box', color: '#ffd700' },
      ],
      audience: { startViewers: 1000, sponsorHypeThreshold: 0.8 },
      autoBudget: 3,
      notifyPrefix: 'New achievement!',
      stats: [{ id: 'str', label: 'Strength', abbr: 'STR', default: 3 }],
      resources: [{ id: 'hp', label: 'Health', color: '#ff3355', default: 10 }],
      voices: [
        { id: 'host', label: 'Host', lang: 'en-US', rate: 1.1, pitch: 1, prefer: ['Alex'] },
        { id: 'gremlin', label: 'Gremlin', lang: 'en-US', rate: 1.2, pitch: 1.4, prefer: [] },
      ],
    },
    'achievements.json': [
      { id: 'first_blood', title: 'First Blood', desc: 'You hit something.', voice: 'ach_fb', reward: 'Bronze Box', group: 'Combat' },
      { id: 'plain', title: 'Plain', desc: 'No voice.' },
    ],
    'items.json': [
      { id: 'duck', name: 'Duck', desc: 'Squeak.', rarity: 'common', image: 'duck.webp' },
      { id: 'sword', name: 'Sword', desc: 'Pointy.', rarity: 'rare', flavor: 'Forged by someone who really hated bread.' },
      { id: 'crown', name: 'Crown', desc: 'Shiny.', rarity: 'legendary' },
    ],
    'loot.json': {
      bronze: [
        { item: 'duck', weight: 3 },
        { item: 'sword', weight: 1 },
      ],
      gold: [{ item: 'crown', weight: 1 }],
    },
    'quips.json': [
      { id: 'nat1_01', category: 'nat1', text: 'One.', audio: 'nat1_01.mp3' },
      { id: 'nat1_02', category: 'nat1', text: 'Another one.' },
      { id: 'nat1_03', category: 'nat1', text: 'Yet another one.' },
      { id: 'ach_fb', category: 'achievement', text: 'Blood!' },
      { id: 'ach_01', category: 'achievement', text: 'Achievement unlocked.' },
      { id: 'loot_01', category: 'loot', text: 'Loot!' },
    ],
    ...overrides,
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    if (data !== null) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio', 'gremlin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'duck.webp'), 'webp');
  fs.writeFileSync(path.join(dir, 'audio', 'nat1_01.mp3'), 'mp3');
  fs.writeFileSync(path.join(dir, 'audio', 'gremlin', 'nat1_01.mp3'), 'mp3');
  return dir;
}

/** Deterministic RNG returning the given values in a cycle. */
export function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}
