// Remarques d'amélioration (bouton « Amélioration ? » de l'écran) :
//   POST  /api/admin/improvements        un humain connecté ou une clé de service
//   GET   /api/admin/improvements        liste (?status=), plus récentes d'abord, compteurs
//   PATCH /api/admin/improvements/:id    statut et note interne
// Pas de suppression. Tout compte connecté peut lire et suivre : les testeurs
// partagent le suivi (il n'existe qu'un rôle d'administration).
import { audit } from "../db/repo";
import {
  IMPROVEMENT_NOTE_MAX, IMPROVEMENT_PATH_MAX, IMPROVEMENT_TEXT_MAX, IMPROVEMENT_TEXT_MIN, IMPROVEMENT_TITLE_MAX, IMPROVEMENT_UA_MAX,
  createImprovement, getImprovement, improvementCounts, isImprovementStatus, listImprovements, updateImprovement,
  type ImprovementStatus,
} from "../services/improvements";
import { currentUser, guard } from "./admin";
import { apiError, json, readJson, type Router } from "./router";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_BODY_BYTES = 16_384; // 2 000 caractères en UTF-8 : 8 Ko au plus, plus les autres champs
const clean = (s: string) => s.replace(CONTROL, "").trim();

export function registerImprovementRoutes(router: Router): void {
  router.post("/api/admin/improvements", guard(async (req, env) => {
    // Corps borné avant lecture : 2 000 caractères de texte + quelques champs tiennent largement.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return apiError(413, "la demande est trop volumineuse");
    const body = await readJson<{ text?: unknown; pagePath?: unknown; pageTitle?: unknown; viewportWidth?: unknown }>(req);
    if (!body || typeof body !== "object") return apiError(400, "demande illisible");
    const text = typeof body.text === "string" ? clean(body.text) : "";
    if (text.length < IMPROVEMENT_TEXT_MIN) return apiError(400, `la remarque est trop courte (${IMPROVEMENT_TEXT_MIN} caractères au moins)`);
    if (text.length > IMPROVEMENT_TEXT_MAX) return apiError(400, `la remarque est trop longue (${IMPROVEMENT_TEXT_MAX} caractères au plus)`);
    const pagePath = typeof body.pagePath === "string" ? clean(body.pagePath) : "";
    if (!pagePath) return apiError(400, "la page est obligatoire");
    if (pagePath.length > IMPROVEMENT_PATH_MAX) return apiError(400, "l'adresse de la page est trop longue");
    const pageTitle = typeof body.pageTitle === "string" && clean(body.pageTitle) ? clean(body.pageTitle).slice(0, IMPROVEMENT_TITLE_MAX) : null;
    const vw = Number(body.viewportWidth);
    const viewportWidth = Number.isInteger(vw) && vw > 0 && vw < 20000 ? vw : null;
    const ua = clean(req.headers.get("user-agent") ?? "").slice(0, IMPROVEMENT_UA_MAX) || null;
    const row = await createImprovement(env.DB, { author: currentUser(req), pagePath, pageTitle, text, userAgent: ua, viewportWidth });
    await audit(env.DB, "admin", "improvement.create", `improvement:${row.id}`, { par: currentUser(req), page: pagePath });
    return json({ ok: true, improvement: row });
  }));

  router.get("/api/admin/improvements", guard(async (_req, env, _p, url) => {
    const raw = url.searchParams.get("status");
    if (raw && !isImprovementStatus(raw)) return apiError(400, "statut inconnu");
    const [improvements, counts] = await Promise.all([listImprovements(env.DB, raw && isImprovementStatus(raw) ? raw : undefined), improvementCounts(env.DB)]);
    return json({ improvements, counts });
  }));

  router.patch("/api/admin/improvements/:id", guard(async (req, env, p) => {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id <= 0) return apiError(400, "numéro invalide");
    const body = await readJson<{ status?: unknown; adminNote?: unknown }>(req);
    if (!body || typeof body !== "object") return apiError(400, "demande illisible");
    const patch: { status?: ImprovementStatus; adminNote?: string | null } = {};
    if (body.status !== undefined) {
      if (!isImprovementStatus(body.status)) return apiError(400, "statut inconnu");
      patch.status = body.status;
    }
    if (body.adminNote !== undefined) {
      if (body.adminNote !== null && typeof body.adminNote !== "string") return apiError(400, "note invalide");
      const note = body.adminNote == null ? "" : clean(body.adminNote);
      if (note.length > IMPROVEMENT_NOTE_MAX) return apiError(400, `la note est trop longue (${IMPROVEMENT_NOTE_MAX} caractères au plus)`);
      patch.adminNote = note || null;
    }
    if (patch.status === undefined && patch.adminNote === undefined) return apiError(400, "rien à modifier");
    const before = await getImprovement(env.DB, id);
    if (!before) return apiError(404, "remarque introuvable");
    const row = await updateImprovement(env.DB, id, patch);
    await audit(env.DB, "admin", "improvement.update", `improvement:${id}`, {
      par: currentUser(req),
      ...(patch.status !== undefined ? { status: patch.status, avant: before.status } : {}),
      ...(patch.adminNote !== undefined ? { note: true } : {}),
    });
    return json({ ok: true, improvement: row });
  }));
}
