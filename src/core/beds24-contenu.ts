// Contenu éditorial envoyé à Beds24 à la création de la propriété (10/10/2026,
// consigne Julien : « reprends ce qu'on avait déjà fait »).
//
// SOURCE. Les textes ci-dessous sont repris mot pour mot des pages vitrine
// (public/la-maison-du-scieur/, public/la-scierie/, public/index.html,
// public/infos-pratiques/). Le Worker ne lit pas ces fichiers HTML à
// l'exécution (assets servis à part, absents des tests) : ils sont recopiés
// ici. Une page vitrine réécrite doit être répercutée ici, puis dans Beds24.
// Repli : `units.description` quand elle ne porte pas de TODO.
//
// ÉQUIPEMENTS. Codes Beds24 (« featureCodes ») pris dans la liste publiée par
// Beds24 (wiki.beds24.com, Airbnb Mapping › All feature codes — l'apiV2.yaml
// ne les énumère pas). On n'envoie QUE ce que nos textes affirment. Ce qui est
// payant en supplément (bain chaud, sauna, four à pain) n'est pas déclaré comme
// équipement inclus : sur Airbnb, un équipement listé est réputé compris.

export interface UnitContent {
  description: string;
  /** Lignes « featureCodes » Beds24 : un tableau par ligne (équipements,
   *  salles d'eau, chambres). Forme de apiV2.yaml : tableau de tableaux. */
  featureCodes: string[][];
  /** Capacité saisie à la main dans Beds24 (prime sur la base). */
  capacite?: number;
  /** Équipements de nos textes sans code Beds24 sûr, ou volontairement non
   *  envoyés : à saisir à la main dans Beds24. */
  aCompleter: string[];
}

const SUPPLEMENTS =
  "Bain chaud, sauna et four à pain : sur le domaine, en supplément — pas de code Beds24 « payant » : à décrire dans les textes de l'annonce ou en extra";

export const UNIT_CONTENT: Record<string, UnitContent> = {
  "maison-du-scieur": {
    description: [
      "Constituée de quatre chambres, de deux douches, d'une salle de bain et d'un grand salon, La Maison du Scieur est naturellement destinée aux grands groupes. La cuisinière de restaurant et la salle à manger de douze places soulignent cette qualité : on y cuisine pour tout le monde, et tout le monde s'assied en même temps.",
      "Les bois de bardage et de construction proviennent des épicéas qui ont poussé sur le terrain entre 1945 et 1992, quand la scierie était désaffectée. La maison est classée gîte rural par la Communauté Française, et gîte PANDA par le WWF.",
      "Le domaine n'est pas raccordé au réseau électrique : l'électricité vient de la roue hydraulique alimentée par le ruisseau, et l'eau d'une source voisine.",
      "Équipements : 4 chambres, 2 douches + 1 salle de bain, grand salon, cuisinière de restaurant, salle à manger de 12 places, mezzanine, poêle à bois dans la salle à manger, feu extérieur. Ménage et charges compris dans les frais généraux.",
      "Home cinéma avec projecteur et système son.",
      "Matelas d'appoint possible sur demande.",
      "Sur le domaine, en supplément : le bain chaud, le sauna, le four à pain et les promenades.",
    ].join("\n\n"),
    capacite: 11,
    featureCodes: [
      ["KITCHEN", "DINING_TABLE", "LIVING_ROOM", "HEATING", "FIRE_PIT", "PETS_CONSIDERED", "WIFI", "PARKING_INCLUDED", "SMOKING_NOT_ALLOWED", "DISHES_UTENSILS", "DISHWASHER", "REFRIGERATOR", "TV", "STEREO"],
      [],
      ["BATHROOM_SHOWER", "BATH_SHOWER"],
      ["BATHROOM_SHOWER", "BATH_SHOWER"],
      ["BATHROOM"],
      ["BEDROOM", "BED_DOUBLE"],
      ["BEDROOM", "BED_DOUBLE"],
      ["BEDROOM", "BED_DOUBLE"],
      ["BEDROOM", "BED_SINGLE", "BED_SINGLE", "BED_SINGLE", "BED_SINGLE"],
      ["BEDROOM", "BED_SINGLE"],
    ],
    aCompleter: [
      "Poêle à bois : pas de code dédié (FIREPLACE = feu ouvert)",
      SUPPLEMENTS,
    ],
  },
  "la-scierie": {
    description: [
      "La Scierie abrite en son sein la mini-centrale électrique du domaine. Elle dispose de deux chambres séparées, d'une mezzanine, d'une salle de bain et d'une douche. C'est une maison accueillante, qui invite à se réfugier devant le feu ouvert quand le temps se gâte — et le temps se gâte volontiers en Ardenne.",
      "C'est le bâtiment d'origine : fondé en 1674 comme scierie hydraulique par Arnold d'Hoffschmidt, alors surintendant pour le duc d'Aremberg, restauré en 1992 dans un esprit de respect de la nature. La terrasse en bois ouvre plein sud sur la vallée boisée.",
      "La roue à augets qui alimente la maison est la même qui alimente le domaine : ici, la centrale électrique fait partie du salon.",
      "Équipements : 2 chambres + mezzanine, 1 salle de bain + 1 douche, salon et cuisine ouverts, feu ouvert, mini-centrale hydraulique intégrée, terrasse en bois plein sud, vue sur le ruisseau, charpente et lambris d'origine. Ménage et charges compris dans les frais généraux.",
      "Home cinéma avec projecteur et système son.",
      "Sur le domaine, en supplément : le bain chaud, le sauna, le four à pain et les promenades.",
    ].join("\n\n"),
    capacite: 8,
    featureCodes: [
      ["KITCHEN", "LIVING_ROOM", "FIREPLACE", "HEATING", "WATER_VIEW", "PETS_CONSIDERED", "WIFI", "PARKING_INCLUDED", "SMOKING_NOT_ALLOWED", "DISHES_UTENSILS", "DISHWASHER", "REFRIGERATOR", "TV", "STEREO"],
      [],
      ["BATHROOM"],
      ["BATHROOM_SHOWER", "BATH_SHOWER"],
      ["BEDROOM", "BED_DOUBLE"],
      ["BEDROOM", "BED_DOUBLE"],
      ["BEDROOM", "BED_SINGLE", "BED_SINGLE", "BED_SINGLE", "BED_SINGLE"],
    ],
    aCompleter: [
      "Terrasse en bois plein sud : pas de code « terrasse » dans la liste Beds24",
      SUPPLEMENTS,
    ],
  },
};

