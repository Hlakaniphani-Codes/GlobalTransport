import { poll, thresholds } from './common.js';

export const options = {
  scenarios: {
    passengers: { executor: 'constant-vus', exec: 'passenger', vus: 700, duration: '5m' },
    drivers: { executor: 'constant-vus', exec: 'driver', vus: 250, duration: '5m' },
    admins: { executor: 'constant-vus', exec: 'admin', vus: 50, duration: '5m' },
  },
  thresholds,
};

export function passenger() {
  poll('passengers', '/rides/trips?page_size=25');
}

export function driver() {
  poll('drivers', '/driver/home');
}

export function admin() {
  poll('admins', '/admin/trips?page=1&page_size=25');
}

export default passenger;
