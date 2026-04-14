#!/usr/bin/env node
/**
 * test-report.js — 為「蘇米飯」建立商機小錦囊測試資料
 *
 * 用法：
 *   node test-report.js           # 建立測試資料
 *   node test-report.js --verify  # 驗證 API 回傳內容（不建立新資料）
 *
 * 前提：伺服器需在 localhost:3000 執行（npm start）
 *
 * 建立後，用以下資訊在手機端查看商機小錦囊：
 *   姓名：蘇米飯
 *   Email：sumiifan.test@bni.com
 */

'use strict';

const BASE      = 'http://localhost:3000';
const MY_NAME   = '蘇米飯';
const MY_EMAIL  = 'sumiifan.test@bni.com';
const MY_TABLE  = 8;

// ── 工具 ─────────────────────────────────────────────────
async function api(method, path, body, adminPass) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (adminPass) opts.headers['x-admin-password'] = adminPass;
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...json };
}

// 若使用者已存在，先刪除再建立（確保 email 正確寫入）
async function createUser(name, table, identity, needs, email) {
  const existing = await api('POST', '/api/login', { name, tableNumber: table });
  if (existing.userId) {
    await api('DELETE', `/api/admin/participant/${existing.userId}`, null, process.env.ADMIN_PASSWORD || 'bni2024');
  }
  return api('POST', '/api/login', { name, tableNumber: table, identity, needs, email, isFirstTime: true });
}

async function connect(userId, participantId, type, reason) {
  return api('POST', '/api/connect', { userId, participantId, type, source: 'browse', reason });
}

function ok(label)   { console.log(`  ✅ ${label}`); }
function skip(label) { console.log(`  ⏭  ${label}（已存在）`); }
function fail(label) { console.log(`  ❌ ${label}`); }

// ── 測試資料定義 ────────────────────────────────────────
// 3 人想認識蘇米飯（部分有 email，部分沒有）
const MEETERS = [
  { name: '王大明', table: 2, identity: '長榮會員', needs: '尋找科技業合作夥伴',    email: 'damingwang@bni.com',  reason: '蘇米飯的餐飲背景很特別，想了解是否有合作餐廳的可能' },
  { name: '林佳慧', table: 5, identity: '來賓',     needs: '希望拓展人脈到各行各業', email: null,                  reason: '聽到蘇米飯的自我介紹很感興趣，想進一步了解她的事業' },
  { name: '陳志豪', table: 3, identity: '長榮會員', needs: '找尋餐飲供應商合作',     email: 'zhihao.chen@bni.com', reason: '我的客戶有餐飲需求，想認識蘇米飯聊聊媒合機會' },
];

// 3 人可以幫助蘇米飯（部分有 email，部分沒有）
const HELPERS = [
  { name: '張雅婷', table: 1, identity: '長榮會員', needs: '尋找行銷合作夥伴', email: 'yating.zhang@bni.com', reason: '我有豐富的食品行銷資源，可以協助蘇米飯的品牌推廣' },
  { name: '李明哲', table: 6, identity: '長榮會員', needs: '拓展企業客戶',     email: null,                   reason: '我的企業客戶有餐飲採購需求，可以幫忙引薦' },
  { name: '黃淑芬', table: 4, identity: '來賓',     needs: '尋找創業夥伴',     email: null,                   reason: '我認識很多餐飲創業者，可以協助建立人脈網絡' },
];

// 蘇米飯想認識的 3 人（部分有 email，部分沒有）
const MY_WANTS = [
  { name: '吳建國', table: 7,  identity: '長榮會員', needs: '尋找品牌設計合作', email: 'jianguo.wu@bni.com', reason: '對方在品牌設計領域很有經驗，想學習如何打造餐飲品牌' },
  { name: '蔡怡君', table: 10, identity: '長榮會員', needs: '拓展網路銷售通路', email: null,                  reason: '想了解電商平台如何幫助餐飲業者增加銷售' },
  { name: '周志明', table: 2,  identity: '來賓',     needs: '尋找投資合作機會', email: null,                  reason: '聽說對方有投資餐飲業的興趣，想進一步洽談' },
];

