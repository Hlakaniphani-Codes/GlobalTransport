const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPassengerEta } = require('../src/services/passengerTripService');

function fixture(now) {
  const plannedCurrent = new Date(now + 10 * 60_000).toISOString();
  const updatedAt = new Date(now).toISOString();
  const etaAt = new Date(now + 20 * 60_000).toISOString();
  const currentPickup = {
    id: 'mine-pickup',
    sequence: 1,
    stop_type: 'pickup',
    address: '1 Main Road',
    suburb: 'Midrand',
    planned_at: plannedCurrent,
    status: 'en_route',
    eta_at: etaAt,
    eta_updated_at: updatedAt,
  };
  const otherPickup = {
    ...currentPickup,
    id: 'other-pickup',
    sequence: 2,
    eta_at: etaAt,
    eta_updated_at: updatedAt,
  };
  const laterOwnStop = {
    id: 'mine-dropoff',
    sequence: 4,
    stop_type: 'dropoff',
    address: '10 Work Road',
    suburb: 'Midrand',
    planned_at: new Date(now + 60 * 60_000).toISOString(),
    status: 'pending',
    eta_at: null,
    eta_updated_at: null,
  };
  return {
    allStops: [currentPickup, otherPickup, {
      ...laterOwnStop, id: 'other-dropoff', sequence: 3, ride_request_id: 'other-request',
    }, laterOwnStop],
    ownStops: [currentPickup, laterOwnStop],
    currentPickup,
    laterOwnStop,
  };
}

test('passenger ETA exposes only their current pickup and projects later own stops', () => {
  const now = Date.now();
  const data = fixture(now);
  const eta = buildPassengerEta(data.allStops, data.ownStops, now);

  assert.equal(eta.etaPhaseHint, 'arriving_at');
  assert.equal(eta.etaUpdatedAt, new Date(now).toISOString());
  assert.equal(eta.ownStops[0].eta_at, new Date(now + 20 * 60_000).toISOString());
  assert.equal(eta.ownStops[1].projected_at, new Date(now + 70 * 60_000).toISOString());
  assert.equal(Object.hasOwn(eta.ownStops[1], 'eta_at'), false);
  assert.equal(JSON.stringify(eta).includes('other-pickup'), false);
});

test('passenger ETA hides stale and overdue times with the requested phase hints', () => {
  const now = Date.now();
  const stale = fixture(now);
  stale.currentPickup.eta_updated_at = new Date(now - 16 * 60_000).toISOString();
  stale.ownStops[0].eta_updated_at = stale.currentPickup.eta_updated_at;
  const staleEta = buildPassengerEta(stale.allStops, stale.ownStops, now);
  assert.equal(staleEta.etaPhaseHint, 'on_the_way');
  assert.equal(staleEta.ownStops[0].eta_at, null);
  assert.equal(staleEta.ownStops[1].projected_at, null);

  const late = fixture(now);
  late.currentPickup.eta_at = new Date(now - 6 * 60_000).toISOString();
  late.ownStops[0].eta_at = late.currentPickup.eta_at;
  const lateEta = buildPassengerEta(late.allStops, late.ownStops, now);
  assert.equal(lateEta.etaPhaseHint, 'little_late');
  assert.equal(lateEta.ownStops[0].eta_at, null);
});
