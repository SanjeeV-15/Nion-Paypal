export type Answer = "yes" | "no" | "other";

const YES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "confirm",
  "confirmed",
  "correct",
  "absolutely",
  "go ahead",
  "do it",
  "pay it",
  "please do",
  "yes please",
  "yes go ahead",
  "yes confirm",
  "yes pay it",
  "sure thing",
]);

const NO = new Set([
  "no",
  "nope",
  "nah",
  "cancel",
  "stop",
  "dont",
  "do not",
  "never mind",
  "nevermind",
  "no thanks",
  "no thank you",
  "dont pay",
  "dont do it",
  "cancel it",
  "cancel that",
  "cancel the payment",
]);

/**
 * Reads a spoken or typed reply to a payment question. The whole utterance has
 * to be a plain yes or no; anything with extra words ("yes but make it five")
 * counts as neither, so a half-heard sentence never moves money.
 */
export function classifyAnswer(text: string): Answer {
  const s = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (YES.has(s)) return "yes";
  if (NO.has(s)) return "no";
  return "other";
}
