import { poll, thresholds } from './common.js';

export const options = {
  scenarios: {
    soak: { executor: 'constant-vus', vus: 300, duration: '30m' },
  },
  thresholds,
};

export default function () {
  const role = __VU % 5 === 0 ? 'drivers' : 'passengers';
  poll(role, role === 'drivers' ? '/driver/home' : '/rides/trips?page_size=25');
}
