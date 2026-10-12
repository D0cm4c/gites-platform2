// Typage de l'environnement du Worker (bindings wrangler.jsonc + secrets).
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL: string;
  EMAILS_ENABLED?: string;
  // Secrets (.dev.vars en local, wrangler secret en prod) — tous optionnels :
  // absents = mode stub (paiement simulé, emails journalisés uniquement).
  // Clés Stripe de REPLI : un compte Stripe par propriété (table property_stripe,
  // Réglages > Comptes Stripe). Ces variables ne servent qu'aux propriétés sans clés propres.
  STRIPE_SECRET_KEY?: string;
  /** Clé publique Stripe (pk_test_… / pk_live_…) — confiée au navigateur pour
   *  monter le Payment Element. Absente = repli sur Checkout hébergé. */
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** `checkout` force le retour à la page de paiement hébergée. Toute autre
   *  valeur (ou l'absence) = Payment Element intégré, le défaut. */
  STRIPE_UI?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ADMIN_TOKEN?: string;
  /** Refresh token API v2 Beds24 (canal OTA) — absent = intégration OFF. */
  BEDS24_REFRESH_TOKEN?: string;
  /** Clé secrète du webhook entrant Beds24 (/api/webhooks/beds24?key=…). */
  BEDS24_WEBHOOK_KEY?: string;
  /** Clé PUBLIQUE du widget Cloudflare Turnstile (issue #6). Exposée telle
   *  quelle par /api/public/today. Absente = anti-robot désactivé. */
  TURNSTILE_SITE_KEY?: string;
  /** Clé SECRÈTE Turnstile (`wrangler secret put`). Absente = anti-robot
   *  désactivé : les deux clés vont ensemble, cf. services/turnstile.ts. */
  TURNSTILE_SECRET_KEY?: string;
  /** Autorise les ÉCRITURES vers Beds24 (compte réel, pas de bac à sable).
   *  Seule la valeur "true" autorise (fermé par défaut) — cf. beds24WritesAllowed(). */
  BEDS24_WRITE_ENABLED?: string;
  /** Mails par SMTP (Infomaniak, site Node seulement) : actif quand les quatre
   *  SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM sont posés, EMAILS_ENABLED
   *  vaut "true" et que node/server.mjs a fourni SMTP_SEND. Prime sur Resend. */
  SMTP_HOST?: string;
  /** 465 (TLS direct, le défaut) ou 587 (STARTTLS obligatoire). */
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  /** Expéditeur, « Nom <adresse> » ; sur Node, remplace RESEND_FROM. */
  MAIL_FROM?: string;
  /** Transport SMTP injecté par node/server.mjs (node:net/node:tls, absent sur
   *  Workers, dont le runtime n'ouvre pas de socket SMTP sortante). */
  SMTP_SEND?: (mail: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string | null;
    references?: string | null;
    attachments?: { filename: string; contentType: string; content: Uint8Array }[];
  }) => Promise<{ id: string }>;
  /** Relève de la boîte de contact (IMAP, Gmail « mot de passe d'application ») : actif quand
   *  IMAP_USER et un mot de passe (IMAP_PASSWORD, sinon SMTP_PASSWORD) sont posés et que
   *  node/server.mjs a fourni IMAP_FETCH. Sur Workers : relève désactivée (pas de socket). */
  IMAP_HOST?: string;
  /** 993 (TLS direct, le seul mode accepté). */
  IMAP_PORT?: string;
  IMAP_USER?: string;
  IMAP_PASSWORD?: string;
  /** Client IMAP injecté par node/server.mjs (node:tls) ; absent sur Workers. */
  IMAP_FETCH?: (query: ImapQuery) => Promise<ImapBatch>;
  /** Instantané complet de la base SQLite (VACUUM INTO), injecté par
   *  node/server.mjs ; absent sur Workers (export SQL à la place). */
  SQLITE_SNAPSHOT?: () => Promise<Uint8Array>;
  /** Adresses ou plages CIDR autorisées sur /api/admin/* et /admin/
   *  (virgules ou espaces). Vide = ouvert. Garde appliquée aux HUMAINS : une
   *  clé de service `svc:` et le compte `sauvegarde` passent depuis toute
   *  adresse (lot 3). Cf. src/core/ip-allow.ts. */
  ADMIN_ALLOWED_IPS?: string;
  /** Dépôt des photos envoyées depuis le back-office. Fourni par
   *  node/server.mjs (dossier UPLOADS_DIR, servi sous /uploads/) ; absent sur
   *  Workers, où l'envoi répond 501. */
  UPLOADS?: UploadStore;
}

/** Écriture d'un fichier envoyé. `name` est déjà validé (hexadécimal + extension). */
interface UploadStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** Retire un fichier déposé (compensation quand la base refuse la ligne). */
  remove?(name: string): Promise<void>;
  /** Noms des fichiers déposés (sauvegarde des photos, lot 3). */
  list?(): Promise<string[]>;
  /** Contenu et date (secondes Unix) d'un fichier déposé. */
  read?(name: string): Promise<{ bytes: Uint8Array; mtime: number }>;
}

/** Demande de relève IMAP (node/imap.mjs : fetchNewMail). */
interface ImapQuery {
  uidValidity: number | null;
  lastUid: number | null;
  /** Fenêtre du premier passage (ou d'une boîte reconstruite), en jours. */
  sinceDays: number;
  /** Nombre de mails au plus par appel. */
  max: number;
  /** Octets au plus par mail (le reste n'est pas descendu). */
  maxBytes?: number;
}

interface ImapBatch {
  uidValidity: number;
  mails: { uid: number; raw: string; size: number; truncated: boolean }[];
  /** Il reste des mails au-delà de ce lot. */
  more: boolean;
  /** Plus grand UID examiné dans ce lot (ceux sans corps compris). */
  highestUid: number | null;
  /** UID examinés dans ce lot, du plus ancien au plus récent. */
  batchUids?: number[];
}
