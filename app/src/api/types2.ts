// Formes des réponses de l'API admin lues par les écrans du lot 1 (réglages,
// tarifs, plateformes, journaux). Mêmes routes que l'ancien /admin/.
import type { IsoDate } from "./types";

export interface PropertyFull {
  id: number;
  slug: string;
  name: string;
  address: string | null;
  commune: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  beds24PropertyId: number | null;
}

export interface UnitFull {
  id: number;
  propertyId: number;
  name: string;
  description: string | null;
  capacityBase: number;
  capacityMax: number;
  isComposite: boolean;
  compositePricing: "own" | "sum";
  active: boolean;
  sortOrder: number;
  cleaningFeeCents: number;
  photoUrl: string | null;
  beds24RoomId: number | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  depositPct: number | null;
}

export interface FullSettings {
  depositPct: number;
  balanceDueDays: number;
  holdMinutes: number;
  touristTaxCentsPerPersonNight: number;
  touristTaxIncludeChildren: boolean;
  cautionCents: number;
  checkinTime: string;
  checkoutTime: string;
  cgvText: string;
  allowDeposit: boolean;
  allowFullPayment: boolean;
  autoReplyEnabled: boolean;
  autoReplyText: string;
  emailForwardTo: string;
}

export interface Season {
  id: number;
  name: string;
  dateStart: IsoDate;
  dateEnd: IsoDate;
  priority: number;
}

export interface RateRule {
  id: number;
  unitId: number;
  unitName?: string;
  seasonId: number | null;
  priceWeekCents: number;
  priceWeekendCents: number;
  holidayPct: number;
  minNights: number;
  checkinDays: number[] | null;
}

export interface RateOverride {
  unitId: number;
  date: IsoDate;
  priceCents: number | null;
  minNights: number | null;
}

export interface Promotion {
  id: number;
  kind: "code" | "long_stay" | "early_bird" | "last_minute";
  code: string | null;
  label: string;
  discountPct: number | null;
  discountCents: number | null;
  threshold: number | null;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
}

export type PricingMode = "per_stay" | "per_night" | "per_person" | "per_person_night" | "per_unit_qty";

export interface OptionRow {
  id: number;
  name: string;
  pricingMode: PricingMode;
  priceCents: number;
  unitLabel: string | null;
  maxQty: number | null;
  active: boolean;
  sortOrder: number;
}

export interface GuestRow {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string;
  phone: string | null;
  address: string | null;
  country: string | null;
  lang: string;
  notes: string | null;
  createdAt: string;
  bookingsCount?: number;
  totalSpentCents?: number;
}

export interface PaymentRow {
  id: number;
  bookingId: number;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  outcome: "expired" | "superseded" | null;
  note: string | null;
  receivedAt: string | null;
  createdAt: string;
  bookingReference?: string;
}

export interface MonthStat {
  month: number;
  occupiedNights: number;
  capacityNights: number;
  occupancyPct: number;
  revenueCents: number;
}

export interface YearStats {
  year: number;
  months: MonthStat[];
  occupancyPct: number;
  revenueCents: number;
  adrCents: number;
  avgStayNights: number;
  bookingsCount: number;
  soldNights: number;
  perUnit: { unitId: number; name: string; nights: number; revenueCents: number }[];
}

export interface LeadGroup {
  key: number;
  label: string;
  count: number;
  avgDays: number;
  medianDays: number;
}

export interface StatsResponse {
  current: YearStats;
  previous: YearStats;
  leadTime?: { count: number; avgDays: number; medianDays: number; byMonth: LeadGroup[]; byUnit: LeadGroup[] };
  funnel?: { steps: { key: string; label: string; count: number; fromPreviousPct: number | null }[]; biggestDropKey: string | null };
  searches?: { topEmpty: { checkin: IsoDate; checkout: IsoDate; nights: number; maxPersons: number; count: number }[] };
}

export interface IcalFeed {
  id: number;
  unitId: number;
  unitName?: string;
  name: string;
  url: string;
  active: boolean;
  departureDayIncluded: boolean;
  lastSyncAt: string | null;
  lastStatus: string | null;
}

export interface IcalResponse {
  feeds: IcalFeed[];
  exports: { unitId: number; unitName: string; url: string }[];
}

export interface FeedSyncResult {
  error?: string;
  imported: number;
  updated: number;
  cancelled: number;
  conflicts: unknown[];
}

