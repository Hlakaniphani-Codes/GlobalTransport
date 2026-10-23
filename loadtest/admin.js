import { poll, request, thresholds } from './common.js';
import { formatJohannesburgDateTime } from './johannesburg-time.js';

export const options = { thresholds, vus: 5, duration: '2m' };

export default function () {
  poll('admins', '/admin/dashboard/summary', 'admin_dashboard');
  poll('admins', '/admin/trips?page=1&page_size=25', 'admin_trips');
  poll('admins', '/admin/trips/live?page=1&page_size=25', 'admin_live_trips');
  poll('admins', '/admin/needs-attention', 'admin_needs_attention');
  const pending = poll(
    'admins',
    '/admin/ride-requests?page=1&page_size=25&status=pending&unassigned_only=true&sort=asc',
    'admin_pending_requests',
  );
  const rideRequest = pending.json('ride_requests.0');
  if (!rideRequest?.id || __ITER % 10 !== 0) return;

  const time = new Date(rideRequest.scheduled_at);
  const target = formatJohannesburgDateTime(time);
  const pickup = formatJohannesburgDateTime(time, rideRequest.direction === 'to_work' ? -30 : 0);
  const dropoff = formatJohannesburgDateTime(time, rideRequest.direction === 'home' ? 30 : 0);
  const targetTime = target.time;
  const pickupTime = pickup.time;
  const dropoffTime = dropoff.time;
  const created = request('admins', 'POST', '/admin/trips', {
    direction: rideRequest.direction,
    dates: [target.date],
    ...(rideRequest.direction === 'to_work' ? { target_time: targetTime } : {}),
    workplace_name: rideRequest.workplace_name,
    workplace_address: rideRequest.workplace_address,
    stops: [
      { ride_request_id: rideRequest.id, stop_type: 'pickup', sequence: 1, planned_time: pickupTime },
      { ride_request_id: rideRequest.id, stop_type: 'dropoff', sequence: 2, planned_time: dropoffTime },
    ],
  }, 'admin_create_trip');
  const seriesId = created.json('series_id');
  if (!seriesId) return;
  const drivers = request(
    'admins',
    'GET',
    `/admin/series/${seriesId}/eligible-drivers?page=1&page_size=25`,
    undefined,
    'admin_eligible_drivers',
  );
  const eligibleDriver = drivers.json('drivers.0') || drivers.json('eligible_drivers.0');
  if (eligibleDriver?.user_id) {
    request('admins', 'POST', `/admin/series/${seriesId}/offer`, {
      driver_ids: [eligibleDriver.user_id],
      window_minutes: 30,
    }, 'admin_offer_trip');
  }
}
