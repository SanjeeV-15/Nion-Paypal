// Pure helpers for speech, kept free of browser globals so they can be tested.

// Novelty voices that ship with macOS. Fun for a minute, wrong for paying someone.
const NOVELTY = new Set([
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Fred",
  "Good News",
  "Jester",
  "Junior",
  "Organ",
  "Ralph",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
]);

// Compact character voices: usable, but they sound the most synthetic.
const CHARACTER = /^(Kathy|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;

/** @typedef {{ name: string, lang: string, localService?: boolean }} VoiceLike */

/** @param {VoiceLike} voice */
export function scoreVoice(voice) {
  const { name, lang, localService } = voice;
  let score = 0;
  if (/premium|enhanced|natural|neural/i.test(name)) score += 100;
  if (/^Google (US|UK) English/.test(name)) score += 60;
  if (/online/i.test(name)) score += 40;
  if (/^(Samantha|Ava|Allison|Zoe|Evan|Nathan|Tom|Susan)\b/.test(name)) score += 30;
  if (lang === "en-US") score += 10;
  else if (lang === "en-GB") score += 6;
  if (localService) score += 2;
  if (CHARACTER.test(name)) score -= 50;
  return score;
}

/**
 * English voices, best sounding first, without the novelty ones.
 * @template {VoiceLike} T
 * @param {T[]} voices
 * @returns {T[]}
 */
export function rankVoices(voices) {
  return voices
    .filter((v) => /^en[-_]/i.test(v.lang) && !NOVELTY.has(v.name))
    .map((v) => ({ v, score: scoreVoice(v) }))
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

/**
 * @typedef {object} EndpointerOptions
 * @property {number} silenceMs how long a pause counts as "finished"
 * @property {(text: string) => void} onUtterance called once with the whole sentence
 * @property {(text: string) => void} [onChange] called with the words so far
 * @property {{ set: typeof setTimeout, clear: typeof clearTimeout }} [timers] replaceable for tests
 */

/**
 * Decides when someone has finished talking. Browsers cut a sentence at the
 * first short pause; this waits for real silence, so "pay twelve dollars... to
 * Sunrise Cafe" arrives as one request instead of two.
 */
/** @param {EndpointerOptions} options */
export function createEndpointer({ silenceMs, onUtterance, onChange, timers = { set: setTimeout, clear: clearTimeout } }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let text = "";

  function cancel() {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  }

  function flush() {
    cancel();
    const said = text;
    text = "";
    if (said) onUtterance(said);
  }

  return {
    /**
     * Feed every result heard so far in this session.
     * @param {{ transcript: string }[]} results
     */
    update(results) {
      const joined = results
        .map((r) => r.transcript)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!joined) return;
      text = joined;
      onChange?.(joined);
      cancel();
      timer = timers.set(flush, silenceMs);
    },
    /** Send what has been heard so far, now. */
    flush,
    /** Forget what has been heard. */
    discard() {
      cancel();
      text = "";
    },
    get pending() {
      return text !== "";
    },
  };
}
