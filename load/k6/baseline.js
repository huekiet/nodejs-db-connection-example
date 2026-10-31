import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3101';

export const options = {
  scenarios: { steady: { executor: 'constant-vus', vus: 10, duration: '30s' } },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(95)<100'],
  },
};

export default function () {
  const res = http.get(`${BASE}/fast`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
