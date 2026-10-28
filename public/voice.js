const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canListen = Boolean(Recognition);
export const canSpeak = "speechSynthesis" in window;

/**
 * One utterance at a time. Call start() for each turn; onEnd fires when the
 * browser stops listening so the caller decides whether to go again.
 */
export function createListener({ onInterim, onFinal, onEnd, onError }) {
  let recognition = null;

  function start() {
    if (!Recognition || recognition) return;
    const r = new Recognition();
    recognition = r;
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    let heard = false;
    r.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          heard = true;
          onFinal(text.trim());
        } else {
          interim += text;
        }
      }
      if (interim) onInterim(interim.trim());
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
    try {
      r.abort();
    } catch {
      /* already stopped */
    }
  }

  return { start, stop };
}

let voice = null;

function pickVoice() {
  if (voice) return voice;
  const voices = window.speechSynthesis.getVoices();
  voice =
    voices.find((v) => v.lang === "en-US" && v.localService) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null;
  return voice;
}

/** Speaks text and resolves when it ends or is cancelled. */
export function speak(text) {
  return new Promise((resolve) => {
    if (!canSpeak) return resolve();
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) utterance.voice = v;
    utterance.lang = "en-US";
    utterance.rate = 1.02;

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
