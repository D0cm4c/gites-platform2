import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const JS = read("public/book/book.js");
const CSS = read("public/book/book.css");

describe("survol de plage : minimum de nuits visible avant le clic (demande n° 2 du 03/11)", () => {
  it("la plage survolée passe par une teinte « en attente » tant que le minimum de l'arrivée n'est pas atteint", () => {
    // Le survol calcule les nuits et les compare au minimum du jour d'arrivée…
    expect(JS).toMatch(/const nights = nightsBetween\(selIn, cell\.dataset\.date\)/);
    expect(JS).toMatch(/days\.find\(\(x\) => x\.date === selIn\)\?\.minNights/);
    // …et marque la plage « short » tant que le minimum n'est pas couvert.
    expect(JS).toMatch(/\(short \? \["short"\] : \[\]\)/);
    expect(CSS).toMatch(/\.pday\.hover-range\.short\{/);
    expect(CSS).toMatch(/\.pday\.noarr\.hover-range\.short\{/);
  });

  it("le nombre de nuits du séjour s'affiche dynamiquement sur la case d'arrivée pendant le survol", () => {
    // Le prix de la case d'arrivée laisse la place au compte de nuits…
    expect(JS).toMatch(/p\.textContent = pl\(nights, "nuit", "nuits"\)/);
    expect(JS).toMatch(/p\.classList\.add\("live-nights"\)/);
    expect(CSS).toMatch(/\.pday \.p\.live-nights\{font-weight:600\}/);
    // …et revient au nettoyage : rien ne traîne d'un survol à l'autre.
    expect(JS).toMatch(/\.p\.live-nights\"\)/);
    expect(JS).toMatch(/p\.dataset\.orig != null/);
  });

  it("la prévisualisation ne traverse ni les jours pris ni les jours passés", () => {
    expect(JS).toMatch(/c\.classList\.contains\("past"\) \|\| c\.classList\.contains\("full"\)/);
  });

  it("les hachures d'un jour sans arrivée n'écrasent pas la plage survolée", () => {
    expect(CSS).toMatch(/\.pday\.noarr\.hover-range\{background:#E6EFE8/);
  });

  it("le nettoyage porte sur toute la grille, pas seulement la case quittée", () => {
    expect(JS).toMatch(/querySelectorAll\("\.hover-range"\)/);
    expect(JS).toMatch(/classList\.remove\("hover-range", "short"\)/);
  });
});

describe("book.js : aucun identifiant orphelin (coquille d'édition qui plante à l'exécution)", () => {
  it("aucune ligne n'est un identifiant seul suivi d'un commentaire — motif qui passe node --check mais jette ReferenceError", () => {
    // Née d'un vrai bug (03/11) : « n      // place au séjour envisagé » — le
    // gestionnaire mouseenter plantait en silence après les hover-range, le
    // compte de nuits n'apparaissait jamais. node --check valide ce motif ;
    // seul un balayage des lignes l'attrape.
    const suspects = JS.split("\n")
      .map((l, i) => ({ l: i + 1, t: l.trim() }))
      .filter(({ t }) => /^[A-Za-z_$][\w$]*\s*(\/\/.*)?$/.test(t))
      .filter(({ t }) => !/^(use strict|debugger)$/.test(t));
    expect(suspects, JSON.stringify(suspects)).toEqual([]);
  });
});
