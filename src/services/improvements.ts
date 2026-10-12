// Remarques d'amélioration des testeurs (bouton « Amélioration ? » de l'écran
// d'administration, migration 0035). Lecture, création et suivi de statut ; pas
// de suppression. Le texte est stocké tel quel : l'écran l'affiche en texte
// brut (React échappe), jamais en HTML.

export const IMPROVEMENT_STATUSES = ["nouveau", "en_cours", "fait", "ecarte"] as const;
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];

export const IMPROVEMENT_TEXT_MIN = 3;
export const IMPROVEMENT_TEXT_MAX = 2000;
export const IMPROVEMENT_NOTE_MAX = 2000;
export const IMPROVEMENT_PATH_MAX = 300;
export const IMPROVEMENT_TITLE_MAX = 200;
export const IMPROVEMENT_UA_MAX = 160;

export interface ImprovementRow {
  id: number;
  createdAt: string;
  updatedAt: string;
  author: string;
  pagePath: string;
  pageTitle: string | null;
  text: string;
  status: ImprovementStatus;
  adminNote: string | null;
  userAgent: string | null;
  viewportWidth: number | null;
}

interface Raw {
  id: number;
  created_at: string;
  updated_at: string;
  author: string;
  page_path: string;
  page_title: string | null;
  text: string;
  status: ImprovementStatus;
  admin_note: string | null;
  user_agent: string | null;
  viewport_width: number | null;
}

function map(r: Raw): ImprovementRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    author: r.author,
    pagePath: r.page_path,
    pageTitle: r.page_title,
    text: r.text,
    status: r.status,
    adminNote: r.admin_note,
    userAgent: r.user_agent,
    viewportWidth: r.viewport_width,
  };
}

export function isImprovementStatus(v: unknown): v is ImprovementStatus {
  return typeof v === "string" && (IMPROVEMENT_STATUSES as readonly string[]).includes(v);
}

export async function createImprovement(
  db: D1Database,
  v: { author: string; pagePath: string; pageTitle: string | null; text: string; userAgent: string | null; viewportWidth: number | null },
): Promise<ImprovementRow> {
  const res = await db
    .prepare(
      "INSERT INTO improvement_requests (author, page_path, page_title, text, user_agent, viewport_width) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(v.author, v.pagePath, v.pageTitle, v.text, v.userAgent, v.viewportWidth)
    .run();
  const row = await getImprovement(db, Number(res.meta.last_row_id));
  return row!;
}

export async function getImprovement(db: D1Database, id: number): Promise<ImprovementRow | null> {
  const r = await db.prepare("SELECT * FROM improvement_requests WHERE id = ?1").bind(id).first<Raw>();
  return r ? map(r) : null;
}

export async function listImprovements(db: D1Database, status?: ImprovementStatus, limit = 500): Promise<ImprovementRow[]> {
  const stmt = status
    ? db.prepare("SELECT * FROM improvement_requests WHERE status = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2").bind(status, limit)
    : db.prepare("SELECT * FROM improvement_requests ORDER BY created_at DESC, id DESC LIMIT ?1").bind(limit);
  const { results } = await stmt.all<Raw>();
  return results.map(map);
}

export async function improvementCounts(db: D1Database): Promise<Record<ImprovementStatus, number>> {
  const out: Record<ImprovementStatus, number> = { nouveau: 0, en_cours: 0, fait: 0, ecarte: 0 };
  const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM improvement_requests GROUP BY status").all<{ status: ImprovementStatus; n: number }>();
  for (const r of results) if (r.status in out) out[r.status] = r.n;
  return out;
}

export async function updateImprovement(
  db: D1Database,
  id: number,
  patch: { status?: ImprovementStatus; adminNote?: string | null },
): Promise<ImprovementRow | null> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const binds: unknown[] = [];
  if (patch.status !== undefined) {
    binds.push(patch.status);
    sets.push(`status = ?${binds.length}`);
  }
  if (patch.adminNote !== undefined) {
    binds.push(patch.adminNote);
    sets.push(`admin_note = ?${binds.length}`);
  }
  binds.push(id);
  await db.prepare(`UPDATE improvement_requests SET ${sets.join(", ")} WHERE id = ?${binds.length}`).bind(...binds).run();
  return getImprovement(db, id);
}

/** Remarques arrivées dans les dernières 24 h (résumé quotidien). Table absente
 *  sur une base pas encore migrée : 0. */
export async function countRecentImprovements(db: D1Database, sinceSql: string): Promise<number> {
  try {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM improvement_requests WHERE created_at >= ?1").bind(sinceSql).first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}
