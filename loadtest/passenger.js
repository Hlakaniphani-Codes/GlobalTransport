import { poll, request, thresholds } from './common.js';
import { formatJohannesburgDateTime } from './johannesburg-time.js';

export const options = { thresholds, vus: 25, duration: '2m' };

export default function () {
  poll('passengers', '/rides/trips?page_size=25', 'passenger_upcoming_trips');
  poll('passengers', '/rides/trips?scope=history&page_size=25', 'passenger_trip_history');
  poll('passengers', '/rides/requests?page_size=25', 'passenger_requests');
  poll('passengers', '/notifications', 'passenger_notifications');
  const { date: localDate, time: localTime } = formatJohannesburgDateTime(Date.now() + 2 * 60 * 60 * 1000);
  const created = request('passengers', 'POST', '/rides/requests', {
    direction: 'to_work',
    date: localDate,
    time: localTime,
  }, 'passenger_request_create');
  const requestId = created.json('ride_request.id');
  if (created.status === 201 && requestId) {
    request('passengers', 'POST', `/rides/requests/${requestId}/cancel`, { scope: 'this' }, 'passenger_request_cancel');
  }
}
