/**
 * v2 checks shared by scripts/live-acceptance.ts and the mock suites (spec v2 §19: visitors, dates,
 * the butcher toast, letters and the Keep). Pure functions over snapshots and broadcast messages.
 * A check returns `skipped: true` when the day never gave it a chance (for example no butcher trip),
 * so a short live run does not fail on things that legitimately did not happen.
 */
import type { KeepDataMsg, ToastMsg } from '../../src/shared/protocol.ts';
import type { Letter, Romance, VisitorInfo } from '../../src/shared/types.ts';
import { PLAYER_ID } from '../../src/shared/types.ts';
import { replyOverlap, type CheckResult } from './checks.ts';
import { fromTags } from './provenance.ts';
import { graphicWords } from './v2.ts';

/** AC12 (live): visitors came by train; `seen` is every VisitorInfo broadcast or snapshotted. */
export function checkVisitors(seen: readonly VisitorInfo[], min: number, trainArrived: boolean): CheckResult {
  const base = { id: 'AC12', title: `at least ${min} visitors arrive by train and check in` };
  const byId = new Map<string, VisitorInfo>();
  for (const v of seen) byId.set(v.villagerId, v);
  const all = [...byId.values()];
  const checkedIn = all.filter((v) => v.roomId !== null || v.status !== 'arriving');
  if (!trainArrived && all.length === 0)
    return { ...base, pass: false, skipped: true, detail: 'no train arrived yet' };
  const via = fromTags(
    all.map((v) => ({ source: v.source })),
    'visitor profiles',
  );
  return {
    ...base,
    pass: checkedIn.length >= min,
    detail: `${all.length} visitors (${checkedIn.length} checked in): ${all.map((v) => v.villagerId).join(', ') || 'none'}`,
    ...(via ? { via } : {}),
  };
}

/** AC20 (live): the player's letter is delivered and read, and the reply quotes it. */
export function checkLetter(
  letters: readonly Letter[],
  sentText: string,
  toId: string | null,
  error?: string,
): CheckResult {
  const base = {
    id: 'AC20',
    title: 'a player letter is delivered, read and answered with a reply that refers to it',
  };
  if (!toId) return { ...base, pass: false, detail: 'the player never reached the post office' };
  const mine = letters.find((l) => l.from === PLAYER_ID && l.to === toId && l.text === sentText);
  if (!mine)
    return {
      ...base,
      pass: false,
      detail: error ? `letter.send rejected: ${error}` : `no letter to ${toId} found`,
    };
  const reply = letters.find((l) => l.replyTo === mine.id && l.from === toId);
  const problems: string[] = [];
  if (mine.deliveredAt === undefined) problems.push(`letter ${mine.status}, never delivered`);
  if (mine.readAt === undefined) problems.push('never read');
  if (!reply) problems.push('no reply');
  const shared = reply ? replyOverlap(sentText, reply.text).shared : [];
  if (reply && shared.length === 0) problems.push(`reply "${reply.text.slice(0, 80)}" shares no keyword`);
  const via = reply ? fromTags([{ source: reply.source, text: reply.text }], 'reply') : undefined;
  return {
    ...base,
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `reply "${reply!.text.slice(0, 100)}" shares [${shared.join(', ')}]`,
    ...(via ? { via } : {}),
  };
}

/** AC22 (live): keep.open inside the post office lists the logged note and letter, newest first. */
export function checkKeep(
  data: KeepDataMsg | undefined,
  refIds: readonly string[],
  error?: string,
): CheckResult {
  const base = { id: 'AC22', title: 'the Keep lists the door note and the letter, newest first' };
  if (!data)
    return { ...base, pass: false, detail: error ? `keep.open rejected: ${error}` : 'no keep.data reply' };
  const missing = refIds.filter((r) => !data.entries.some((e) => e.refId === r));
  let ordered = true;
  for (let i = 1; i < data.entries.length; i++)
    if (data.entries[i]!.at > data.entries[i - 1]!.at) ordered = false;
  const problems = [
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(ordered ? [] : ['not newest first']),
  ];
  return {
    ...base,
    pass: refIds.length > 0 && problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `${data.total} entries; found ${refIds.length} logged items`,
    via: { via: 'n/a', detail: 'deterministic' },
  };
}

/** AC10 (live): butcher toasts name the burger joint and contain no graphic words. */
export function checkButcherToasts(toasts: readonly Pick<ToastMsg, 'text'>[]): CheckResult {
  const base = { id: 'AC10', title: 'the butcher toast is friendly (no graphic words)' };
  const butcher = toasts.filter((t) => /butcher/i.test(t.text));
  if (butcher.length === 0)
    return { ...base, pass: true, skipped: true, detail: 'no animal went to the butcher' };
  const bad = butcher.filter((t) => graphicWords(t.text).length > 0);
  return {
    ...base,
    pass: bad.length === 0,
    detail: bad.length
      ? `graphic words in "${bad[0]!.text}": ${graphicWords(bad[0]!.text).join(', ')}`
      : `${butcher.length} toast(s), e.g. "${butcher[0]!.text}"`,
  };
}

/** AC15 (live): a date was asked and planned at a venue. Needs a multi-day run for crushes to form. */
export function checkDates(romances: readonly Romance[], days: number, minDays = 3): CheckResult {
  const base = { id: 'AC15', title: 'a crush leads to a date' };
  const dates = romances.flatMap((r) => r.dates.map((d) => ({ r, d })));
  if (dates.length === 0 && days < minDays)
    return {
      ...base,
      pass: true,
      skipped: true,
      detail: `${romances.length} romance(s), no date in ${days} day(s); run --days ${minDays} or more`,
    };
  const via = fromTags(
    dates.map(({ d }) => ({ source: d.source })),
    'dates',
    true,
  );
  return {
    ...base,
    pass: dates.length > 0,
    detail: dates.length
      ? dates.map(({ r, d }) => `${r.pair.join('+')} at ${d.locationId} (${d.status})`).join('; ')
      : `${romances.length} romance(s) (${romances.map((r) => `${r.pair.join('+')} ${r.stage}`).join(', ') || 'none'}), no date`,
    ...(via ? { via } : {}),
  };
}
