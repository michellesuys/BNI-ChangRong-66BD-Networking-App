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
  // 先取得目前活動 phase，再決定顯示哪個畫面
  let currentPhase = 'warmup';
  try {
    const ev = await fetch('/api/event-state').then(r => r.json());
    currentPhase = ev.phase || 'warmup';
  } catch (_) { }

  const saved = localStorage.getItem('bni_session');
  if (saved) {
    try {
      const session = JSON.parse(saved);
      const data = await api('POST', '/api/login', {
        email: session.email,
        isFirstTime: false,
      });
      state.user = {
        userId: data.userId,
        name: data.name,
        identity: data.identity,
        tableNumber: data.tableNumber,
        needs: data.needs,
        email: data.email,
      };
      localStorage.setItem('bni_session', JSON.stringify({ email: state.user.email }));
      await startApp();
      return;
    } catch {
      localStorage.removeItem('bni_session');
    }
  }

  // 未登入：根據 phase 決定畫面
  if (currentPhase === 'ended') {
    showScreen('main');
    updateHeaderUser(); // 確保 header 無使用者資訊與登出按鈕
    document.getElementById('ended-name-row')?.classList.remove('hidden');
    applyPhase('ended');
  } else {
    showScreen('login');
    showReturnLogin();
  }

  // 未登入時持續 poll phase（login ↔ ended 雙向切換）
  startLoginPhasePolling(currentPhase);
}

async function startApp() {
  clearInterval(_loginPhasePollTimer); // 登入成功，停止未登入的 phase polling
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
  } catch (_) { }
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
      } catch (_) { }
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

// 未登入時的 phase polling（login ↔ ended 雙向自動切換）
let _loginPhasePollTimer = null;
let _loginCurrentPhase = 'warmup'; // 追蹤未登入時的目前 phase

function startLoginPhasePolling(initialPhase = 'warmup') {
  _loginCurrentPhase = initialPhase;
  clearInterval(_loginPhasePollTimer);
  _loginPhasePollTimer = setInterval(async () => {
    try {
      const ev = await fetch('/api/event-state').then(r => r.json());
      const phase = ev.phase || 'warmup';
      if (phase === _loginCurrentPhase) return; // 無變化
      _loginCurrentPhase = phase;

      if (phase === 'ended') {
        showScreen('main');
        updateHeaderUser(); // 確保 header 無使用者資訊
        document.getElementById('ended-name-row')?.classList.remove('hidden');
        applyPhase('ended');
      } else {
        // phase 從 ended 切回其他狀態 → 回到 login 畫面
        showScreen('login');
        showReturnLogin();
      }
    } catch (_) { }
  }, 5000);
}

function startSpeakerPolling() {
  clearInterval(state.speakerPollTimer);
  state.speakerPollTimer = setInterval(async () => {
    await loadCurrentSpeaker();
    // 同步活動 phase（作為 SSE 的 fallback，確保斷線也能更新）
    try {
      const es = await api('GET', '/api/event-state');
      applyPhase(es.phase);
    } catch (_) { }
  }, 5000);
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
    } catch (_) { }
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 5000); // 斷線後 5 秒重連
  };
}

function applyPhase(phase) {
  const tabNav = document.querySelector('nav');
  const tabSpeaker = document.getElementById('tab-speaker');
  const tabBrowse = document.getElementById('tab-browse');
  const tabEnded = document.getElementById('tab-ended');
  if (!tabEnded) return;

  if (phase === 'ended') {
    if (tabNav) tabNav.classList.add('hidden');
    if (tabSpeaker) tabSpeaker.classList.add('hidden');
    if (tabBrowse) tabBrowse.classList.add('hidden');
    tabEnded.classList.remove('hidden');
    showEndedScreen();
  } else {
    if (tabNav) tabNav.classList.remove('hidden');
    tabEnded.classList.add('hidden');
    // 恢復目前 active tab
    if (state.activeTab === 'browse') {
      if (tabSpeaker) tabSpeaker.classList.add('hidden');
      if (tabBrowse) tabBrowse.classList.remove('hidden');
    } else {
      if (tabSpeaker) tabSpeaker.classList.remove('hidden');
      if (tabBrowse) tabBrowse.classList.add('hidden');
    }
  }
}

