/**
 * Acceptance checks shared by the automated suite (mock provider) and scripts/live-acceptance.ts
 * (real provider). Pure functions over snapshots and broadcast messages, so both runs judge the same
 * way. See specs/technical-spec.md §14.
 */
import type { ConversationMessageMsg, InspectDataMsg } from '../../src/shared/protocol.ts';
import type {
  DoorNote,
  GameMinutes,
  Location,
  VillageEvent,
  VillagerId,
  VillagerState,
  WorldSnapshot,
} from '../../src/shared/types.ts';
import { minuteOfDay } from '../../src/shared/time.ts';

export interface CheckResult {
  id: string;
  title: string;
  pass: boolean;
  /** The run never gave the check a chance (counted neither as pass nor as fail). */
  skipped?: boolean;
  detail: string;
  /** Live runs only: whether the result came from LLM output or a fallback (see provenance.ts). */
  via?: { via: 'llm' | 'fallback' | 'mixed' | 'unknown' | 'n/a'; detail: string };
}

// ---------- AC2: plans followed ----------

export interface AdherenceSample {
  time: GameMinutes;
  villagers: VillagerState[];
}

export interface Adherence {
  villagerId: VillagerId;
  /** Awake samples with a plan block (talking excluded). */
  samples: number;
  following: number;
  ratio: number;
  locationsVisited: number;
}

function inside(p: { x: number; y: number }, loc: Location): boolean {
  const { x, y, w, h } = loc.area;
  return p.x >= x - 0.5 && p.x < x + w + 0.5 && p.y >= y - 0.5 && p.y < y + h + 0.5;
}

/**
 * A sample counts as following the plan when the villager is at the current block's location, or is
 * walking towards it (path ends inside it). Conversations interrupt plans by design and are excluded;
 * attending counts when the block belongs to an event.
 */
export function isFollowing(
  v: VillagerState,
  time: GameMinutes,
  locations: readonly Location[],
): boolean | null {
  if (v.status === 'sleeping' || v.status === 'talking' || !v.plan) return null;
  const mod = minuteOfDay(time);
  const block = v.plan.blocks.find((b) => b.start <= mod && mod < b.end);
  if (!block) return null;
  if (v.locationId === block.locationId) return true;
  const loc = locations.find((l) => l.id === block.locationId);
  if (loc && inside(v.pos, loc)) return true;
  if (v.status === 'attending' && block.eventId) return true;
  if (v.status === 'walking') {
    const dest = v.path[v.path.length - 1];
    if (!dest) return true;
    return loc
      ? inside(dest, loc) || (Math.abs(dest.x - loc.entry.x) <= 1 && Math.abs(dest.y - loc.entry.y) <= 1)
      : false;
  }
  return false;
}

export function planAdherence(samples: AdherenceSample[], locations: readonly Location[]): Adherence[] {
  const by = new Map<VillagerId, { samples: number; following: number; locs: Set<string> }>();
  for (const s of samples) {
    for (const v of s.villagers) {
      const entry = by.get(v.id) ?? { samples: 0, following: 0, locs: new Set<string>() };
      by.set(v.id, entry);
      if (v.locationId) entry.locs.add(v.locationId);
      const f = isFollowing(v, s.time, locations);
      if (f === null) continue;
      entry.samples++;
      if (f) entry.following++;
    }
  }
  return [...by].map(([villagerId, e]) => ({
    villagerId,
    samples: e.samples,
    following: e.following,
    ratio: e.samples ? e.following / e.samples : 0,
    locationsVisited: e.locs.size,
  }));
}

export function checkPlans(snapshot: WorldSnapshot, adherence: Adherence[], minRatio = 0.7): CheckResult {
  const problems: string[] = [];
  for (const v of snapshot.villagers) {
    if (!v.plan) problems.push(`${v.id}: no plan`);
    else if (v.plan.source !== 'llm') problems.push(`${v.id}: plan source ${v.plan.source}`);
    else if (v.plan.blocks.length < 3) problems.push(`${v.id}: only ${v.plan.blocks.length} blocks`);
  }
  for (const a of adherence) {
    if (a.samples === 0) problems.push(`${a.villagerId}: no awake samples with a plan`);
    else if (a.ratio < minRatio) problems.push(`${a.villagerId}: adherence ${(a.ratio * 100).toFixed(0)}%`);
    if (a.locationsVisited < 2) problems.push(`${a.villagerId}: stayed in ${a.locationsVisited} location(s)`);
  }
  const avg = adherence.length ? adherence.reduce((n, a) => n + a.ratio, 0) / adherence.length : 0;
  return {
    id: 'AC2',
    title: `${snapshot.villagers.length} villagers each have an LLM plan and follow it`,
    pass: snapshot.villagers.length > 0 && problems.length === 0,
    detail: problems.length ? problems.join('; ') : `average adherence ${(avg * 100).toFixed(0)}%`,
  };
}

// ---------- AC3: gossip ----------

export function gossipMentions<
  M extends Pick<ConversationMessageMsg, 'speakerId' | 'text' | 'time' | 'listenerId'>,
