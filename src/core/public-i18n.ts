// Néerlandais du tunnel de réservation public (lot 3, #34).
//
// Les textes que le SERVEUR produit pour le client (messages d'erreur de
// /api/public/*, libellés des lignes de devis, phrase de disponibilité, mention
// de non-cumul) sont écrits en français dans le code. Pour un client en
// néerlandais, ils sont traduits ici, en un seul endroit :
//  - à la sortie de /api/public/* quand la page le demande (en-tête
//    `x-gites-lang: nl`, posé par public/book/i18n.js) — localizePublicResponse ;
//  - dans les mails au client (src/services/email.ts) — nlText.
// Un texte inconnu reste en français : mieux vaut une phrase juste dans une autre
// langue qu'une traduction inventée. Les noms saisis par le propriétaire (saisons,
// remises, hébergements) ne sont pas traduits.
// Terminologie belge : arrhes = voorschot, garantie/caution = waarborg,
// taxe de séjour = verblijfsbelasting, solde = saldo.

export type PublicLang = "fr" | "nl";

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const mois = (m: string) => MOIS_NL[MOIS_FR.indexOf(m)] ?? m;
const nuits = (n: string) => (n === "1" ? "1 nacht" : `${n} nachten`);

const EXACT: Record<string, string> = {
  "domaine inconnu": "onbekend domein",
  "acceptation des conditions générales requise": "aanvaarding van de algemene voorwaarden vereist",
  "dates invalides (format AAAA-MM-JJ)": "ongeldige data (formaat JJJJ-MM-DD)",
  "le départ doit suivre l'arrivée": "het vertrek moet na de aankomst komen",
  "l'arrivée ne peut pas être dans le passé": "de aankomst kan niet in het verleden liggen",
  "réservation trop lointaine (max 2 ans)": "reservering te ver vooruit (max. 2 jaar)",
  "nombre d'adultes invalide": "ongeldig aantal volwassenen",
  "nombre d'enfants invalide": "ongeldig aantal kinderen",
  "hébergement inconnu": "onbekende accommodatie",
  "corps JSON attendu": "ongeldige aanvraag",
  "nom du client requis": "naam van de klant vereist",
  "email invalide": "ongeldig e-mailadres",
  "l'acceptation des conditions générales est requise": "u moet de algemene voorwaarden aanvaarden",
  "code promo invalide ou expiré": "promotiecode ongeldig of verlopen",
  "séjour impossible à ces conditions": "verblijf niet mogelijk onder deze voorwaarden",
  "montant trop faible pour un paiement en ligne": "bedrag te laag voor een onlinebetaling",
  "cet hébergement vient d'être réservé sur ces dates": "deze accommodatie is net voor deze data geboekt",
  "réservation introuvable": "reservering niet gevonden",
  "indisponible": "niet beschikbaar",
  "session inconnue": "onbekende sessie",
  "session invalide": "ongeldige sessie",
  "nom requis": "naam vereist",
  "message trop court ou trop long": "bericht te kort of te lang",
  "cette réservation est intégralement réglée": "deze reservering is volledig betaald",
  "solde trop faible pour un paiement en ligne": "saldo te laag voor een onlinebetaling",
  "cette réservation n'est plus active": "deze reservering is niet meer actief",
  "l'option a expiré — le créneau est de nouveau ouvert, relancez une réservation": "de optie is verlopen — de periode is opnieuw vrij, start een nieuwe reservering",
  "calendrier inconnu": "onbekende kalender",
  "Frais généraux — ménage et charges": "Algemene kosten — schoonmaak en lasten",
  "Une seule remise s'applique — la plus avantageuse pour vous.": "Er geldt maar één korting — de voordeligste voor u.",
  "Consultez le calendrier pour les disponibilités.": "Bekijk de kalender voor de beschikbaarheid.",
  "Trop de réservations lancées depuis cette connexion sur la dernière heure. Réessayez dans quelques minutes, ou contactez-nous directement : nous réserverons pour vous.":
    "Te veel reserveringen gestart vanaf deze verbinding in het afgelopen uur. Probeer opnieuw over enkele minuten, of neem rechtstreeks contact met ons op: wij reserveren voor u.",
  "Arrhes": "Voorschot",
  "Solde": "Saldo",
  "Paiement intégral": "Volledige betaling",
  "Paiement": "Betaling",
};

