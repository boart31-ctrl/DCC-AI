// Claude via the Artifact `sample` capability: achievement writer, session summary, prep chat.
// Every call runs on the GM's own Claude plan; failures hide the feature or show a short note.
import { sampleProblem } from './util.js';

export class SystemAI {
  constructor(sample, pack) {
    this.sample = sample;
    this.pack = pack;
    this.disabled = !sample;
    this.listeners = new Set();
  }

  get available() { return !this.disabled; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  fail(e) {
    const p = sampleProblem(e);
    if (p.hide) {
      this.disabled = true;
      for (const fn of this.listeners) { try { fn(false); } catch {} }
    }
    const err = new Error(p.userMessage);
    err.userMessage = p.userMessage;
    err.hide = p.hide;
    err.code = e?.code;
    err.partial = e?.text;
    return err;
  }

  voiceBrief() {
    const ex = (this.pack.achievements || []).filter((a) => a.desc).slice(0, 3)
      .map((a) => `- Title: ${a.title}\n  Desc: ${a.desc}${a.reward ? `\n  Reward: ${a.reward}` : ''}`).join('\n');
    return `You write for "${this.pack.systemName}", the sarcastic, smug announcer AI of a tabletop RPG run as an intergalactic game show. Its voice: dry, cutting, bureaucratic, darkly funny, mild profanity is fine. Write original text only; never quote or reference any book, film or commercial game.${ex ? `\n\nExamples of its achievements:\n${ex}` : ''}`;
  }

  /** "Write it for me": returns {title, desc, reward} for GM approval. */
  async writeAchievement({ brief, player }) {
    if (this.disabled) throw this.fail({ code: 'not_granted' });
    const who = player ? `${player.name}${player.klass ? `, a ${[player.race, player.klass].filter(Boolean).join(' ')}` : ''}, level ${player.level ?? 1}` : 'a crawler';
    const prompt = `${this.voiceBrief()}

The GM just saw this happen at the table: "${brief}"
It was done by ${who}.

Write ONE new achievement for it. Rules:
- title: 2-6 words, punchy.
- desc: 2-4 sentences in the System's voice, addressed to the player as "you".
- reward: a short, concrete, small in-game reward (e.g. "A Bronze Box", "+1 to your next roll"), or "" if none fits.

Reply with only JSON: {"title": "...", "desc": "...", "reward": "..."}`;
    try {
      const r = await this.sample.json(prompt, { cache: false });
      if (!r || typeof r !== 'object') throw { code: 'invalid_json' };
      return { title: String(r.title || '').slice(0, 80), desc: String(r.desc || '').slice(0, 1200), reward: String(r.reward || '').slice(0, 160) };
    } catch (e) {
      throw this.fail(e);
    }
  }

  /** End of session: factual summary + dramatic "Previously on…". */
  async summarizeSession({ story, log, players }) {
    if (this.disabled) throw this.fail({ code: 'not_granted' });
    const prompt = `${this.voiceBrief()}

You are given the running campaign story so far and this session's event log from a tabletop game. Produce two texts.
1. "summary": a short factual summary of THIS session for the GM's campaign notes. 4-8 plain sentences. Name characters, what they got and what happened. No jokes.
2. "previously": a dramatic "Previously on..." recap in the System's voice, 60-120 words, to be read aloud at the start of next session.

Story so far:
${(story || '(none yet)').slice(-6000)}

Party:
${players}

Session log (oldest first):
${log}

Reply with only JSON: {"summary": "...", "previously": "..."}`;
    try {
      const r = await this.sample.json(prompt, { cache: false });
      return { summary: String(r?.summary || ''), previously: String(r?.previously || '') };
    } catch (e) {
      throw this.fail(e);
    }
  }

  /**
   * Prep chat turn. `turns` is the page-kept conversation; `context` is rebuilt every call
   * (Claude keeps nothing between calls). Tools create prepared cards in the page.
   */
  async prepTurn({ turns, context, tools, onText, signal }) {
    if (this.disabled) throw this.fail({ code: 'not_granted' });
    const rules = `${this.voiceBrief()}

You are helping the GM prepare the next session. You can see the campaign below. Be concrete and brief. When the GM agrees on something to prepare, call a tool to create a one-tap card for the GM desk: prepare_achievement, prepare_loot, prepare_message, prepare_line, or add_note for a plan note. Use exact ids from the context for players, tiers and catalog achievements. After using tools, say in one or two sentences what you created.

CAMPAIGN CONTEXT
${context}`;
    try {
      const { text } = await this.sample([{ role: 'user', content: rules }, ...turns], { cache: false, tools, onText, signal });
      return text;
    } catch (e) {
      throw this.fail(e);
    }
  }
}
