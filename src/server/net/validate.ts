import { z } from 'zod';
import {
  KEEP_PAGE_MAX,
  NOTE_MAX_LENGTH,
  NOTICE_MAX_LENGTH,
  SAY_MAX_LENGTH,
  SPEEDS,
  type ClientMessage,
} from '../../shared/protocol.ts';
import type { KeepEntryKind, WorldEventKind } from '../../shared/types.ts';

const id = z.string().min(1).max(64);
const requestId = z.string().max(64).optional();
const point = z.object({ x: z.number().finite(), y: z.number().finite() });

const WORLD_EVENT_KINDS = [
  'rain',
  'party',
  'stranger',
  'birthday',
  'townEvent',
  'train',
  'date',
  'couple',
  'farm',
] as const satisfies readonly WorldEventKind[];
const KEEP_ENTRY_KINDS = [
  'note',
  'letter',
  'notice',
  'rumor',
  'reply',
] as const satisfies readonly KeepEntryKind[];

// Text limits are twice the gameplay limit: handlers reply with a friendly "keep it under N" error.
const schemas = [
  z.object({ type: z.literal('inspect'), villagerId: id.nullable(), requestId }),
  z.object({
    type: z.literal('speed'),
    speed: z.literal(SPEEDS),
    requestId,
  }),
  z.object({
    type: z.literal('note.post'),
    houseId: id,
    text: z.string().max(NOTE_MAX_LENGTH * 2),
    requestId,
  }),
  z.object({ type: z.literal('save'), requestId }),
  z.object({ type: z.literal('player.move'), to: point, requestId }),
  z.object({
    type: z.literal('player.say'),
    villagerId: id,
    text: z.string().max(SAY_MAX_LENGTH * 2),
    mode: z.enum(['say', 'ask']),
    requestId,
  }),
  z.object({
    type: z.literal('player.rumor'),
    villagerId: id,
    text: z.string().max(SAY_MAX_LENGTH * 2),
    requestId,
  }),
  z.object({ type: z.literal('player.pairTalk'), aId: id, bId: id, requestId }),
  z.object({ type: z.literal('player.gift'), villagerId: id, itemId: id, requestId }),
  z.object({
    type: z.literal('world.trigger'),
    kind: z.enum(WORLD_EVENT_KINDS),
    villagerId: id.optional(),
    requestId,
  }),
  z.object({ type: z.literal('decor.toggle'), itemId: id, requestId }),
  z.object({
    type: z.literal('pet.command'),
    action: z.enum(['follow', 'stay', 'pet', 'rename']),
    name: z.string().max(48).optional(),
    requestId,
  }),
  z.object({
    type: z.literal('debug.inject'),
    villagerId: id,
    text: z.string().min(1).max(1000),
    importance: z.number().min(1).max(10).optional(),
    requestId,
  }),
  z.object({ type: z.literal('debug.jump'), toTime: z.number().finite(), requestId }),
  // v2 (spec v2 §14)
  z.object({ type: z.literal('player.enter'), locationId: id, requestId }),
  z.object({ type: z.literal('player.exit'), requestId }),
  z.object({ type: z.literal('player.ride'), locationId: id, requestId }),
  z.object({ type: z.literal('player.buy'), locationId: id, itemId: id, requestId }),
  z.object({
    type: z.literal('letter.send'),
    to: id,
    text: z.string().max(NOTE_MAX_LENGTH * 2),
    requestId,
  }),
  z.object({ type: z.literal('letter.read'), letterId: id, requestId }),
  z.object({
    type: z.literal('notice.post'),
    text: z.string().max(NOTICE_MAX_LENGTH * 2),
    requestId,
  }),
  z.object({
    type: z.literal('keep.open'),
    query: z.string().max(200).optional(),
    kind: z.enum(KEEP_ENTRY_KINDS).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(KEEP_PAGE_MAX).optional(),
    requestId,
  }),
] as const;

const clientMessage = z.discriminatedUnion('type', schemas);

// Compile-time guard: every ClientMessage type has a schema and every schema is a ClientMessage.
type Parsed = z.infer<typeof clientMessage>;
type MissingSchema = Exclude<ClientMessage['type'], Parsed['type']>;
type UnknownSchema = Exclude<Parsed['type'], ClientMessage['type']>;
const schemaCoverage: [MissingSchema, UnknownSchema] extends [never, never] ? true : never = true;
void schemaCoverage;
const parsedIsClientMessage = (m: Parsed): ClientMessage => m;
void parsedIsClientMessage;

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string; requestId?: string };

/** Parse and validate one WebSocket text frame from a client. */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  const rid =
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { requestId?: unknown }).requestId === 'string'
      ? (data as { requestId: string }).requestId
      : undefined;
  const parsed = clientMessage.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error = issue ? `${issue.path.join('.') || 'message'}: ${issue.message}` : 'Invalid message';
    return rid ? { ok: false, error, requestId: rid } : { ok: false, error };
  }
  return { ok: true, msg: parsed.data };
}
