import { t } from "@lingui/core/macro";
// Accès à l'API admin JSON (/api/admin/*), même origine que l'écran.
//
// La session est celle de l'ancien back-office : `POST /api/admin/login`
// renvoie un jeton, envoyé ensuite en `Authorization: Bearer session:<jeton>`.
// Les clés de stockage sont celles de l'ancien écran (gp_session, gp_token,
// gp_user) : se connecter à l'un connecte l'autre.

const SESSION_KEY = "gp_session";
const TOKEN_KEY = "gp_token";
const USER_KEY = "gp_user";
const LAST_USER_KEY = "gp_last_user";

function lire(cle: string): string | null {
  try {
    return localStorage.getItem(cle);
  } catch {
    return null;
  }
}
function ecrire(cle: string, valeur: string | null): void {
  try {
    if (valeur == null) localStorage.removeItem(cle);
    else localStorage.setItem(cle, valeur);
  } catch {
    /* navigation privée : la session ne survivra pas au rechargement */
  }
}

export function authHeader(): string | null {
  const session = lire(SESSION_KEY);
  if (session) return `Bearer session:${session}`;
  const token = lire(TOKEN_KEY);
  const user = lire(USER_KEY);
  if (token) return `Bearer ${user ? `${user}:${token}` : token}`;
  return null;
}

/** À l'ouverture de l'écran : si le compte connecté n'est plus celui qui a
 *  rempli le cache hors ligne (changement de compte sur le même navigateur, qui
 *  partage la session), on vide ce cache. */
const CACHE_OWNER_KEY = "gp2_cache_owner";
export function checkOfflineCacheOwner(): void {
  const user = lire(USER_KEY) ?? "";
  if ((lire(CACHE_OWNER_KEY) ?? "") !== user || !isLoggedIn()) void clearOfflineCache();
  ecrire(CACHE_OWNER_KEY, isLoggedIn() ? user : null);
}

export function isLoggedIn(): boolean {
  return authHeader() != null;
}

export function currentUser(): string | null {
  return lire(USER_KEY);
}

export function lastUser(): string {
  return lire(LAST_USER_KEY) ?? "";
}

export function clearSession(): void {
  ecrire(SESSION_KEY, null);
  ecrire(TOKEN_KEY, null);
  void clearOfflineCache();
}

/** Vide les lectures de l'API gardées pour le hors-ligne (service worker) : à la
 *  connexion, à la déconnexion et à toute session refusée (401), pour qu'un
 *  compte ne relise jamais hors ligne ce qu'un autre a vu. */
export async function clearOfflineCache(): Promise<void> {
  // D'abord le service worker : il change de génération, une lecture encore en
  // vol ne pourra plus être écrite dans le cache après la purge.
  try {
    navigator.serviceWorker?.controller?.postMessage("vider");
  } catch {
    /* pas de service worker */
  }
  try {
    // Seules les lectures de l'API partent : l'écran lui-même (HTML, scripts,
    // icônes) ne contient aucune donnée et reste disponible hors ligne.
    for (const k of await caches.keys()) {
      if (!k.startsWith("gites-admin")) continue;
      const c = await caches.open(k);
      for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith("/api/")) await c.delete(req);
    }
  } catch {
    /* pas de cache (navigateur ancien, page non sécurisée, tests) */
  }
}

/** Erreur d'API : le message du serveur (déjà en français) et le statut. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Prévenu à chaque 401 : la coque renvoie alors vers la connexion. */
type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const url = new URL(`/api/admin${path}`, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = authHeader();
  if (auth) headers.authorization = auth;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new ApiError(0, t`Pas de connexion avec le serveur. Vérifiez internet, puis réessayez.`, null);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      unauthorizedListeners.forEach((fn) => fn());
    }
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `erreur ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

/** Ouvre un PDF du back-office (confirmation de réservation et conditions générales) dans un nouvel onglet.
 *  Le fichier est demandé avec l'en-tête d'accès (un simple lien n'en porterait
 *  pas) ; l'onglet est ouvert AVANT l'attente pour ne pas être bloqué par le navigateur. */
export async function openAdminPdf(path: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const auth = authHeader();
    const res = await fetch(new URL(`/api/admin${path}`, window.location.origin), { headers: auth ? { authorization: auth } : {} });
    if (!res.ok) {
      if (res.status === 401) {
        clearSession();
        unauthorizedListeners.forEach((fn) => fn());
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? `erreur ${res.status}`, body);
    }
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Envoi d'un formulaire multipart (photos) : même garde et mêmes erreurs que api(). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = authHeader();
  if (auth) headers.authorization = auth;
  let res: Response;
  try {
    res = await fetch(new URL(`/api/admin${path}`, window.location.origin), { method: "POST", headers, body: form });
  } catch {
    throw new ApiError(0, t`Pas de connexion avec le serveur. Vérifiez internet, puis réessayez.`, null);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      unauthorizedListeners.forEach((fn) => fn());
    }
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `erreur ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export async function login(user: string, password: string): Promise<void> {
  const data = await api<{ ok: boolean; user: string; session?: string }>("/login", { method: "POST", body: { user, password } });
  await clearOfflineCache();
  ecrire(CACHE_OWNER_KEY, data.user);
  ecrire(USER_KEY, data.user);
  ecrire(LAST_USER_KEY, data.user);
  if (data.session) {
    ecrire(SESSION_KEY, data.session);
    ecrire(TOKEN_KEY, null);
  } else {
    // Accès de secours (ADMIN_TOKEN) : pas de session, le mot de passe est
    // gardé comme le fait l'ancien écran.
    ecrire(TOKEN_KEY, password);
    ecrire(SESSION_KEY, null);
  }
}

export async function logout(): Promise<void> {
  try {
    await api("/logout", { method: "POST" });
  } catch {
    /* la session locale est effacée de toute façon */
  }
  clearSession();
  await clearOfflineCache();
}

/** Message lisible pour une erreur quelconque. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return humanize(e.message, e.status);
  if (e instanceof Error) return e.message;
  return t`Quelque chose n'a pas marché. Réessayez.`;
}

/** Les messages du serveur sont en français mais parfois en termes de
 *  développeur : on reformule les plus courants pour l'écran. */
function humanize(msg: string, status: number): string {
  const m = msg.trim();
  if (status === 0) return m;
  if (status === 401) return t`Votre session a expiré. Reconnectez-vous.`;
  if (/créneau (déjà occupé|indisponible)/.test(m)) return t`Ces nuits sont déjà prises. Rien n'a été changé.`;
  if (/^devis impossible/.test(m)) return t`Ces dates ne se vendent pas telles quelles (minimum de nuits ou jour d'arrivée). Rien n'a été changé.`;
  if (status >= 500) return t`Le serveur n'a pas pu le faire. Rien n'a été changé ; réessayez dans un instant.`;
  return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? "" : ".");
}
