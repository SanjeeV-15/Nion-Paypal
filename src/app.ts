import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { demoChat } from "./chat/demo.js";
import { defaultPolicy } from "./config.js";
import { SpendingGate } from "./limits/gate.js";
import { MERCHANTS } from "./merchants.js";
import { PayPalError, type PayPalClient } from "./paypal/client.js";
import { PayPalExecutor } from "./paypal/executor.js";
import { answerPending, demoExecutor, type Executor } from "./payments.js";
import { SessionStore, type Session } from "./sessions.js";
import { walletSnapshot } from "./wallet.js";

const COOKIE = "nion_sid";
const MAX_MESSAGE_CHARS = 500;
const here = path.dirname(fileURLToPath(import.meta.url));

export type ChatHandler = (session: Session, message: string, executor: Executor) => Promise<string>;

export interface AppOptions {
  store?: SessionStore;
  chat?: ChatHandler;
  executor?: Executor;
  /** When given, payments go to the PayPal sandbox; otherwise the app runs in demo mode. */
  paypal?: PayPalClient;
  /** Where PayPal sends the buyer back to. Always taken from config, never from the request. */
  publicBaseUrl?: string;
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
  const paypal = options.paypal;
  const executor = options.executor ?? (paypal ? new PayPalExecutor(paypal) : demoExecutor);
  const mode = paypal ? "sandbox" : "demo";
  const baseUrl = (options.publicBaseUrl ?? "http://localhost:4310").replace(/\/+$/, "");
  const snapshot = (session: Session) => walletSnapshot(session, mode);

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
    res.json({ wallet: snapshot(res.locals.session as Session) });
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
      res.json({ reply, wallet: snapshot(session) });
    }),
  );

  // The Confirm and Cancel buttons. Only a click on our own page reaches these.
  for (const answer of ["yes", "no"] as const) {
    app.post(
      answer === "yes" ? "/api/confirm" : "/api/cancel",
      handler(async (req, res) => {
        const session = res.locals.session as Session;
        if (!session.pending || session.pending.proposalId !== req.body?.proposalId) {
          res.status(409).json({
            error: "That question is no longer waiting.",
            wallet: snapshot(session),
          });
          return;
        }
        const reply = await answerPending(session, answer, executor);
        res.json({ reply, wallet: snapshot(session) });
      }),
    );
  }

  if (paypal) {
    app.post(
      "/api/paypal/connect",
      handler(async (_req, res) => {
        const session = res.locals.session as Session;
        if (session.paypal) {
          res.status(409).json({ error: "PayPal is already connected.", wallet: snapshot(session) });
          return;
        }
        try {
          const token = await paypal.createSetupToken({
            returnUrl: `${baseUrl}/api/paypal/return`,
            cancelUrl: `${baseUrl}/api/paypal/cancel`,
            description: "Let Nion Pay pay merchants for you, within the limits you set",
            requestId: randomUUID(),
          });
          session.paypalSetupId = token.id;
          res.json({ approveUrl: token.approveUrl });
        } catch (err) {
          console.error("paypal connect failed:", err instanceof Error ? err.message : err);
          res.status(502).json({ error: "I couldn't reach PayPal to start the connection. Try again in a moment." });
        }
      }),
    );

    // PayPal sends the buyer here after they approve. The setup token must be the
    // one this visitor started, so nobody can attach a wallet to someone else's session.
    app.get(
      "/api/paypal/return",
      handler(async (req, res) => {
        const session = res.locals.session as Session;
        const setupId = session.paypalSetupId;
        if (!setupId) {
          res.redirect(session.paypal ? "/?paypal=connected" : "/?paypal=failed");
          return;
        }
        const returned = req.query.approval_token_id;
        if (returned !== undefined && returned !== setupId) {
          res.redirect("/?paypal=failed");
          return;
        }
        try {
          const wallet = await paypal.createSavedWallet(setupId, `wallet-${setupId}`);
          session.paypal = wallet;
          session.paypalSetupId = null;
          res.redirect("/?paypal=connected");
        } catch (err) {
          console.error("paypal save failed:", err instanceof Error ? err.message : err);
          res.redirect("/?paypal=failed");
        }
      }),
    );

    app.get("/api/paypal/cancel", (_req, res) => {
      (res.locals.session as Session).paypalSetupId = null;
      res.redirect("/?paypal=cancelled");
    });

    app.post(
      "/api/paypal/disconnect",
      handler(async (_req, res) => {
        const session = res.locals.session as Session;
        const wallet = session.paypal;
        if (wallet) {
          try {
            await paypal.deleteSavedWallet(wallet.vaultId);
          } catch (err) {
            // A wallet PayPal no longer knows about is already gone; anything else, keep it connected.
            if (!(err instanceof PayPalError && err.status === 404)) {
              console.error("paypal disconnect failed:", err instanceof Error ? err.message : err);
              res.status(502).json({
                error: "I couldn't disconnect PayPal just now, so it is still connected. Try again.",
                wallet: snapshot(session),
              });
              return;
            }
          }
          session.paypal = null;
        }
        res.json({ wallet: snapshot(session) });
      }),
    );
  }

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
