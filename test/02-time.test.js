import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tzOffsetMs,
  localDateToUtc,
  utcToLocalDate,
  addLocalMonthsClamped,
  addLocalDays,
  countLocalDays,
} from '../src/shared/time.js';

describe('timezone calendar boundaries', () => {
  test('local midnight round-trips across timezones', () => {
    for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Shanghai', 'Pacific/Auckland']) {
      const utc = localDateToUtc('2026-03-15', tz);
      assert.equal(utcToLocalDate(utc, tz), '2026-03-15', tz);
    }
  });

  test('US Eastern DST spring-forward: 2026-03-08 local midnight is 05:00 UTC', () => {
    // midnight is before the 02:00 -> 03:00 jump, so it is still EST (-05:00)
    const utc = localDateToUtc('2026-03-08', 'America/New_York');
    assert.equal(new Date(utc).toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(tzOffsetMs(localDateToUtc('2026-03-07', 'America/New_York'), 'America/New_York'), -5 * 3600e3);
    assert.equal(tzOffsetMs(utc, 'America/New_York'), -5 * 3600e3);
    // by that afternoon the offset is EDT (-04:00)
    assert.equal(tzOffsetMs(utc + 12 * 3600e3, 'America/New_York'), -4 * 3600e3);
    // and local midnight on the day after resolves at 04:00 UTC
    assert.equal(new Date(localDateToUtc('2026-03-09', 'America/New_York')).toISOString(),
      '2026-03-09T04:00:00.000Z');
  });

  test('US Eastern DST fall-back: 2026-11-01 still resolves to one unambiguous day', () => {
    const utc = localDateToUtc('2026-11-01', 'America/New_York');
    assert.equal(utcToLocalDate(utc, 'America/New_York'), '2026-11-01');
    assert.equal(utcToLocalDate(utc + 25 * 3600e3, 'America/New_York'), '2026-11-02');
  });

  test('Pacific/Auckland is UTC+13 in summer: local 2026-01-15 starts on 2026-01-14 UTC', () => {
    const utc = localDateToUtc('2026-01-15', 'Pacific/Auckland');
    assert.equal(new Date(utc).toISOString(), '2026-01-14T11:00:00.000Z');
    assert.equal(utcToLocalDate(utc, 'Pacific/Auckland'), '2026-01-15');
  });

  test('day counts are calendar-based, immune to 23h/25h DST days', () => {
    const start = localDateToUtc('2026-03-07', 'America/New_York');
    const end = localDateToUtc('2026-03-10', 'America/New_York');
    assert.equal(countLocalDays(start, end, 'America/New_York'), 3);
    assert.notEqual((end - start) / 3600e3, 72); // actual elapsed is 71h over DST
  });

  test('month addition clamps at month end (cross-month anchor)', () => {
    assert.equal(addLocalMonthsClamped('2026-01-31', 1), '2026-02-28');
    assert.equal(addLocalMonthsClamped('2026-01-31', 2), '2026-03-31');
    assert.equal(addLocalMonthsClamped('2026-01-31', 13), '2027-02-28');
    assert.equal(addLocalMonthsClamped('2024-01-31', 1), '2024-02-29'); // leap
    assert.equal(addLocalMonthsClamped('2026-08-15', 1), '2026-09-15');
  });

  test('addLocalDays walks calendar dates', () => {
    assert.equal(addLocalDays('2026-12-30', 5), '2027-01-04');
    assert.equal(addLocalDays('2026-02-27', 2), '2026-03-01');
  });
});
