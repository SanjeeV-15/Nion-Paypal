import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { demoChat } from "./chat/demo.js";
import { defaultPolicy } from "./config.js";
import { SpendingGate } from "./limits/gate.js";
import { MERCHANTS } from "./merchants.js";
import { answerPending, demoExecutor, type Executor } from "./payments.js";
import { SessionStore, type Session } from "./sessions.js";
import { walletSnapshot, type WalletSnapshot } from "./wallet.js";

const COOKIE = "nion_sid";
const MAX_MESSAGE_CHARS = 500;
const here = path.dirname(fileURLToPath(import.meta.url));

export type ChatHandler = (session: Session, message: string, executor: Executor) => Promise<string>;

export interface AppOptions {
  store?: SessionStore;
  chat?: ChatHandler;
  executor?: Executor;
  mode?: WalletSnapshot["mode"];
}

export function createApp(options: AppOptions = {}) {
  const names = new Map(MERCHANTS.map((m) => [m.id, m.name]));
  const store =
    options.store ??
    new SessionStore({
      ttlMs: 6 * 60 * 60 * 1000,
      max: 1000,
      createGate: () =>
        new SpendingGate(defaultPolicy(), { merchantName: (id) => names.get(id) ?? id }),
    });
  const chat = options.chat ?? demoChat;
  const executor = options.executor ?? demoExecutor;
  const mode = options.mode ?? "demo";

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Anything that can move money must come from our own page, as JSON.
  app.use("/api", (req, res, next) => {
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "Send JSON." });
      return;
    }
    next();
  });

  app.use("/api", (req, res, next) => {
    const sid = readCookie(req.headers.cookie, COOKIE);
    const { session, created } = store.get(sid);
    if (created || sid !== session.id) {
      res.cookie(COOKIE, session.id, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        maxAge: 6 * 60 * 60 * 1000,
        path: "/",
      });
    }
    res.locals.session = session;
    next();
  });

  app.get("/api/wallet", (_req, res) => {
    res.json({ wallet: walletSnapshot(res.locals.session as Session, mode) });
  });

  app.post(
    "/api/chat",
    handler(async (req, res) => {
      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      if (!message || message.length > MAX_MESSAGE_CHARS) {
        res.status(400).json({ error: `Say something up to ${MAX_MESSAGE_CHARS} characters.` });
        return;
      }
      const session = res.locals.session as Session;
      const reply = await chat(session, message, executor);
      res.json({ reply, wallet: walletSnapshot(session, mode) });
    }),
  );

  // The Confirm and Cancel buttons. Only a click on our own page reaches these.
  app.post(
    "/api/confirm",
    handler(async (req, res) => {
      const session = res.locals.session as Session;
      if (!session.pending || session.pending.proposalId !== req.body?.proposalId) {
        res.status(409).json({
          error: "That question is no longer waiting.",
          wallet: walletSnapshot(session, mode),
        });
        return;
      }
      const reply = await answerPending(session, "yes", executor);
      res.json({ reply, wallet: walletSnapshot(session, mode) });
    }),
  );

  app.post(
    "/api/cancel",
    handler(async (req, res) => {
      const session = res.locals.session as Session;
      if (!session.pending || session.pending.proposalId !== req.body?.proposalId) {
        res.status(409).json({
          error: "That question is no longer waiting.",
          wallet: walletSnapshot(session, mode),
        });
        return;
      }
      const reply = await answerPending(session, "no", executor);
      res.json({ reply, wallet: walletSnapshot(session, mode) });
    }),
  );

  app.use(express.static(path.resolve(here, "../public")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "That was not valid JSON." });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
