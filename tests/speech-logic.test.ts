import { afterEach, describe, expect, it, vi } from "vitest";
import { createEndpointer, rankVoices, scoreVoice, silenceFor } from "../public/speech-logic.js";

const voice = (name: string, lang = "en-US", localService = true) => ({ name, lang, localService });

// What this Mac reports, trimmed.
const macOS = [
  voice("Albert"),
  voice("Bad News"),
  voice("Daniel", "en-GB"),
  voice("Eddy (English (United States))"),
  voice("Fred"),
  voice("Grandma (English (United States))"),
  voice("Karen", "en-AU"),
  voice("Kathy"),
  voice("Samantha"),
  voice("Zarvox"),
  voice("Amélie", "fr-CA"),
  voice("Kyoko", "ja-JP"),
];

describe("rankVoices", () => {
  it("puts the best stock voice first and drops novelty and non-English voices", () => {
    const names = rankVoices(macOS).map((v) => v.name);
    expect(names[0]).toBe("Samantha");
    for (const bad of ["Albert", "Bad News", "Fred", "Zarvox", "Amélie", "Kyoko"]) {
      expect(names).not.toContain(bad);
    }
  });

  it("puts the compact character voices last", () => {
    const names = rankVoices(macOS).map((v) => v.name);
    expect(names.slice(-3).sort()).toEqual([
      "Eddy (English (United States))",
      "Grandma (English (United States))",
      "Kathy",
    ]);
  });

  it("prefers premium and enhanced voices over the stock one", () => {
    const names = rankVoices([...macOS, voice("Ava (Premium)"), voice("Zoe (Enhanced)")]).map((v) => v.name);
    expect(names.slice(0, 2).sort()).toEqual(["Ava (Premium)", "Zoe (Enhanced)"]);
    expect(names.indexOf("Samantha")).toBeGreaterThan(1);
  });

  it("prefers a Google or a natural online voice, as Chrome and Edge offer", () => {
    const chrome = rankVoices([...macOS, voice("Google US English", "en-US", false)]).map((v) => v.name);
    expect(chrome[0]).toBe("Google US English");
    const edge = rankVoices([
      voice("Samantha"),
      voice("Microsoft Aria Online (Natural) - English (United States)", "en-US", false),
    ]).map((v) => v.name);
    expect(edge[0]).toMatch(/Aria Online/);
  });

  it("returns an empty list when there are no English voices", () => {
    expect(rankVoices([voice("Kyoko", "ja-JP")])).toEqual([]);
    expect(rankVoices([])).toEqual([]);
  });

  it("orders ties by name so the list is stable", () => {
    const names = rankVoices([voice("Zed Voice"), voice("Abe Voice")]).map((v) => v.name);
    expect(names).toEqual(["Abe Voice", "Zed Voice"]);
  });

  it("scores a US voice above the same voice from another region", () => {
    expect(scoreVoice(voice("Samantha", "en-US"))).toBeGreaterThan(scoreVoice(voice("Samantha", "en-AU")));
  });
});

function setup(silenceMs = 1300) {
  const heard: string[] = [];
  const shown: string[] = [];
  let next = 1;
  const pending = new Map<number, () => void>();
  const cleared: number[] = [];
  const endpointer = createEndpointer({
    silenceMs,
    onUtterance: (t) => heard.push(t),
    onChange: (t) => shown.push(t),
    timers: {
      set: ((fn: () => void) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      }) as unknown as typeof setTimeout,
      clear: ((id: number) => {
        cleared.push(id);
        pending.delete(id);
      }) as unknown as typeof clearTimeout,
    },
  });
  /** Pretend the silence has lasted long enough. */
  const elapse = () => [...pending.values()].forEach((fn) => fn());
  return { endpointer, heard, shown, elapse, pending };
}

