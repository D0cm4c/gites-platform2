// Intégration Beds24 API v2 — le « tuyau certifié » vers les OTAs
// (Airbnb Preferred+, Booking.com, Vrbo) : notre plateforme reste la source de
// vérité, Beds24 n'est utilisé que pour pousser tarifs/disponibilités vers les
// annonces OTA et rapatrier leurs réservations. Réf : note projet
// « 2026-07-27 – API Airbnb, middleware & canaux de distribution – v2 ».
//
// Authentification (wiki.beds24.com, Category:API_V2) :
//   1. Invite code généré dans l'UI Beds24 (SETTINGS > MARKETPLACE > API,
//      https://beds24.com/control3.php?pagetype=apiv2) — valable 24 h.
//   2. GET /authentication/setup  (header `code`)   → { token, refreshToken }.
//   3. Le refresh token est ILLIMITÉ tant qu'il sert au moins tous les 30 jours
//      → stocké en secret (BEDS24_REFRESH_TOKEN, .dev.vars / wrangler secret).
//   4. GET /authentication/token  (header `refreshToken`) → token 24 h.
//
// Sans BEDS24_REFRESH_TOKEN : mode OFF — aucun appel réseau, la plateforme
// fonctionne exactement comme avant (le direct n'a pas besoin de Beds24).

import { getSetting } from "./settings";

const BEDS24_API = "https://api.beds24.com/v2";
const FETCH_TIMEOUT_MS = 30_000;

/** Refresh token : la base (réglable depuis le back-office, page Canaux OTA)
 *  prime sur le secret d'environnement — le secret reste le repli. */
async function refreshTokenValue(env: Env): Promise<string> {
  const stored = (await getSetting(env.DB, "beds24_refresh_token"))?.trim() ?? "";
  return stored || env.BEDS24_REFRESH_TOKEN?.trim() || "";
}

export async function beds24Configured(env: Env): Promise<boolean> {
  return (await refreshTokenValue(env)) !== "";
}

/** À appeler quand le refresh token change (nouveau code d'invitation). */
export function resetBeds24TokenCache(): void {
  cachedToken = null;
}

/** Cache d'access token par isolate (durée de vie 24 h côté Beds24 —
 *  on garde une marge en le renouvelant au bout de 20 h). */
let cachedToken: { value: string; expiresAt: number } | null = null;

export class Beds24Error extends Error {
  /** `refus` : Beds24 a répondu non, rien n'a été appliqué. `inconnu` : panne
   *  réseau, délai ou erreur 5xx — une écriture a PU être appliquée. */
  constructor(
    message: string,
    public status?: number,
    public issue: "refus" | "inconnu" = "refus",
    /** Corps de la réponse Beds24 tel quel (tronqué), pour l'audit et le
     *  diagnostic : un refus sans `errors` se lit ici mot pour mot. */
    public response?: unknown,
  ) {
    super(message);
  }
}

