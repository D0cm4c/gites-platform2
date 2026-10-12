// Rendu des conditions générales stockées en base (issue #3).
//
// Le texte est stocké en TEXTE BRUT, sans balisage : c'est la même chaîne qui
// est hachée comme preuve d'acceptation et jointe en clair au mail de
// confirmation. Le seul enrichissement fait ici est typographique — titre du
// document et lignes « Article N » en gras, paragraphes séparés — et il est
// appliqué APRÈS échappement : le contenu de la base ne sert jamais de source
// HTML, même si quelqu'un colle du markup dans le back-office.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function cgvHtml(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const html = esc(block).replace(/\n/g, "<br>");
      return /^(Article \d+|CONDITIONS GÉNÉRALES|Comment ça se passe$)/.test(block)
        ? `<p class="cgv-h"><b>${html}</b></p>`
        : `<p>${html}</p>`;
    })
    .join("");
}