export interface AdminUser {
  id: number;
  username: string;
  active: number | boolean;
  created_at: string;
  last_login_at: string | null;
  sessions: number;
}

export interface ChecklistItem {
  id: number;
  section: string;
  label: string;
  owner: "papa" | "julien" | "claude";
  status: "a_faire" | "en_cours" | "fait" | "verifie" | "n_a";
  note: string | null;
  url: string | null;
  sortOrder: number;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  detail: string | null;
  createdAt: string;
}

export interface EmailLogRow {
  id: number;
  bookingId: number | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  kind: string;
  status: string;
  errorDetail: string | null;
  createdAt: string;
}

export interface SyncConflict {
  id: number;
  source: "beds24" | "ical";
  kind: string;
  status: "open" | "ignored" | "resolved";
  unitId: number;
  unitName: string;
  checkin: IsoDate;
  checkout: IsoDate;
  bookingReference: string | null;
  channelLabel: string | null;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  ignoreReason: string | null;
}

export interface ChannelsOverview {
  configured: boolean;
  webhookUrl: string | null;
  property: { id: number; name: string; beds24PropertyId: number | null } | null;
  units: { id: number; name: string; isComposite: boolean; beds24RoomId: number | null }[];
  channelBookings: { reference: string; unitName: string; channelLabel: string | null; checkin: IsoDate; checkout: IsoDate; status: string; totalCents: number; guestName: string | null }[];
  lastPull: string | null;
  events: AuditRow[];
  conflicts: SyncConflict[];
}

export interface ChannelMarkup {
  channel: string;
  label: string;
  markupPct: number;
}

export interface MarkupState {
  channels: ChannelMarkup[];
  examples: { channel: string; label: string; markupPct: number; suggestedCents: number }[];
  formula: string;
  maxPct: number;
  pushChannel: string | null;
  pushMarkupPct: number;
  example: { directCents: number; pushedCents: number };
}

export interface Beds24Status {
  connected: boolean;
  properties?: { id: number; name: string }[];
  error?: string;
}

export interface RegisterEntry {
  id: number;
  lastName: string;
  firstName: string;
  birthDate: IsoDate;
  nationality: string;
  idType: string;
  idNumber: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  recordedBy: string | null;
  recordedAt: string | null;
  supersedesId: number | null;
  supersededById: number | null;
}

export interface RegisterResponse {
  entries: RegisterEntry[];
  idTypes: { value: string; label: string }[];
  prefill: { firstName: string; lastName: string; nationality: string; arrivalDate: IsoDate; departureDate: IsoDate; occupants: number };
  retentionYears: number;
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  imported: number;
  conflicts: number;
  errors: number;
  skipped: number;
  rows: { line: number; status: string; reference?: string; message?: string }[];
}

export interface Photo {
  id: number;
  path: string;
  alt: string;
  caption: string | null;
  active: boolean;
}

// --- lot 3 : promotions Airbnb, prix dérivés, avis -------------------------------

export interface AirbnbPromotions {
  weeklyPct: number;
  biweeklyPct: number;
  monthlyPct: number;
  earlyBirdDays: number | null;
  earlyBirdPct: number;
  lastMinuteDays: number | null;
  lastMinutePct: number;
  nonRefundablePct: number;
}

export interface AirbnbPreview {
  stayCents: number;
  nights: number;
  markupPct: number;
  airbnbCents: number;
  lengthPct: number;
  withLengthCents: number;
  nonRefundableCents: number | null;
  earlyBirdCents: number | null;
  lastMinuteCents: number | null;
}

export interface Beds24WriteState {
  configured: boolean;
  writesAllowed: boolean;
  reason: string | null;
}

export interface AirbnbPromotionsState {
  propertyId: number;
  promotions: AirbnbPromotions;
  earlyBirdDays: number[];
  markupPct: number;
  markupSource: string;
  preview: AirbnbPreview;
  beds24: Beds24WriteState & { linked: boolean; rooms: number };
  lastSent: { at: string; by: string } | null;
  sentSame: boolean;
}

export interface PriceLinkingState {
  enabled: boolean;
  lines: { channel: string; label: string; beds24Channel: string; markupPct: number; multiplier: number; priceId: number; exampleCents: number }[];
  unlinked: string[];
  exampleDirectCents: number;
  pushChannel: string | null;
  pushPct: number;
  upToDate: boolean;
  sentAt: string | null;
  beds24: Beds24WriteState & { linked: number };
}