// ════════════════════════════════════════════════
// 商機小錦囊
// ════════════════════════════════════════════════
function showEndedScreen() {
  const emailForm = document.getElementById('ended-email-form');
  const reportArea = document.getElementById('ended-report');
  if (!emailForm || !reportArea) return;

  if (state.user?.email) {
    // 已登入且有 email，直接載入報表
    document.getElementById('ended-name-row')?.classList.add('hidden');
    emailForm.classList.add('hidden');
    loadMyReport(state.user.name, state.user.email);
  } else {
    // 未登入或無 email，顯示驗證表單（含姓名欄位）
    document.getElementById('ended-name-row')?.classList.remove('hidden');
    emailForm.classList.remove('hidden');
    reportArea.classList.add('hidden');
  }
}

async function submitEmailForReport() {
  const input = document.getElementById('ended-email-input');
  const errEl = document.getElementById('ended-email-error');
  const btn = document.getElementById('ended-email-btn');
  const email = input?.value.trim();

  if (!email) {
    errEl.textContent = '請輸入 Email';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  // 未登入時從輸入欄位取得姓名
  const name = state.user?.name || document.getElementById('ended-name-input')?.value.trim() || '';
  if (!name) {
    errEl.textContent = '請輸入姓名';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '查詢中...';

  try {
    await loadMyReport(name, email);
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
  document.getElementById('report-name').textContent = data.name || '—';
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

  const contactLine = (p, colorClass) => {
    const parts = [];
    if (p.phone) parts.push(`📞 ${esc(p.phone)}`);
    if (p.line_id) parts.push(`💬 LINE：${esc(p.line_id)}`);
    if (p.email) parts.push(`✉️ ${esc(p.email)}`);
    return parts.length
      ? `<p class="text-xs font-medium mb-1 ${colorClass}">${parts.join('　')}</p>`
      : `<p class="text-gray-300 text-xs mb-1">（未填寫聯絡方式）</p>`;
  };

  renderList('report-meeters', data.meeters,
    p => `<div class="border border-rose-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
      </div>
      ${contactLine(p, 'text-rose-500')}
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">"${esc(p.reason)}"</p>` : ''}
    </div>`,
    '這次尚無新的交流邀請，<br>持續被看見，連結就會發生。'
  );

  renderList('report-helpers', data.helpers,
    p => `<div class="border border-green-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
      </div>
      ${contactLine(p, 'text-green-600')}
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">"${esc(p.reason)}"</p>` : ''}
    </div>`,
    '這次尚未媒合到協助，<br>需求越具體，越容易找到資源。'
  );

  renderList('report-mywants', data.myWants,
    p => `<div class="border border-blue-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
        <span class="text-xs text-blue-600 font-bold ml-auto">第 ${esc(p.table_number || '?')} 桌</span>
      </div>
      ${contactLine(p, 'text-blue-500')}
      ${p.needs ? `<p class="text-gray-500 text-xs mb-1">需求：${esc(p.needs)}</p>` : ''}
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">你的原因：「${esc(p.reason)}」</p>` : ''}
    </div>`,
    '這次尚未建立新連結，<br>下次遇到合適夥伴，歡迎主動開口。'
  );

  renderList('report-myhelps', data.myHelps,
    p => `<div class="border border-orange-100 rounded-2xl p-3.5">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-black text-gray-800 text-base">${esc(p.name)}</span>
        <span class="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">${esc(p.identity || '')}</span>
        <span class="text-xs text-orange-600 font-bold ml-auto">第 ${esc(p.table_number || '?')} 桌</span>
      </div>
      ${contactLine(p, 'text-orange-500')}
      ${p.needs ? `<p class="text-gray-500 text-xs mb-1">需求：${esc(p.needs)}</p>` : ''}
      ${p.reason ? `<p class="text-gray-600 text-sm leading-relaxed">你的承諾：「${esc(p.reason)}」</p>` : ''}
    </div>`,
    '這次尚未提供協助，<br>你的專業，可能正是別人的需要。'
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

const REASON_OPTIONS = {
  want_to_meet: ['有潛在合作機會', '想了解你的業務', '想為你介紹轉介', '個人交流，想認識你'],
  can_provide:  ['有相關資源可介紹', '我有轉介名單可提供', '業務上可以合作', '有具體需求想討論'],
};

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
    ? '選擇你可以提供的資源或協助'
    : '選擇你想認識他的原因';

  // Render radio options
  const options = REASON_OPTIONS[type] || [];
  const container = document.getElementById('reason-options-container');
  container.innerHTML = options.map((opt, i) => `
    <label class="flex items-center gap-3 p-3.5 rounded-2xl border-2 border-gray-200 cursor-pointer transition-all hover:border-red-300 has-checked:border-red-500 has-checked:bg-red-50">
      <input type="radio" name="reason-option" value="${esc(opt)}" class="w-4 h-4 accent-red-600" ${i === 0 ? 'checked' : ''}>
      <span class="text-gray-700 font-medium text-sm">${esc(opt)}</span>
    </label>
  `).join('');

  document.getElementById('reason-modal').classList.remove('hidden');
}

function closeReasonModal() {
  document.getElementById('reason-modal').classList.add('hidden');
  _pendingConnection = null;
}

async function submitReason() {
  if (!_pendingConnection) return;

  const checkedEl = document.querySelector('input[name="reason-option"]:checked');
  const reason = checkedEl?.value || '';
  if (!reason) {
    showToast('請選擇一個原因', 'error');
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
        <p class="text-sm mt-2">請稍候，等待下一位發言者</p>
      </div>
    `;
    return;
  }

  const conns = state.connections[s.id] || {};
  const wantMeet = !!conns['want_to_meet'];
  const canProvide = !!conns['can_provide'];
  const isSelf = state.user?.userId === s.id;

  el.innerHTML = `
    <div class="bg-white rounded-3xl shadow-lg overflow-hidden mb-4">
      <div class="bg-red-600 px-5 py-3 flex items-center gap-2">
        <span class="bg-white text-red-600 text-xs font-black px-2 py-0.5 rounded-full pulse-red">LIVE</span>
        <span class="text-white font-bold text-sm">目前發言者</span>
      </div>

      <div class="px-5 pt-5 pb-4">
        <h2 class="text-4xl font-black text-gray-800 mb-1">${esc(s.name)}</h2>
        <p class="text-gray-500 text-base">${esc(s.identity || s.industry || '')}</p>
        ${s.specialty ? `<p class="text-gray-400 text-sm mt-0.5">🏷️ ${esc(s.specialty)}</p>` : ''}
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

      ${isSelf ? `
        <div class="px-5 pb-5">
          <p class="text-center text-gray-400 text-sm py-3 bg-gray-50 rounded-2xl">這是你自己的發言</p>
        </div>
      ` : `
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
      `}
    </div>
    <p class="text-center text-gray-400 text-xs">每 5 秒自動同步發言者</p>
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
      (p.specialty || '').toLowerCase().includes(search) ||
      (p.needs || '').toLowerCase().includes(search) ||
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
    const conns = state.connections[p.id] || {};
    const wantMeet = !!conns['want_to_meet'];
    const canProvide = !!conns['can_provide'];
    const hasAny = wantMeet || canProvide;
    const isSpeaker = state.currentSpeaker?.id === p.id;
    const isSelf = state.user?.userId === p.id;

    return `
      <div class="bg-white rounded-2xl shadow-sm mb-3 overflow-hidden ${hasAny ? 'ring-2 ring-red-400' : 'border border-gray-100'}">
        <div class="p-4">
          <div class="flex items-start justify-between mb-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-xl font-black text-gray-800">${esc(p.name)}</h3>
                ${isSpeaker ? '<span class="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-bold">發言中</span>' : ''}
                ${isSelf ? '<span class="bg-gray-200 text-gray-500 text-xs px-2 py-0.5 rounded-full font-semibold">我</span>' : ''}
                ${hasAny ? '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-semibold">已互動</span>' : ''}
              </div>
              <p class="text-gray-500 text-sm mt-0.5">${esc(p.identity || p.industry || '')}</p>
              ${p.specialty ? `<p class="text-gray-400 text-xs mt-0.5">🏷️ ${esc(p.specialty)}</p>` : ''}
            </div>
            <span class="text-red-600 font-bold text-sm whitespace-nowrap ml-2">
              第 ${esc(p.table_number || '?')} 桌
            </span>
          </div>

          ${p.needs ? `
            <div class="mt-1 mb-3 bg-red-50 border border-red-100 rounded-xl p-3">
              <p class="text-red-600 text-xs font-bold uppercase tracking-wide mb-0.5">在商務上需要的協助</p>
              <p class="text-gray-700 text-sm leading-relaxed">${esc(p.needs)}</p>
            </div>
          ` : ''}

          ${isSelf ? '' : `
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
          `}
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
  const logoutBtn = document.getElementById('header-logout-btn');
  const editBtn   = document.getElementById('header-edit-btn');
  if (state.user) {
    if (el) el.textContent = `${state.user.name} · ${state.user.identity || ''}`;
    logoutBtn?.classList.remove('hidden');
    editBtn?.classList.remove('hidden');
  } else {
    if (el) el.textContent = '';
    logoutBtn?.classList.add('hidden');
    editBtn?.classList.add('hidden');
  }
}

// ════════════════════════════════════════════════
// 登入畫面切換
// ════════════════════════════════════════════════
function showFullForm() { showFullReg(); }
function showFullReg() {
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
  const name = document.getElementById('input-name').value.trim();
  const tableNum = document.getElementById('input-table').value.trim();
  const specialty = document.getElementById('input-specialty').value.trim();
  const needs = document.getElementById('input-needs').value.trim();
  const email = document.getElementById('input-email').value.trim();
  const phone = document.getElementById('input-phone').value.trim();
  const lineId = document.getElementById('input-line').value.trim();
  const identityEl = document.querySelector('input[name="identity"]:checked');

  if (!name) { showToast('請輸入你的名字', 'error'); document.getElementById('input-name').focus(); return; }
  if (!tableNum) { showToast('請輸入你的桌號', 'error'); document.getElementById('input-table').focus(); return; }
  if (!specialty) { showToast('請填寫你的專業別', 'error'); document.getElementById('input-specialty').focus(); return; }
  if (!needs) { showToast('請填寫你的商務需求', 'error'); document.getElementById('input-needs').focus(); return; }
  if (!identityEl) { showToast('請選擇手環顏色', 'error'); return; }
  if (!email) { showToast('請填寫 Email，活動結束後將寄送名片', 'error'); document.getElementById('input-email').focus(); return; }
  if (!phone && !lineId) { showToast('請填寫電話或 LINE ID（擇一）', 'error'); document.getElementById('input-phone').focus(); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = '登入中...';

  try {
    const data = await api('POST', '/api/login', {
      name, tableNumber: tableNum, needs, identity: identityEl.value,
      email, specialty, phone: phone || null, lineId: lineId || null,
      isFirstTime: true,
    });
    state.user = {
      userId: data.userId, name: data.name, identity: data.identity,
      tableNumber: data.tableNumber, needs: data.needs, email: data.email,
    };
    localStorage.setItem('bni_session', JSON.stringify({ email: state.user.email }));
    await startApp();
  } catch (e) {
    showToast(e.message || '登入失敗，請重試', 'error');
    btn.disabled = false;
    btn.textContent = '加入神秘互助活動！';
  }
}

// ════════════════════════════════════════════════
// 回訪快速登入（以 Email 識別）
// ════════════════════════════════════════════════
async function handleReturnLogin() {
  const email = document.getElementById('input-email-return').value.trim();

  if (!email) { showToast('請輸入你的 Email', 'error'); document.getElementById('input-email-return').focus(); return; }

  const btn = document.getElementById('btn-return');
  btn.disabled = true;
  btn.textContent = '登入中...';

  try {
    const data = await api('POST', '/api/login', { email, isFirstTime: false });
    state.user = {
      userId: data.userId, name: data.name, identity: data.identity,
      tableNumber: data.tableNumber, needs: data.needs, email: data.email,
    };
    localStorage.setItem('bni_session', JSON.stringify({ email: state.user.email }));
    await startApp();
  } catch (e) {
    // 找不到此 email → 帶入 email 切換到完整表單
    if (e.message?.includes('找不到此 Email')) {
      showFullReg();
      document.getElementById('input-email').value = email;
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
  ['input-name', 'input-table', 'input-specialty', 'input-needs', 'input-email', 'input-phone', 'input-line', 'input-email-return'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('input[name="identity"]').forEach(r => r.checked = false);
  updateRoleStyle();

  // Reset button states (may have been locked from a previous login attempt)
  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) { btnLogin.disabled = false; btnLogin.textContent = '加入活動！'; }
  const btnReturn = document.getElementById('btn-return');
  if (btnReturn) { btnReturn.disabled = false; btnReturn.textContent = '進入活動'; }
}

// ════════════════════════════════════════════════
// IDENTITY BUTTON STYLE
// ════════════════════════════════════════════════
function updateRoleStyle() {
  const map = {
    '長榮會員': 'role-label-member',
    '金手環': 'role-label-guest',
    '銀手環': 'role-label-friend',
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
// PROFILE EDIT MODAL
// ════════════════════════════════════════════════
function openProfileEdit() {
  if (!state.user) return;
  const u = state.user;
  document.getElementById('edit-name').value      = u.name || '';
  document.getElementById('edit-table').value     = u.tableNumber || '';
  document.getElementById('edit-specialty').value = u.specialty || '';
  document.getElementById('edit-needs').value     = u.needs || '';
  document.getElementById('edit-phone').value     = u.phone || '';
  document.getElementById('edit-line').value      = u.lineId || '';

  // Set identity radio
  document.querySelectorAll('input[name="edit-identity"]').forEach(r => {
    r.checked = r.value === u.identity;
  });
  updateEditRoleStyle();

  document.getElementById('profile-edit-modal').classList.remove('hidden');
}

function closeProfileEdit() {
  document.getElementById('profile-edit-modal').classList.add('hidden');
}

function updateEditRoleStyle() {
  document.querySelectorAll('.edit-role-label').forEach(label => {
    const radio = label.querySelector('input[type="radio"]');
    if (radio?.checked) {
      label.classList.add('border-red-500', 'bg-red-50');
      label.classList.remove('border-gray-200');
    } else {
      label.classList.remove('border-red-500', 'bg-red-50');
      label.classList.add('border-gray-200');
    }
  });
}

async function submitProfileEdit() {
  if (!state.user) return;

  const name      = document.getElementById('edit-name').value.trim();
  const table     = document.getElementById('edit-table').value.trim();
  const specialty = document.getElementById('edit-specialty').value.trim();
  const needs     = document.getElementById('edit-needs').value.trim();
  const phone     = document.getElementById('edit-phone').value.trim();
  const lineId    = document.getElementById('edit-line').value.trim();
  const identityEl = document.querySelector('input[name="edit-identity"]:checked');

  if (!name)      { showToast('請輸入姓名', 'error'); return; }
  if (!table)     { showToast('請輸入桌號', 'error'); return; }
  if (!specialty) { showToast('請填寫專業別', 'error'); return; }

  try {
    const data = await api('PATCH', '/api/profile', {
      userId: state.user.userId,
      name, tableNumber: table, specialty, needs,
      phone: phone || null,
      lineId: lineId || null,
      identity: identityEl?.value,
    });

    // Update local state
    state.user = { ...state.user, ...data };
    localStorage.setItem('bni_session', JSON.stringify({ email: state.user.email }));

    closeProfileEdit();
    updateHeaderUser();
    showToast('資料已更新', 'success');
  } catch (e) {
    showToast(e.message || '更新失敗，請重試', 'error');
  }
}

// ════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════
init();
