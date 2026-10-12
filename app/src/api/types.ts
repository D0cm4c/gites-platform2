// Formes des réponses de l'API admin utilisées par le pilote (sous-ensemble).
export type IsoDate = string;

export interface Property {
  id: number;
  slug: string;
  name: string;
  commune: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

export interface Unit {
  id: number;
  propertyId: number;
  name: string;
  capacityBase: number;
  capacityMax: number;
  isComposite: boolean;
  compositePricing: "own" | "sum";
  active: boolean;
  sortOrder: number;
  cleaningFeeCents: number;
}

export interface UnitLink {
  unitId: number;
  blocksUnitId: number;
}

export interface PlanningBooking {
  id: number;
  reference: string;
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  status: "pending" | "confirmed" | "cancelled";
  source: "direct" | "manual" | "ical" | "import";
  channelLabel: string | null;
  guestName: string;
  persons: number;
  isComposite: boolean;
  paidState: "n/a" | "soldée" | "acompte" | "impayée";
  balanceCents: number;
}

export interface PlanningLinkBlock {
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  sourceBookingId: number;
  sourceReference: string;
}

export interface ManualBlock {
  id: number;
  unitId: number;
  checkin: IsoDate;
  checkout: IsoDate;
  reason: string | null;
}

export interface Planning {
  from: IsoDate;
  to: IsoDate;
  units: { id: number; name: string; isComposite: boolean; active: boolean }[];
  bookings: PlanningBooking[];
  blocks: PlanningLinkBlock[];
  manualBlocks: ManualBlock[];
}

export interface OverviewBalance {
  id: number;
  reference: string;
  unitName: string;
  guestName: string | null;
  checkin: IsoDate;
  checkout: IsoDate;
  balanceCents: number;
  balanceDueDate: IsoDate | null;
  overdue: boolean;
}

export interface Overview {
  property: { id: number; name: string };
  today: IsoDate;
  kpis: {
    balanceDueTotalCents: number;
    balanceDueCount: number;
    monthLabel?: string;
    occupancyPct?: number;
    occupancyPrevPct?: number;
    revenueCents?: number;
    revenuePrevCents?: number;
    nextArrival?: { checkin: IsoDate; unitName: string; persons: number; guestName: string | null } | null;
  };
  movements?: { kind: "arrivée" | "départ"; id: number; reference: string; unitName: string; guestName: string | null; checkin: IsoDate; checkout: IsoDate; persons: number; status: string }[];
  alerts: {
    overdueBalances: OverviewBalance[];
    linkAlerts?: { id: number; unitName: string; checkin: IsoDate; checkout: IsoDate; blocked: string[] }[];
    activeHolds: { id: number; reference: string; unitName: string; holdExpiresAt: string | null }[];
    newEmails: number;
    feedAlerts?: { id: number; name: string; status: string | null }[];
  };
  health?: {
    orphanPayments: { reference: string; bookingId: number; amountCents: number; bookingStatus: string }[];
    overpaidBookings: { reference: string; bookingId: number; overpaidCents: number }[];
    failedEmails: { bookingId: number | null; reference: string | null; kind: string; toEmail: string; errorDetail: string | null }[];
    recentErrors: { action: string; entity: string | null; createdAt: string }[];
    beds24Stale: boolean;
    beds24StaleHours: number | null;
    drift: { kind: string; label: string; detail: string; href: string }[];
    ok: boolean;
  };
}

export interface DayRate {
  date: IsoDate;
  priceCents: number | null;
  source: string | null;
  minNights: number | null;
  weekend: boolean;
  holidayRated: boolean;
  fallbackPriceCents: number | null;
  overridePriceCents: number | null;
  overrideMinNights: number | null;
  seasonName?: string | null;
}

export interface RateCalendarUnit {
  unit: { id: number; name: string; editable: boolean; priceMinCents: number | null; priceMaxCents: number | null };
  days: DayRate[];
}

export interface Booking {
  id: number;
  reference: string;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  guestId: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  status: "pending" | "confirmed" | "cancelled";
  holdExpiresAt: string | null;
  source: "direct" | "manual" | "ical" | "import";
  channelLabel: string | null;
  totalCents: number;
  depositCents: number;
  paidCents: number;
  balanceDueDate: IsoDate | null;
  internalNotes: string | null;
  guestNotes: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface Payment {
  id: number;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  receivedAt: string | null;
  createdAt: string;
  note: string | null;
}

export interface EmailLog {
  id: number;
  kind: string;
  subject: string;
  toEmail?: string | null;
  status: string;
  errorDetail?: string | null;
  /** Pièces jointes parties avec le mail (le PDF de la confirmation). */
  attachments?: { filename: string; bytes: number }[];
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  createdAt: string;
  actor: string;
  detail?: string | null;
}

export interface BookingDetail {
  booking: Booking;
  payments: Payment[];
  emails: EmailLog[];
  history: AuditEntry[];
  quote: { lines?: QuoteLine[]; totalCents?: number } | null;
}

export interface Guest {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string;
  phone: string | null;
}

export interface QuoteLine {
  kind: string;
  label: string;
  publicLabel?: string;
  amountCents: number;
}

export interface Quote {
  ok: boolean;
  errors: string[];
  nights: number;
  minNights: number;
  checkinDays: number[] | null;
  lines: QuoteLine[];
  totalCents: number;
  depositCents: number;
  depositPct: number;
  balanceCents: number;
  balanceDueDate: IsoDate | null;
}

export interface QuoteResponse {
  unit: { id: number; name: string };
  quote: Quote;
  availability: { available: boolean; conflicts: { reference: string; unitName?: string }[] };
}

export interface Message {
  id: number;
  propertyId: number | null;
  direction: "in" | "out";
  /** 'beds24' : message d'un canal OTA (Airbnb, Booking…) relevé par Beds24 — cf. canaux/canal.ts. */
  channel: "email" | "form" | "beds24";
  /** Nom du canal d'un message 'beds24' (« Airbnb »), sinon null. */
  canal?: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string;
  bodyText: string;
  bookingId: number | null;
  bookingReference: string | null;
  guestId: number | null;
  status: "nouveau" | "traité";
  receivedAt: string;
  /** Pièces jointes d'un mail, listées à la relève (jamais stockées) ; taille null = message coupé. */
  attachments?: { name: string; size: number | null }[];
  /** Mail qui se réclame de l'adresse des gîtes sans que Gmail l'atteste : à ne pas croire. */
  spoofed?: boolean;
}

export interface GuestRegisterInfo {
  entries?: unknown[];
}

// --- lot 2 : ménage, modèles, liens de partage ------------------------------------

export interface Task {
  id: number;
  propertyId: number;
  unitId: number;
  unitName: string;
  isComposite: boolean;
  bookingId: number | null;
  kind: "menage" | "autre";
  dueDate: IsoDate;
  dueTime: string | null;
  nextCheckin: IsoDate | null;
  nextCheckinTime: string | null;
  nextUnitId: number | null;
  nextUnitName: string | null;
  nextPersons: number | null;
  status: "a_faire" | "fait" | "annule";
  assignee: string | null;
  note: string | null;
  doneAt: string | null;
  doneBy: string | null;
  updatedAt: string;
}

export interface TaskShareLink {
  id: number;
  label: string;
  propertyId: number | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface MessageTemplate {
  id: number;
  propertyId: number | null;
  name: string;
  lang: "fr" | "nl" | "en";
  body: string;
  sortOrder: number;
  active: boolean;
  updatedAt: string;
}
