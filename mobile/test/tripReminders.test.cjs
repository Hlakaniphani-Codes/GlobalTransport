const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const source = readFileSync(join(__dirname, '..', 'src', 'notifications', 'tripReminders.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
new Function('exports', 'require', 'module', output)(compiledModule.exports, require, compiledModule);
const { planTripReminders } = compiledModule.exports;

const now = Date.parse('2026-01-01T08:00:00Z');

function driverTrip(id, startsAt, status = 'accepted') {
  return {
    id,
    status,
    starts_at: startsAt,
    stops: [{ stop_type: 'pickup', planned_at: startsAt, sequence: 1 }],
  };
}

test('plans both driver reminders and a passenger pick-up reminder', () => {
  const driver = planTripReminders(
    'driver',
    [driverTrip('driver-trip', '2026-01-02T10:00:00Z')],
    now,
    []
  );
  assert.deepEqual(driver.schedule.map(({ type }) => type), ['driver-60', 'driver-15']);
  assert.match(driver.schedule[0].body, /Your trip starts at 12:00/);
  assert.equal(driver.schedule[1].body,
    'Your trip starts in 15 minutes. Check your vehicle and passengers in the app.');

  const passenger = planTripReminders('passenger', [{
    id: 'passenger-trip',
    status: 'accepted',
    own_stops: [{ stop_type: 'pickup', planned_at: '2026-01-02T10:00:00Z' }],
  }], now, []);
  assert.equal(passenger.schedule.length, 1);
  assert.equal(passenger.schedule[0].type, 'passenger-30');
  assert.match(passenger.schedule[0].body, /Your ride is at 12:00/);
});

test('reschedules a changed trip time and cancels reminders for started trips', () => {
  const identifier = 'globalride-trip-reminder:driver:trip-1:60';
  const existing = [{ identifier, fireAt: Date.parse('2026-01-02T09:00:00Z') }];
  const rescheduled = planTripReminders(
    'driver',
    [driverTrip('trip-1', '2026-01-02T11:00:00Z')],
    now,
    existing
  );
  assert.deepEqual(rescheduled.cancel, [identifier]);
  assert.equal(rescheduled.schedule.find(({ identifier: id }) => id === identifier).fireAt,
    Date.parse('2026-01-02T10:00:00Z'));

  const started = planTripReminders('driver', [driverTrip('trip-1', '2026-01-02T11:00:00Z', 'in_progress')], now, existing);
  assert.deepEqual(started.schedule, []);
  assert.deepEqual(started.cancel, [identifier]);
});

test('does not schedule reminders in the past', () => {
  const plan = planTripReminders(
    'driver',
    [driverTrip('soon', '2026-01-01T08:40:00Z')],
    now,
    []
  );
  assert.deepEqual(plan.schedule.map(({ type }) => type), ['driver-15']);
  assert.ok(plan.schedule.every(({ fireAt }) => fireAt >= now));
});

test('caps scheduled reminders at twenty within the next seven days', () => {
  const trips = Array.from({ length: 15 }, (_, index) => {
    const startsAt = new Date(now + (12 + index) * 60 * 60_000).toISOString();
    return driverTrip(`trip-${index}`, startsAt);
  });
  const plan = planTripReminders('driver', trips, now, []);
  assert.equal(plan.schedule.length, 20);
  assert.ok(plan.schedule.every(({ fireAt }) => fireAt >= now && fireAt <= now + 7 * 24 * 60 * 60_000));
});
