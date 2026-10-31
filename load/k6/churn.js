import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: {
    churn: {
      executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s',
      duration: '60s', preAllocatedVUs: 50, maxVUs: 150,
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

export default function () {
  http.get(`${BASE}/churn`);
}