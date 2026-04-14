#!/usr/bin/env node
/**
 * simulate-lights.js — 模擬台下夥伴按「我可以幫助他」的燈號效果
 *
 * 用法：
 *   node simulate-lights.js 5       # 模擬 5 人
 *   node simulate-lights.js 10      # 模擬 10 人
 *   node simulate-lights.js 15      # 模擬 15 人（達到禮品門檻）
 *   node simulate-lights.js 20      # 模擬 20 人（全滿，跑馬燈）
 *   node simulate-lights.js 30      # 模擬 30 人（超過上限，燈號仍 cap 在 20）
 *   node simulate-lights.js 10 --reset  # 先清除此發言者的舊互動，再模擬
 *
 * 前提：伺服器需在 localhost:3000 執行，且已在 Admin 設定目前發言者。
 */

'use strict';

const BASE       = 'http://localhost:3000';
const WINDOW_MS  = 15_000;   // 全部互動隨機分佈在 15 秒內
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'bni2024';

// ── CLI 參數 ──────────────────────────────────────────────
const args  = process.argv.slice(2);
const count = parseInt(args.find(a => /^\d+$/.test(a)) ?? '10', 10);
const reset = args.includes('--reset');

if (isNaN(count) || count < 1) {
  console.error('用法：node simulate-lights.js [人數] [--reset]');
  process.exit(1);
}

// ── 工具 ─────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pad    = n  => String(n).padStart(2, '0');
const stamp  = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': ADMIN_PASS,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...json };
}

// ── API 呼叫 ──────────────────────────────────────────────
async function getSpeaker() {
  return api('GET', '/api/current-speaker');
}

async function createTestUser(index, runId) {
  return api('POST', '/api/login', {
    name:        `模擬夥伴${String(index).padStart(3,'0')}-${runId}`,
    tableNumber: Math.ceil(index / 3),   // 每桌約 3 人
    needs:       '（模擬測試帳號）',
    identity:    '來賓',
    isFirstTime: true,
  });
}

async function submitHelp(userId, speakerId, index) {
  return api('POST', '/api/connect', {
    userId,
    participantId: speakerId,
    type:   'can_provide',
    source: 'speaker',
    reason: `模擬夥伴 #${index} 送出的幫助`,
  });
}

async function resetSpeakerConnections(speakerId) {
  const r = await api('DELETE', `/api/admin/connections/${speakerId}`);
  if (r.success) {
    console.log(`  🗑  已清除發言者 ID ${speakerId} 的所有互動記錄（共 ${r.deleted ?? '?'} 筆）\n`);
  } else {
    console.warn(`  ⚠️  清除失敗：${r.error || '未知錯誤'}\n`);
  }
}

// ── 進度列 ────────────────────────────────────────────────
function progressBar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${done}/${total}`;
}

// ── 主程式 ────────────────────────────────────────────────
async function main() {
  const runId = Date.now().toString(36).toUpperCase(); // 短識別碼，避免重複名稱

  console.log('\n╔════════════════════════════════════════╗');
  console.log(`║  BNI 燈號模擬器  (run: ${runId.padEnd(14)})  ║`);
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`  人數：${count} 人`);
  console.log(`  時間窗：${WINDOW_MS / 1000} 秒（互動隨機分佈）`);
  console.log(`  重置：${reset ? '是' : '否'}\n`);

  // ── 確認伺服器 ──
  let speaker;
  try {
    speaker = await getSpeaker();
  } catch {
    console.error('❌ 無法連線到 localhost:3000，請先啟動伺服器（npm start）');
    process.exit(1);
  }

  if (!speaker || !speaker.id) {
    console.error('❌ 目前沒有設定發言者。');
    console.error('   請開啟 http://localhost:3000/admin 設定發言者後再執行。');
    process.exit(1);
  }

  console.log(`🎤 發言者：${speaker.name}（第 ${speaker.table_number} 桌）`);
  console.log(`   ID：${speaker.id}\n`);

  if (reset) await resetSpeakerConnections(speaker.id);

  // ── 建立測試使用者 ──
  process.stdout.write('👥 建立測試帳號…  ');
  const users = [];
  for (let i = 1; i <= count; i++) {
    const u = await createTestUser(i, runId);
    if (!u.userId) {
      console.warn(`\n  ⚠️  第 ${i} 位建立失敗：${u.error || '未知錯誤'}`);
      continue;
    }
    users.push({ ...u, simIndex: i });
    process.stdout.write(`\r👥 建立測試帳號…  ${progressBar(i, count)}`);
  }
  console.log(`\n  ✅ 成功建立 ${users.length} 位模擬夥伴\n`);

  if (users.length === 0) {
    console.error('❌ 沒有可用的測試帳號，中止。');
    process.exit(1);
  }

  // ── 分配隨機延遲，模擬「不同時」行為 ──
  // 使用 uniform random，再加一點 cluster 感（偶爾兩人接近）
  const delays = users.map(() => Math.random() * WINDOW_MS);
  delays.sort((a, b) => a - b); // 排序後方便觀察

  console.log('🔔 開始模擬按燈，請切換到 display 頁面觀察效果…\n');
  console.log('  時間      夥伴                    結果');
  console.log('  ────────  ──────────────────────  ──────────────────');

  let success = 0;
  let skipped = 0;

  const startTime = Date.now();

  const tasks = users.map((user, idx) => {
    const delay = delays[idx];
    return sleep(delay).then(async () => {
      const result = await submitHelp(user.userId, speaker.id, user.simIndex);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1).padStart(4);
      const name    = (user.name || `夥伴${user.simIndex}`).padEnd(20);

      if (result.success) {
        success++;
        console.log(`  +${elapsed}s   ${name}  💡 亮燈！`);
      } else if (result.error?.includes('UNIQUE') || result.error?.includes('已送出')) {
        skipped++;
        console.log(`  +${elapsed}s   ${name}  ⏭  已送出過（跳過）`);
      } else {
        console.log(`  +${elapsed}s   ${name}  ❌ ${result.error || '失敗'}`);
      }
    });
  });

  await Promise.all(tasks);

  // ── 結果摘要 ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n  ────────────────────────────────────────────────');
  console.log(`  ✅ 完成！耗時 ${elapsed} 秒`);
  console.log(`  💡 成功亮燈：${success} 筆`);
  if (skipped) console.log(`  ⏭  已重複跳過：${skipped} 筆`);
  console.log(`  🎯 燈號上限：20（超過後 display 頁維持滿燈跑馬燈）`);

  if (count >= 15) console.log('\n  🎁 已達 15 燈門檻 → display 應顯示兌換禮品 Banner');
  if (count >= 20) console.log('  🌟 已達 20 燈 → display 應顯示金色跑馬燈滿燈動畫');
  console.log();
}

main().catch(err => {
  console.error('\n❌ 執行錯誤：', err.message);
  process.exit(1);
});
