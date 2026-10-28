import { PaymentUncertainError, type Executor } from "../payments.js";
import { PayPalError, type PayPalClient } from "./client.js";

/** Pays by charging the visitor's saved PayPal wallet in the sandbox. */
export class PayPalExecutor implements Executor {
  constructor(private readonly client: Pick<PayPalClient, "charge">) {}

  ready: Executor["ready"] = (session) =>
    session.paypal
      ? null
      : "PayPal isn't connected yet. Tap Connect PayPal first, approve it once, and then I can pay for you.";

  pay: Executor["pay"] = async (session, entry) => {
    const wallet = session.paypal;
    if (!wallet) throw new Error("PayPal is not connected.");
    try {
      const charge = await this.client.charge({
        vaultId: wallet.vaultId,
        amountCents: entry.request.amountCents,
        currency: entry.request.currency,
        description: `Nion Pay: ${session.gate.merchantLabel(entry.request.merchantId)}`,
        customId: entry.request.merchantId,
        reference: entry.id,
      });
      return charge.captureId;
    } catch (err) {
      if (err instanceof PayPalError && err.uncertain) {
        throw new PaymentUncertainError(err.message, { cause: err });
      }
      throw err;
    }
  };

  receipt: Executor["receipt"] = (summary) => `Paid ${summary} with PayPal.`;
}
