import Anthropic from "@anthropic-ai/sdk";
import { createClaudeChat } from "./agent/claude.js";
import { createApp, type ChatHandler } from "./app.js";
import { ChatLimiter } from "./limiter.js";
import { PayPalClient } from "./paypal/client.js";

const port = Number(process.env.PORT ?? 4310);

let paypal: PayPalClient | undefined;
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (clientId && clientSecret) {
  if (process.env.PAYPAL_ENV !== "sandbox") {
    throw new Error('PAYPAL_ENV must be "sandbox". This app never uses live PayPal credentials.');
  }
  paypal = new PayPalClient({ clientId, clientSecret });
}

let chat: ChatHandler | undefined;
const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
if (process.env.ANTHROPIC_API_KEY) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 2 });
  chat = createClaudeChat({
    client: { beta: { messages: { create: (params) => anthropic.beta.messages.create(params) } } },
    model,
    limiter: new ChatLimiter({
      perVisitorPerHour: whole(process.env.NION_MAX_AI_PER_HOUR, 40),
      perDay: whole(process.env.NION_MAX_AI_PER_DAY, 1500),
    }),
  });
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

createApp({ paypal, chat, publicBaseUrl }).listen(port, () => {
  console.log(
    `nion-paypal listening on ${publicBaseUrl} | payments: ${paypal ? "PayPal sandbox" : "demo"} | chat: ${chat ? `Claude (${model})` : "simple responder"}`,
  );
});

function whole(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
