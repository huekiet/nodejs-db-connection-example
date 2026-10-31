import http from 'k6/http';
import { check } from 'k6';

const URLS = (__ENV.BASE_URLS || 'http://host.docker.internal:3101').split(',');

export const options = {
  scenarios: { pin: { executor: 'constant-vus', vus: 120, duration: '60s' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const base = URLS[(__VU - 1) % URLS.length];
  const res = http.get(`${base}/hold?ms=1000`);
  check(res, { 'status 200': (r) => r.status === 200 });
}