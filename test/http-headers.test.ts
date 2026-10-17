// Issue #22 — en-têtes de sécurité et de cache sur TOUTES les réponses du
// Worker. Le portage Node les posait déjà ; la production, elle, n'en posait
// aucun. Ces tests verrouillent l'alignement des deux runtimes.
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { cacheControlFor, withStandardHeaders } from "../src/services/http-headers";

/** Binding ASSETS simulé : rend ce qu'on lui demande, comme le ferait
 *  Cloudflare pour un fichier de `public/`. */
function assetsReturning(body: string, contentType: string): Fetcher {
  return {
    fetch: async () => new Response(body, { headers: { "content-type": contentType } }),
  } as unknown as Fetcher;
}

function envWith(assets: Fetcher): Env {
  return {
    DB: undefined as unknown as D1Database,
    ASSETS: assets,
    PUBLIC_BASE_URL: "https://test.local",
    EMAILS_ENABLED: "false",
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function call(url: string, assets = assetsReturning("<html></html>", "text/html; charset=utf-8")) {
  return worker.fetch(new Request(url), envWith(assets), ctx);
}

describe("en-têtes de sécurité", () => {
  it("pose les quatre en-têtes de sécurité sur une page HTML servie par les assets", async () => {
    const res = await call("https://test.local/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("pose aussi les en-têtes sur une réponse d'API (404 JSON)", async () => {
    const res = await call("https://test.local/api/route-qui-nexiste-pas");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("annonce la CSP en observation, jamais en mode bloquant", async () => {
    const res = await call("https://test.local/");
    expect(res.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'none'");
    // Le jour où cette assertion tombe, c'est que quelqu'un a rendu la CSP
    // bloquante : le site public contient encore des scripts en ligne.
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("autorise l'iframe UNIQUEMENT pour le tunnel de réservation /book/ (intégration WordPress)", async () => {
    const book = await call("https://test.local/book/");
    expect(book.headers.get("x-frame-options")).toBeNull();
    const autre = await call("https://test.local/");
    expect(autre.headers.get("x-frame-options")).toBe("DENY");
  });
  it("ouvre Stripe — et Stripe seulement — pour le paiement intégré (issue #26)", async () => {
    const csp = (await call("https://test.local/book/")).headers.get("content-security-policy-report-only")!;
    // Le Payment Element a besoin d'exactement trois choses.
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://js.stripe.com");
    expect(csp).toContain("connect-src 'self' https://api.stripe.com");
    expect(csp).toContain("frame-src https://www.google.com https://js.stripe.com");
  });

  it("n'ouvre AUCUNE autre origine : la liste des hôtes autorisés est fermée", async () => {
    const csp = (await call("https://test.local/")).headers.get("content-security-policy-report-only")!;
    // Toutes les origines http(s) citées dans la politique, quelle que soit la
    // directive. Le jour où quelqu'un ajoute un CDN de police ou un domaine de
    // télémétrie « juste pour essayer », ce test tombe.
    const origins = [...new Set(csp.match(/https?:\/\/[^\s;]+/g) ?? [])].sort();
    expect(origins).toEqual([
      "https://api.stripe.com",             // PaymentIntent : confirmation depuis le navigateur
      "https://challenges.cloudflare.com",  // widget anti-robot Turnstile du tunnel (issue #6)
      "https://js.stripe.com",              // script + iframes du Payment Element
      "https://www.google.com",             // carte intégrée de « la propriété »
    ]);
    // Les directives non liées à Stripe ni à Turnstile sont inchangées.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("img-src 'self' data: https:");
  });

  it("n'annonce pas HSTS en clair (http local) — les navigateurs l'ignorent de toute façon", async () => {
    const res = await call("http://localhost:8788/");
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("préserve le corps et le statut de la réponse d'origine", async () => {
    const res = await call("https://test.local/", assetsReturning("<html>bonjour</html>", "text/html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>bonjour</html>");
  });
});

describe("cache", () => {
  it("met les images en cache long et immuable", async () => {
    const res = await call("https://test.local/img/pont-entree.jpg", assetsReturning("binaire", "image/jpeg"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("empêche la mise en cache dure des pages HTML", async () => {
    const res = await call("https://test.local/book/", assetsReturning("<html></html>", "text/html; charset=utf-8"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("laisse un cache d'un jour aux autres fichiers statiques", async () => {
    const res = await call("https://test.local/admin/app.js", assetsReturning("//js", "text/javascript"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("n'écrase JAMAIS le cache-control décidé par un handler (no-store des API)", async () => {
    const res = await call("https://test.local/api/route-qui-nexiste-pas");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("cacheControlFor arbitre sur le chemin ET sur le type de contenu", () => {
    expect(cacheControlFor("/img/x.png", null)).toContain("immutable");
    expect(cacheControlFor("/media/x.png", "image/png")).toContain("immutable");
    expect(cacheControlFor("/", "text/html; charset=utf-8")).toBe("no-cache");
    expect(cacheControlFor("/style.css", "text/css")).toBe("public, max-age=86400");
  });

  it("ne casse pas une réponse sans corps (304)", () => {
    const res = withStandardHeaders(new Response(null, { status: 304 }), new URL("https://test.local/img/a.png"));
    expect(res.status).toBe(304);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