async function accessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  let res: Response;
  try {
    res = await fetch(`${BEDS24_API}/authentication/token`, {
      headers: { refreshToken: await refreshTokenValue(env) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Beds24Error(`renouvellement du token Beds24 injoignable (${e instanceof Error ? e.message : String(e)})`);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Beds24Error(`échec du renouvellement de token Beds24 : ${data.error ?? res.status}`, res.status);
  }
  cachedToken = { value: data.token, expiresAt: Date.now() + 20 * 3600 * 1000 };
  return cachedToken.value;
}

/** Les ÉCRITURES sortantes sont réservées à la production.
 *
 *  Beds24 n'a pas de bac à sable et `.dev.vars` porte le vrai refresh token :
 *  une session locale (base de seed, prix TODO) pousserait des tarifs et des
 *  disponibilités faux sur 400 jours dans le compte réel — et demain jusqu'à
 *  Airbnb et Booking. Jusqu'ici, seule la panne DNS du VPN Emeria empêchait
 *  ça, par accident (audit ECC 2026-07-30). Les lectures restent libres. */
export function beds24WritesAllowed(env: Env): boolean {
  // Fermé par défaut (contrôle Codex 10/10/2026) : seule la production pose
  // BEDS24_WRITE_ENABLED="true" (wrangler.jsonc, env.production ; variable
  // d'environnement du site Node sur Infomaniak, cf. .env.example). Le https ne
  // suffit plus : l'environnement d'essai est en https et ne doit jamais
  // écrire dans le compte réel, même si on y colle un code d'invitation.
  return env.BEDS24_WRITE_ENABLED === "true";
}

/** Texte d'un élément refusé qui ne porte ni `errors` ni `error` ni
 *  `message` (10/10/2026 : POST /properties a répondu 201 avec un élément
 *  `success: false` sans `errors`, et l'écran n'affichait que « échec ») :
 *  ses `warnings` et `info` s'il en a, sinon l'élément entier, tel quel. */
function withoutErrors(item: Record<string, unknown>): string {
  const notes: string[] = [];
  for (const key of ["warnings", "info"] as const) {
    const list = item[key];
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      notes.push(`${key === "warnings" ? "avertissement" : "info"} ${motifText(m)}`);
    }
  }
  if (notes.length) return notes.join(" ; ");
  // Aucun motif lisible : le JSON brut de l'élément, tel que Beds24 l'a envoyé
  // (non filtré par la liste blanche : c'est justement ce qui manquait).
  return `réponse sans motif : ${truncate(JSON.stringify(item), 800)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} caractères coupés)` : text;
}

/** Champs gardés d'une réponse d'écriture ou d'erreur Beds24 : statut, ids,
 *  motifs. Liste blanche : rien d'autre (aucun champ de voyageur) n'entre dans
 *  l'audit ni dans le 502. Les motifs, eux, sont gardés en entier. */
const KEPT_FIELDS = ["success", "id", "roomId", "propertyId", "new", "modified", "errors", "warnings", "info", "action", "field", "subField", "error", "message", "code", "type"] as const;

const MOTIF_LISTS = new Set(["errors", "warnings", "info"]);

/** Un élément de errors[] / warnings[] / info[] : TOUTES ses clés scalaires
 *  (chaîne, nombre, booléen, null), pas seulement la liste blanche. Le 11/10
 *  Beds24 a refusé la liaison des prix par six `warnings` dont le texte, sous
 *  des clés hors liste, avait été réduit à `{}`. Copie brute `raw` (JSON de
 *  l'élément, 600 caractères) : elle rend visible ce que la réduction jette
 *  quand les clés scalaires manquent (clés imbriquées seulement). */
function keepMotif(m: unknown): unknown {
  if (!m || typeof m !== "object" || Array.isArray(m)) return keepFields(m, 1);
  const out: Record<string, unknown> = { raw: truncate(JSON.stringify(m), 600) };
  for (const [k, val] of Object.entries(m as Record<string, unknown>)) {
    if (val === null || ["string", "number", "boolean"].includes(typeof val)) out[k] = typeof val === "string" ? truncate(val, 2000) : val;
  }
  return out;
}

/** Texte d'un motif (élément de errors/warnings/info), mot pour mot. Sans clé
 *  scalaire, le JSON brut de l'élément est donné (« {} — brut : … ») ; un
 *  élément vraiment vide reste « {} (Beds24 n'a rien dit) ». */
export function motifText(m: unknown): string {
  if (typeof m === "string") return m;
  if (!m || typeof m !== "object") return String(m);
  const o = m as Record<string, unknown>;
  const entries = Object.entries(o).filter(([k, val]) => k !== "raw" && (val === null || ["string", "number", "boolean"].includes(typeof val)));
  if (entries.length === 0) {
    // `raw` déjà posé (élément gardé) ou JSON de l'élément brut (réponse reçue).
    const brut = typeof o.raw === "string" ? o.raw : truncate(JSON.stringify(o), 600);
    return brut === "{}" ? "{} (Beds24 n'a rien dit)" : `{} — brut : ${brut}`;
  }
  const field = typeof o.field === "string" && o.field ? `${o.field} : ` : "";
  if (typeof o.message === "string") {
    const rest = entries.filter(([k]) => k !== "message" && k !== "field");
    return `${field}${o.message}${rest.length ? ` [${rest.map(([k, val]) => `${k}=${String(val)}`).join(", ")}]` : ""}`;
  }
  return entries.map(([k, val]) => `${k}=${String(val)}`).join(", ");
}

function keepFields(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => keepFields(x, depth));
  if (!v || typeof v !== "object") return typeof v === "string" ? truncate(v, 2000) : v;
  if (depth > 4) return "…";
  const out: Record<string, unknown> = {};
  for (const k of KEPT_FIELDS) {
    if (!(k in (v as Record<string, unknown>))) continue;
    const val = (v as Record<string, unknown>)[k];
    out[k] = MOTIF_LISTS.has(k) && Array.isArray(val) ? val.slice(0, 50).map(keepMotif) : keepFields(val, depth + 1);
  }
  return out;
}

/** Réponse Beds24 gardée pour l'audit et le diagnostic (liste blanche ci-dessus). */
export function rawForAudit(data: unknown): unknown {
  return keepFields(data);
}

/** L'API v2 répond parfois 200 avec un échec par élément
 *  ({ success:false, errors:[…] } par room) : un calendrier partiellement
 *  rejeté passait pour un push réussi. On remonte ces échecs en erreur. */
