#!/usr/bin/env node
/**
 * test-reward.js — 觸發／重置「蘇米雪」的獎勵 Banner 狀態
 *
 * 用法：
 *   node test-reward.js <桌號>           # 觸發獎勵（建立15假燈 + 蘇米雪送出）
 *   node test-reward.js <桌號> --reset   # 先清除發言者舊互動再觸發獎勵
 *   node test-reward.js <桌號> --undo    # 重置：清除所有互動，補回15假燈（不含蘇米雪）→ Banner 消失
 *
 * 前提：
 *   1. 伺服器需在 localhost:3000 執行（npm start）
 *   2. Admin 需已設定目前發言者（localhost:3000/admin）
 */

'use strict';

const BASE       = 'http://localhost:3000';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'bni2024';
const MY_NAME    = '蘇米雪';

// ── CLI 參數 ──────────────────────────────────────────────
const args       = process.argv.slice(2);
const tableArg   = args.find(a => /^\d+$/.test(a));
const reset      = args.includes('--reset');
const undo       = args.includes('--undo');

if (!tableArg) {
  console.error('用法：node test-reward.js <桌號> [--reset | --undo]');
  console.error('例如：node test-reward.js 3');
  console.error('      node test-reward.js 3 --undo  # 取消獎勵狀態');
  process.exit(1);
}
const tableNumber = parseInt(tableArg, 10);

// ── 工具 ─────────────────────────────────────────────────
const pad   = n  => String(n).padStart(2, '0');

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': ADMIN_PASS,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...json };
}

