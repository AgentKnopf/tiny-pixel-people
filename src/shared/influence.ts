/**
 * Influence API contracts (specs/influence-api-v2.md). A separate, opt-in way to nudge the town:
 * every influence only adds an in-world stimulus through an existing path, and is logged honestly.
 */
import { NOTE_MAX_LENGTH, NOTICE_MAX_LENGTH, SAY_MAX_LENGTH } from './protocol.ts';
import type {
  EventId,
  GameMinutes,
  LocationId,
  MemoryId,
  NoteId,
  Provenance,
  VillageEventStatus,
  VillagerId,
} from './types.ts';

export const INFLUENCE_ENDPOINTS = ['rumour', 'note', 'event', 'nudge', 'weather'] as const;
export type InfluenceEndpoint = (typeof INFLUENCE_ENDPOINTS)[number];

/** `inf_<n>`, unique within a save. */
export type InfluenceId = string;

export const RUMOUR_SOURCES = ['passerby', 'traveller', 'crow', 'child'] as const;
export type RumourSource = (typeof RUMOUR_SOURCES)[number];

/** What villagers are told about where a rumour came from; never the player. */
export const RUMOUR_SOURCE_LABELS: Readonly<Record<RumourSource, string>> = {
  passerby: 'A passerby',
  traveller: 'A traveller from the train',
  crow: 'The crow',
  child: 'A child in the square',
};

/** Caps in UTF-16 code units, counted after cleaning (spec §5). */
export const INFLUENCE_TEXT_MAX = {
  rumour: SAY_MAX_LENGTH,
  nudge: SAY_MAX_LENGTH,
  note: NOTE_MAX_LENGTH,
  eventText: NOTICE_MAX_LENGTH,
  eventTitle: 40,
  signature: 24,
} as const;

export const INFLUENCE_RAIN_HOURS = { min: 1, max: 3 } as const;
export const INFLUENCE_EVENT_MINUTES = { min: 30, max: 180, default: 120 } as const;
/** An event starts at least this many game minutes from now. */
export const INFLUENCE_EVENT_LEAD_MINUTES = 30;
/** An event ends at least this many game minutes before the earliest resident bedtime. */
export const INFLUENCE_EVENT_BEDTIME_MARGIN = 60;
export const INFLUENCE_LOG_PAGE_MAX = 200;

// ---------- Request bodies (HTTP JSON, before cleaning) ----------

export interface RumourBody {
  to: VillagerId;
  text: string;
  source: RumourSource;
}

export interface NoteBody {
  to: VillagerId;
  text: string;
  /** Optional signature; without it the note is anonymous. There is deliberately no `from`. */
  signed?: string;
}

export interface EventBody {
  title: string;
  text: string;
  location: LocationId;
  /** `HH:MM` today. */
  time: string;
  /** Default INFLUENCE_EVENT_MINUTES.default. */
  minutes?: number;
}

export interface NudgeBody {
  agent: VillagerId;
  thought: string;
}

export interface WeatherBody {
  weather: 'rain' | 'clear';
  /** Game hours, required for `rain`, ignored for `clear`. */
  hours?: number;
}

export interface InfluenceBodies {
  rumour: RumourBody;
  note: NoteBody;
  event: EventBody;
  nudge: NudgeBody;
  weather: WeatherBody;
}

/** What `SimEngine.applyInfluence` takes: an endpoint and its schema-checked body. */
export type InfluenceRequest = {
  [E in InfluenceEndpoint]: { endpoint: E; body: InfluenceBodies[E] };
}[InfluenceEndpoint];

// ---------- Results ----------

export interface InfluenceRefs {
  originId?: MemoryId;
  noteId?: NoteId;
  eventId?: EventId;
  worldEventId?: string;
}

/** 200 body. */
export interface InfluenceAccepted {
  id: InfluenceId;
  tick: GameMinutes;
  refs: InfluenceRefs;
}

/** Error ids of the 409, 503 and 429 bodies (spec §3). */
export const INFLUENCE_ERRORS = [
  'asleep',
  'already_raining',
  'not_raining',
  'board_full',
  'event_pending',
  'busy',
  'limit',
] as const;
export type InfluenceErrorId = (typeof INFLUENCE_ERRORS)[number];

/**
 * A refusal decided by the engine. Each maps to one HTTP status; 400 and earlier statuses come
 * from the HTTP layer. Refusals never count against the budget and are not logged as influences.
 */
export type InfluenceRefusal =
  | { status: 422; error: 'invalid'; message: string }
  | { status: 409; error: 'asleep'; wakesAt: GameMinutes }
  | { status: 409; error: 'already_raining' | 'not_raining' | 'board_full' | 'event_pending' }
  | { status: 503; error: 'busy' }
  | { status: 429; error: 'limit'; resetsAtTick: GameMinutes };

export type InfluenceResult = ({ ok: true } & InfluenceAccepted) | ({ ok: false } & InfluenceRefusal);

// ---------- Outcomes (spec §7): only facts traceable by id, updated as they happen ----------

export interface RumourOutcomes {
  spreadTo: { from: VillagerId; to: VillagerId; tick: GameMinutes }[];
}

export interface NoteOutcomes {
  readAt?: GameMinutes;
  repliedAt?: GameMinutes;
  replySource?: Provenance;
}

export interface EventOutcomes {
  accepted: VillagerId[];
  declined: VillagerId[];
  attended: VillagerId[];
  status: VillageEventStatus;
}

export interface NudgeOutcomes {
  /** The first plan made for the target after the nudge; not a claim that the nudge changed it. */
  planAfter?: { tick: GameMinutes; revision: number; source: Provenance };
}

export interface WeatherOutcomes {
  startedAt?: GameMinutes;
  endedAt?: GameMinutes;
  /** Plan blocks moved indoors. */
  swaps: number;
}

export interface InfluenceOutcomes {
  rumour: RumourOutcomes;
  note: NoteOutcomes;
  event: EventOutcomes;
  nudge: NudgeOutcomes;
  weather: WeatherOutcomes;
}

// ---------- Log ----------

export type InfluenceEntry = {
  [E in InfluenceEndpoint]: {
    id: InfluenceId;
    tick: GameMinutes;
    /** Real ISO-8601 time the influence was accepted. */
    ts: string;
    day: number;
    /** `HH:MM` game time. */
    time: string;
    endpoint: E;
    /** The cleaned body. */
    payload: InfluenceBodies[E];
    targets: VillagerId[];
    refs: InfluenceRefs;
    outcomes: InfluenceOutcomes[E];
    /** The target is a visitor (rumour and nudge only). */
    visitor?: boolean;
  };
}[InfluenceEndpoint];

export interface InfluenceBudget {
  /** `influence.perGameDay`; 0 means no limit. */
  limit: number;
  usedToday: number;
  /** Next 00:00. */
  resetsAtTick: GameMinutes;
}

export interface InfluenceLogQuery {
  /** A game tick (number) or an ISO-8601 timestamp, as in the observer API. */
  since?: GameMinutes | string;
  /** At most INFLUENCE_LOG_PAGE_MAX. */
  limit?: number;
}

export interface InfluenceLogPage {
  entries: InfluenceEntry[];
  /** Value for `since` on the next poll (`X-Next-Since`). */
  nextSince?: string;
  budget: InfluenceBudget;
}

export interface ApplyInfluenceOptions {
  /** Real ISO-8601 time to record instead of the wall clock (deterministic tests). */
  ts?: string;
}