function collectFailures(data: unknown): string[] {
  const out: string[] = [];
  const describe = (item: Record<string, unknown>): string => {
    const errs = item.errors ?? item.error ?? item.message;
    const target = item.roomId ?? item.propertyId ?? item.id;
    // Format des écritures v2 (multiplePostResponse) : errors = [{ action,
    // field, message }] — rendu « champ : message » pour que l'erreur Beds24
    // remonte en clair jusqu'à l'écran, au lieu d'un JSON illisible.
    const text = Array.isArray(errs)
      ? errs
          .map((e) => {
            return motifText(e);
          })
          .join(" ; ")
      : typeof errs === "string"
        ? errs
        : errs != null
          ? JSON.stringify(rawForAudit(errs))
          : withoutErrors(item);
    return `${target != null ? `#${String(target)} ` : ""}${text}`;
  };
  // Les POST v2 (POST /properties, POST /inventory/rooms/calendar…) répondent
  // par un TABLEAU d'un résultat par élément envoyé, sans enveloppe `data` :
  // un refus y passait inaperçu.
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      // `success` n'est pas obligatoire dans multiplePostResponse : un élément
      // qui porte des `errors` sans se dire réussi est un échec.
      const hasErrors = Array.isArray(o.errors) && o.errors.length > 0;
      if (o.success === false || (o.success !== true && hasErrors)) out.push(describe(o));
    }
    return out;
  }
  if (data && typeof data === "object") {
    const root = data as Record<string, unknown>;
    if (root.success === false) out.push(describe(root));
    const list = root.data;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object" && (item as Record<string, unknown>).success === false) {
          out.push(describe(item as Record<string, unknown>));
        }
      }
    }
  }
  return out;
}