export interface ReviewItem {
  id: number;
  channel: "airbnb" | "booking";
  rating: number | null;
  rawScore: number | null;
  rawScale: number;
  reviewerName: string | null;
  headline: string | null;
  body: string | null;
  negative: string | null;
  replied: boolean;
  submittedAt: string | null;
  unitName: string | null;
}

export interface ReviewsSummary {
  count: number;
  average: number | null;
  byChannel: { channel: string; count: number; average: number | null }[];
  latest: ReviewItem[];
  low: ReviewItem[];
  replyUrl: string;
  lowScore: number;
}

// --- Beds24 : création de la propriété (PR #104, portée de l'ancien écran) ---
export type MappingEtat = "absent" | "actif" | "perime" | "inconnu";
export interface Beds24Liaison {
  connected: boolean;
  error?: string;
  compte?: { id: number | null; appareil?: string | null; scopes: string[]; limiteAPropriete?: number | null };
  properties?: { id: number; name: string; roomTypes?: { id: number; name: string }[] }[];
  ecritureAutorisee: boolean;
  ecriturePropriete: boolean | null;
  jetonRestreint: boolean;
  mapping: {
    propertyId: number;
    propertyName: string;
    beds24PropertyId: number | null;
    etat: MappingEtat;
    rooms: { unitId: number; unitName: string; beds24RoomId: number | null; etat: MappingEtat }[];
    homonyme: { id: number; name: string } | null;
  } | null;
  mappingARefaire: boolean;
  contenuPrepare: boolean;
  contenuEnAttente: boolean;
  creationPossible: boolean;
}
export interface Beds24PropertyPlan {
  propertyId: number;
  name: string;
  currency: string;
  address?: string;
  city?: string;
  country: string;
  checkInStart?: string;
  checkOutEnd?: string;
  rooms: { unitId: number; name: string; maxPeople: number; minStay?: number; rackRate?: number; cleaningFee?: number; description?: string; featureCodes: string[][]; photos: { url: string; legende: string }[] }[];
  directOnly: { unitId: number; name: string; raison: string }[];
  aCompleter: string[];
}
export interface Beds24Creation {
  ok: true;
  propriete: { beds24PropertyId: number; name: string; creee: boolean };
  rooms: { unitId: number; name: string; beds24RoomId: number; creee: boolean }[];
  envoye: { propriete: string[]; rooms: { name: string; champs: string[] }[] };
  contenu: { ok: boolean; erreur?: string };
  aCompleter: { propriete: string[]; rooms: { unitId: number; name: string; points: string[]; photos: { url: string; legende: string }[] }[] };
  avertissements: string[];
}

// --- Accès de service (PR #105) ---
export interface ServiceKey {
  id: number;
  name: string;
  keyHint: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Réglages › Comptes Stripe : l'état d'une propriété. Aucune clé en clair, jamais. */
export interface StripeKeyState {
  set: boolean;
  setAt: string | null;
  /** « …ab12 » : les quatre derniers caractères, pour reconnaître la clé. */
  hint: string | null;
}
export interface StripeProperty {
  propertyId: number;
  name: string;
  slug: string;
  mode: "test" | "live";
  accountLabel: string | null;
  secret: StripeKeyState;
  publishable: StripeKeyState;
  webhook: StripeKeyState;
  /** Ce que le serveur utilise vraiment : les clés de la propriété, le repli (environnement), ou rien (simulateur). */
  effective: "property" | "env" | "none";
  webhookPath: string;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface StripeSettings {
  baseUrl: string;
  events: string[];
  envFallback: { secret: boolean; publishable: boolean; webhook: boolean; mode: "test" | "live" | null };
  properties: StripeProperty[];
}

export interface Encaissement {
  paymentId: number;
  receivedAt: string;
  bookingId: number;
  bookingReference: string;
  kind: string;
  amountCents: number;
  feeCents: number | null;
  netCents: number | null;
  status: string;
  stripeRef: string | null;
}
export interface EncaissementMonth {
  month: string;
  count: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  unknownFees: number;
}
export interface EncaissementsReport {
  propertyId: number;
  rows: Encaissement[];
  months: EncaissementMonth[];
  totals: { count: number; grossCents: number; feeCents: number; netCents: number; unknownFees: number };
}
