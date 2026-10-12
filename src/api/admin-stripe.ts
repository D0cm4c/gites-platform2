// Réglages › Paiements : un compte Stripe par propriété (migration 0030).
//
//  - GET  /api/admin/stripe                      : état de chaque propriété (jamais une clé en clair)
//  - PUT  /api/admin/stripe/:propertyId          : pose / efface les clés, choisit test ou réel
//  - POST /api/admin/stripe/:propertyId/test     : « Tester la clé » (GET /v1/balance)
//  - GET  /api/admin/encaissements               : encaissements d'une propriété, par mois
//  - GET  /api/admin/encaissements.csv           : même chose en CSV
//  - POST /api/admin/encaissements/frais         : relève les frais Stripe manquants
//
// Poser ou changer une clé : session humaine seulement (une clé de service ne
// touche pas aux moyens d'encaissement). Les clés ne sont jamais renvoyées, ni
// écrites dans le journal d'audit : celui-ci ne garde que QUELS champs ont changé.
import { apiError, json, readJson, type Router } from "./router";
import { currentUser, guard, isHuman } from "./admin";
import { audit, getProperty, listProperties } from "../db/repo";
import { sqlNow } from "../core/dates";
import { backfillFees, encaissementsCsv, listEncaissements } from "../services/encaissements";
import { modeOfSecretKey, stripeConfigFromEnv, testStripeSecretKey } from "../services/stripe";
import {
  applyStripePatch,
  getPropertyStripe,
  propertyStripeView,
  resolveStripeConfig,
  savePropertyStripe,
  StripeKeyError,
  type PropertyStripePatch,
} from "../services/stripe-config";
import { STRIPE_EVENTS_HANDLED } from "../services/stripe-webhook";

function propertyParam(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function registerStripeAdminRoutes(router: Router): void {
  router.get("/api/admin/stripe", guard(async (_req, env) => {
    const properties = await listProperties(env.DB);
    const envCfg = stripeConfigFromEnv(env);
    const items = [];
    for (const prop of properties) {
      const row = await getPropertyStripe(env.DB, prop.id);
      const eff = await resolveStripeConfig(env.DB, env, prop.id);
      items.push({ name: prop.name, slug: prop.slug, ...propertyStripeView(prop.id, row, eff.source) });
    }
    return json({
      baseUrl: env.PUBLIC_BASE_URL,
      events: STRIPE_EVENTS_HANDLED,
      // Le repli existe-t-il ? (variables d'environnement) — jamais leur valeur.
      envFallback: { secret: !!envCfg.secretKey, publishable: !!envCfg.publishableKey, webhook: !!envCfg.webhookSecret, mode: envCfg.mode },
      properties: items,
    });
  }));

  router.put("/api/admin/stripe/:propertyId", guard(async (req, env, p) => {
    if (!isHuman(req)) return apiError(403, "les clés Stripe se posent depuis une session humaine (pas par une clé de service)");
    const propertyId = propertyParam(p.propertyId);
    const prop = propertyId ? await getProperty(env.DB, propertyId) : null;
    if (!prop) return apiError(404, "propriété inconnue");
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== "object") return apiError(400, "corps JSON attendu");
    const str = (k: string): string | undefined => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const patch: PropertyStripePatch = {
      secretKey: str("secretKey"),
      publishableKey: str("publishableKey"),
      webhookSecret: str("webhookSecret"),
      mode: str("mode"),
      accountLabel: str("accountLabel"),
    };
    const current = await getPropertyStripe(env.DB, propertyId);
    let next;
    try {
      next = applyStripePatch(current, patch, sqlNow(), currentUser(req));
    } catch (e) {
      if (e instanceof StripeKeyError) return apiError(400, e.message);
      throw e;
    }
    await savePropertyStripe(env.DB, propertyId, { ...next, propertyId });
    const changed = (Object.keys(patch) as (keyof PropertyStripePatch)[]).filter((k) => patch[k] !== undefined);
    await audit(env.DB, "admin", "stripe.keys_update", `property:${propertyId}`, { champs: changed, mode: next.mode, par: currentUser(req) });
    const row = await getPropertyStripe(env.DB, propertyId);
    const eff = await resolveStripeConfig(env.DB, env, propertyId);
    return json({ ok: true, stripe: { name: prop.name, slug: prop.slug, ...propertyStripeView(propertyId, row, eff.source) } });
  }));

  router.post("/api/admin/stripe/:propertyId/test", guard(async (req, env, p) => {
    const propertyId = propertyParam(p.propertyId);
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(404, "propriété inconnue");
    // Teste la clé en base (ou, à défaut, celle de l'environnement qui sert de repli).
    const cfg = await resolveStripeConfig(env.DB, env, propertyId);
    if (!cfg.secretKey) return json({ ok: false, error: "Aucune clé secrète posée pour cette propriété (ni de repli en environnement)." });
    const res = await testStripeSecretKey(cfg.secretKey);
    const declared = modeOfSecretKey(cfg.secretKey);
    let warning: string | undefined;
    if (res.ok && res.livemode !== undefined && declared && (declared === "live") !== res.livemode) {
      warning = "Stripe annonce un mode différent de celui du préfixe de la clé.";
    }
    await audit(env.DB, "admin", "stripe.key_test", `property:${propertyId}`, { ok: res.ok, source: cfg.source, par: currentUser(req) });
    return json({ ok: res.ok, livemode: res.livemode, source: cfg.source, error: res.error, warning });
  }));

  router.get("/api/admin/encaissements", guard(async (_req, env, _p, url) => {
    const propertyId = propertyParam(url.searchParams.get("property"));
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "property : identifiant de propriété attendu");
    const report = await listEncaissements(env.DB, propertyId, { from: url.searchParams.get("from"), to: url.searchParams.get("to") });
    return json({ report });
  }));

  router.get("/api/admin/encaissements.csv", guard(async (req, env, _p, url) => {
    const propertyId = propertyParam(url.searchParams.get("property"));
    const prop = propertyId ? await getProperty(env.DB, propertyId) : null;
    if (!prop) return apiError(400, "property : identifiant de propriété attendu");
    const report = await listEncaissements(env.DB, propertyId, { from: url.searchParams.get("from"), to: url.searchParams.get("to") });
    await audit(env.DB, "admin", "encaissements.export_csv", `property:${propertyId}`, { lignes: report.rows.length, par: currentUser(req) });
    return new Response(encaissementsCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="encaissements-${prop.slug}-${sqlNow().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }));

  router.post("/api/admin/encaissements/frais", guard(async (req, env, _p, url) => {
    const propertyId = propertyParam(url.searchParams.get("property"));
    if (!propertyId || !(await getProperty(env.DB, propertyId))) return apiError(400, "property : identifiant de propriété attendu");
    const res = await backfillFees(env.DB, env, propertyId);
    await audit(env.DB, "admin", "encaissements.frais", `property:${propertyId}`, { ...res, par: currentUser(req) });
    return json({ ok: true, ...res });
  }));
}
