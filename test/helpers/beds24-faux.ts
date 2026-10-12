// Faux Beds24 pour les lignes de prix (priceRules) des chambres : garde un état
// par chambre, répond à GET /properties?includePriceRules=true et à
// POST /properties, et VALIDE chaque ligne envoyée contre le schéma extrait de
// https://api.beds24.com/v2/apiV2.yaml (test/fixtures/beds24-priceRules.schema.json),
// en mode strict : un champ inconnu, un type faux ou une borne dépassée est
// refusé comme Beds24 le ferait (élément `success: false` dans une réponse 201).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
interface Schema { type?: string; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; minimum?: number; maximum?: number; nullable?: boolean }

export const PRICE_RULE_SCHEMA = (JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/beds24-priceRules.schema.json", import.meta.url)), "utf8")) as { schema: Schema }).schema;

/** Écarts d'une valeur au schéma (sous-ensemble OpenAPI 3.0 utilisé par apiV2.yaml). */
export function validate(schema: Schema, value: unknown, path = ""): string[] {
  if (value === null) return schema.nullable ? [] : [`${path} : null interdit`];
  const t = schema.type;
  if (t === "integer" && !(typeof value === "number" && Number.isInteger(value))) return [`${path} : entier attendu`];
  if (t === "number" && typeof value !== "number") return [`${path} : nombre attendu`];
  if (t === "string" && typeof value !== "string") return [`${path} : texte attendu`];
  if (t === "boolean" && typeof value !== "boolean") return [`${path} : booléen attendu`];
  if (t === "array" && !Array.isArray(value)) return [`${path} : tableau attendu`];
  if (t === "object" && (typeof value !== "object" || Array.isArray(value))) return [`${path} : objet attendu`];
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path} : valeur hors liste`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) out.push(`${path} : sous ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${path} : au-dessus de ${schema.maximum}`);
  }
  if (t === "array" && schema.items) (value as unknown[]).forEach((v, i) => out.push(...validate(schema.items!, v, `${path}[${i}]`)));
  if (t === "object" && schema.properties) {
    for (const [k, v] of Object.entries(value as Json)) {
      const sub = schema.properties[k];
      if (!sub) out.push(`${path}.${k} : champ inconnu`);
      else out.push(...validate(sub, v, `${path}.${k}`));
    }
  }
  return out;
}

export const DEFAULT_RULE_1: Json = {
  id: 1, name: "Prix 1", priceFor: { type: "maxCapacity" }, minimumStay: 2,
  channels: { airbnb: { enabled: true }, booking: { enabled: true }, vrbo: { enabled: true } },
};

export class FauxBeds24 {
  /** propriété → chambres → lignes de prix (forme de la réponse GET). */
  props = new Map<number, Map<number, Json[]>>();
  /** Refus « métier » d'un élément POST (null = accepté). Forme libre : c'est l'élément de réponse. */
  refuser: ((propertyId: number, element: Json) => Json | null) | null = null;
  /** Refus APRÈS application de la première chambre seulement (refus partiel, issue inconnue). */
  partialRefusal: ((propertyId: number) => Json | null) | null = null;
  /** Panne de lecture (GET /properties) pour cette propriété. */
  readFails = new Set<number>();

  seed(propertyId: number, roomIds: number[], rules: Json[] = [DEFAULT_RULE_1]): void {
    const rooms = new Map<number, Json[]>();
    for (const r of roomIds) rooms.set(r, structuredClone(rules));
    this.props.set(propertyId, rooms);
  }

  rules(roomId: number): Json[] {
    for (const rooms of this.props.values()) if (rooms.has(roomId)) return rooms.get(roomId)!;
    return [];
  }

  get(query: URLSearchParams): Response {
    const ids = query.getAll("id").map(Number);
    if (ids.some((id) => this.readFails.has(id))) return new Response(JSON.stringify({ success: false, error: "lecture refusée par le faux Beds24" }), { status: 400 });
    const data = ids.filter((id) => this.props.has(id)).map((id) => ({
      id,
      roomTypes: [...this.props.get(id)!].map(([roomId, rules]) => ({ id: roomId, ...(query.get("includePriceRules") === "true" ? { priceRules: structuredClone(rules) } : {}) })),
    }));
    return new Response(JSON.stringify({ success: true, type: "property", data }), { status: 200 });
  }

  post(body: unknown): Response {
    const out = (body as Json[]).map((el) => this.postOne(el));
    return new Response(JSON.stringify(out), { status: 201 });
  }

  private postOne(el: Json): Json {
    const pid = el.id as number;
    const rooms = this.props.get(pid);
    if (!rooms) return { success: false, errors: [{ action: "modify", field: "id", message: "property not found" }] };
    const errors: Array<{ action: string; field: string; message: string }> = [];
    for (const rt of (el.roomTypes as Json[] | undefined) ?? []) {
      if (!rooms.has(rt.id as number)) errors.push({ action: "modify", field: "roomTypes.id", message: "room not found" });
      for (const [i, r] of ((rt.priceRules as Json[] | undefined) ?? []).entries()) {
        for (const e of validate(PRICE_RULE_SCHEMA, r, `roomTypes.priceRules[${i}]`)) errors.push({ action: "modify", field: e.split(" : ")[0]!, message: e.split(" : ")[1]! });
        const pl = r.priceLinking as Json | undefined;
        if (pl && pl.priceId != null && pl.priceId === r.id && (pl.roomId == null || pl.roomId === rt.id)) errors.push({ action: "modify", field: "priceLinking", message: "price cannot be linked to itself" });
      }
    }
    if (errors.length) return { success: false, errors };
    const refused = this.refuser?.(pid, el);
    if (refused) return refused;
    const partial = this.partialRefusal?.(pid) ?? null;
    for (const rt of ((el.roomTypes as Json[] | undefined) ?? []).slice(0, partial ? 1 : undefined)) {
      const list = rooms.get(rt.id as number)!;
      for (const r of (rt.priceRules as Json[] | undefined) ?? []) {
        let cur = list.find((x) => x.id === r.id);
        if (!cur) {
          cur = { id: r.id };
          list.push(cur);
          list.sort((a, b) => (a.id as number) - (b.id as number));
        }
        for (const [k, v] of Object.entries(r)) {
          if (k === "channels") {
            const ch = (cur.channels ?? {}) as Json;
            for (const [c, s] of Object.entries(v as Json)) ch[c] = { ...((ch[c] as Json) ?? {}), ...(s as Json) };
            cur.channels = ch;
          } else if (k === "priceLinking") {
            const p = v as Json;
            if (p.priceId == null) delete cur.priceLinking;
            else cur.priceLinking = { roomId: null, offsetMultiplier: 1, offsetAmount: 0, ...p };
          } else if (k !== "id") cur[k] = v;
        }
      }
    }
    if (partial) return partial;
    return { success: true, modified: { id: pid } };
  }
}