const PATTERNS: Array<[RegExp, (...m: string[]) => string]> = [
  [/^séjour trop long \(max (\d+) nuits\)$/, (_, n) => `verblijf te lang (max. ${n} nachten)`],
  [/^capacité dépassée \(max (\d+) personnes\)$/, (_, n) => `capaciteit overschreden (max. ${n} personen)`],
  [/^Vous avez déjà (\d+) réservations en attente de paiement\. .*$/, (_, n) => `U hebt al ${n} reserveringen die op betaling wachten. Rond er een af, of wacht tot de blokkering verloopt (30 minuten), voor u een nieuwe start.`],
  [/^(\d+) nuits? (weekend|semaine)( — (.+))?$/, (_, n, k, _s, unit) => `${nuits(n)} ${k === "weekend" ? "weekend" : "week"}${unit ? ` — ${unit}` : ""}`],
  [/^(\d+) nuits? (weekend|semaine) · (.+?)( — (.+))?$/, (_, n, k, season, _s, unit) => `${nuits(n)} ${k === "weekend" ? "weekend" : "week"} · ${SEASON[season!] ?? season}${unit ? ` — ${unit}` : ""}`],
  [/^Majoration jours fériés & ponts \((\d+) nuits?\)$/, (_, n) => `Toeslag feestdagen en brugdagen (${nuits(n)})`],
  [/^Code promo (.+)$/, (_, c) => `Promotiecode ${c}`],
  [/^Taxe de séjour \((\d+) pers\. × (\d+) nuits?\)$/, (_, p, n) => `Verblijfsbelasting (${p} pers. × ${nuits(n)})`],
  [/^À partir de (\d+) nuits? : (.+)$/, (_, n, a) => `Vanaf ${nuits(n)}: ${a}`],
  [/^En réservant au moins (\d+) jours? à l'avance : (.+)$/, (_, n, a) => `Bij boeking minstens ${n} ${n === "1" ? "dag" : "dagen"} op voorhand: ${a}`],
  [/^Pour une arrivée dans les (\d+) jours? : (.+)$/, (_, n, a) => `Voor een aankomst binnen ${n} ${n === "1" ? "dag" : "dagen"}: ${a}`],
  [/^Prochain week-end libre : à partir du vendredi (\d+) (\S+)\.$/, (_, d, m) => `Volgend vrij weekend: vanaf vrijdag ${d} ${mois(m!)}.`],
  [/^Aucun week-end libre en (.+?)\. Prochain week-end disponible : à partir du vendredi (\d+) (\S+)\.$/, (_, p, d, m) => `Geen vrij weekend in ${period(p!)}. Volgend beschikbaar weekend: vanaf vrijdag ${d} ${mois(m!)}.`],
  [/^Aucun week-end libre en (.+?)\.$/, (_, p) => `Geen vrij weekend in ${period(p!)}.`],
  [/^Le seul week-end d(?:'|e )(.+) est encore libre\.$/, (_, p) => `Het enige weekend van ${period(p!)} is nog vrij.`],
  [/^Les (\d+) week-ends d(?:'|e )(.+) sont encore libres\.$/, (_, n, p) => `De ${n} weekends van ${period(p!)} zijn nog vrij.`],
  [/^(\d+) week-ends? encore libres? sur les (\d+) d(?:'|e )(.+)\.$/, (_, f, n, p) => `${f} ${f === "1" ? "weekend" : "weekends"} nog vrij op de ${n} van ${period(p!)}.`],
];

/** Provenance d'un prix (pricing.ts) ; un nom de saison saisi reste tel quel. */
const SEASON: Record<string, string> = { "tarif de base": "basistarief", "prix fixé à la main": "vaste prijs" };

function period(p: string): string {
  return p.split(" et ").map(mois).join(" en ");
}

/** Traduit un texte du serveur vers le néerlandais ; inconnu → inchangé. */
export function nlText(fr: string): string {
  const exact = EXACT[fr];
  if (exact) return exact;
  for (const [re, f] of PATTERNS) {
    const m = re.exec(fr);
    if (m) return f(...(m as unknown as string[]));
  }
  return fr;
}

/** Langue demandée par la page publique (en-tête posé par public/book/i18n.js). */
export function publicLang(req: Request): PublicLang {
  const h = (req.headers.get("x-gites-lang") ?? "").trim().toLowerCase();
  return h === "nl" ? "nl" : "fr";
}

/** Clés JSON dont la valeur est un texte du serveur destiné au client. */
const TEXT_KEYS = new Set(["error", "label", "publicLabel", "sentence", "nonCumulNote"]);

function walk(v: unknown, depth: number): unknown {
  if (depth > 8 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = TEXT_KEYS.has(k) && typeof x === "string" ? nlText(x) : walk(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Réponse de /api/public/* traduite pour un client néerlandophone ; sinon la même. */
export async function localizePublicResponse(req: Request, res: Response): Promise<Response> {
  if (publicLang(req) !== "nl") return res;
  if (!new URL(req.url).pathname.startsWith("/api/public/")) return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  let data: unknown;
  try {
    data = await res.clone().json();
  } catch {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.append("vary", "x-gites-lang");
  return new Response(JSON.stringify(walk(data, 0)), { status: res.status, statusText: res.statusText, headers });
}
