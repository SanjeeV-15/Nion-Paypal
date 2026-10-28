import {
  availableVoices,
  canListen,
  canSpeak,
  cancelSpeech,
  createListener,
  currentVoice,
  onVoicesChanged,
  setPreferredVoice,
  speak,
} from "/voice.js";

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
  voicePicker: $("voice-picker"),
  voiceSelect: $("voice-select"),
  badge: $("mode-badge"),
  banner: $("mode-banner"),
  notice: $("notice"),
  noticeText: $("notice-text"),
  noticeAction: $("notice-action"),
  noticeDismiss: $("notice-dismiss"),
  paypalCard: $("paypal-card"),
  paypalStatus: $("paypal-status"),
  paypalConnect: $("paypal-connect"),
  paypalDisconnect: $("paypal-disconnect"),
  spent: $("spent"),
  meter: $("meter"),
  meterFill: $("meter-fill"),
  remaining: $("remaining"),
  rules: $("rules"),
  merchants: $("merchants"),
  bills: $("bills"),
  activity: $("activity"),
  activityEmpty: $("activity-empty"),
  approval: $("approval"),
  approvalAmount: $("approval-amount"),
  approvalReasons: $("approval-reasons"),
  approvalTimer: $("approval-timer"),
  approvalSource: $("approval-source"),
  limitsCard: $("limits-card"),
  limitsEdit: $("limits-edit"),
  limitsForm: $("limits-form"),
  limitsError: $("limits-error"),
  limitsCancel: $("limits-cancel"),
  limitAuto: $("limit-auto"),
  limitOne: $("limit-one"),
  limitDay: $("limit-day"),
  reset: $("reset"),
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
  listenTimer: null,
  thinkingEl: null,
  lastProposal: null,
  seen: { bills: new Map(), activity: new Set(), ready: false },
  flash: null, // a one-off message, e.g. the result of connecting PayPal
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

const EXAMPLES = [
  "Pay $12 to Sunrise Cafe",
  "Pay $48 to Blue Door Taxi",
  "What bills are due?",
  "Pay my phone bill",
];

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

// ---- voice choice ---------------------------------------------------------------

try {
  setPreferredVoice(localStorage.getItem("nion.voice"));
} catch {
  /* storage can be blocked */
}

function fillVoices() {
  const voices = availableVoices();
  els.voicePicker.hidden = voices.length < 2;
  const chosen = currentVoice()?.name;
  els.voiceSelect.replaceChildren(
    ...voices.map((v) => {
      const option = document.createElement("option");
      option.value = v.name;
      option.textContent = `${v.name} (${v.lang})`;
      option.selected = v.name === chosen;
      return option;
    }),
  );
}

els.voiceSelect.addEventListener("change", () => {
  setPreferredVoice(els.voiceSelect.value);
  try {
    localStorage.setItem("nion.voice", els.voiceSelect.value);
  } catch {
    /* ignore */
  }
  speak("This is how I sound.");
});

fillVoices();
onVoicesChanged(fillVoices);

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
  for (const el of [els.bills, els.limitsCard, els.reset]) el.toggleAttribute("inert", phase === "thinking");
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

function showThinking() {
  clearThinking();
  const li = document.createElement("li");
  li.className = "msg nion thinking";
  li.setAttribute("role", "status");
  li.setAttribute("aria-label", "Thinking");
  for (let i = 0; i < 3; i++) li.append(document.createElement("i"));
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
  state.thinkingEl = li;
}

function clearThinking() {
  state.thinkingEl?.remove();
  state.thinkingEl = null;
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

  const sandbox = wallet.mode === "sandbox";
  els.badge.hidden = false;
  els.badge.textContent = sandbox ? "PayPal sandbox" : "Demo mode";
  els.banner.hidden = false;
  els.banner.textContent = sandbox
    ? "PayPal sandbox. These are real PayPal calls, but with test money only."
    : "Demo mode. PayPal is not connected yet, so no money moves.";

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
    unconfirmed: "Unconfirmed, check PayPal",
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
      // The reference PayPal gave this payment, so it can be found in PayPal's own records.
      if (wallet.mode === "sandbox" && a.ref) {
        const ref = span(`PayPal capture ${a.ref}`, "meta ref");
        ref.title = "PayPal's own ID for this payment";
        item.append(ref);
      }
      item.className = a.status;
      if (state.seen.ready && !state.seen.activity.has(a.id)) item.classList.add("flash");
      return item;
    }),
  );
  state.seen.activity = new Set(wallet.activity.map((a) => a.id));
  els.activityEmpty.hidden = wallet.activity.length > 0;

  renderBills(wallet);
  renderPayPal(wallet.paypal);
  renderApproval(wallet.pending);
  state.seen.ready = true;
}