export const PROPERTY_DESCRIPTION =
  "Fondé en 1674, autonome en énergie. Deux gîtes d'exception classés PANDA par le WWF, au cœur de la nature ardennaise, au confluent du ruisseau de l'Eau Bue et du Ry des Glands. La propriété fait 6 ha. Deux maisons : La Maison du Scieur (11 personnes) et La Scierie (6 à 8 personnes).";

/** featureCodes au niveau de la propriété : une ligne, saisie à la main dans
 *  Beds24 les 10 et 11/10/2026 (source de vérité, reprise telle quelle). */
export const PROPERTY_FEATURE_CODES: string[][] = [
  ["WIFI", "PARKING_INCLUDED", "PETS_CONSIDERED", "SMOKING_NOT_ALLOWED", "KITCHEN", "DISHES_UTENSILS", "DISHWASHER", "REFRIGERATOR", "TV", "STEREO"],
];

export const HOUSE_RULES = [
  "Étant donné le caractère ouvert de la propriété, aucun chien n'est toléré sans être tenu en laisse autour du moulin.",
  "Période de chasse du 1er octobre au 31 décembre : rester sur les chemins.",
  "Les déchets sont triés. Les voyageurs reprennent avec eux le verre, le papier-carton et les PMC ; le compost sur place accueille les déchets organiques.",
].join("\n");

/** Adresse publique du domaine, telle que la publient les pages vitrine
 *  (données structurées JSON-LD de public/la-maison-du-scieur/ et
 *  public/la-scierie/). Prime sur `properties.address`, champ libre. */
export const ADRESSE_VITRINE: Record<string, { address: string; postcode: string; city: string; state: string; phone: string }> = {
  "pre-more": {
    address: "Hameau du Pré Moré",
    postcode: "6890",
    city: "Redu",
    state: "Luxembourg",
    phone: "+32498440883",
  },
};

/** Contenu d'une unité : la page vitrine d'abord, sinon sa description en base. */
export function unitContent(slug: string, dbDescription: string | null): UnitContent | null {
  const known = UNIT_CONTENT[slug];
  if (known) return known;
  const d = (dbDescription ?? "").trim();
  if (!d || /TODO/i.test(d)) return null;
  return { description: d, featureCodes: [], aCompleter: [] };
}
