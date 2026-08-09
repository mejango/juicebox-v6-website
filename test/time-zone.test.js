import { afterEach, describe, expect, it } from 'vitest';
import { timestampToZonedInput, zonedInputToTimestamp } from '../src/time-zone.js';

afterEach(() => localStorage.removeItem('jb-time-zone'));

describe('timezone-aware date inputs', () => {
  it('formats and parses a timestamp in the selected timezone', () => {
    localStorage.setItem('jb-time-zone', 'America/New_York');
    const timestamp = Date.parse('2026-08-08T12:30:00Z') / 1000;
    expect(timestampToZonedInput(timestamp, 'datetime')).toBe('2026-08-08T08:30');
    expect(zonedInputToTimestamp('2026-08-08T08:30', 'datetime')).toBe(timestamp);
  });

  it('uses midnight in the selected timezone for a date-only field', () => {
    localStorage.setItem('jb-time-zone', 'Asia/Tokyo');
    expect(zonedInputToTimestamp('2026-08-08', 'date')).toBe(
      Date.parse('2026-08-07T15:00:00Z') / 1000,
    );
  });

  it('rejects a wall clock skipped by daylight saving time', () => {
    localStorage.setItem('jb-time-zone', 'America/New_York');
    expect(zonedInputToTimestamp('2026-03-08T02:30', 'datetime')).toBe(0);
  });
});
