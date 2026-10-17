// En-têtes de sécurité et de cache — appliqués à TOUTES les réponses du Worker
// (routes dynamiques comme fichiers statiques servis par le binding ASSETS).
//
// Contexte (issue #22) : le portage Node (`node/server.mjs`, fonction
// `staticHeaders`) posait déjà ces en-têtes, mais le Worker — c'est-à-dire la
// production — n'en posait aucun. Ce module aligne les deux runtimes.
//
// Deux principes tiennent tout le fichier :
//  1. On n'écrase jamais un `cache-control` déjà décidé par un handler
//     (`json()` pose `no-store`, l'export iCal aussi) : la couche transverse
//     complète, elle n'arbitre pas à la place du métier.
//  2. La CSP est en **Report-Only**. Le site public est un export WordPress
//     truffé de scripts et de styles en ligne : une CSP bloquante casserait
//     des pages le jour de sa mise en ligne. Report-Only donne la visibilité
//     sans le risque ; le passage en mode bloquant est une décision séparée,
//     qui suppose d'abord d'extraire les scripts en ligne.

/** Un an — valeur usuelle pour HSTS et pour les images versionnées. */
const ONE_YEAR = 31_536_000;
/** Un jour — CSS, JS et fichiers divers : assez pour soulager, assez court
 *  pour qu'une correction se propage sans purge de cache. */
const ONE_DAY = 86_400;

/** Origines Stripe autorisées, et rien de plus (issue #26).
 *
 *  Le Payment Element a besoin d'exactement deux choses : charger
 *  `js.stripe.com/v3/` (script) et les iframes qu'il y monte (frame), puis
 *  parler à `api.stripe.com` (connect). Aucune autre origine n'est ouverte —
 *  ni CDN de police, ni domaine de télémétrie.
 *
 *  > [!warning]
 *  > **À ajouter AVANT de passer la CSP en mode bloquant** :
 *  > `frame-src https://hooks.stripe.com` — c'est là que Stripe héberge le
 *  > challenge 3-D Secure (DSP2). Sans lui, tout paiement par carte demandant
 *  > une authentification bancaire échouerait (contre-review Gemini
 *  > 2026-08-30). Aucun effet aujourd'hui : la politique est en Report-Only,
 *  > et l'ouvrir maintenant élargirait la liste au-delà des deux origines
 *  > arbitrées. Le passage en mode bloquant est une décision séparée
 *  > (cf. commentaire d'en-tête de ce fichier) : c'est là que la ligne se
 *  > pose, avec un test de bout en bout sur un paiement 3DS réel. */
const STRIPE_SCRIPT_SRC = "https://js.stripe.com";
const STRIPE_FRAME_SRC = "https://js.stripe.com";
const STRIPE_CONNECT_SRC = "https://api.stripe.com";

/** Widget anti-robot Turnstile du tunnel de réservation (issue #6) : script,
 *  iframe du défi et ses propres appels partent tous de la même origine.
 *  Autorisée en dur plutôt que conditionnée à la présence des clés — la CSP est
 *  une constante servie sur TOUTES les réponses, la rendre variable
 *  demanderait de la recalculer par requête pour un gain nul. En Report-Only,
 *  une directive de plus n'autorise rien : elle décrit la cible. Et le script
 *  n'est de toute façon chargé que si la clé publique existe. */
const TURNSTILE_SRC = "https://challenges.cloudflare.com";

/** Politique de sécurité du contenu, en observation. Elle décrit la cible :
 *  tout vient du site, sauf les images (le contenu WordPress importé pointe
 *  encore vers i0.wp.com), la carte Google Maps intégrée sur « la propriété »
 *  le formulaire de paiement Stripe du tunnel et son widget anti-robot.
 *  Les `'unsafe-inline'` sont le constat de l'existant, pas un choix. */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline' ${STRIPE_SCRIPT_SRC} ${TURNSTILE_SRC}`,
  "font-src 'self' data:",
  `connect-src 'self' ${STRIPE_CONNECT_SRC} ${TURNSTILE_SRC}`,
  `frame-src https://www.google.com ${STRIPE_FRAME_SRC} ${TURNSTILE_SRC}`,
].join("; ");

/** Permissions-Policy volontairement minimale : on coupe les trois capteurs
 *  qu'aucune page du site n'utilise. Rien de plus — une liste exhaustive se
 *  périme et finit par bloquer une fonctionnalité légitime. */
const PERMISSIONS_POLICY = "geolocation=(), camera=(), microphone=()";

/** Cache-control à appliquer quand le handler n'en a pas décidé. */
export function cacheControlFor(pathname: string, contentType: string | null): string {
  // Les images sont immuables en pratique : elles changent de nom, pas de
  // contenu. C'est le cache long recommandé par l'audit SEO.
  if (pathname.startsWith("/img/") || (contentType ?? "").startsWith("image/")) {
    return `public, max-age=${ONE_YEAR}, immutable`;
  }
  // HTML : jamais mis en cache dur, sinon une correction de contenu reste
  // invisible pour les visiteurs déjà venus.
  if ((contentType ?? "").includes("text/html")) return "no-cache";
  return `public, max-age=${ONE_DAY}`;
}

/**
 * Renvoie une copie de `response` enrichie des en-têtes de sécurité et de cache.
 * `url` sert à décider du cache (chemin) et de HSTS (schéma).
 */
export function withStandardHeaders(response: Response, url: URL): Response {
  // `new Response(body, response)` recopie statut, statusText et en-têtes en
  // les rendant modifiables. Les statuts sans corps (204, 304…) ont déjà
  // `body === null`, la construction reste donc valide.
  const out = new Response(response.body, response);
  const h = out.headers;

  h.set("x-content-type-options", "nosniff");
  // Le tunnel de réservation /book/ est la seule page intégrable en iframe
  // (WordPress) ; partout ailleurs, l'intégration reste interdite.
  if (!url.pathname.startsWith("/book/")) h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", PERMISSIONS_POLICY);
  h.set("content-security-policy-report-only", CSP_REPORT_ONLY);

  // HSTS n'a de sens que sur une réponse déjà servie en HTTPS ; l'annoncer sur
  // http://localhost n'apporte rien (les navigateurs l'ignorent) et brouille
  // la lecture d'un `curl -I` en développement.
  if (url.protocol === "https:") {
    h.set("strict-transport-security", `max-age=${ONE_YEAR}; includeSubDomains`);
  }

  if (!h.has("cache-control")) {
    h.set("cache-control", cacheControlFor(url.pathname, h.get("content-type")));
  }

  return out;
}