describe("createEndpointer", () => {
  it("sends what was said only after the silence", () => {
    const { endpointer, heard, elapse } = setup();
    endpointer.update([{ transcript: "pay twelve dollars" }]);
    expect(heard).toEqual([]);
    elapse();
    expect(heard).toEqual(["pay twelve dollars"]);
  });

  it("joins a sentence the browser split at a pause", () => {
    const { endpointer, heard, elapse } = setup();
    endpointer.update([{ transcript: "pay twelve dollars" }]);
    endpointer.update([{ transcript: "pay twelve dollars" }, { transcript: "to Sunrise Cafe" }]);
    elapse();
    expect(heard).toEqual(["pay twelve dollars to Sunrise Cafe"]);
  });

  it("restarts the wait each time more speech arrives", () => {
    const { endpointer, pending } = setup();
    endpointer.update([{ transcript: "pay" }]);
    const first = [...pending.keys()];
    endpointer.update([{ transcript: "pay twelve" }]);
    expect(first.every((id) => !pending.has(id))).toBe(true);
    expect(pending.size).toBe(1);
  });

  it("shows the words as they come in", () => {
    const { endpointer, shown } = setup();
    endpointer.update([{ transcript: "pay" }]);
    endpointer.update([{ transcript: "pay twelve" }]);
    expect(shown).toEqual(["pay", "pay twelve"]);
  });

  it("cleans up stray whitespace", () => {
    const { endpointer, heard, elapse } = setup();
    endpointer.update([{ transcript: "  pay   twelve " }, { transcript: " dollars  " }]);
    elapse();
    expect(heard).toEqual(["pay twelve dollars"]);
  });

  it("ignores empty results and starts no timer for them", () => {
    const { endpointer, heard, pending } = setup();
    endpointer.update([]);
    endpointer.update([{ transcript: "   " }]);
    expect(pending.size).toBe(0);
    expect(heard).toEqual([]);
  });

  it("sends immediately on flush, for when the browser stops first", () => {
    const { endpointer, heard, pending } = setup();
    endpointer.update([{ transcript: "pay twelve dollars" }]);
    endpointer.flush();
    expect(heard).toEqual(["pay twelve dollars"]);
    expect(pending.size).toBe(0);
  });

  it("sends nothing on flush when nothing was said", () => {
    const { endpointer, heard } = setup();
    endpointer.flush();
    expect(heard).toEqual([]);
  });

  it("sends an utterance only once", () => {
    const { endpointer, heard, elapse } = setup();
    endpointer.update([{ transcript: "yes" }]);
    elapse();
    endpointer.flush();
    expect(heard).toEqual(["yes"]);
  });

  it("forgets everything on discard, so a stopped mic sends nothing", () => {
    const { endpointer, heard, elapse, pending } = setup();
    endpointer.update([{ transcript: "pay twelve dollars" }]);
    endpointer.discard();
    elapse();
    endpointer.flush();
    expect(heard).toEqual([]);
    expect(pending.size).toBe(0);
    expect(endpointer.pending).toBe(false);
  });

  it("handles a second utterance after the first", () => {
    const { endpointer, heard, elapse } = setup();
    endpointer.update([{ transcript: "yes" }]);
    elapse();
    endpointer.update([{ transcript: "how much is left" }]);
    elapse();
    expect(heard).toEqual(["yes", "how much is left"]);
  });
});

describe("createEndpointer with its default timers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works when setTimeout is as strict as a browser's", async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    // Browsers throw "Illegal invocation" unless setTimeout is called with no owner.
    const strict = <F extends (...args: never[]) => unknown>(real: F) =>
      function (this: unknown, ...args: Parameters<F>) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        return real(...args);
      };
    vi.stubGlobal("setTimeout", strict(realSet));
    vi.stubGlobal("clearTimeout", strict(realClear));

    const heard: string[] = [];
    const endpointer = createEndpointer({ silenceMs: 10, onUtterance: (t) => heard.push(t) });
    endpointer.update([{ transcript: "pay twelve dollars" }]);
    endpointer.update([{ transcript: "pay twelve dollars to Sunrise Cafe" }]);
    await new Promise((resolve) => realSet(resolve, 60));
    expect(heard).toEqual(["pay twelve dollars to Sunrise Cafe"]);
  });
});

describe("silenceFor", () => {
  it.each(["yes", "Yes.", "no", "Nope", "okay", "confirm", "cancel", "yes please", "No, "])(
    "answers a plain %j quickly",
    (text) => {
      expect(silenceFor(text)).toBe(600);
    },
  );

  it.each(["pay twelve dollars to", "pay twelve dollars to the", "how much is left and", "I want to pay a", "um"])(
    "waits longer when %j trails off",
    (text) => {
      expect(silenceFor(text)).toBe(1800);
    },
  );

  it("waits a little longer for a payment that has no merchant yet", () => {
    expect(silenceFor("pay twelve dollars")).toBe(1700);
    expect(silenceFor("send 48 bucks")).toBe(1700);
  });

  it("uses a normal wait for a finished request", () => {
    expect(silenceFor("pay twelve dollars to Sunrise Cafe")).toBe(1000);
    expect(silenceFor("how much do I have left")).toBe(1000);
  });

  it("does not mistake a longer sentence for a quick yes", () => {
    expect(silenceFor("yes but make it five dollars")).not.toBe(600);
  });

  it("is faster for a yes than for anything else", () => {
    expect(silenceFor("yes")).toBeLessThan(silenceFor("pay twelve dollars to Sunrise Cafe"));
  });
});

describe("createEndpointer with a silence function", () => {
  it("asks the function for each wait, using the words so far", () => {
    const waits: number[] = [];
    const delays: number[] = [];
    const endpointer = createEndpointer({
      silenceMs: (text) => {
        waits.push(text.length);
        return text === "yes" ? 100 : 900;
      },
      onUtterance: () => {},
      timers: {
        set: ((_fn: () => void, ms: number) => {
          delays.push(ms);
          return delays.length;
        }) as unknown as typeof setTimeout,
        clear: (() => {}) as unknown as typeof clearTimeout,
      },
    });
    endpointer.update([{ transcript: "pay" }]);
    endpointer.update([{ transcript: "yes" }]);
    expect(waits).toEqual([3, 3]);
    expect(delays).toEqual([900, 100]);
  });
});