/** Appel générique API v2 (JSON), token gérés automatiquement. */
export async function beds24Fetch<T>(
  env: Env,
  path: string,
  init: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    query?: Record<string, string>;
    /** Reçoit les en-têtes de la réponse (quota X-FiveMinCreditLimit…), même en erreur. */
    onHeaders?: (headers: Headers) => void;
  } = {},
): Promise<T> {
  if (!(await beds24Configured(env))) throw new Beds24Error("Beds24 non configuré (aucun refresh token en base ni en secret)");
  const method = init.method ?? "GET";
  if (method !== "GET" && !beds24WritesAllowed(env)) {
    throw new Beds24Error(
      `écriture Beds24 bloquée hors production (${method} ${path}) — poser BEDS24_WRITE_ENABLED=true pour forcer`,
    );
  }
  const token = await accessToken(env);
  const url = new URL(`${BEDS24_API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { token, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      // Un appel qui pend indéfiniment tiendrait un verrou (création de
      // propriété) au-delà de son délai : on coupe à 30 s.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // Panne réseau ou délai dépassé : une Beds24Error, pour que l'appelant
    // la journalise et l'affiche en clair au lieu d'un 500 opaque. Pour une
    // écriture, l'issue est INCONNUE (Beds24 a pu l'appliquer).
    throw new Beds24Error(
      `Beds24 ${method} ${path} injoignable (${e instanceof Error ? e.message : String(e)})${method !== "GET" ? " — résultat inconnu côté Beds24" : ""}`,
      undefined,
      "inconnu",
    );
  }
  init.onHeaders?.(res.headers);
  // Le texte d'abord : un corps qui n'est pas du JSON reste lisible dans l'erreur.
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    const msg = `Beds24 ${path} → ${res.status} réponse non JSON : ${truncate(text, 500)}`;
    if (res.ok) throw new Beds24Error(msg, res.status, method !== "GET" ? "inconnu" : "refus");
    parsed = { error: `réponse non JSON : ${truncate(text, 500)}` };
  }
  const data = parsed as T & { success?: boolean; error?: string };
  if (!res.ok) {
    throw new Beds24Error(`Beds24 ${path} → ${res.status} ${data.error ?? ""}`.trim(), res.status, res.status >= 500 ? "inconnu" : "refus", rawForAudit(data));
  }
  const failures = collectFailures(data);
  if (failures.length > 0) {
    // Un élément refusé à côté d'un `new`/`modified` peut traduire une
    // application PARTIELLE (le POST n'est pas réputé atomique) : issue inconnue.
    const partial = Array.isArray(data) && data.some((i) => i && typeof i === "object" && ("new" in i || "modified" in i));
    throw new Beds24Error(
      `Beds24 ${path} → ${res.status} mais ${failures.length} élément(s) refusé(s) : ${failures.slice(0, 3).join(" · ")}`,
      res.status,
      partial ? "inconnu" : "refus",
      rawForAudit(data),
    );
  }
  return data;
}

/** Échange un invite code (généré dans l'UI) contre { token, refreshToken }.
 *  Utilisé une seule fois au setup — le refreshToken part en secret. */
export async function beds24Setup(inviteCode: string): Promise<{ token: string; refreshToken: string }> {
  const res = await fetch(`${BEDS24_API}/authentication/setup`, { headers: { code: inviteCode } });
  const data = (await res.json().catch(() => ({}))) as { token?: string; refreshToken?: string; error?: string };
  if (!res.ok || !data.token || !data.refreshToken) {
    throw new Beds24Error(`setup Beds24 refusé : ${data.error ?? res.status}`, res.status);
  }
  return { token: data.token, refreshToken: data.refreshToken };
}

/** Diagnostic de connexion : détails du compte + propriétés visibles.
 *  Sert à l'endpoint admin /api/admin/beds24/status. */
export interface Beds24PropertySummary {
  id: number;
  name: string;
  roomTypes?: { id: number; name: string }[];
}

/** Identité du compte relié, telle que l'API la donne. L'API v2 n'expose PAS
 *  le nom d'utilisateur du compte (« gites-premore ») : seulement son numéro
 *  (`ownerId`), le nom donné au jeton à sa création et ses droits. */
export interface Beds24Compte {
  id: number | null;
  appareil: string | null;
  scopes: string[];
  /** Jeton restreint à une seule propriété (null = toutes). */
  limiteAPropriete: number | null;
}

function readCompte(details: unknown): Beds24Compte {
  const root = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
  const token = (root.token && typeof root.token === "object" ? root.token : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: n(token.ownerId),
    appareil: typeof token.deviceName === "string" ? token.deviceName : null,
    scopes: Array.isArray(token.scopes) ? token.scopes.filter((x): x is string => typeof x === "string") : [],
    limiteAPropriete: n(token.onlyPropertyId),
  };
}

/** Liste des propriétés du compte, avec leurs rooms. */
export async function beds24ListProperties(env: Env): Promise<Beds24PropertySummary[]> {
  // Réponse paginée (pages.nextPageExists) : une page manquée ferait croire
  // à un mapping périmé ou cacherait un homonyme — d'où un doublon.
  const all: Beds24PropertySummary[] = [];
  for (let page = 1; page <= 20; page++) {
    const props = await beds24Fetch<{ data?: Beds24PropertySummary[]; pages?: { nextPageExists?: boolean } }>(
      env,
      "/properties",
      { query: { includeAllRooms: "true", ...(page > 1 ? { page: String(page) } : {}) } },
    );
    all.push(...(props.data ?? []));
    if (!props.pages?.nextPageExists) break;
    if (page === 20) throw new Beds24Error("liste des propriétés Beds24 trop longue (plus de 20 pages)");
  }
  return all.map((p) => ({
    id: Number(p.id),
    name: String(p.name ?? ""),
    roomTypes: (p.roomTypes ?? []).map((r) => ({ id: Number(r.id), name: String(r.name ?? "") })),
  }));
}

export async function beds24Status(env: Env): Promise<{
  connected: boolean;
  account?: unknown;
  compte?: Beds24Compte;
  properties?: Beds24PropertySummary[];
  error?: string;
}> {
  if (!(await beds24Configured(env))) return { connected: false, error: "aucun refresh token Beds24 (base ou secret)" };
  try {
    const details = await beds24Fetch<{ data?: unknown }>(env, "/authentication/details");
    const properties = await beds24ListProperties(env);
    const account = details.data ?? details;
    return { connected: true, account, compte: readCompte(account), properties };
  } catch (e) {
    console.error("beds24Status —", e);
    // sonde réseau : distingue « sortie internet morte » de « Beds24 inaccessible »
    const probe = async (url: string) => {
      try {
        const r = await fetch(url, { method: "GET" });
        return `${r.status}`;
      } catch (pe) {
        return `KO: ${pe instanceof Error ? pe.message.slice(0, 60) : String(pe)}`;
      }
    };
    const probes = {
      "cloudflare.com/cdn-cgi/trace": await probe("https://www.cloudflare.com/cdn-cgi/trace"),
      "api.beds24.com sans auth": await probe("https://api.beds24.com/v2/authentication/details"),
    };
    return { connected: false, error: (e instanceof Error ? e.message : String(e)) + " | sondes: " + JSON.stringify(probes) };
  }
}

/** Quota de l'API v2 : des crédits sur une fenêtre glissante de 5 minutes,
 *  partagés par tous les jetons du compte. Lu dans les en-têtes de chaque
 *  réponse ; null quand Beds24 ne les envoie pas. */
export interface Beds24Credit {
  limit: number | null;
  remaining: number | null;
  resetsIn: number | null;
  cost: number | null;
}

export function readBeds24Credit(h: Headers): Beds24Credit {
  const n = (name: string): number | null => {
    const v = h.get(name);
    if (v == null || v.trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    limit: n("X-FiveMinCreditLimit"),
    remaining: n("X-FiveMinCreditLimit-Remaining"),
    resetsIn: n("X-FiveMinCreditLimit-ResetsIn"),
    cost: n("X-RequestCost"),
  };
}
