import { poll, thresholds } from './common.js';

export const options = {
  scenarios: {
    shift_change: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 1000 },
        { duration: '5m', target: 1000 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds,
};

export default function () {
  const role = __VU % 100 < 85 ? 'passengers' : 'drivers';
  poll(role, role === 'passengers' ? '/rides/trips?page_size=25' : '/driver/home');
}
