// Fifth edition fantasy rules, 2024 revision ("5.5"). Mechanics only, in our own words.
// Game mechanics follow the System Reference Document 5.2 by Wizards of the Coast LLC,
// licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/legalcode). See docs/RULESETS.md.
import { dndShared } from './dnd-shared.js';

export default dndShared({
  id: 'dnd2024',
  name: '5e fantasy (2024 rules)',
  system: {
    family: 'dnd',
    edition: '2024',
    label: '5e · 2024 rules (SRD 5.2)',
    short: '5e 2024',
    attribution:
      'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  },
  labels: { race: 'Species', class: 'Class', background: 'Background' },
  exhaustion: '2024',
});
