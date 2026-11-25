import test from 'node:test';
import assert from 'node:assert/strict';
import { runningSinceFromResources, validateLabUsageSettings, recordLabUse, readLabUsageSettings } from '../lib/labUsage.js';
import { labUsageInfo, isOutsideClassHours, formatDurationShort } from '../dashboard/public/ux.js';

const HOUR = 3600 * 1000;
// Wednesday 25.11.2026 10:00 local time: inside class hours.
const wednesdayMorning = new Date(2026, 10, 25, 10, 0);

test('running since = start of the oldest running VM of the lab (Proxmox uptime)', () => {
  const now = Date.UTC(2026, 10, 25, 10);
  const resources = new Map([
    [101, { vmid: 101, status: 'running', uptime: 3600 }],
    [102, { vmid: 102, status: 'running', uptime: 7200 }],
    [103, { vmid: 103, status: 'stopped', uptime: 0 }],
    [999, { vmid: 999, status: 'running', uptime: 99999 }]
  ]);
  assert.equal(runningSinceFromResources([101, 102, 103], resources, now), new Date(now - 7200 * 1000).toISOString());
  assert.equal(runningSinceFromResources([103], resources, now), null, 'no running VM');
  assert.equal(runningSinceFromResources([104], resources, now), null, 'VM absent from Proxmox');
});

test('forgotten threshold accepts whole days between 1 and 30', () => {
  assert.deepEqual(validateLabUsageSettings({ forgottenAfterDays: 3 }), { value: { forgottenAfterDays: 3 } });
  for (const value of [0, 31, 1.5, 'abc', null]) assert.ok(validateLabUsageSettings({ forgottenAfterDays: value }).errors, String(value));
});

test('recording a use is throttled for running labs and tolerates a missing migration', async () => {
  const queries = [];
  await recordLabUse({ query: async (sql, params) => queries.push(params) }, ['a', 'a', 'b'], { throttle: true });
  assert.deepEqual(queries[0][0], ['a', 'b']);
  assert.equal(queries[0][1], true);
  await recordLabUse({ query: async () => { throw Object.assign(new Error('no column'), { code: '42703' }); } }, ['a']);
  await recordLabUse({ query: async () => { throw new Error('unexpected'); } }, []); // nothing to record: no query
  assert.deepEqual(await readLabUsageSettings({ query: async () => { throw Object.assign(new Error('no table'), { code: '42P01' }); } }),
    { forgottenAfterDays: 1, updatedAt: null, updatedBy: null });
});

test('class hours: Monday to Friday 06:00-20:00', () => {
  assert.equal(isOutsideClassHours(wednesdayMorning), false);
  assert.equal(isOutsideClassHours(new Date(2026, 10, 25, 20, 0)), true, 'evening');
  assert.equal(isOutsideClassHours(new Date(2026, 10, 25, 5, 59)), true, 'early morning');
  assert.equal(isOutsideClassHours(new Date(2026, 10, 28, 10, 0)), true, 'Saturday');
  assert.equal(formatDurationShort(30 * 60000), '30 min');
  assert.equal(formatDurationShort(5 * HOUR), '5 h');
  assert.equal(formatDurationShort(49 * HOUR), '2 days');
});

test('lab usage line: running, probably forgotten, last used, unknown', () => {
  const settings = { forgottenAfterDays: 2 };
  const running = since => ({ status: 'running', runningSince: new Date(wednesdayMorning - since).toISOString() });
  let usage = labUsageInfo(running(3 * HOUR), settings, wednesdayMorning);
  assert.equal(usage.text, 'Running for 3 h'); assert.equal(usage.forgotten, false);
  usage = labUsageInfo(running(3 * 24 * HOUR), settings, wednesdayMorning);
  assert.equal(usage.text, 'Running for 3 days'); assert.equal(usage.forgotten, true);
  assert.match(usage.title, /more than 2 days/);
  usage = labUsageInfo(running(HOUR), settings, new Date(2026, 10, 25, 21, 0));
  assert.equal(usage.forgotten, true, 'still running in the evening');
  assert.match(usage.title, /outside class hours/);
  usage = labUsageInfo({ status: 'stopped', lastUsedAt: new Date(wednesdayMorning - 2 * 24 * HOUR).toISOString() }, settings, wednesdayMorning);
  assert.equal(usage.text, 'Last used 2 days ago'); assert.equal(usage.forgotten, false);
  assert.equal(labUsageInfo({ status: 'stopped', lastUsedAt: null }, settings, wednesdayMorning).text, 'Last use unknown');
  for (const status of ['idle', 'queued', 'deploying', 'destroyed', 'waiting_for_pool']) assert.equal(labUsageInfo({ status }, settings), null, status);
});
