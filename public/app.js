'use strict';

// ════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════
const state = {
  user: null,            // { userId, name, identity, tableNumber, needs, email }
  participants: [],      // all participants from server
  currentSpeaker: null,  // speaker object or null
  speakerLightCount: 0,  // current speaker's can_provide light count
  /**
   * connections: { [participantId]: { [type]: { source, reason } } }
   * Once submitted, entries are immutable (no toggle/delete)
   */
  connections: {},
  activeTab: 'speaker',
  speakerPollTimer: null,
};

// ════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════
async function init() {
  const saved = localStorage.getItem('bni_session');
  if (saved) {
    try {
      const session = JSON.parse(saved);
      // Verify session by attempting login with name+tableNumber
      const data = await api('POST', '/api/login', {
        name: session.name,
        tableNumber: session.tableNumber,
      });
      state.user = {
        userId: data.userId,
        name: data.name,
        identity: data.identity,
        tableNumber: data.tableNumber,
        needs: data.needs,
        email: data.email,
      };
      localStorage.setItem('bni_session', JSON.stringify({ name: state.user.name, tableNumber: state.user.tableNumber }));
      await startApp();
      return;
    } catch {
      localStorage.removeItem('bni_session');
    }
  }
  showScreen('login');
  showReturnLogin();
}

async function startApp() {
  showScreen('main');
  updateHeaderUser();
  await Promise.all([
    loadParticipants(),
    loadUserConnections(),
    loadCurrentSpeaker(),
  ]);
  startSpeakerPolling();
  try {
    const eventState = await api('GET', '/api/event-state');
    applyPhase(eventState.phase);
  } catch (_) {}
  connectSSE();
}

// ════════════════════════════════════════════════
// API HELPERS
// ════════════════════════════════════════════════
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '請求失敗');
  return data;
}

// ════════════════════════════════════════════════
// DATA LOADERS
// ════════════════════════════════════════════════
async function loadParticipants() {
  try {
    state.participants = await api('GET', '/api/participants');
  } catch (e) {
    console.error('loadParticipants:', e);
  }
}

async function loadCurrentSpeaker() {
  try {
    const speaker = await api('GET', '/api/current-speaker');
    const changed = JSON.stringify(speaker) !== JSON.stringify(state.currentSpeaker);
    state.currentSpeaker = speaker;

    // Load light count for reward check
    if (speaker) {
      try {
        const lights = await api('GET', '/api/lights');
        state.speakerLightCount = lights.count || 0;
      } catch (_) {}
    } else {
      state.speakerLightCount = 0;
    }

    if (changed && state.activeTab === 'speaker') renderSpeaker();
    updateRewardBanner();
  } catch (e) {
    console.error('loadCurrentSpeaker:', e);
  }
}

async function loadUserConnections() {
  try {
    const conns = await api('GET', `/api/connections?userId=${state.user.userId}`);
    state.connections = {};
    for (const c of conns) {
      if (!state.connections[c.participant_id]) state.connections[c.participant_id] = {};
      state.connections[c.participant_id][c.type] = { source: c.source, reason: c.reason };
    }
  } catch (e) {
    console.error('loadUserConnections:', e);
  }
}

function startSpeakerPolling() {
  clearInterval(state.speakerPollTimer);
  state.speakerPollTimer = setInterval(loadCurrentSpeaker, 5000);
}

// ════════════════════════════════════════════════
// SSE — 即時同步活動 Phase
// ════════════════════════════════════════════════
function connectSSE() {
  const es = new EventSource('/api/event-stream');
  es.addEventListener('event-state', e => {
    try {
      const data = JSON.parse(e.data);
      applyPhase(data.phase);
    } catch (_) {}
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 5000); // 斷線後 5 秒重連
  };
}

