import type { Improvement } from "./types";

/** Une cellule de CSV : guillemets doublés, et une cellule qui commencerait par
 *  = + - @ (ou une tabulation) est précédée d'une apostrophe, pour qu'un tableur
 *  ne la prenne jamais pour une formule. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Export du suivi : séparateur « ; » (tableur belge), UTF-8 avec BOM. */
export function improvementsCsv(rows: Improvement[], header: string[], statusLabel: (s: Improvement["status"]) => string): string {
  const lines = [header.map(csvCell).join(";")];
  for (const r of rows) {
    lines.push(
      [r.id, r.createdAt, r.author, r.pageTitle, r.pagePath, statusLabel(r.status), r.text, r.adminNote, r.viewportWidth, r.updatedAt].map(csvCell).join(";"),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
