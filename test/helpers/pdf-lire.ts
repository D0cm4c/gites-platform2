// Lecture minimale d'un PDF produit par src/core/pdf.ts, pour les tests :
// structure (en-tête, xref, décalages), nombre de pages et texte par page.
// Ne sait lire que ce que le générateur écrit (flux non compressés, textes en
// hexadécimal WinAnsi) : ce n'est pas un lecteur de PDF général.

const WIN_ANSI_EXTRA: Record<number, string> = {
  0x80: "€", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™", 0x9c: "œ",
};

export function pdfAsString(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Texte de chaque page, dans l'ordre ; une chaîne par opérateur Tj, séparées par des retours à la ligne. */
export function pdfPagesText(bytes: Uint8Array): string[] {
  const src = pdfAsString(bytes);
  const pages: string[] = [];
  for (const m of src.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    const lines: string[] = [];
    for (const t of m[1]!.matchAll(/<([0-9a-f]*)> Tj/g)) {
      let out = "";
      for (let i = 0; i < t[1]!.length; i += 2) {
        const code = parseInt(t[1]!.slice(i, i + 2), 16);
        out += WIN_ANSI_EXTRA[code] ?? String.fromCharCode(code);
      }
      lines.push(out);
    }
    pages.push(lines.join("\n"));
  }
  return pages;
}

export function pdfText(bytes: Uint8Array): string {
  return pdfPagesText(bytes).join("\n");
}

/** Liste des anomalies de structure (vide = fichier cohérent). */
export function pdfStructureProblems(bytes: Uint8Array): string[] {
  const src = pdfAsString(bytes);
  const problems: string[] = [];
  if (!src.startsWith("%PDF-1.")) problems.push("en-tête %PDF- absent");
  if (!src.trimEnd().endsWith("%%EOF")) problems.push("%%EOF absent");
  const start = /startxref\n(\d+)\n%%EOF/.exec(src);
  if (!start) return [...problems, "startxref absent"];
  const xrefAt = Number(start[1]);
  if (!src.startsWith("xref\n", xrefAt)) problems.push(`startxref (${xrefAt}) ne pointe pas sur « xref »`);
  const head = /xref\n0 (\d+)\n/.exec(src.slice(xrefAt));
  if (!head) return [...problems, "table xref illisible"];
  const count = Number(head[1]);
  const entries = src.slice(xrefAt + head[0].length).split("\n").slice(0, count);
  entries.forEach((e, n) => {
    if (n === 0) return;
    if (!/^\d{10} 00000 n $/.test(e)) problems.push(`entrée xref ${n} mal formée : « ${e} »`);
    else if (!src.startsWith(`${n} 0 obj`, Number(e.slice(0, 10)))) problems.push(`l'objet ${n} n'est pas à l'offset ${Number(e.slice(0, 10))}`);
  });
  const size = /\/Size (\d+)/.exec(src);
  if (!size || Number(size[1]) !== count) problems.push("/Size différent du nombre d'entrées xref");
  // longueur déclarée des flux = longueur réelle
  for (const m of src.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    if (Number(m[1]) !== m[2]!.length) problems.push(`flux de ${m[2]!.length} octets déclaré ${m[1]}`);
  }
  const pageCount = (src.match(/\/Type \/Page /g) ?? []).length;
  const declared = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(src);
  if (!declared || Number(declared[1]) !== pageCount) problems.push("/Count différent du nombre de pages");
  return problems;
}

export function pdfPageCount(bytes: Uint8Array): number {
  return (pdfAsString(bytes).match(/\/Type \/Page /g) ?? []).length;
}