function applyPhase(phase) {
  const tabNav      = document.querySelector('nav');
  const tabSpeaker  = document.getElementById('tab-speaker');
  const tabBrowse   = document.getElementById('tab-browse');
  const tabEnded    = document.getElementById('tab-ended');
  if (!tabEnded) return;

  if (phase === 'ended') {
    if (tabNav)     tabNav.classList.add('hidden');
    if (tabSpeaker) tabSpeaker.classList.add('hidden');
    if (tabBrowse)  tabBrowse.classList.add('hidden');
    tabEnded.classList.remove('hidden');
    showEndedScreen();
  } else {
    if (tabNav)     tabNav.classList.remove('hidden');
    tabEnded.classList.add('hidden');
    // 恢復目前 active tab
    if (state.activeTab === 'browse') {
      if (tabSpeaker) tabSpeaker.classList.add('hidden');
      if (tabBrowse)  tabBrowse.classList.remove('hidden');
    } else {
      if (tabSpeaker) tabSpeaker.classList.remove('hidden');
      if (tabBrowse)  tabBrowse.classList.add('hidden');
    }
  }
}

// ════════════════════════════════════════════════
// 商機小錦囊
// ════════════════════════════════════════════════
function showEndedScreen() {
  const emailForm   = document.getElementById('ended-email-form');
  const reportArea  = document.getElementById('ended-report');
  if (!emailForm || !reportArea) return;

  if (state.user?.email) {
    // 有 email，直接載入報表
    emailForm.classList.add('hidden');
    loadMyReport(state.user.name, state.user.email);
  } else {
    // 無 email，顯示驗證表單
    emailForm.classList.remove('hidden');
    reportArea.classList.add('hidden');
  }
}

