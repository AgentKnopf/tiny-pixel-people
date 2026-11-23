import { z } from 'zod';
import { NOTE_MAX_LENGTH, SAY_MAX_LENGTH, SPEEDS, type ClientMessage } from '../../shared/protocol.ts';

const id = z.string().min(1).max(64);
const requestId = z.string().max(64).optional();
const point = z.object({ x: z.number().finite(), y: z.number().finite() });

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
    kind: z.enum(['rain', 'party', 'stranger', 'birthday', 'townEvent']),
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
] as const;

const clientMessage = z.discriminatedUnion('type', schemas);

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
  return { ok: true, msg: parsed.data as ClientMessage };
}
