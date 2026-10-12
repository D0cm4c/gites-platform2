// Messages des canaux (Airbnb, Booking.com, Vrbo, Expedia relevés par Beds24) dans
// l'écran Messages : le badge de provenance, la phrase sous la réponse, et le
// texte de confirmation après l'envoi. Un message de canal se répond sur le
// canal (par Beds24), jamais par mail : l'adresse du voyageur y est un relais.
import { t } from "@lingui/core/macro";
import type { Message } from "../api/types";
import "./canal.css";

export interface SourceBadge {
  cls: string;
  text: string;
}

/** Famille du canal, pour la couleur du badge. */
function family(canal: string): "airbnb" | "booking" | "vrbo" | "autre" {
  const k = canal.toLowerCase();
  if (k.includes("airbnb")) return "airbnb";
  if (k.includes("booking")) return "booking";
  if (k.includes("vrbo") || k.includes("homeaway") || k.includes("abritel")) return "vrbo";
  return "autre";
}

/** Origine d'un message, d'un seul mot partout : « e-mail », « Airbnb », « Booking », « Vrbo »,
 *  « site » (ou le nom du canal quand il n'est pas l'un de ceux-là). */
export type Origin = "email" | "site" | "airbnb" | "booking" | "vrbo" | "canal";

export function originOf(m: Pick<Message, "channel" | "canal">): Origin {
  if (m.channel === "form") return "site";
  if (m.channel === "email") return "email";
  const f = family(m.canal || "");
  return f === "autre" ? "canal" : f;
}

/** Badge de provenance d'un message : site, e-mail, ou le canal OTA (même vocabulaire partout). */
export function sourceLabel(m: Pick<Message, "channel" | "canal">): SourceBadge {
  switch (originOf(m)) {
    case "site":
      return { cls: "st", text: t`Site` };
    case "email":
      return { cls: "", text: t`E-mail` };
    case "airbnb":
      return { cls: "canal canal-airbnb", text: "Airbnb" };
    case "booking":
      return { cls: "canal canal-booking", text: "Booking" };
    case "vrbo":
      return { cls: "canal canal-vrbo", text: "Vrbo" };
    default:
      return { cls: "canal canal-autre", text: m.canal || t`Canal` };
  }
}

/** Décompte des messages par origine, du plus nombreux au moins nombreux : « E-mail 2, Airbnb 1 ». */
export function originCounts(list: Pick<Message, "channel" | "canal">[]): { key: string; text: string; n: number }[] {
  const by = new Map<string, { key: string; text: string; n: number }>();
  for (const m of list) {
    const label = sourceLabel(m).text;
    const key = originOf(m) === "canal" ? `canal:${label}` : originOf(m);
    const cur = by.get(key) ?? { key, text: label, n: 0 };
    cur.n += 1;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text));
}

export function originSummary(list: Pick<Message, "channel" | "canal">[]): string {
  return originCounts(list)
    .map((o) => `${o.text} ${o.n}`)
    .join(", ");
}

export function isChannelMessage(m: Pick<Message, "channel">): boolean {
  return m.channel === "beds24";
}

/** La phrase sous le champ de réponse. */
export function replyHint(m: Pick<Message, "channel" | "canal" | "fromEmail" | "bookingId"> & { spoofed?: boolean }): string {
  if (m.spoofed) return t`Ce message prétend venir de l'adresse des gîtes sans que Gmail le confirme : pas de réponse possible.`;
  const to = m.fromEmail;
  if (m.channel === "email") return t`La réponse part par e-mail à ${to}, depuis l'adresse des gîtes, dans le même fil que son message.`;
  if (m.channel === "beds24") return t`La réponse part sur ${m.canal || t`le canal`}, dans la conversation du voyageur (par Beds24).`;
  return m.bookingId ? t`La réponse part par mail à ${to} quand l'envoi des mails est actif, et s'affiche sur la page du client.` : t`La réponse part par mail à ${to} quand l'envoi des mails est actif.`;
}

/** Confirmation après l'envoi d'une réponse partie par le canal ; null sinon. */
export function channelDeliveryText(delivery: string | undefined, canal: string | null | undefined): string | null {
  return delivery === "beds24" ? t`C'est fait. Réponse envoyée sur ${canal || t`le canal`}.` : null;
}

/** Nom affiché d'un correspondant : jamais l'adresse pseudo « beds24:<id> ». */
export function displayName(m: Pick<Message, "fromName" | "fromEmail" | "channel" | "canal">): string {
  if (m.fromName) return m.fromName;
  if (m.channel === "beds24" && m.fromEmail.startsWith("beds24:")) return m.canal ? t`Voyageur ${m.canal}` : t`Voyageur du canal`;
  return m.fromEmail;
}