>(
  messages: readonly M[],
  keyword: string,
  sourceId: VillagerId,
  since: GameMinutes,
  until: GameMinutes,
): M[] {
  const k = keyword.toLowerCase();
  return messages.filter(
    (m) => m.speakerId !== sourceId && m.time >= since && m.time <= until && m.text.toLowerCase().includes(k),
  );
}

export function checkGossip(
  messages: readonly ConversationMessageMsg[],
  keyword: string,
  sourceId: VillagerId,
  since: GameMinutes,
  until: GameMinutes,
): CheckResult {
  const hits = gossipMentions(messages, keyword, sourceId, since, until);
  const speakers = [...new Set(hits.map((h) => h.speakerId))];
  return {
    id: 'AC3',
    title: `fact told to ${sourceId} is mentioned by another villager by evening`,
    pass: hits.length > 0,
    detail: hits.length
      ? `"${keyword}" said by ${speakers.join(', ')} (first: "${hits[0]!.text.slice(0, 80)}")`
      : `nobody but ${sourceId} said "${keyword}"`,
  };
}

// ---------- AC4: door notes ----------

/** Share of the note's keywords that appear in the reply. */
export function replyOverlap(note: string, reply: string): { shared: string[]; ratio: number } {
  const stop = new Set([
    'that',
    'this',
    'with',
    'from',
    'your',
    'have',
    'will',
    'about',
    'there',
    'what',
    'could',
    'would',
    'please',
  ]);
  const kw = [...new Set((note.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !stop.has(w)))];
  const r = reply.toLowerCase();
  const shared = kw.filter((w) => r.includes(w) || (w.length > 5 && r.includes(w.slice(0, -2))));
  return { shared, ratio: kw.length ? shared.length / kw.length : 0 };
}

export function checkNote(note: DoorNote | undefined): CheckResult {
  const base = { id: 'AC4', title: 'door note is read on the next home visit and the reply references it' };
  if (!note) return { ...base, pass: false, detail: 'note not found' };
  if (note.status !== 'replied' || !note.reply)
    return { ...base, pass: false, detail: `note status ${note.status}` };
  const { shared } = replyOverlap(note.text, note.reply);
  return {
    ...base,
    pass: shared.length > 0,
    detail: `reply "${note.reply.slice(0, 100)}" shares [${shared.join(', ')}]`,
  };
}

// ---------- AC5: events ----------

export function checkEvents(events: readonly VillageEvent[], minAttendees = 3): CheckResult {
  const done = events.filter((e) => e.status === 'done');
  const good = done.filter((e) => new Set(e.attendees).size >= minAttendees);
  return {
    id: 'AC5',
    title: `a proposed event happens with >= ${minAttendees} attendees`,
    pass: good.length > 0,
    detail: events.length
      ? events.map((e) => `${e.title} (${e.status}, ${new Set(e.attendees).size} attended)`).join('; ')
      : 'no events',
  };
}

// ---------- AC6: inspector ----------

export function inspectProblems(msg: InspectDataMsg | undefined, villagerId: VillagerId): string[] {
  if (!msg) return [`${villagerId}: no inspect.data`];
  const p: string[] = [];
  if (msg.villagerId !== villagerId) p.push(`${villagerId}: wrong villagerId ${msg.villagerId}`);
  if (!msg.plan || msg.plan.blocks.length === 0) p.push(`${villagerId}: no plan`);
  if (!Array.isArray(msg.memories) || msg.memories.length === 0) p.push(`${villagerId}: no memories`);
  else {
    if (msg.memories.length > 10) p.push(`${villagerId}: ${msg.memories.length} memories (max 10)`);
    if (msg.memories.some((m) => 'embedding' in m)) p.push(`${villagerId}: embeddings not stripped`);
    for (let i = 1; i < msg.memories.length; i++)
      if (msg.memories[i]!.createdAt > msg.memories[i - 1]!.createdAt) {
        p.push(`${villagerId}: memories not newest first`);
        break;
      }
  }
  if (!msg.state || msg.state.id !== villagerId) p.push(`${villagerId}: missing state`);
  return p;
}

export function checkInspector(results: { id: VillagerId; msg: InspectDataMsg | undefined }[]): CheckResult {
  const problems = results.flatMap((r) => inspectProblems(r.msg, r.id));
  return {
    id: 'AC6',
    title: 'inspector data (plan + memories) for every villager',
    pass: results.length > 0 && problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${results.length} villagers ok`,
  };
}

export function formatReport(results: CheckResult[]): string {
  const lines = results.map(
    (r) =>
      `${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(5)} ${r.title}\n        ${r.detail}` +
      (r.via && r.via.via !== 'n/a' ? `\n        via ${r.via.via}: ${r.via.detail}` : ''),
  );
  const judged = results.filter((r) => !r.skipped);
  const passed = judged.filter((r) => r.pass).length;
  const skipped = results.length - judged.length;
  const attributed = judged.filter((r) => r.pass && r.via && r.via.via !== 'n/a');
  const count = (v: string) => attributed.filter((r) => r.via!.via === v).length;
  const tally = attributed.length
    ? ` (model-output checks: ${count('llm')} via LLM, ${count('fallback') + count('mixed')} via fallback, ${count('unknown')} unknown)`
    : '';
  return `${lines.join('\n')}\n\n${passed}/${judged.length} checks passed${skipped ? ` (${skipped} skipped)` : ''}${tally}`;
}
