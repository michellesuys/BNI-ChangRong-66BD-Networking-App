/**
 * BNI 商務交流媒合系統 — k6 負載測試
 *
 * 模擬 100 位使用者同時使用的真實情境：
 *   1. 登入
 *   2. 載入參與者名單
 *   3. 每 5 秒輪詢發言者（與 app 行為一致）
 *   4. 瀏覽名單並標記媒合
 *
 * 執行方式：
 *   k6 run load-test.js
 *   k6 run --env BASE_URL=https://你的網域 load-test.js
 */

import http from 'k6/http';
import { sleep, check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── 目標網址（預設本機，可透過 --env 覆寫）──────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// ── 自訂指標 ───────────────────────────────────────────────
const loginFailRate    = new Rate('login_fail_rate');
const connectFailRate  = new Rate('connect_fail_rate');
const speakerPollTime  = new Trend('speaker_poll_duration', true);

// ── 模擬情境設定 ────────────────────────────────────────────
export const options = {
  scenarios: {
    // 場景一：100 位使用者在 30 秒內陸續進場，模擬活動開始
    participants: {
      executor: 'ramping-vus',   // 逐步增加虛擬使用者
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 }, // 30 秒內增加到 100 人
        { duration: '2m',  target: 100 }, // 維持 100 人 2 分鐘
        { duration: '15s', target: 0   }, // 15 秒內全部離開
      ],
    },
  },
  thresholds: {
    // 效能門檻：不符合則測試視為失敗
    http_req_duration:    ['p(95)<800'],  // 95% 請求在 800ms 內完成
    http_req_failed:      ['rate<0.01'],  // 錯誤率 < 1%
    login_fail_rate:      ['rate<0.01'],
    connect_fail_rate:    ['rate<0.02'],
    speaker_poll_duration: ['p(95)<500'],
  },
};

// ── 模擬姓名資料 ────────────────────────────────────────────
const NAMES = [
  '王建宏','李雅慧','陳志明','林美玲','張偉強','黃淑芬','吳宗翰','劉靜怡',
  '蔡佳穎','周明德','許淑惠','鄭文凱','謝雅婷','洪志豪','邱美芳','楊俊傑',
  '施雅文','廖建志','盧淑貞','宋志遠','韓美玲','賴宗霖','江淑芳','何志強',
];
const ROLES = ['長榮會員', '來賓', '親友'];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── 主要測試流程（每位虛擬使用者執行一次）──────────────────
export default function () {
  const headers = { 'Content-Type': 'application/json' };

  // ── Step 1：登入 ─────────────────────────────────────────
  let userId = null;

  group('01_login', () => {
    const payload = JSON.stringify({
      name: randomItem(NAMES) + Math.floor(Math.random() * 999),
      role: randomItem(ROLES),
    });

    const res = http.post(`${BASE_URL}/api/login`, payload, { headers });

    const ok = check(res, {
      'login status 200': r => r.status === 200,
      'login returns userId': r => {
        try { return JSON.parse(r.body).userId > 0; } catch { return false; }
      },
    });

    loginFailRate.add(!ok);

    if (ok) {
      try { userId = JSON.parse(res.body).userId; } catch { /* skip */ }
    }
  });

  if (!userId) return; // 登入失敗則跳過後續步驟

  sleep(0.5); // 模擬使用者登入後短暫停頓

  // ── Step 2：載入參與者名單 ──────────────────────────────
  group('02_load_participants', () => {
    const res = http.get(`${BASE_URL}/api/participants`, { headers });
    check(res, {
      'participants status 200': r => r.status === 200,
      'participants is array': r => {
        try { return Array.isArray(JSON.parse(r.body)); } catch { return false; }
      },
    });
  });

  // ── Step 3：同時載入連線記錄 ────────────────────────────
  group('03_load_connections', () => {
    const res = http.get(`${BASE_URL}/api/connections?userId=${userId}`, { headers });
    check(res, {
      'connections status 200': r => r.status === 200,
    });
  });

  sleep(1);

  // ── Step 4：模擬活動進行中，每 5 秒輪詢發言者（共 6 次）─
  let participants = [];

  // 先取得名單供後續媒合使用
  try {
    const r = http.get(`${BASE_URL}/api/participants`, { headers });
    participants = JSON.parse(r.body);
  } catch { /* skip */ }

  for (let poll = 0; poll < 6; poll++) {
    group('04_poll_speaker', () => {
      const start = Date.now();
      const res = http.get(`${BASE_URL}/api/current-speaker`, { headers });
      speakerPollTime.add(Date.now() - start);

      check(res, {
        'speaker poll status 200': r => r.status === 200,
      });

      // 如果有發言者，隨機模擬標記行為（40% 機率）
      if (res.status === 200 && participants.length > 0 && Math.random() < 0.4) {
        try {
          const speaker = JSON.parse(res.body);
          if (speaker && speaker.id) {
            const type = Math.random() < 0.5 ? 'want_to_meet' : 'can_provide';
            group('05_connect_speaker', () => {
              const connectRes = http.post(
                `${BASE_URL}/api/connect`,
                JSON.stringify({ userId, participantId: speaker.id, type, source: 'speaker' }),
                { headers }
              );
              connectFailRate.add(connectRes.status !== 200);
            });
          }
        } catch { /* skip */ }
      }
    });

    sleep(5); // 與 app 輪詢間隔一致
  }

  // ── Step 5：瀏覽名單並標記最多 3 位（模擬來賓頁操作）──
  if (participants.length > 0) {
    const picks = participants
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.floor(Math.random() * 3) + 1);

    picks.forEach(p => {
      group('06_connect_browse', () => {
        const type = Math.random() < 0.6 ? 'want_to_meet' : 'can_provide';
        const res = http.post(
          `${BASE_URL}/api/connect`,
          JSON.stringify({ userId, participantId: p.id, type, source: 'browse' }),
          { headers }
        );
        connectFailRate.add(res.status !== 200);
        sleep(0.3 + Math.random() * 0.7); // 模擬使用者點擊間隔
      });
    });
  }

  sleep(2);
}
