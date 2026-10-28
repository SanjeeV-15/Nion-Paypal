import { canListen, canSpeak, cancelSpeech, createListener, speak } from "/voice.js";

const $ = (id) => document.getElementById(id);
const els = {
  log: $("log"),
  orb: $("orb"),
  orbLabel: $("orb-label"),
  voice: $("voice"),
  voiceStatus: $("voice-status"),
  form: $("form"),
  text: $("text"),
  send: $("send"),
  hint: $("hint"),
  speak: $("speak-replies"),
  badge: $("mode-badge"),
  banner: $("demo-banner"),
  spent: $("spent"),
  meter: $("meter"),
  meterFill: $("meter-fill"),
  remaining: $("remaining"),
  rules: $("rules"),
  merchants: $("merchants"),
  activity: $("activity"),
  activityEmpty: $("activity-empty"),
  approval: $("approval"),
  approvalAmount: $("approval-amount"),
  approvalReasons: $("approval-reasons"),
  approvalTimer: $("approval-timer"),
  approve: $("approve"),
  decline: $("decline"),
};

const state = {
  phase: "idle", // idle | listening | thinking | speaking
  conversation: false,
  turn: 0,
  silentRuns: 0,
  wallet: null,
  interim: null,
};

const PHASE_TEXT = {
  idle: "Tap to talk",
  listening: "Listening. Tap to stop.",
  thinking: "Thinking...",
  speaking: "Speaking. Tap to interrupt.",
};
const ORB_LABEL = {
  idle: "Start talking",
  listening: "Stop listening",
  thinking: "Stop the conversation",
  speaking: "Interrupt",
};

const EXAMPLES = ["Pay $12 to Sunrise Cafe", "Pay $48 to Blue Door Taxi", "How much do I have left?"];

// ---- storage ---------------------------------------------------------------

try {
  if (localStorage.getItem("nion.speak") === "off") els.speak.checked = false;
} catch {
  /* storage can be blocked; the page works without it */
}
els.speak.addEventListener("change", () => {
  if (!els.speak.checked) cancelSpeech();
  try {
    localStorage.setItem("nion.speak", els.speak.checked ? "on" : "off");
  } catch {
    /* ignore */
  }
});

// ---- rendering ---------------------------------------------------------------

function setPhase(phase) {
  state.phase = phase;
  els.orb.dataset.state = phase;
  els.orb.setAttribute("aria-pressed", String(state.conversation));
  els.orbLabel.textContent = ORB_LABEL[phase];
  els.voiceStatus.textContent = PHASE_TEXT[phase];
  els.send.disabled = phase === "thinking";
  els.approve.disabled = phase === "thinking";
  els.decline.disabled = phase === "thinking";
}

function setHint(text) {
  els.hint.textContent = text || "";
}

function addMessage(role, text, extra) {
  els.log.querySelector(".welcome")?.remove();
  const li = document.createElement("li");
  li.className = `msg ${role}${extra ? ` ${extra}` : ""}`;
  li.textContent = text;
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
  return li;
}

function showInterim(text) {
  if (!state.interim) state.interim = addMessage("you", text, "interim");
  state.interim.textContent = text;
  els.log.scrollTop = els.log.scrollHeight;
}

function clearInterim() {
  state.interim?.remove();
  state.interim = null;
}

function showWelcome() {
  const li = document.createElement("li");
  li.className = "welcome";
  const title = document.createElement("strong");
  title.textContent = "Tell me what to pay.";
  const sub = document.createElement("span");
  sub.textContent = "I will stay inside your limits and ask before anything big.";
  const chips = document.createElement("div");
  chips.className = "chips";
  for (const example of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = example;
    chip.addEventListener("click", () => send(example));
    chips.append(chip);
  }
  li.append(title, sub, chips);
  els.log.append(li);
}

const moneyFormats = new Map();
function money(cents, currency) {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, new Intl.NumberFormat(undefined, { style: "currency", currency }));
  }
  return moneyFormats.get(currency).format(cents / 100);
}

function li(...children) {
  const el = document.createElement("li");
  el.append(...children);
  return el;
}

