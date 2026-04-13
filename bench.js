/**
 * BNI 壓力測試腳本 — bench.js
 * 用法：k6 run --vus N --duration 30s bench.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const errorRate = new Rate('error_rate');

const NAMES  = ['王建宏','李雅慧','陳志明','林美玲','張偉強','黃淑芬','吳宗翰','劉靜怡','蔡佳穎','周明德'];
const ROLES  = ['長榮會員', '來賓', '親友'];
const TYPES  = ['want_to_meet', 'can_provide'];
const SOURCES = ['speaker', 'browse'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export default function () {
  const headers = { 'Content-Type': 'application/json' };

  // 1. 登入
  const loginRes = http.post(`${BASE_URL}/api/login`,
    JSON.stringify({ name: rand(NAMES) + __VU, role: rand(ROLES) }),
    { headers }
  );
  const loginOk = check(loginRes, { 'login 200': r => r.status === 200 });
  errorRate.add(!loginOk);
  if (!loginOk) return;

  const userId = JSON.parse(loginRes.body).userId;
  sleep(0.3);

  // 2. 載入參與者名單
  const partRes = http.get(`${BASE_URL}/api/participants`, { headers });
  const partOk = check(partRes, { 'participants 200': r => r.status === 200 });
  errorRate.add(!partOk);

  let participants = [];
  try { participants = JSON.parse(partRes.body); } catch { /* skip */ }
  sleep(0.2);

  // 3. 輪詢發言者（最高頻操作）
  const spkRes = http.get(`${BASE_URL}/api/current-speaker`, { headers });
  const spkOk = check(spkRes, { 'speaker 200': r => r.status === 200 });
  errorRate.add(!spkOk);
  sleep(0.2);

  // 4. 載入個人媒合記錄
  const connRes = http.get(`${BASE_URL}/api/connections?userId=${userId}`, { headers });
  check(connRes, { 'connections 200': r => r.status === 200 });
  sleep(0.2);

  // 5. 標記媒合（50% 機率）
  if (participants.length > 0 && Math.random() < 0.5) {
    const p = rand(participants);
    const connectRes = http.post(`${BASE_URL}/api/connect`,
      JSON.stringify({ userId, participantId: p.id, type: rand(TYPES), source: rand(SOURCES) }),
      { headers }
    );
    check(connectRes, { 'connect 200': r => r.status === 200 });
    errorRate.add(connectRes.status !== 200);
  }

  sleep(0.5);
}
