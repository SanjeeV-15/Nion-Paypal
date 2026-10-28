import { describe, expect, it } from "vitest";
import { classifyAnswer } from "../src/confirm.js";

describe("classifyAnswer", () => {
  it.each(["yes", "Yes.", "  YEAH!  ", "yep", "sure", "okay", "OK", "go ahead", "do it", "Yes, please."])(
    "reads %j as yes",
    (text) => {
      expect(classifyAnswer(text)).toBe("yes");
    },
  );

  it.each(["no", "No.", "nope", "cancel", "don't", "Don't pay", "never mind", "no thanks"])(
    "reads %j as no",
    (text) => {
      expect(classifyAnswer(text)).toBe("no");
    },
  );

  it.each([
    "yes but make it five dollars",
    "yes pay Sunrise Cafe instead",
    "no wait yes",
    "I said yes to the other one",
    "pay $12 to Sunrise Cafe",
    "yes yes yes",
    "maybe",
    "",
    "   ",
  ])("treats %j as neither", (text) => {
    expect(classifyAnswer(text)).toBe("other");
  });
});