// ── 主程式 ────────────────────────────────────────────────
async function main() {
  const verify = process.argv.includes('--verify');

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  商機小錦囊測試資料產生器（蘇米飯）         ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // ── 確認伺服器 ──
  try {
    await api('GET', '/api/event-state');
  } catch {
    console.error('❌ 無法連線到 localhost:3000，請先啟動伺服器（npm start）');
    process.exit(1);
  }

  // ── --verify 模式：直接查詢報表 ──
  if (verify) {
    console.log(`🔍 驗證模式：查詢「${MY_NAME}」的商機小錦囊…\n`);
    const r = await api('POST', '/api/my-report', { name: MY_NAME, email: MY_EMAIL });
    if (!r.ok) {
      console.error(`❌ 查詢失敗：${r.error}`);
      process.exit(1);
    }
    console.log(`👤 ${r.name}（${r.identity}）\n`);
    const emailStr = p => p.email ? `✉️ ${p.email}` : '✉️ 未填寫';
    console.log(`🤝 想認識你的人（${r.meeters?.length ?? 0} 筆）：`);
    r.meeters?.forEach(p => console.log(`   - ${p.name}（${p.identity}）${emailStr(p)}：${p.reason}`));
    console.log(`\n💡 可以幫助你的人（${r.helpers?.length ?? 0} 筆）：`);
    r.helpers?.forEach(p => console.log(`   - ${p.name}（${p.identity}）${emailStr(p)}：${p.reason}`));
    console.log(`\n🌟 你想認識的人（${r.myWants?.length ?? 0} 筆）：`);
    r.myWants?.forEach(p => console.log(`   - ${p.name}（${p.identity}）第 ${p.table_number} 桌 ${emailStr(p)}：${p.reason}`));
    console.log();
    return;
  }

  // ── STEP 1：建立或取得「蘇米飯」帳號 ──
  console.log(`👤 STEP 1：建立「${MY_NAME}」帳號…`);
  const me = await createUser(MY_NAME, MY_TABLE, '長榮會員', '希望拓展餐飲事業的商業合作', MY_EMAIL);
  if (me.userId) {
    ok(`${MY_NAME}（userId: ${me.userId}，桌號: ${MY_TABLE}，Email: ${MY_EMAIL}）`);
  } else if (me.error?.includes('UNIQUE') || me.status === 200) {
    skip(MY_NAME);
    // 用 session 恢復取得 userId
    const existing = await api('POST', '/api/login', { name: MY_NAME, tableNumber: MY_TABLE });
    me.userId = existing.userId;
  } else {
    fail(`建立失敗：${me.error}`);
    process.exit(1);
  }
  const myId = me.userId;

  // ── STEP 2：建立「想認識蘇米飯的人」並送出 want_to_meet ──
  console.log('\n🤝 STEP 2：建立想認識蘇米飯的人…');
  for (const p of MEETERS) {
    const u = await createUser(p.name, p.table, p.identity, p.needs, p.email);
    if (!u.userId) { fail(`建立 ${p.name} 失敗`); continue; }
    const r = await connect(u.userId, myId, 'want_to_meet', p.reason);
    if (r.success) ok(`${p.name} 想認識蘇米飯${p.email ? `（${p.email}）` : '（無 Email）'}`);
    else if (r.error?.includes('UNIQUE') || r.error?.includes('已送出')) skip(`${p.name} 已送出`);
    else fail(`${p.name} 送出失敗：${r.error}`);
  }

  // ── STEP 3：建立「可以幫助蘇米飯的人」並送出 can_provide ──
  console.log('\n💡 STEP 3：建立可以幫助蘇米飯的人…');
  for (const p of HELPERS) {
    const u = await createUser(p.name, p.table, p.identity, p.needs, p.email);
    if (!u.userId) { fail(`建立 ${p.name} 失敗`); continue; }
    const r = await connect(u.userId, myId, 'can_provide', p.reason);
    if (r.success) ok(`${p.name} 可以幫助蘇米飯${p.email ? `（${p.email}）` : '（無 Email）'}`);
    else if (r.error?.includes('UNIQUE') || r.error?.includes('已送出')) skip(`${p.name} 已送出`);
    else fail(`${p.name} 送出失敗：${r.error}`);
  }

  // ── STEP 4：蘇米飯想認識的人 ──
  console.log('\n🌟 STEP 4：蘇米飯想認識的人…');
  for (const p of MY_WANTS) {
    const u = await createUser(p.name, p.table, p.identity, p.needs, p.email);
    if (!u.userId) { fail(`建立 ${p.name} 失敗`); continue; }
    const r = await connect(myId, u.userId, 'want_to_meet', p.reason);
    if (r.success) ok(`蘇米飯想認識 ${p.name}（第 ${p.table} 桌${p.email ? `・${p.email}` : '・無 Email'}）`);
    else if (r.error?.includes('UNIQUE') || r.error?.includes('已送出')) skip(`已送出 → ${p.name}`);
    else fail(`送出失敗：${r.error}`);
  }

  // ── 完成 ──
  console.log('\n────────────────────────────────────────────');
  console.log('✅ 測試資料建立完成！\n');
  console.log('📱 查看商機小錦囊：');
  console.log(`   1. Admin 後台將 phase 切換為「結束」`);
  console.log(`   2. 手機開啟 app，用「${MY_NAME}」的帳號登入`);
  console.log(`   3. 出現 Email 驗證框時，輸入：`);
  console.log(`      ${MY_EMAIL}`);
  console.log('\n🔍 或直接驗證 API 資料：');
  console.log('   node test-report.js --verify\n');
}

main().catch(err => {
  console.error('\n❌ 執行錯誤：', err.message);
  process.exit(1);
});
