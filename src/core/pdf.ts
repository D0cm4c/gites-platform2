// Générateur PDF minimal, sans dépendance (ni Node ni Workers : du texte et des
// octets, rien d'autre). Il sert au PDF de confirmation joint au mail de
// confirmation (src/services/confirmation-pdf.ts) ; il couvre exactement ce dont un
// document de texte a besoin et rien de plus :
//   - A4, marges réglables, Helvetica et Helvetica-Bold (polices standard du
//     PDF : rien à embarquer), accents et « » € — … en WinAnsi ;
//   - titres, paragraphes (retours à la ligne automatiques, retrait,
//     justification à gauche, à droite ou centrée), espaces, filets ;
//   - tableaux simples (colonnes proportionnelles, en-tête répété à chaque
//     page, cellules multilignes, alignement par colonne, une ligne de tableau
//     n'est jamais coupée entre deux pages) ;
//   - pagination automatique et pied de page « Page n / N » ;
//   - métadonnées (titre, auteur, date) en UTF-16BE.
//
// Choix de robustesse :
//   - tout texte sort en chaîne HEXADÉCIMALE <…> : aucune parenthèse, aucun
//     antislash à échapper, donc rien qui puisse casser le flux ;
//   - le fichier est ASCII pur (les chaînes sont en hexadécimal) : le décalage
//     d'un objet est la longueur de la chaîne cumulée, la table xref est
//     exacte par construction ;
//   - les flux ne sont pas compressés : ils restent lisibles et un document
//     de quelques pages pèse quelques dizaines de ko.

/** Largeurs Helvetica (AFM, 1/1000 em) pour les caractères ASCII 32 à 126. */
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // ' ' à '/'
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
  278, 278, 584, 584, 584, 556, 1015, // : ; < = > ? @
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A-Z
  278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a-z
  334, 260, 334, 584, // { | } ~
];
/** Largeurs Helvetica-Bold, mêmes caractères. */
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
];

/** Caractères hors ASCII dont WinAnsi connaît l'octet (zone 0x80-0x9F). */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Largeur (1/1000 em) de quelques caractères non ASCII usuels ; les lettres accentuées prennent celle de leur lettre de base. */
const WIDE: Record<string, [number, number]> = {
  "€": [556, 556], "—": [1000, 1000], "–": [556, 556], "…": [1000, 1000], "’": [222, 278], "‘": [222, 278],
  "“": [333, 500], "”": [333, 500], "«": [556, 556], "»": [556, 556], "•": [350, 350], "°": [400, 400],
  "œ": [944, 944], "Œ": [1000, 1000], "×": [584, 584], "ß": [611, 611], "æ": [889, 889], "Æ": [1000, 1000],
  "™": [1000, 1000], "©": [737, 737], "®": [737, 737], "§": [556, 556], "·": [278, 278], "ç": [500, 556], "Ç": [722, 722],
};

/** Texte tel que le PDF l'écrira : espaces insécables normalisées, caractères de contrôle retirés. */
function clean(text: string): string {
  return text
    .replace(/[\u00a0\u202f\u2009\u2007]/g, " ")
    .replace(/[\u2010\u2011\u2212]/g, "-")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u2192/g, "->")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

/** Octet WinAnsi d'un caractère ; « ? » pour ce que la police standard ne sait pas dessiner. */
function winAnsiByte(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 32 && cp <= 126) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN_ANSI_EXTRA[ch] ?? 0x3f;
}

function charWidth(ch: string, bold: boolean): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 32 && cp <= 126) return (bold ? W_BOLD : W_REG)[cp - 32]!;
  const wide = WIDE[ch];
  if (wide) return wide[bold ? 1 : 0];
  const base = ch.normalize("NFD").charAt(0);
  const bcp = base.codePointAt(0)!;
  if (bcp >= 32 && bcp <= 126) return (bold ? W_BOLD : W_REG)[bcp - 32]!;
  return 556;
}

/** Largeur d'un texte, en points. */
export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of clean(text)) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

const hexByte = (n: number) => n.toString(16).padStart(2, "0");

/** Chaîne PDF hexadécimale d'un texte (WinAnsi). */
function hexText(text: string): string {
  let out = "";
  for (const ch of clean(text).replace(/\n/g, " ")) out += hexByte(winAnsiByte(ch));
  return `<${out}>`;
}