// ── 主程式 ────────────────────────────────────────────────
async function main() {
  const runId = Date.now().toString(36).toUpperCase();

  const mode = undo ? '重置模式 --undo' : reset ? '重設模式 --reset' : '觸發模式';
  console.log('\n╔════════════════════════════════════════╗');
  console.log(`║  BNI 獎勵測試  (run: ${runId.padEnd(14)})  ║`);
  console.log(`║  ${mode.padEnd(38)}  ║`);
  console.log('╚════════════════════════════════════════╝\n');

  // ── 確認伺服器 ──
  let speaker;
  try {
    speaker = await api('GET', '/api/current-speaker');
  } catch {
    console.error('❌ 無法連線到 localhost:3000，請先啟動伺服器（npm start）');
    process.exit(1);
  }

  if (!speaker || !speaker.id) {
    console.error('❌ 目前沒有設定發言者。');
    console.error('   請開啟 http://localhost:3000/admin 設定發言者後再執行。');
    process.exit(1);
  }

  console.log(`🎤 發言者：${speaker.name}（第 ${speaker.table_number} 桌，ID: ${speaker.id}）\n`);

  // ── 登入為「蘇米雪」──
  const me = await api('POST', '/api/login', {
    name:        MY_NAME,
    tableNumber: tableNumber,
  });

  if (!me.userId) {
    console.error(`❌ 找不到「${MY_NAME}」（桌號 ${tableNumber}）的帳號。`);
    console.error('   請確認姓名和桌號正確，且已完成過登入。');
    process.exit(1);
  }

  console.log(`👤 找到帳號：${me.name}（第 ${me.tableNumber} 桌，userId: ${me.userId}）\n`);

  // ══════════════════════════════════════════
  // --undo：重置蘇米雪的獎勵狀態
  // ══════════════════════════════════════════
  if (undo) {
    console.log('↩️  重置模式：清除所有互動，補回 15 個假燈（不含蘇米雪）…\n');

    // 1. 清除發言者所有連接
    const del = await api('DELETE', `/api/admin/connections/${speaker.id}`);
    if (del.success) {
      console.log(`🗑  已清除發言者的所有互動（共 ${del.deleted ?? '?'} 筆）`);
    } else {
      console.warn(`⚠️  清除失敗：${del.error || '未知錯誤'}`);
    }

    // 2. 補回 15 個假燈（不含蘇米雪）
    console.log('\n👥 補回 15 個模擬夥伴燈號…\n');
    let refilled = 0;
    for (let i = 1; i <= 15; i++) {
      const fakeName = `測試夥伴${pad(i)}-${runId}`;
      const user = await api('POST', '/api/login', {
        name:        fakeName,
        tableNumber: Math.ceil(i / 3),
        needs:       '（測試帳號）',
        identity:    '來賓',
        isFirstTime: true,
      });
      if (!user.userId) continue;

      const r = await api('POST', '/api/connect', {
        userId:        user.userId,
        participantId: speaker.id,
        type:          'can_provide',
        source:        'speaker',
        reason:        `測試夥伴 #${i} 模擬幫助`,
      });
      if (r.success) {
        refilled++;
        process.stdout.write(`  💡 [${pad(i)}/15] ${fakeName} 亮燈\n`);
      }
    }

    // 3. 確認結果
    const lights = await api('GET', '/api/lights');
    const total  = lights.count || 0;

    console.log('\n────────────────────────────────────────');
    console.log(`💡 目前燈號：${total} 個（蘇米雪沒有 can_provide 記錄）`);
    console.log(`🚫 獎勵 Banner 已消失`);
    console.log(`\n   重新整理「${MY_NAME}」的手機畫面，Banner 應已消失。`);
    console.log();
    return;
  }

  // ══════════════════════════════════════════
  // 一般模式：觸發獎勵
  // ══════════════════════════════════════════

  // ── 清除舊互動（--reset） ──
  if (reset) {
    const r = await api('DELETE', `/api/admin/connections/${speaker.id}`);
    if (r.success) {
      console.log(`🗑  已清除發言者的所有互動（共 ${r.deleted ?? '?'} 筆）\n`);
    } else {
      console.warn(`⚠️  清除失敗：${r.error || '未知錯誤'}\n`);
    }
  }

  // ── 建立 15 個假帳號並送出 can_provide ──
  console.log('👥 建立 15 個模擬夥伴並送出「我可以幫助他」…\n');
  let lightCount = 0;

  for (let i = 1; i <= 15; i++) {
    const fakeName = `測試夥伴${pad(i)}-${runId}`;
    const user = await api('POST', '/api/login', {
      name:        fakeName,
      tableNumber: Math.ceil(i / 3),
      needs:       '（測試帳號）',
      identity:    '來賓',
      isFirstTime: true,
    });

    if (!user.userId) {
      console.log(`  ⚠️  第 ${i} 位建立失敗，跳過`);
      continue;
    }

    const result = await api('POST', '/api/connect', {
      userId:        user.userId,
      participantId: speaker.id,
      type:          'can_provide',
      source:        'speaker',
      reason:        `測試夥伴 #${i} 模擬幫助`,
    });

    if (result.success) {
      lightCount++;
      process.stdout.write(`  💡 [${pad(i)}/15] ${fakeName} 亮燈\n`);
    } else {
      process.stdout.write(`  ❌ [${pad(i)}/15] ${result.error || '失敗'}\n`);
    }
  }

  // ── 讓蘇米雪也送出 can_provide ──
  console.log(`\n🌟 讓「${MY_NAME}」送出「我可以幫助他」…`);

  const myResult = await api('POST', '/api/connect', {
    userId:        me.userId,
    participantId: speaker.id,
    type:          'can_provide',
    source:        'speaker',
    reason:        '我可以提供相關資源與協助',
  });

  if (myResult.success) {
    console.log(`  ✅ ${MY_NAME} 已成功送出！`);
  } else if (myResult.error?.includes('UNIQUE') || myResult.error?.includes('已送出')) {
    console.log(`  ✅ ${MY_NAME} 之前已送出過（保留原記錄）`);
  } else {
    console.log(`  ❌ 送出失敗：${myResult.error || '未知錯誤'}`);
  }

  // ── 確認目前燈號 ──
  const lights = await api('GET', '/api/lights');
  const total  = lights.count || 0;

  console.log('\n────────────────────────────────────────');
  console.log(`💡 目前燈號：${total} 個`);
  console.log(`🎯 達標門檻：15 個`);

  if (total >= 15) {
    console.log('\n🎁 燈號已達標！');
    console.log(`   現在用「${MY_NAME}」帳號登入手機版，`);
    console.log('   「目前發言者」頁籤頂部應出現黃色獎勵 Banner。');
  } else {
    console.log(`\n⚠️  燈號不足（還差 ${15 - total} 個），Banner 不會顯示。`);
    console.log('   嘗試加上 --reset 清除舊記錄後重跑。');
  }

  console.log();
}

main().catch(err => {
  console.error('\n❌ 執行錯誤：', err.message);
  process.exit(1);
});