async function submitEmailForReport() {
  const input = document.getElementById('ended-email-input');
  const errEl = document.getElementById('ended-email-error');
  const btn   = document.getElementById('ended-email-btn');
  const email = input?.value.trim();

  if (!email) {
    errEl.textContent = '請輸入 Email';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '查詢中...';

  try {
    await loadMyReport(state.user.name, email);
    document.getElementById('ended-email-form').classList.add('hidden');
  } catch (e) {
    errEl.textContent = e.message || '查詢失敗，請確認 Email 是否正確';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '查看我的商機小錦囊';
  }
}

async function loadMyReport(name, email) {
  const reportArea = document.getElementById('ended-report');
  const res = await fetch('/api/my-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '查詢失敗');
  renderReport(data);
  reportArea.classList.remove('hidden');
}

function renderReport(data) {
  document.getElementById('report-name').textContent     = data.name || '—';
  document.getElementById('report-identity').textContent = data.identity || '—';

  const renderList = (containerId, items, renderFn, emptyMsg) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items?.length) {
      el.innerHTML = `<p class="text-gray-400 text-sm text-center py-4">${emptyMsg}</p>`;
      return;
    }
    el.innerHTML = items.map(renderFn).join('');
  };

  renderList('report-meeters', data.meeters,
    p => `<div class="border border-rose-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
      </div>
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">"${esc(p.reason)}"</p>` : ''}
    </div>`,
    '這次沒有人表達想認識你，繼續加油！'
  );

  renderList('report-helpers', data.helpers,
    p => `<div class="border border-green-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
      </div>
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">"${esc(p.reason)}"</p>` : ''}
    </div>`,
    '這次沒有人提供幫助'
  );

  renderList('report-mywants', data.myWants,
    p => `<div class="border border-blue-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
        <span class="text-xs text-blue-600 font-bold ml-auto">第 ${esc(p.table_number || '?')} 桌</span>
      </div>
      ${p.needs ? `<p class="text-gray-500 text-xs mb-1">需求：${esc(p.needs)}</p>` : ''}
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">你的原因：「${esc(p.reason)}」</p>` : ''}
    </div>`,
    '這次沒有想認識的人'
  );
}

// ════════════════════════════════════════════════
// REWARD BANNER
// ════════════════════════════════════════════════
function updateRewardBanner() {
  const banner = document.getElementById('reward-banner');
  if (!banner) return;

  const speaker = state.currentSpeaker;
  const lightCount = state.speakerLightCount;
  const isRewardThreshold = lightCount >= 15;

  // Check if current user has submitted can_provide for this speaker
  const userHelpedSpeaker = speaker && state.connections[speaker.id]?.['can_provide'];

  const show = isRewardThreshold && !!userHelpedSpeaker && !!speaker;
  banner.classList.toggle('hidden', !show);
}

// ════════════════════════════════════════════════
// REASON MODAL
// ════════════════════════════════════════════════
let _pendingConnection = null; // { participantId, type, source }

function openReasonModal(participantId, type, source) {
  const pid = Number(participantId);

  // Already submitted
  if (state.connections[pid]?.[type]) {
    showToast('你已送出過這個互動', 'info');
    return;
  }

  _pendingConnection = { participantId: pid, type, source };

  const isHelp = type === 'can_provide';
  document.getElementById('reason-modal-title').textContent = isHelp ? '我想幫助他' : '我想認識他';
  document.getElementById('reason-modal-subtitle').textContent = isHelp
    ? '請描述你可以提供的資源或協助'
    : '請說明你想認識他的原因';
  document.getElementById('reason-label').innerHTML = isHelp
    ? '可提供的資源或協助 <span class="text-red-500">*</span>'
    : '想認識的原因 <span class="text-red-500">*</span>';
  document.getElementById('reason-input').placeholder = isHelp
    ? '例如：我有建材供應商人脈，可以幫忙介紹...'
    : '例如：我對他的產業很有興趣，希望深入交流...';
  document.getElementById('reason-input').value = '';

  document.getElementById('reason-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('reason-input').focus(), 100);
}

function closeReasonModal() {
  document.getElementById('reason-modal').classList.add('hidden');
  _pendingConnection = null;
}

async function submitReason() {
  if (!_pendingConnection) return;

  const reason = document.getElementById('reason-input').value.trim();
  if (!reason) {
    showToast('請填寫原因後再送出', 'error');
    document.getElementById('reason-input').focus();
    return;
  }

  const { participantId, type, source } = _pendingConnection;
  const btn = document.getElementById('reason-submit-btn');
  btn.disabled = true;
  btn.textContent = '送出中...';

  try {
    await api('POST', '/api/connect', {
      userId: state.user.userId,
      participantId,
      type,
      source,
      reason,
    });

    // Mark as submitted in local state
    if (!state.connections[participantId]) state.connections[participantId] = {};
    state.connections[participantId][type] = { source, reason };

    closeReasonModal();
    showToast('已成功送出！', 'success');

    // Re-render
    if (state.activeTab === 'speaker') renderSpeaker();
    else renderParticipantsList();

    // Immediately reload lights to check reward
    await loadCurrentSpeaker();

  } catch (e) {
    showToast(e.message || '送出失敗，請重試', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認送出';
  }
}

// ════════════════════════════════════════════════
// RENDER: CURRENT SPEAKER
// ════════════════════════════════════════════════
function renderSpeaker() {
  const el = document.getElementById('speaker-content');
  const s = state.currentSpeaker;

  if (!s) {
    el.innerHTML = `
      <div class="text-center py-20 text-gray-400">
        <div class="text-6xl mb-4">🎤</div>
        <p class="text-xl font-semibold">等待發言者...</p>
        <p class="text-sm mt-2">請稍候，管理員將設定目前的發言者</p>
      </div>
    `;
    return;
  }

  const conns       = state.connections[s.id] || {};
  const wantMeet    = !!conns['want_to_meet'];
  const canProvide  = !!conns['can_provide'];

  el.innerHTML = `
    <div class="bg-white rounded-3xl shadow-lg overflow-hidden mb-4">
      <div class="bg-red-600 px-5 py-3 flex items-center gap-2">
        <span class="bg-white text-red-600 text-xs font-black px-2 py-0.5 rounded-full pulse-red">LIVE</span>
        <span class="text-white font-bold text-sm">目前發言者</span>
      </div>

      <div class="px-5 pt-5 pb-4">
        <h2 class="text-4xl font-black text-gray-800 mb-1">${esc(s.name)}</h2>
        <p class="text-gray-500 text-base">${esc(s.identity || s.industry || '')}</p>
        <p class="text-red-600 font-bold text-base mt-1">
          📍 第 <span class="text-2xl">${esc(s.table_number || '?')}</span> 桌
        </p>

        ${s.needs ? `
          <div class="mt-4 bg-red-50 border border-red-100 rounded-2xl p-4">
            <p class="text-red-600 text-xs font-bold uppercase tracking-wide mb-1">我在商務上需要的協助</p>
            <p class="text-gray-700 text-base leading-relaxed">${esc(s.needs)}</p>
          </div>
        ` : ''}
      </div>

      <div class="px-5 pb-5 grid grid-cols-2 gap-3">
        <button
          onclick="openReasonModal(${s.id}, 'want_to_meet', 'speaker')"
          ${wantMeet ? 'disabled' : ''}
          class="py-5 rounded-2xl font-bold text-base border-2 transition-all ${wantMeet
            ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
            : 'border-red-500 text-red-600 bg-white active:bg-red-50'
          }"
        >
          ${wantMeet ? '✓ 已送出認識' : '🤝 我想認識他'}
        </button>
        <button
          onclick="openReasonModal(${s.id}, 'can_provide', 'speaker')"
          ${canProvide ? 'disabled' : ''}
          class="py-5 rounded-2xl font-bold text-base border-2 transition-all ${canProvide
            ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
            : 'border-red-500 text-red-600 bg-white active:bg-red-50'
          }"
        >
          ${canProvide ? '✓ 已送出幫助' : '💼 我想幫助他'}
        </button>
      </div>
    </div>
    <p class="text-center text-gray-400 text-xs">送出後不可修改 · 每 5 秒自動同步發言者</p>
  `;

  updateRewardBanner();
}

// ════════════════════════════════════════════════
// RENDER: PARTICIPANTS LIST
// ════════════════════════════════════════════════
function renderParticipantsList() {
  const el = document.getElementById('participants-list');
  const search = (document.getElementById('search-input')?.value || '').toLowerCase().trim();

  const list = search
    ? state.participants.filter(p =>
        p.name.toLowerCase().includes(search) ||
        (p.identity || p.industry || '').toLowerCase().includes(search) ||
        (p.table_number || '').includes(search)
      )
    : state.participants;

  if (list.length === 0) {
    el.innerHTML = `<div class="text-center py-16 text-gray-400">
      <div class="text-4xl mb-2">🔍</div>
      <p>找不到符合的成員</p>
    </div>`;
    return;
  }

  el.innerHTML = list.map(p => {
    const conns      = state.connections[p.id] || {};
    const wantMeet   = !!conns['want_to_meet'];
    const canProvide = !!conns['can_provide'];
    const hasAny     = wantMeet || canProvide;
    const isSpeaker  = state.currentSpeaker?.id === p.id;

    return `
      <div class="bg-white rounded-2xl shadow-sm mb-3 overflow-hidden ${hasAny ? 'ring-2 ring-red-400' : 'border border-gray-100'}">
        <div class="p-4">
          <div class="flex items-start justify-between mb-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-xl font-black text-gray-800">${esc(p.name)}</h3>
                ${isSpeaker ? '<span class="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-bold">發言中</span>' : ''}
                ${hasAny ? '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-semibold">已互動</span>' : ''}
              </div>
              <p class="text-gray-500 text-sm mt-0.5">${esc(p.identity || p.industry || '')}</p>
            </div>
            <span class="text-red-600 font-bold text-sm whitespace-nowrap ml-2">
              第 ${esc(p.table_number || '?')} 桌
            </span>
          </div>

          ${p.needs ? `
            <div class="mt-1 mb-3 bg-red-50 border border-red-100 rounded-xl p-3">
              <p class="text-red-600 text-xs font-bold uppercase tracking-wide mb-0.5">商務需求</p>
              <p class="text-gray-700 text-sm leading-relaxed">${esc(p.needs)}</p>
            </div>
          ` : ''}

          <div class="grid grid-cols-2 gap-2 mt-2">
            <button
              onclick="openReasonModal(${p.id}, 'want_to_meet', 'browse')"
              ${wantMeet ? 'disabled' : ''}
              class="py-3.5 rounded-xl font-bold text-sm border-2 transition-all ${wantMeet
                ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                : 'border-gray-300 text-gray-600 bg-white active:bg-gray-50'
              }"
            >
              ${wantMeet ? '✓ 已送出認識' : '🤝 我想認識他'}
            </button>
            <button
              onclick="openReasonModal(${p.id}, 'can_provide', 'browse')"
              ${canProvide ? 'disabled' : ''}
              class="py-3.5 rounded-xl font-bold text-sm border-2 transition-all ${canProvide
                ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                : 'border-gray-300 text-gray-600 bg-white active:bg-gray-50'
              }"
            >
              ${canProvide ? '✓ 已送出幫助' : '💼 我想幫助他'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function filterParticipants() {
  renderParticipantsList();
}

// ════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════
function switchTab(tab) {
  state.activeTab = tab;
  const isSpeaker = tab === 'speaker';

  document.getElementById('tab-speaker').classList.toggle('hidden', !isSpeaker);
  document.getElementById('tab-browse').classList.toggle('hidden', isSpeaker);
  document.getElementById('tab-btn-speaker').classList.toggle('tab-active', isSpeaker);
  document.getElementById('tab-btn-browse').classList.toggle('tab-active', !isSpeaker);

  if (!isSpeaker) renderParticipantsList();
  else renderSpeaker();
}

function showScreen(name) {
  document.getElementById('screen-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('screen-main').classList.toggle('hidden', name !== 'main');
}

function updateHeaderUser() {
  const el = document.getElementById('header-user');
  if (el && state.user) {
    el.textContent = `${state.user.name} · ${state.user.identity || ''}`;
  }
}

// ════════════════════════════════════════════════
// 登入畫面切換
// ════════════════════════════════════════════════
function showFullForm() {
  document.getElementById('form-fullreg').classList.remove('hidden');
  document.getElementById('form-return').classList.add('hidden');
}

function showReturnLogin() {
  document.getElementById('form-fullreg').classList.add('hidden');
  document.getElementById('form-return').classList.remove('hidden');
}

// ════════════════════════════════════════════════
// 登入（第一次完整表單）
// ════════════════════════════════════════════════
async function handleLogin() {
  const name      = document.getElementById('input-name').value.trim();
  const tableNum  = document.getElementById('input-table').value.trim();
  const needs     = document.getElementById('input-needs').value.trim();
  const email     = document.getElementById('input-email').value.trim();
  const identityEl = document.querySelector('input[name="identity"]:checked');

  if (!name) { showToast('請輸入你的名字', 'error'); document.getElementById('input-name').focus(); return; }
  if (!tableNum) { showToast('請輸入你的桌號', 'error'); document.getElementById('input-table').focus(); return; }
  if (!needs) { showToast('請填寫你的商務需求', 'error'); document.getElementById('input-needs').focus(); return; }
  if (!identityEl) { showToast('請選擇你的身份', 'error'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = '登入中...';

  try {
    const data = await api('POST', '/api/login', {
      name, tableNumber: tableNum, needs, identity: identityEl.value,
      email: email || null, isFirstTime: true,
    });
    state.user = {
      userId: data.userId, name: data.name, identity: data.identity,
      tableNumber: data.tableNumber, needs: data.needs, email: data.email,
    };
    localStorage.setItem('bni_session', JSON.stringify({ name: state.user.name, tableNumber: state.user.tableNumber }));
    await startApp();
  } catch (e) {
    showToast(e.message || '登入失敗，請重試', 'error');
    btn.disabled = false;
    btn.textContent = '加入神秘互助活動！';
  }
}

// ════════════════════════════════════════════════
// 回訪快速登入
// ════════════════════════════════════════════════
async function handleReturnLogin() {
  const name     = document.getElementById('input-name-return').value.trim();
  const tableNum = document.getElementById('input-table-return').value.trim();

  if (!name) { showToast('請輸入你的名字', 'error'); document.getElementById('input-name-return').focus(); return; }
  if (!tableNum) { showToast('請輸入你的桌號', 'error'); document.getElementById('input-table-return').focus(); return; }

  const btn = document.getElementById('btn-return');
  btn.disabled = true;
  btn.textContent = '登入中...';

  try {
    const data = await api('POST', '/api/login', { name, tableNumber: tableNum });
    state.user = {
      userId: data.userId, name: data.name, identity: data.identity,
      tableNumber: data.tableNumber, needs: data.needs, email: data.email,
    };
    localStorage.setItem('bni_session', JSON.stringify({ name: state.user.name, tableNumber: state.user.tableNumber }));
    await startApp();
  } catch (e) {
    // 找不到紀錄 → server 回傳「請選擇身份」，自動帶入資料跳轉完整表單
    if (e.message === '請選擇身份') {
      showFullForm();
      document.getElementById('input-name').value = name;
      document.getElementById('input-table').value = tableNum;
      btn.disabled = false;
      btn.textContent = '進入活動';
      return;
    }
    showToast(e.message || '登入失敗，請重試', 'error');
    btn.disabled = false;
    btn.textContent = '進入活動';
  }
}

function handleLogout() {
  clearInterval(state.speakerPollTimer);
  state.user = null;
  state.connections = {};
  state.participants = [];
  state.currentSpeaker = null;
  state.speakerLightCount = 0;
  state.activeTab = 'speaker';
  localStorage.removeItem('bni_session');

  switchTab('speaker');
  showScreen('login');
  showReturnLogin();

  // Reset form
  ['input-name', 'input-table', 'input-needs', 'input-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('input[name="identity"]').forEach(r => r.checked = false);
  updateRoleStyle();
}

// ════════════════════════════════════════════════
// IDENTITY BUTTON STYLE
// ════════════════════════════════════════════════
function updateRoleStyle() {
  const map = {
    '長榮會員': 'role-label-member',
    '來賓': 'role-label-guest',
    '親友': 'role-label-friend',
  };
  document.querySelectorAll('input[name="identity"]').forEach(el => {
    const label = document.getElementById(map[el.value]);
    if (!label) return;
    if (el.checked) {
      label.classList.add('border-red-500', 'bg-red-50');
      label.classList.remove('border-gray-200');
    } else {
      label.classList.remove('border-red-500', 'bg-red-50');
      label.classList.add('border-gray-200');
    }
  });
}

// ════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════
let _toastTimer = null;

function showToast(message, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'fixed bottom-6 left-4 right-4 max-w-sm mx-auto text-white text-center py-3.5 px-5 rounded-2xl shadow-2xl z-50 text-base font-semibold';
  if (type === 'error' || type === 'warning') el.classList.add('bg-red-600');
  else if (type === 'success') el.classList.add('bg-green-600');
  else el.classList.add('bg-gray-800');

  el.style.transform = 'translateY(0)';
  el.style.opacity = '1';

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.transform = 'translateY(120px)';
    el.style.opacity = '0';
  }, type === 'warning' ? 4000 : 2500);
}

// ════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════
init();
