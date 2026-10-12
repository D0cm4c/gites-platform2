// Adaptateur SQLite → API D1.
//
// Le code métier (src/db/repo.ts, 236 appels) parle le dialecte D1 :
//   db.prepare(sql).bind(...).run() / .all() / .first()
//   db.batch([...])  ·  res.meta.changes  ·  res.meta.last_row_id
// D1 n'étant qu'un habillage de SQLite, cet adaptateur reproduit cette surface
// au-dessus de `node:sqlite` (intégré au runtime Node 22+, donc AUCUNE
// dépendance à compiler — ni better-sqlite3, ni module natif).
//
// Conséquence voulue : ni repo.ts ni aucun service ne change d'une ligne, et
// la garantie anti-surbooking reste celle de SQLite — un seul écrivain à la
// fois, donc aucune fenêtre entre le contrôle de disponibilité et l'insertion.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** node:sqlite peut renvoyer des BigInt pour les entiers ; le code métier
 *  attend des nombres JS. Conversion défensive, sans perte à notre volume. */
function toNumber(v) {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Les valeurs acceptées par SQLite : null, number, bigint, string, Buffer.
 *  D1 tolère les booléens et `undefined` — on normalise pour éviter des
 *  « TypeError: Invalid argument type » à l'exécution. */
function normalizeParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

class PreparedStatement {
  #db;
  #sql;
  #params;

  constructor(db, sql, params = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  /** D1 : `.bind()` renvoie une NOUVELLE instruction liée (immuable). */
  bind(...params) {
    return new PreparedStatement(this.#db, this.#sql, params.map(normalizeParam));
  }

  get sql() {
    return this.#sql;
  }
  get params() {
    return this.#params;
  }

  #stmt() {
    return this.#db.prepare(this.#sql);
  }

  async run() {
    const res = this.#stmt().run(...this.#params);
    return {
      success: true,
      results: [],
      meta: {
        changes: toNumber(res.changes),
        last_row_id: toNumber(res.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: toNumber(res.changes),
      },
    };
  }

  async all() {
    const rows = this.#stmt().all(...this.#params);
    return {
      success: true,
      results: rows,
      meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: rows.length, rows_written: 0 },
    };
  }

  /** D1 : `.first()` renvoie la 1re ligne (ou null) ; `.first(col)` la colonne. */
  async first(colName) {
    const row = this.#stmt().get(...this.#params);
    if (row === undefined || row === null) return null;
    if (colName === undefined) return row;
    return row[colName] ?? null;
  }

  async raw() {
    const rows = this.#stmt().all(...this.#params);
    return rows.map((r) => Object.values(r));
  }
}

export class SqliteD1 {
  #db;

  constructor(filePath) {
    this.#db = new DatabaseSync(filePath);
    // WAL : lectures concurrentes illimitées pendant qu'une écriture a lieu.
    this.#db.exec("PRAGMA journal_mode = WAL");
    // Si une écriture est en cours, attendre au lieu d'échouer sur SQLITE_BUSY.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    // D1 applique les clés étrangères ; SQLite ne le fait PAS par défaut.
    this.#db.exec("PRAGMA foreign_keys = ON");
    // Durabilité correcte sans payer un fsync par transaction.
    this.#db.exec("PRAGMA synchronous = NORMAL");
  }

  prepare(sql) {
    return new PreparedStatement(this.#db, sql);
  }

  /** D1 : exécution atomique d'une liste d'instructions. On l'enveloppe dans
   *  une vraie transaction — plus fort que D1, qui ne garantit que le lot. */
  async batch(statements) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = [];
      for (const st of statements) out.push(await st.run());
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* transaction déjà défaite */
      }
      throw e;
    }
  }

  async exec(sql) {
    this.#db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Hors API D1 — utilisé par le lanceur de migrations et l'arrêt propre. */
  get raw() {
    return this.#db;
  }
  close() {
    this.#db.close();
  }
}

export function openDatabase(filePath) {
  return new SqliteD1(filePath);
}

/** Copie cohérente de toute la base, en octets (fichier SQLite complet).
 *
 *  `VACUUM INTO` écrit un instantané transactionnel : les écritures qui
 *  arrivent pendant la copie ne s'y mêlent pas, et le WAL est intégré (pas de
 *  fichier -wal à rapatrier à côté). La copie passe par un fichier temporaire
 *  dans `dir` (le dossier de la base, inscriptible par définition), supprimé
 *  avant de rendre la main, même en cas d'échec. Sert à
 *  GET /api/admin/export.sqlite (sauvegarde de nuit tirée depuis le Mac). */
export function snapshotSqlite(d1, dir) {
  const tmp = join(dir, `.export-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  try {
    d1.raw.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    // Secrets Stripe (migration 0030) : jamais dans une sauvegarde. secure_delete
    // efface les octets des pages libérées, puis VACUUM compacte le fichier.
    const copy = new DatabaseSync(tmp);
    try {
      const has = copy.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'property_stripe'").get();
      if (has) {
        copy.exec("PRAGMA secure_delete = ON");
        copy.exec("UPDATE property_stripe SET secret_key = NULL, webhook_secret = NULL");
        copy.exec("VACUUM");
      }
    } finally {
      copy.close();
    }
    return new Uint8Array(readFileSync(tmp));
  } finally {
    rmSync(tmp, { force: true });
  }
}
