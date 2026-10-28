import { createEndpointer, rankVoices } from "/speech-logic.js";

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const SILENCE_MS = 1300;

export const canListen = Boolean(Recognition);
export const canSpeak = "speechSynthesis" in window;

/**
 * One utterance at a time. Call start() for each turn; onEnd fires when the
 * browser stops listening so the caller decides whether to go again. An
 * utterance ends after a real pause, not at the browser's first short one.
 */
export function createListener({ onInterim, onFinal, onEnd, onError }) {
  let recognition = null;
  let endpointer = null;

  function start() {
    if (!Recognition || recognition) return;
    const r = new Recognition();
    recognition = r;
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    let heard = false;
    const mine = createEndpointer({
      silenceMs: SILENCE_MS,
      onChange: onInterim,
      onUtterance: (text) => {
        heard = true;
        onFinal(text);
      },
    });
    endpointer = mine;
    r.onresult = (event) => {
      try {
        mine.update(Array.from(event.results, (res) => ({ transcript: res[0].transcript })));
      } catch (err) {
        // A listener that hears you but never answers is worse than one that says it broke.
        console.error("speech handling failed", err);
        onError("internal");
      }
    };
    r.onerror = (event) => {
      // "no-speech" and "aborted" are normal; the caller restarts on end.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        onError("blocked");
      } else {
        onError(event.error);
      }
    };
    r.onend = () => {
      if (recognition === r) recognition = null;
      mine.flush(); // the browser stopped first; do not lose what was said
      onEnd({ heard });
    };

    try {
      r.start();
    } catch {
      recognition = null;
      onError("start-failed");
    }
  }

  function stop() {
    const r = recognition;
    recognition = null;
    if (!r) return;
    r.onend = null;
    r.onresult = null;
    r.onerror = null;
    endpointer?.discard();
    endpointer = null;
    try {
      r.abort();
    } catch {
      /* already stopped */
    }
  }

  return { start, stop };
}

let preferredName = null;

/** English voices on this device, best sounding first. */
export function availableVoices() {
  return canSpeak ? rankVoices(window.speechSynthesis.getVoices()) : [];
}

/** The voice that will be used: the user's choice if it still exists, else the best one. */
export function currentVoice() {
  const voices = availableVoices();
  return voices.find((v) => v.name === preferredName) ?? voices[0] ?? null;
}

export function setPreferredVoice(name) {
  preferredName = name;
}

/** Browsers load voices late, so callers refresh their lists when this fires. */
export function onVoicesChanged(callback) {
  if (canSpeak) window.speechSynthesis.addEventListener("voiceschanged", callback);
}

/** Speaks text and resolves when it ends or is cancelled. */
export function speak(text) {
  return new Promise((resolve) => {
    if (!canSpeak) return resolve();
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    if (v) {
      utterance.voice = v;
      utterance.lang = v.lang;
    } else {
      utterance.lang = "en-US";
    }
    utterance.rate = 1;

    // Chrome sometimes never fires "end", which would leave the app stuck on "Speaking".
    const guard = setTimeout(done, Math.max(6000, text.length * 110));
    function done() {
      clearTimeout(guard);
      resolve();
    }
    utterance.onend = done;
    utterance.onerror = done;
    synth.speak(utterance);
  });
}

export function cancelSpeech() {
  if (canSpeak) window.speechSynthesis.cancel();
}
