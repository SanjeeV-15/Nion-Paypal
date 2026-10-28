export interface Merchant {
  id: string;
  name: string;
  blurb: string;
}

// These become PayPal sandbox merchant accounts once the payment layer exists.
export const MERCHANTS: readonly Merchant[] = [
  { id: "blue-door-taxi", name: "Blue Door Taxi", blurb: "Rides around town" },
  { id: "sunrise-cafe", name: "Sunrise Cafe", blurb: "Coffee and breakfast" },
  { id: "harbor-tours", name: "Harbor Tours", blurb: "Tickets for boat tours" },
];

export function findMerchant(text: string): Merchant | undefined {
  const needle = normalize(text);
  return MERCHANTS.find((m) => needle.includes(normalize(m.name)) || needle.includes(m.id));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
