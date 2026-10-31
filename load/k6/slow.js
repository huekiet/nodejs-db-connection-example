import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: {
    arrive: {
      executor: 'ramping-arrival-rate',
      startRate: 10, timeUnit: '1s',
      preAllocatedVUs: 100, maxVUs: 400,
      stages: [
        { target: 20, duration: '20s' },
        { target: 100, duration: '60s' },
        { target: 100, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  http.get(`${BASE}/slow?ms=300`);
}