function dueText(bill) {
  const date = new Date(`${bill.dueDate}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const days = bill.daysUntilDue;
  if (days < 0) return `${date}, ${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return `${date}, due today`;
  if (days === 1) return `${date}, tomorrow`;
  return `${date}, in ${days} days`;
}

function renderBills(wallet) {
  const m = (cents) => money(cents, wallet.limits.currency);
  els.bills.replaceChildren(
    ...wallet.bills.map((bill) => {
      const status = bill.status === "due" && bill.daysUntilDue < 0 ? "overdue" : bill.status;
      const item = li(
        span(bill.name, "bill-name"),
        span(m(bill.amountCents), "amount"),
        span(`${bill.payee} · ${bill.status === "paid" ? "paid" : dueText(bill)}`, "bill-meta"),
      );
      const waiting = wallet.pending?.billId === bill.id;
      item.className = waiting ? "waiting" : status;
      const before = state.seen.bills.get(bill.id);
      if (before !== undefined && before !== bill.status) item.classList.add("flash");
      if (waiting) {
        item.append(span("Waiting for your yes", "bill-status"));
      } else if (bill.status === "due") {
        const pay = document.createElement("button");
        pay.type = "button";
        pay.className = "btn small bill-pay";
        pay.textContent = "Pay";
        pay.setAttribute("aria-label", `Pay ${bill.name}, ${m(bill.amountCents)}`);
        pay.addEventListener("click", () => payBillButton(bill));
        item.append(pay);
      } else if (bill.status === "unconfirmed") {
        item.append(span("Unconfirmed, check PayPal", "bill-status"));
      } else {
        item.append(span("Paid", "bill-status"));
      }
      return item;
    }),
  );
  state.seen.bills = new Map(wallet.bills.map((b) => [b.id, b.status]));
}

function payBillButton(bill) {
  if (state.phase === "thinking") return;
  runTurn(() => api("/api/bills/pay", { billId: bill.id }), `Pay my ${bill.name.toLowerCase()} bill`);
}

function renderPayPal(paypal) {
  els.paypalCard.hidden = !paypal;
  if (!paypal) {
    updateNotice();
    return;
  }
  els.paypalStatus.textContent = paypal.connected
    ? `Connected${paypal.email ? ` as ${paypal.email}` : ""}. I can pay merchants within your limits.`
    : "Not connected. Connect the sandbox buyer account once, and I can pay for you.";
  els.paypalConnect.hidden = paypal.connected;
  els.paypalDisconnect.hidden = !paypal.connected;
  updateNotice();
}

function showNotice(text, { kind, action, dismissible } = {}) {
  els.notice.hidden = false;
  els.notice.dataset.kind = kind || "info";
  els.noticeText.textContent = text;
  els.noticeAction.hidden = !action;
  els.noticeAction.textContent = action || "";
  els.noticeDismiss.hidden = !dismissible;
}

// A one-off message wins; otherwise nudge towards connecting PayPal when that is all that is missing.
function updateNotice() {
  if (state.flash) {
    showNotice(state.flash.text, { kind: state.flash.kind, dismissible: true });
    return;
  }
  const paypal = state.wallet?.paypal;
  if (paypal && !paypal.connected) {
    showNotice("Connect PayPal once so I can pay for you within your limits.", { action: "Connect PayPal" });
    return;
  }
  els.notice.hidden = true;
}

function setFlash(text, kind) {
  state.flash = { text, kind };
  updateNotice();
}

let approvalTimer = null;
function renderApproval(pending) {
  clearInterval(approvalTimer);
  if (!pending) {
    els.approval.hidden = true;
    state.lastProposal = null;
    return;
  }
  const { limits } = state.wallet;
  const what = `${money(pending.amountCents, limits.currency)} to ${pending.merchant}`;
  els.approvalAmount.textContent = pending.billName ? `${pending.billName}: ${what}` : what;
  els.approvalReasons.replaceChildren(
    ...pending.reasons.map((reason) =>
      li(
        reason === "above_auto_approve"
          ? `Over your ${money(limits.autoApproveUpToCents, limits.currency)} auto-approve limit`
          : "Same amount to the same place a moment ago",
      ),
    ),
  );
  els.approvalSource.textContent =
    state.wallet.mode === "sandbox"
      ? "Paid from your PayPal wallet (sandbox, test money)."
      : "Demo: simulated, no money moves.";
  els.approval.hidden = false;
  els.approval.dataset.proposalId = pending.proposalId;
  if (state.lastProposal !== pending.proposalId) {
    state.lastProposal = pending.proposalId;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    els.approval.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }

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
  clearTimeout(state.listenTimer);
  listener.stop();
  cancelSpeech();
  clearInterim();
  if (userText) addMessage("you", userText);
  setPhase("thinking");
  showThinking();

  let reply = null;
  try {
    const data = await request();
    clearThinking();
    renderWallet(data.wallet);
    reply = data.reply;
    addMessage("nion", reply);
  } catch (err) {
    clearThinking();
    if (err.wallet) renderWallet(err.wallet);
    addMessage("nion", err.message, "error");
  }

  // A newer turn took over while we waited; it owns the orb now.
  if (id !== state.turn) return;
  let spoke = false;
  if (reply && els.speak.checked && canSpeak) {
    setPhase("speaking");
    await speak(reply);
    spoke = true;
    if (id !== state.turn) return;
  }
  afterTurn(id, spoke);
}

// Speakers keep ringing for a moment, and the mic would hear the tail of Nion's own voice.
const ECHO_SETTLE_MS = 400;

function afterTurn(id, spoke) {
  if (!(state.conversation && canListen)) {
    setPhase("idle");
    return;
  }
  setPhase("listening");
  clearTimeout(state.listenTimer);
  state.listenTimer = setTimeout(
    () => {
      if (id === state.turn && state.conversation) listener.start();
    },
    spoke ? ECHO_SETTLE_MS : 0,
  );
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

async function connectPayPal() {
  els.paypalConnect.disabled = true;
  els.noticeAction.disabled = true;
  try {
    const { approveUrl } = await api("/api/paypal/connect", {});
    const host = new URL(approveUrl).hostname;
    if (!(host === "paypal.com" || host.endsWith(".paypal.com"))) throw new Error("That link did not look right, so I did not open it.");
    window.location.assign(approveUrl);
  } catch (err) {
    els.paypalConnect.disabled = false;
    els.noticeAction.disabled = false;
    if (err.wallet) renderWallet(err.wallet);
    setFlash(err.message, "problem");
  }
}

async function disconnectPayPal() {
  els.paypalDisconnect.disabled = true;
  try {
    renderWallet((await api("/api/paypal/disconnect", {})).wallet);
    setFlash("PayPal is disconnected. I can't pay for you until you connect it again.", "info");
  } catch (err) {
    if (err.wallet) renderWallet(err.wallet);
    setFlash(err.message, "problem");
  } finally {
    els.paypalDisconnect.disabled = false;
  }
}

els.paypalConnect.addEventListener("click", connectPayPal);
els.noticeAction.addEventListener("click", connectPayPal);
els.paypalDisconnect.addEventListener("click", disconnectPayPal);
els.noticeDismiss.addEventListener("click", () => {
  state.flash = null;
  updateNotice();
});

els.approve.addEventListener("click", () => answerPending("/api/confirm", "Confirm"));
els.decline.addEventListener("click", () => answerPending("/api/cancel", "Cancel"));

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.text.value;
  els.text.value = "";
  send(text);
});

// ---- limits and start over ---------------------------------------------------

function openLimits() {
  const { limits, ceilings } = state.wallet;
  els.limitAuto.value = limits.autoApproveUpToCents / 100;
  els.limitOne.value = limits.perPurchaseCapCents / 100;
  els.limitDay.value = limits.dailyCapCents / 100;
  els.limitAuto.max = ceilings.perPurchaseCapCents / 100;
  els.limitOne.max = ceilings.perPurchaseCapCents / 100;
  els.limitDay.max = ceilings.dailyCapCents / 100;
  els.limitsError.textContent = "";
  els.limitsForm.hidden = false;
  els.rules.hidden = true;
  els.limitsEdit.hidden = true;
  els.limitAuto.focus();
}

function closeLimits() {
  els.limitsForm.hidden = true;
  els.rules.hidden = false;
  els.limitsEdit.hidden = false;
}

els.limitsEdit.addEventListener("click", openLimits);
els.limitsCancel.addEventListener("click", closeLimits);
els.limitsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cents = (input) => Math.round(Number(input.value) * 100);
  try {
    const { wallet } = await api("/api/limits", {
      autoApproveUpToCents: cents(els.limitAuto),
      perPurchaseCapCents: cents(els.limitOne),
      dailyCapCents: cents(els.limitDay),
    });
    renderWallet(wallet);
    closeLimits();
    setFlash("Your limits are saved. Only you can change them; the AI cannot.", "info");
  } catch (err) {
    els.limitsError.textContent = err.message;
  }
});

