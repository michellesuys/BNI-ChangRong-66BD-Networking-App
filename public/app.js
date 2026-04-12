'use strict';

// ════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════
const state = {
  user: null,           // { userId, name, role }
  participants: [],     // all participants from server
  currentSpeaker: null, // speaker object or null
  /**
   * connections: { [participantId]: { [type]: source } }
   * e.g. { 5: { want_to_meet: 'speaker', can_provide: 'browse' } }
   * type:   'want_to_meet' | 'can_provide'
   * source: 'speaker' | 'browse'
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
      state.user = JSON.parse(saved);
      await startApp();
      return;
    } catch {
      localStorage.removeItem('bni_session');
    }
  }
  showScreen('login');
}

async function startApp() {
  showScreen('main');
  updateHeaderUser();
  // Load everything in parallel for speed
  await Promise.all([
    loadParticipants(),
    loadUserConnections(),
    loadCurrentSpeaker(),
  ]);
  startSpeakerPolling();
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
    if (changed && state.activeTab === 'speaker') renderSpeaker();
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
      state.connections[c.participant_id][c.type] = c.source;
    }
  } catch (e) {
    console.error('loadUserConnections:', e);
  }
}

function startSpeakerPolling() {
  clearInterval(state.speakerPollTimer);
  // Poll every 5 s — 200 users × 0.2 req/s = 40 req/s, SQLite handles this easily
  state.speakerPollTimer = setInterval(loadCurrentSpeaker, 5000);
}

// ════════════════════════════════════════════════
// CONNECTION LOGIC
// ════════════════════════════════════════════════

/** Count unique participants that have at least one BROWSE-sourced connection */
function getBrowseCount() {
  return Object.values(state.connections).filter(
    types => Object.values(types).includes('browse')
  ).length;
}

/**
 * Toggle a connection on/off.
 * Uses optimistic updates for instant UI feedback.
 */
async function toggleConnection(participantId, type, source) {
  const pid      = Number(participantId);
  const existing = state.connections[pid]?.[type];
  const isOn     = !!existing;

  // ── Browse limit check (3 unique people) ──
  if (source === 'browse' && !isOn) {
    const alreadyInBrowse = state.connections[pid] &&
      Object.values(state.connections[pid]).includes('browse');
    if (!alreadyInBrowse && getBrowseCount() >= 3) {
      showToast('請專注於最想交流的三位夥伴。', 'warning');
      return;
    }
  }

  // ── Optimistic update ──
  if (isOn) {
    delete state.connections[pid][type];
    if (Object.keys(state.connections[pid]).length === 0) delete state.connections[pid];
  } else {
    if (!state.connections[pid]) state.connections[pid] = {};
    state.connections[pid][type] = source;
  }

  updateCounterBadge();
  if (source === 'speaker') renderSpeaker();
  else renderParticipantsList();

  // ── Persist to server ──
  try {
    if (isOn) {
      await api('DELETE', '/api/connect', {
        userId: state.user.userId, participantId: pid, type,
      });
    } else {
      await api('POST', '/api/connect', {
        userId: state.user.userId, participantId: pid, type, source,
      });
    }
  } catch {
    // Revert optimistic update
    if (isOn) {
      if (!state.connections[pid]) state.connections[pid] = {};
      state.connections[pid][type] = existing;
    } else {
      delete state.connections[pid]?.[type];
      if (state.connections[pid] && Object.keys(state.connections[pid]).length === 0)
        delete state.connections[pid];
    }
    updateCounterBadge();
    if (source === 'speaker') renderSpeaker();
    else renderParticipantsList();
    showToast('操作失敗，請重試', 'error');
  }
}

// ════════════════════════════════════════════════
// RENDER: CURRENT SPEAKER
// ════════════════════════════════════════════════
function renderSpeaker() {
  const el = document.getElementById('speaker-content');
  const s  = state.currentSpeaker;

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

  const conns      = state.connections[s.id] || {};
  const wantMeet   = !!conns['want_to_meet'];
  const canProvide = !!conns['can_provide'];

  el.innerHTML = `
    <div class="bg-white rounded-3xl shadow-lg overflow-hidden mb-4">
      <!-- Red top bar -->
      <div class="bg-red-600 px-5 py-3 flex items-center gap-2">
        <span class="bg-white text-red-600 text-xs font-black px-2 py-0.5 rounded-full pulse-red">LIVE</span>
        <span class="text-white font-bold text-sm">目前發言者</span>
      </div>

      <!-- Speaker info -->
      <div class="px-5 pt-5 pb-4">
        <h2 class="text-4xl font-black text-gray-800 mb-1">${esc(s.name)}</h2>
        <p class="text-gray-500 text-lg">${esc(s.industry || '（未填寫專業）')}</p>
        <p class="text-red-600 font-bold text-base mt-1">
          📍 第 <span class="text-2xl">${esc(s.table_number || '?')}</span> 桌
        </p>

        ${s.needs ? `
          <div class="mt-4 bg-red-50 border border-red-100 rounded-2xl p-4">
            <p class="text-red-600 text-xs font-bold uppercase tracking-wide mb-1">需求</p>
            <p class="text-gray-700 text-base leading-relaxed">${esc(s.needs)}</p>
          </div>
        ` : ''}
      </div>

      <!-- Action Buttons -->
      <div class="px-5 pb-5 grid grid-cols-2 gap-3">
        <button
          onclick="toggleConnection(${s.id}, 'want_to_meet', 'speaker')"
          class="py-5 rounded-2xl font-bold text-base border-2 transition-all ${
            wantMeet
              ? 'bg-red-600 text-white border-red-600 shadow-md'
              : 'border-red-500 text-red-600 bg-white active:bg-red-50'
          }"
        >
          ${wantMeet ? '✓ 已標記' : '🤝 我想認識他'}
        </button>
        <button
          onclick="toggleConnection(${s.id}, 'can_provide', 'speaker')"
          class="py-5 rounded-2xl font-bold text-base border-2 transition-all ${
            canProvide
              ? 'bg-red-600 text-white border-red-600 shadow-md'
              : 'border-red-500 text-red-600 bg-white active:bg-red-50'
          }"
        >
          ${canProvide ? '✓ 已標記' : '💼 我可提供'}
        </button>
      </div>
    </div>

    <p class="text-center text-gray-400 text-xs">每 5 秒自動更新 · 點擊按鈕即時記錄</p>
  `;
}

// ════════════════════════════════════════════════
// RENDER: PARTICIPANT LIST
// ════════════════════════════════════════════════
function renderParticipantsList() {
  const el     = document.getElementById('participants-list');
  const search = (document.getElementById('search-input')?.value || '').toLowerCase().trim();

  const list = search
    ? state.participants.filter(p =>
        p.name.toLowerCase().includes(search) ||
        (p.industry || '').toLowerCase().includes(search) ||
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
          <!-- Name row -->
          <div class="flex items-start justify-between mb-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-xl font-black text-gray-800">${esc(p.name)}</h3>
                ${isSpeaker ? '<span class="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full font-bold">發言中</span>' : ''}
                ${hasAny ? '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-semibold">已選</span>' : ''}
              </div>
              <p class="text-gray-500 text-sm mt-0.5">${esc(p.industry || '')}</p>
            </div>
            <span class="text-red-600 font-bold text-sm whitespace-nowrap ml-2">
              第 ${esc(p.table_number || '?')} 桌
            </span>
          </div>

          <!-- Buttons -->
          <div class="grid grid-cols-2 gap-2">
            <button
              onclick="toggleConnection(${p.id}, 'want_to_meet', 'browse')"
              class="py-3.5 rounded-xl font-bold text-sm border-2 transition-all ${
                wantMeet
                  ? 'bg-red-600 text-white border-red-600'
                  : 'border-gray-300 text-gray-600 bg-white active:bg-gray-50'
              }"
            >
              ${wantMeet ? '✓ 想交流' : '想交流'}
            </button>
            <button
              onclick="toggleConnection(${p.id}, 'can_provide', 'browse')"
              class="py-3.5 rounded-xl font-bold text-sm border-2 transition-all ${
                canProvide
                  ? 'bg-red-600 text-white border-red-600'
                  : 'border-gray-300 text-gray-600 bg-white active:bg-gray-50'
              }"
            >
              ${canProvide ? '✓ 可提供資源' : '可提供資源'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  updateCounterBadge();
}

function filterParticipants() {
  renderParticipantsList();
}

function updateCounterBadge() {
  const count = getBrowseCount();
  const badge = document.getElementById('counter-badge');
  if (!badge) return;
  badge.textContent = `${count} / 3`;
  badge.className = count >= 3
    ? 'bg-red-600 text-white font-black px-4 py-1 rounded-full text-sm'
    : 'bg-gray-100 text-gray-700 font-black px-4 py-1 rounded-full text-sm';
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

  if (!isSpeaker) {
    renderParticipantsList();
    updateCounterBadge();
  } else {
    renderSpeaker();
  }
}

function showScreen(name) {
  document.getElementById('screen-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('screen-main').classList.toggle('hidden', name !== 'main');
}

function updateHeaderUser() {
  const el = document.getElementById('header-user');
  if (el && state.user) {
    el.textContent = `${state.user.name} · ${state.user.role}`;
  }
}

// ════════════════════════════════════════════════
// LOGIN / LOGOUT
// ════════════════════════════════════════════════
async function handleLogin() {
  const name   = document.getElementById('input-name').value.trim();
  const roleEl = document.querySelector('input[name="role"]:checked');

  if (!name) {
    showToast('請輸入你的名字', 'error');
    document.getElementById('input-name').focus();
    return;
  }
  if (!roleEl) {
    showToast('請選擇你的身份', 'error');
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled   = true;
  btn.textContent = '登入中...';

  try {
    const data = await api('POST', '/api/login', { name, role: roleEl.value });
    state.user = { userId: data.userId, name: data.name, role: data.role };
    localStorage.setItem('bni_session', JSON.stringify(state.user));
    await startApp();
  } catch (e) {
    showToast(e.message || '登入失敗，請重試', 'error');
    btn.disabled   = false;
    btn.textContent = '進入交流系統';
  }
}

function handleLogout() {
  clearInterval(state.speakerPollTimer);
  state.user        = null;
  state.connections = {};
  state.participants = [];
  state.currentSpeaker = null;
  state.activeTab   = 'speaker';
  localStorage.removeItem('bni_session');

  // Reset tabs
  switchTab('speaker');
  showScreen('login');

  // Reset form
  document.getElementById('input-name').value = '';
  document.querySelectorAll('input[name="role"]').forEach(r => r.checked = false);
  updateRoleStyle();
}

// ════════════════════════════════════════════════
// ROLE BUTTON STYLE
// ════════════════════════════════════════════════
function updateRoleStyle() {
  const map = {
    '長榮會員': 'role-label-member',
    '來賓':     'role-label-guest',
    '親友':     'role-label-friend',
  };
  document.querySelectorAll('input[name="role"]').forEach(el => {
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

  // Colors
  el.className = 'fixed bottom-6 left-4 right-4 max-w-sm mx-auto text-white text-center py-3.5 px-5 rounded-2xl shadow-2xl z-50 text-base font-semibold';
  if (type === 'error' || type === 'warning') el.classList.add('bg-red-600');
  else if (type === 'success')               el.classList.add('bg-green-600');
  else                                        el.classList.add('bg-gray-800');

  // Animate in
  el.style.transform = 'translateY(0)';
  el.style.opacity   = '1';

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.transform = 'translateY(120px)';
    el.style.opacity   = '0';
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
