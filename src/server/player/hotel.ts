import type { GameMinutes, HotelState, VillagerId } from '../../shared/types.ts';
import type { HotelService } from './types.ts';

export const HOTEL_ID = 'hotel';

export function hotelRoomId(n: number): string {
  return `hotel_room_${n}`;
}

/** Hotel rooms (spec v2 §5.3): lowest free room on check-in, never overbooked. */
export class Hotel implements HotelService {
  private readonly hotel: HotelState;

  constructor(rooms: number, restored?: HotelState | null) {
    const saved = new Map((restored?.rooms ?? []).map((r) => [r.id, r]));
    this.hotel = {
      locationId: HOTEL_ID,
      rooms: Array.from({ length: rooms }, (_, i) => {
        const id = hotelRoomId(i + 1);
        const r = saved.get(id);
        return { id, guestId: r?.guestId ?? null, since: r?.since ?? null };
      }),
    };
    // Guests of rooms that no longer exist (fewer rooms in config) move into free ones.
    for (const r of restored?.rooms ?? []) {
      if (r.guestId && !this.roomOf(r.guestId)) this.checkIn(r.guestId, r.since ?? 0);
    }
  }

  state(): Readonly<HotelState> {
    return this.hotel;
  }

  freeRooms(): number {
    return this.hotel.rooms.filter((r) => r.guestId === null).length;
  }

  roomOf(guestId: VillagerId): string | null {
    return this.hotel.rooms.find((r) => r.guestId === guestId)?.id ?? null;
  }

  /** Room id, the guest's existing room, or null when full. */
  checkIn(guestId: VillagerId, now: GameMinutes): string | null {
    const existing = this.roomOf(guestId);
    if (existing) return existing;
    const room = this.hotel.rooms.find((r) => r.guestId === null);
    if (!room) return null;
    room.guestId = guestId;
    room.since = now;
    return room.id;
  }

  checkOut(guestId: VillagerId): void {
    for (const r of this.hotel.rooms) {
      if (r.guestId !== guestId) continue;
      r.guestId = null;
      r.since = null;
    }
  }
}