let resetTimer = null;
function disarmReset() {
  clearTimeout(resetTimer);
  delete els.reset.dataset.armed;
  els.reset.textContent = "Start over";
}

els.reset.addEventListener("click", async () => {
  if (!els.reset.dataset.armed) {
    els.reset.dataset.armed = "1";
    els.reset.textContent = "Click again to clear everything";
    resetTimer = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  endConversation();
  try {
    const { wallet } = await api("/api/reset", {});
    state.seen = { bills: new Map(), activity: new Set(), ready: false };
    els.log.replaceChildren();
    showWelcome();
    closeLimits();
    renderWallet(wallet);
    setFlash("Started over. Your PayPal connection is still there.", "info");
  } catch (err) {
    setFlash(err.message, "problem");
  }
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
  clearTimeout(state.listenTimer);
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

// PayPal sends the buyer back here with ?paypal=connected, cancelled or failed.
const FLASH = {
  connected: ["PayPal is connected. I can pay for you now, within your limits.", "info"],
  cancelled: ["You cancelled the PayPal connection. Nothing was saved.", "info"],
  failed: ["I couldn't finish connecting PayPal. Please try Connect PayPal again.", "problem"],
};
const returned = new URLSearchParams(window.location.search).get("paypal");
if (returned && Object.hasOwn(FLASH, returned)) {
  const [text, kind] = FLASH[returned];
  state.flash = { text, kind };
}
if (returned) window.history.replaceState(null, "", window.location.pathname);

refreshWallet();