function span(text, className) {
  const el = document.createElement("span");
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function renderWallet(wallet) {
  state.wallet = wallet;
  const { limits } = wallet;
  const m = (cents) => money(cents, limits.currency);

  els.badge.hidden = wallet.mode !== "demo";
  els.banner.hidden = wallet.mode !== "demo";

  els.spent.textContent = `${m(wallet.spentCents)} spent today`;
  const pct = Math.min(100, Math.round((wallet.spentCents / limits.dailyCapCents) * 100));
  els.meter.setAttribute("aria-valuenow", String(pct));
  els.meterFill.style.width = `${pct}%`;
  els.remaining.textContent = `${m(wallet.remainingCents)} left of ${m(limits.dailyCapCents)}`;

  els.rules.replaceChildren(
    li(`Asks you first above ${m(limits.autoApproveUpToCents)}`),
    li(`Never more than ${m(limits.perPurchaseCapCents)} in one payment`),
    li(`Never more than ${m(limits.dailyCapCents)} in a day`),
    li("Only pays merchants on your list"),
  );

  els.merchants.replaceChildren(
    ...wallet.merchants.map((x) => {
      const small = document.createElement("small");
      small.textContent = x.blurb;
      return li(span(x.name), small);
    }),
  );

  const statusText = {
    completed: wallet.mode === "demo" ? "Paid (demo)" : "Paid",
    pending: "Processing",
    failed: "Failed, not charged",
  };
  els.activity.replaceChildren(
    ...wallet.activity.map((a) => {
      const time = new Date(a.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const item = li(
        span(a.merchant),
        span(m(a.amountCents), "amount"),
        span(`${statusText[a.status]} · ${time}`, "meta"),
      );
      item.className = a.status;
      return item;
    }),
  );
  els.activityEmpty.hidden = wallet.activity.length > 0;

  renderApproval(wallet.pending);
}

let approvalTimer = null;
function renderApproval(pending) {
  clearInterval(approvalTimer);
  if (!pending) {
    els.approval.hidden = true;
    return;
  }
  const { limits } = state.wallet;
  els.approvalAmount.textContent = `${money(pending.amountCents, limits.currency)} to ${pending.merchant}`;
  els.approvalReasons.replaceChildren(
    ...pending.reasons.map((reason) =>
      li(
        reason === "above_auto_approve"
          ? `Over your ${money(limits.autoApproveUpToCents, limits.currency)} auto-approve limit`
          : "Same amount to the same place a moment ago",
      ),
    ),
  );
  els.approval.hidden = false;
  els.approval.dataset.proposalId = pending.proposalId;

  const tick = () => {
    const left = Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000));
    els.approvalTimer.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0) {
      clearInterval(approvalTimer);
      refreshWallet();
    }
  };
  tick();
  approvalTimer = setInterval(tick, 1000);
}

// ---- server ---------------------------------------------------------------

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("I couldn't reach the server. Check your connection and try again.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Something went wrong (${res.status}).`);
    err.wallet = data?.wallet;
    throw err;
  }
  return data;
}

async function refreshWallet() {
  try {
    renderWallet((await api("/api/wallet")).wallet);
  } catch (err) {
    addMessage("nion", err.message, "error");
  }
}

// ---- turns ---------------------------------------------------------------

/** Runs one request, shows the reply, speaks it, then goes back to listening if the conversation is on. */
async function runTurn(request, userText) {
  const id = ++state.turn;
  listener.stop();
  cancelSpeech();
  clearInterim();
  if (userText) addMessage("you", userText);
  setPhase("thinking");

  let reply = null;
  try {
    const data = await request();
    renderWallet(data.wallet);
    reply = data.reply;
    addMessage("nion", reply);
  } catch (err) {
    if (err.wallet) renderWallet(err.wallet);
    addMessage("nion", err.message, "error");
  }

  // A newer turn took over while we waited; it owns the orb now.
  if (id !== state.turn) return;
  if (reply && els.speak.checked && canSpeak) {
    setPhase("speaking");
    await speak(reply);
    if (id !== state.turn) return;
  }
  afterTurn();
}

function afterTurn() {
  if (state.conversation && canListen) {
    listen();
  } else {
    setPhase("idle");
  }
}

function send(text) {
  const message = text.trim();
  if (!message || state.phase === "thinking") return;
  state.silentRuns = 0;
  runTurn(() => api("/api/chat", { message }), message);
}

function answerPending(path, label) {
  const proposalId = els.approval.dataset.proposalId;
  if (!proposalId || state.phase === "thinking") return;
  runTurn(() => api(path, { proposalId }), label);
}

els.approve.addEventListener("click", () => answerPending("/api/confirm", "Confirm"));
els.decline.addEventListener("click", () => answerPending("/api/cancel", "Cancel"));

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.text.value;
  els.text.value = "";
  send(text);
});

// ---- voice ---------------------------------------------------------------

const listener = createListener({
  onInterim: showInterim,
  onFinal: (text) => {
    clearInterim();
    if (text) send(text);
  },
  onEnd: ({ heard }) => {
    if (state.phase !== "listening" || heard) return;
    if (++state.silentRuns >= 4) {
      endConversation("I didn't hear anything, so I stopped listening. Tap the circle to start again.");
      return;
    }
    listener.start();
  },
  onError: (code) => {
    if (code === "blocked") {
      endConversation("The microphone is blocked. Allow it in your browser's address bar, or type instead.");
    } else if (code === "network") {
      endConversation("Speech recognition needs an internet connection. You can still type.");
    } else {
      endConversation(`Voice stopped (${code}). Tap the circle to try again, or type.`);
    }
  },
});

function listen() {
  setPhase("listening");
  listener.start();
}

function startConversation() {
  if (!canListen) return;
  state.conversation = true;
  state.silentRuns = 0;
  setHint("");
  listen();
}

function endConversation(message) {
  state.conversation = false;
  state.turn += 1;
  listener.stop();
  cancelSpeech();
  clearInterim();
  setPhase("idle");
  if (message) setHint(message);
}

els.orb.addEventListener("click", () => {
  if (state.phase === "speaking") {
    // Cancelling resolves the speech promise, which carries on with the next listen.
    cancelSpeech();
  } else if (state.conversation) {
    endConversation();
  } else {
    startConversation();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.phase === "speaking") cancelSpeech();
  else if (state.conversation) endConversation();
});

// ---- start ---------------------------------------------------------------

if (!canListen) {
  els.voice.hidden = true;
  $("approval-voice-hint").hidden = true;
  setHint("Voice needs Chrome or another Chromium browser. You can type below.");
}
setPhase("idle");
showWelcome();
refreshWallet();
