import {
  fixtureFor,
  poll,
  request,
  setTokenIndex,
  thresholds,
  tripsForDriver,
} from './common.js';

export const options = { thresholds, vus: 150, duration: '2m' };

export default function () {
  const driverIndex = (__VU - 1) % 150;
  setTokenIndex('drivers', driverIndex);
  const driver = fixtureFor('drivers', driverIndex);
  poll('drivers', '/driver/home', 'driver_home');
  poll('drivers', '/driver/offers?page_size=25', 'driver_offers');
  poll('drivers', '/driver/trips?page_size=25', 'driver_trips');
  const offers = poll('drivers', '/driver/offers?page_size=25', 'driver_offer_actions');
  if (__ITER !== 0) return;
  const offer = offers.json('offers.0');
  if (offer?.id) {
    request('drivers', 'POST', `/driver/offers/${offer.id}/accept`, {}, 'driver_accept_offer');
  }

  const trips = tripsForDriver(driver.user_id);
  const acceptedTrip = trips.find((candidate) => candidate.status === 'accepted');
  if (acceptedTrip && Date.parse(acceptedTrip.starts_at) <= Date.now() + 90 * 60_000) {
    request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/start`, {}, 'driver_trip_start');
    const pickup = acceptedTrip.stops.find((stop) => stop.type === 'pickup');
    const dropoff = acceptedTrip.stops.find((stop) => stop.type === 'dropoff');
    if (pickup?.id && dropoff?.id) {
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${pickup.id}/eta`, {
        minutes: 5,
      }, 'driver_pickup_eta');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${pickup.id}/arrive`, {}, 'driver_pickup_arrive');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${pickup.id}/complete`, {
        passenger_stop_ids: [pickup.id],
      }, 'driver_pickup_complete');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${dropoff.id}/eta`, {
        minutes: 10,
      }, 'driver_dropoff_eta');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${dropoff.id}/arrive`, {}, 'driver_dropoff_arrive');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/stops/${dropoff.id}/complete`, {
        passenger_stop_ids: [dropoff.id],
      }, 'driver_dropoff_complete');
      request('drivers', 'POST', `/driver/trips/${acceptedTrip.id}/complete`, undefined, 'driver_trip_complete');
    }
  }

  const inProgressTrip = trips.find((candidate) => candidate.status === 'in_progress');
  const activeDropoff = inProgressTrip?.stops.find((stop) => stop.type === 'dropoff');
  if (!inProgressTrip || !activeDropoff || !['en_route', 'arrived'].includes(activeDropoff.status)) return;
  if (activeDropoff.status === 'en_route') {
    request('drivers', 'POST', `/driver/trips/${inProgressTrip.id}/stops/${activeDropoff.id}/eta`, {
      minutes: 5,
    }, 'driver_stop_eta');
  }
  request('drivers', 'POST', `/driver/trips/${inProgressTrip.id}/stops/${activeDropoff.id}/arrive`, {}, 'driver_stop_arrive');
  request('drivers', 'POST', `/driver/trips/${inProgressTrip.id}/stops/${activeDropoff.id}/complete`, {
    passenger_stop_ids: [activeDropoff.id],
  }, 'driver_stop_complete');
  request('drivers', 'POST', `/driver/trips/${inProgressTrip.id}/complete`, undefined, 'driver_trip_complete');
}
