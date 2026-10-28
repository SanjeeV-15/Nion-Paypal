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

// Companies that bills are paid to. Made-up names, so no real brand appears.
export const BILLERS: readonly Merchant[] = [
  { id: "skyline-mobile", name: "Skyline Mobile", blurb: "Phone service" },
  { id: "summit-card", name: "Summit Card", blurb: "Credit card" },
  { id: "bright-power", name: "Bright Power", blurb: "Electricity" },
  { id: "maple-apartments", name: "Maple Apartments", blurb: "Rent" },
];

/** Everyone the spending gate will pay. */
export const ALL_PAYEES: readonly Merchant[] = [...MERCHANTS, ...BILLERS];

export function payeeName(id: string): string {
  return ALL_PAYEES.find((p) => p.id === id)?.name ?? id;
}

export function findMerchant(text: string): Merchant | undefined {
  const needle = normalize(text);
  return MERCHANTS.find((m) => needle.includes(normalize(m.name)) || needle.includes(m.id));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
