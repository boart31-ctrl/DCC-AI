// Fifth edition fantasy rules, 2014 version. Mechanics only, in our own words.
// Game mechanics follow the System Reference Document 5.1 by Wizards of the Coast LLC,
// licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/legalcode). See docs/RULESETS.md.
import { dndShared } from './dnd-shared.js';

export default dndShared({
  id: 'dnd5e',
  name: '5e fantasy (2014 rules)',
  system: {
    family: 'dnd',
    edition: '2014',
    label: '5e · 2014 rules (SRD 5.1)',
    short: '5e 2014',
    attribution:
      'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode).',
  },
  labels: { race: 'Race', class: 'Class', background: 'Background' },
  exhaustion: '2014',
});