/** Chaîne PDF hexadécimale UTF-16BE (métadonnées). */
function hexUtf16(text: string): string {
  let out = "feff";
  for (let i = 0; i < text.length; i += 1) out += text.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out}>`;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

export type PdfAlign = "left" | "right" | "center";
export type PdfColor = [number, number, number];

export interface PdfOptions {
  title: string;
  author?: string;
  subject?: string;
  /** Date de création (injectable pour des tests déterministes). */
  date?: Date;
  /** Marge en points (56 ≈ 2 cm). */
  margin?: number;
  /** Texte à gauche du pied de page ; la pagination est à droite. */
  footer?: string;
  /** « Page {n} / {total} » : libellé de la pagination (« Pagina » en néerlandais). */
  pageLabel?: string;
}

export interface TextStyle {
  size?: number;
  bold?: boolean;
  align?: PdfAlign;
  color?: PdfColor;
  /** Retrait à gauche, en points. */
  indent?: number;
  /** Espace sous le bloc, en points. */
  after?: number;
  /** Interligne en multiple de la taille (1,3 par défaut). */
  leading?: number;
}

export interface TableColumn {
  /** Part de la largeur (les parts sont normalisées). */
  width: number;
  align?: PdfAlign;
  bold?: boolean;
}

export interface TableOptions {
  columns: TableColumn[];
  header?: string[];
  size?: number;
  /** Dernière ligne en gras avec un filet au-dessus (ligne de total). */
  totalRow?: boolean;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;

interface PageOps {
  ops: string[];
}

const FOREGROUND: PdfColor = [0.1, 0.1, 0.1];

export class PdfDocument {
  readonly #opts: Required<Pick<PdfOptions, "title">> & PdfOptions;
  readonly #margin: number;
  readonly #pages: PageOps[] = [];
  #y = 0; // distance depuis le haut de la page
  #page: PageOps;

  constructor(opts: PdfOptions) {
    this.#opts = opts;
    this.#margin = opts.margin ?? 56;
    this.#page = { ops: [] };
    this.#pages.push(this.#page);
    this.#y = this.#margin;
  }

  get contentWidth(): number {
    return PAGE_W - 2 * this.#margin;
  }

  get pageCount(): number {
    return this.#pages.length;
  }

  /** Place restante sur la page courante, en points. */
  get remaining(): number {
    return PAGE_H - this.#margin - 18 - this.#y;
  }

  newPage(): void {
    this.#page = { ops: [] };
    this.#pages.push(this.#page);
    this.#y = this.#margin;
  }

  /** Passe à la page suivante si moins de `needed` points restent. */
  ensure(needed: number): void {
    if (this.remaining < needed && this.#y > this.#margin + 1) this.newPage();
  }

  space(points: number): void {
    this.#y += points;
  }

  /** Filet horizontal sur toute la largeur. */
  rule(color: PdfColor = [0.75, 0.75, 0.75], width = 0.6): void {
    this.ensure(8);
    const y = PAGE_H - this.#y;
    this.#page.ops.push(`${num(width)} w ${color.map(num).join(" ")} RG ${num(this.#margin)} ${num(y)} m ${num(PAGE_W - this.#margin)} ${num(y)} l S`);
    this.#y += 6;
  }

  /** Coupe un texte en lignes qui tiennent dans `width` points ; un mot trop long est coupé. */
  wrap(text: string, size: number, bold: boolean, width: number): string[] {
    const lines: string[] = [];
    for (const para of clean(text).split("\n")) {
      if (para.trim() === "") {
        lines.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(/ +/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (textWidth(candidate, size, bold) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        let rest = word;
        while (textWidth(rest, size, bold) > width) {
          let cut = rest.length - 1;
          while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > width) cut -= 1;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  #drawLine(text: string, x: number, size: number, bold: boolean, color: PdfColor, align: PdfAlign, boxWidth: number): void {
    if (text === "") return;
    const w = textWidth(text, size, bold);
    const dx = align === "right" ? boxWidth - w : align === "center" ? (boxWidth - w) / 2 : 0;
    const baseline = PAGE_H - this.#y - size;
    this.#page.ops.push(
      `BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${color.map(num).join(" ")} rg ${num(x + dx)} ${num(baseline)} Td ${hexText(text)} Tj ET`,
    );
  }

  /** Un paragraphe ; les « \n » du texte sont des retours à la ligne. */
  paragraph(text: string, style: TextStyle = {}): void {
    const size = style.size ?? 10;
    const bold = style.bold ?? false;
    const leading = size * (style.leading ?? 1.3);
    const indent = style.indent ?? 0;
    const x = this.#margin + indent;
    const width = this.contentWidth - indent;
    const lines = this.wrap(text, size, bold, width);
    // Veuve et orpheline : au moins deux lignes ensemble en bas de page.
    this.ensure(Math.min(lines.length, 2) * leading);
    for (const line of lines) {
      if (this.remaining < leading) this.newPage();
      this.#drawLine(line, x, size, bold, style.color ?? FOREGROUND, style.align ?? "left", width);
      this.#y += leading;
    }
    this.#y += style.after ?? 4;
  }

  /** Titre : reste collé au paragraphe qui le suit (jamais seul en bas de page). */
  heading(text: string, level: 1 | 2 | 3 = 2): void {
    const size = level === 1 ? 18 : level === 2 ? 12.5 : 10.5;
    this.ensure(size * 1.4 + 44);
    if (level > 1 && this.#y > this.#margin + 1) this.space(level === 2 ? 8 : 4);
    this.paragraph(text, { size, bold: true, after: level === 1 ? 8 : 4, color: level === 1 ? [0.12, 0.27, 0.2] : FOREGROUND });
  }

  /** Tableau simple. Une ligne n'est jamais coupée ; l'en-tête est répété à chaque page. */
  table(rows: string[][], opts: TableOptions): void {
    const size = opts.size ?? 9.5;
    const leading = size * 1.3;
    const pad = 4;
    const total = opts.columns.reduce((a, c) => a + c.width, 0);
    const widths = opts.columns.map((c) => (c.width / total) * this.contentWidth);
    const xs: number[] = [];
    let acc = this.#margin;
    for (const w of widths) {
      xs.push(acc);
      acc += w;
    }

    const drawRow = (cells: string[], style: { bold?: boolean; fill?: PdfColor; topRule?: boolean }): void => {
      const wrapped = cells.map((c, i) => this.wrap(c, size, style.bold ?? opts.columns[i]?.bold ?? false, widths[i]! - 2 * pad));
      const lineCount = Math.max(1, ...wrapped.map((l) => l.length));
      const height = lineCount * leading + 2 * pad - 2;
      if (this.remaining < height) {
        this.newPage();
        if (opts.header && cells !== opts.header) drawRow(opts.header, { bold: true, fill: [0.93, 0.95, 0.93] });
      }
      const top = this.#y;
      if (style.fill) {
        this.#page.ops.push(
          `${style.fill.map(num).join(" ")} rg ${num(this.#margin)} ${num(PAGE_H - top - height)} ${num(this.contentWidth)} ${num(height)} re f`,
        );
      }
      if (style.topRule) {
        this.#page.ops.push(`0.8 w 0.35 0.35 0.35 RG ${num(this.#margin)} ${num(PAGE_H - top)} m ${num(PAGE_W - this.#margin)} ${num(PAGE_H - top)} l S`);
      }
      this.#y = top + pad - 1;
      wrapped.forEach((lines, i) => {
        const saved = this.#y;
        for (const line of lines) {
          this.#drawLine(line, xs[i]! + pad, size, style.bold ?? opts.columns[i]?.bold ?? false, FOREGROUND, opts.columns[i]?.align ?? "left", widths[i]! - 2 * pad);
          this.#y += leading;
        }
        this.#y = saved;
      });
      this.#y = top + height;
      // filet léger sous la ligne
      this.#page.ops.push(`0.4 w 0.85 0.85 0.85 RG ${num(this.#margin)} ${num(PAGE_H - this.#y)} m ${num(PAGE_W - this.#margin)} ${num(PAGE_H - this.#y)} l S`);
    };

    if (opts.header) drawRow(opts.header, { bold: true, fill: [0.93, 0.95, 0.93] });
    rows.forEach((row, i) => {
      const last = opts.totalRow === true && i === rows.length - 1;
      drawRow(row, last ? { bold: true, topRule: true } : {});
    });
    this.#y += 8;
  }

  /** Assemble le fichier. Les pieds de page sont posés ici, quand le nombre de pages est connu. */
  build(): Uint8Array {
    const total = this.#pages.length;
    const label = this.#opts.pageLabel ?? "Page";
    const footerY = this.#margin - 30; // 26 pt du bas de la page avec la marge par défaut
    const pages = this.#pages.map((p, i) => {
      const ops = [...p.ops];
      const gray = "0.45 0.45 0.45 rg";
      if (this.#opts.footer) {
        ops.push(`BT /F1 8 Tf ${gray} ${num(this.#margin)} ${num(footerY)} Td ${hexText(this.#opts.footer)} Tj ET`);
      }
      const right = `${label} ${i + 1} / ${total}`;
      ops.push(`BT /F1 8 Tf ${gray} ${num(PAGE_W - this.#margin - textWidth(right, 8))} ${num(footerY)} Td ${hexText(right)} Tj ET`);
      return ops.join("\n");
    });

    // Objets : 1 catalogue, 2 pages, 3 et 4 polices, 5 informations, puis page + flux par page.
    const objects: string[] = [];
    const kids: string[] = [];
    pages.forEach((_, i) => kids.push(`${6 + i * 2} 0 R`));
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${total} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    const d = this.#opts.date ?? new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    objects[5] =
      `<< /Title ${hexUtf16(this.#opts.title)}` +
      (this.#opts.author ? ` /Author ${hexUtf16(this.#opts.author)}` : "") +
      (this.#opts.subject ? ` /Subject ${hexUtf16(this.#opts.subject)}` : "") +
      ` /Producer ${hexUtf16("Gites Platform")} /CreationDate (${stamp}) >>`;
    pages.forEach((content, i) => {
      const pageObj = 6 + i * 2;
      objects[pageObj] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
      objects[pageObj + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });

    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    for (let n = 1; n < objects.length; n += 1) {
      offsets[n] = out.length;
      out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let n = 1; n < objects.length; n += 1) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    // Chaque caractère de `out` est de code < 256 (le commentaire binaire de
    // l'en-tête est en Latin-1) : un octet par caractère, les décalages tiennent.
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
