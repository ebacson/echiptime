(function () {
  'use strict';

  const ALL_CHECKPOINTS = ['START', 'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'CP7', 'CP8', 'FINISH'];
  const SCAN_DEBOUNCE_MS = 2000;

  let eventData = null;
  let athletesByBib = new Map();
  let allAthletes = [];
  let activeContext = { uid: '', eventKey: '', dbPath: '' };
  let qrScanner = null;
  let lastScanAt = 0;
  let lastScannedBib = '';
  let currentFacingMode = 'environment';
  let cameraRunning = false;
  let nativeScanFrameId = null;
  let pendingSearch = '';
  let firebaseLoadState = 'loading';
  let firebaseValueUnsubscribe = null;
  let discoveredEvents = [];
  let authListenerAttached = false;
  let pendingCheckInPhoto = null;

  const CHECKIN_MAX_IMAGE_WIDTH = 800;
  const CHECKIN_JPEG_QUALITY = 0.72;

  function getAuthUid() {
    return (window.authCurrentUser && window.authCurrentUser.uid) ? window.authCurrentUser.uid : '';
  }

  function getEffectiveUid() {
    const authUid = getAuthUid();
    if (authUid) return authUid;
    return (getQueryParams().uid || '').trim();
  }

  function needsLogin() {
    const qp = getQueryParams();
    if (qp.fixture) return false;
    if (getAuthUid()) return false;
    if (qp.uid) return false;
    if (qp.event && !qp.uid) return false;
    return true;
  }

  function showAuthError(message) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
  }

  function setAuthUi(user) {
    const authPanel = document.getElementById('auth-panel');
    const mainApp = document.getElementById('main-app');
    const userBar = document.getElementById('user-bar');
    const userEmail = document.getElementById('user-email');
    const loginRequired = needsLogin();

    if (authPanel) authPanel.style.display = loginRequired ? 'block' : 'none';
    if (mainApp) mainApp.classList.toggle('hidden', loginRequired);

    if (userBar && userEmail) {
      if (user && user.email) {
        userBar.style.display = 'flex';
        userEmail.textContent = user.email;
      } else if (getEffectiveUid() && !loginRequired) {
        userBar.style.display = 'none';
        userEmail.textContent = '';
      } else {
        userBar.style.display = 'none';
        userEmail.textContent = '';
      }
    }
  }

  function authErrorMessage(err) {
    const code = err && err.code ? String(err.code) : '';
    const map = {
      'auth/invalid-email': 'Email không hợp lệ',
      'auth/user-disabled': 'Tài khoản đã bị vô hiệu hóa',
      'auth/user-not-found': 'Email hoặc mật khẩu không đúng',
      'auth/wrong-password': 'Email hoặc mật khẩu không đúng',
      'auth/invalid-credential': 'Email hoặc mật khẩu không đúng',
      'auth/too-many-requests': 'Đăng nhập quá nhiều lần. Thử lại sau.',
      'auth/network-request-failed': 'Lỗi mạng. Kiểm tra kết nối internet.',
    };
    return map[code] || (err && err.message) || 'Đăng nhập thất bại';
  }

  function waitForAuthInit() {
    return new Promise((resolve) => {
      if (window.firebaseAuthReady) {
        resolve(window.authCurrentUser);
        return;
      }
      const prev = window.onAuthStateReady;
      window.onAuthStateReady = (user) => {
        if (typeof prev === 'function') prev(user);
        window.onAuthStateReady = prev;
        resolve(user);
      };
      setTimeout(() => resolve(window.authCurrentUser), 5000);
    });
  }

  async function handleAuthChange(user) {
    setAuthUi(user);
    showAuthError('');

    const qp = getQueryParams();
    if (qp.fixture) return;

    if (needsLogin()) {
      firebaseLoadState = 'idle';
      showLoading(false);
      detachFirebaseListener();
      updateMetaCounts();
      showStatus('Đăng nhập tài khoản BTC để tải danh sách VĐV', 'info');
      return;
    }

    try {
      showLoading(true);
      await resolveAndLoad();
    } catch (err) {
      firebaseLoadState = 'error';
      showLoading(false);
      const countEl = document.getElementById('athlete-count');
      if (countEl) countEl.textContent = 'Lỗi tải';
      showStatus(err.message || 'Lỗi tải dữ liệu', 'error');
      console.error(err);
    }
  }

  function attachAuthListener() {
    if (authListenerAttached) return;
    authListenerAttached = true;
    const prev = window.onAuthStateReady;
    window.onAuthStateReady = (user) => {
      if (typeof prev === 'function') prev(user);
      handleAuthChange(user);
    };
  }

  function firebaseKeySanitize(s) {
    return String(s || '').replace(/[.#$\[\]\/]/g, '_');
  }

  function buildEventDbPath(uid, eventKey) {
    const ev = firebaseKeySanitize(eventKey);
    const u = (uid || '').trim();
    if (u) return `${firebaseKeySanitize(u)}/${ev}`;
    return ev;
  }

  function isEventPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.Athletes || data.RACE_CONFIG) return true;
    return ALL_CHECKPOINTS.some((cp) => data[cp] != null);
  }

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      uid: (params.get('uid') || '').trim(),
      event: (params.get('event') || params.get('event_name') || '').trim(),
      fixture: (params.get('fixture') || '').trim(),
      bib: (params.get('bib') || '').trim(),
    };
  }

  function getEventDisplayName(data, fallbackKey) {
    const name = data?.RACE_CONFIG?.event_name;
    if (name && String(name).trim()) return String(name).trim();
    return String(fallbackKey || '').replace(/_/g, ' ');
  }

  function normalizeBib(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  /** Trích BIB từ nội dung QR (plain text, URL, số Excel dạng 1234.0, ...) */
  function extractBibFromQr(raw) {
    let text = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!text) return '';

    const firstLine = text.split(/[\r\n]+/).map((s) => s.trim()).find(Boolean) || '';
    text = firstLine;

    if (/^\d+\.0$/.test(text)) {
      text = text.replace(/\.0$/, '');
    }

    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        const fromQuery = url.searchParams.get('bib') || url.searchParams.get('BIB');
        if (fromQuery) return fromQuery.trim();
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length) return parts[parts.length - 1].trim();
      } catch (_) {}
    }

    const bibInText = text.match(/\b(\d{1,5}-[A-Z])\b/i) || text.match(/\b(\d{1,5}-T)\b/i);
    if (bibInText) return bibInText[1];

    return text;
  }

  function formatGender(gen) {
    const g = String(gen || '').trim().toUpperCase();
    if (g === 'M') return 'Nam';
    if (g === 'F') return 'Nữ';
    if (g === 'TEAM') return 'Đội';
    return gen || '—';
  }

  function showStatus(message, type) {
    const el = document.getElementById('status-message');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'status-message' + (type ? ` ${type}` : '');
    el.style.display = message ? 'block' : 'none';
  }

  function showLoading(show) {
    const el = document.getElementById('loading');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  function getAthletesNode(data) {
    if (!data || typeof data !== 'object') return {};
    if (data.Athletes && typeof data.Athletes === 'object') return data.Athletes;
    if (data.athletes && typeof data.athletes === 'object') return data.athletes;
    return {};
  }

  function detachFirebaseListener() {
    if (firebaseValueUnsubscribe) {
      firebaseValueUnsubscribe();
      firebaseValueUnsubscribe = null;
    }
  }

  function updateFirebasePathLabel() {
    /* path không hiển thị cho người dùng */
  }

  function renderEventPicker(events, selectedPath) {
    const wrap = document.getElementById('event-picker-wrap');
    const select = document.getElementById('event-picker');
    discoveredEvents = events;
    if (!wrap || !select || events.length <= 1) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    select.innerHTML = events.map((ev) => {
      const label = ev.displayName || ev.eventKey.replace(/_/g, ' ');
      const selected = ev.dbPath === selectedPath ? ' selected' : '';
      return `<option value="${ev.dbPath}"${selected}>${label}</option>`;
    }).join('');
    select.onchange = () => {
      const chosen = events.find((e) => e.dbPath === select.value);
      if (chosen) loadFromFirebase(chosen.uid, chosen.eventKey, chosen.displayName);
    };
  }

  async function discoverEvents() {
    const rootRef = window.firebaseRef(window.firebaseDatabase, '/');
    const snapshot = await window.firebaseGet(rootRef);
    if (!snapshot.exists()) return [];

    const rootData = snapshot.val() || {};
    const found = [];

    for (const rootKey of Object.keys(rootData)) {
      const node = rootData[rootKey];
      if (!node || typeof node !== 'object') continue;

      if (isEventPayload(node)) {
        found.push({
          uid: '',
          eventKey: rootKey,
          dbPath: firebaseKeySanitize(rootKey),
          displayName: getEventDisplayName(node, rootKey),
        });
        continue;
      }

      for (const eventKey of Object.keys(node)) {
        const eventNode = node[eventKey];
        if (isEventPayload(eventNode)) {
          found.push({
            uid: rootKey,
            eventKey,
            dbPath: buildEventDbPath(rootKey, eventKey),
            displayName: getEventDisplayName(eventNode, eventKey),
          });
        }
      }
    }

    return found;
  }

  async function resolveEventTarget() {
    const qp = getQueryParams();
    const effectiveUid = getEffectiveUid();

    if (qp.fixture) {
      return {
        uid: '',
        eventKey: qp.fixture,
        dbPath: '',
        displayName: qp.fixture.replace(/_/g, ' '),
      };
    }
    if (effectiveUid && qp.event) {
      return {
        uid: effectiveUid,
        eventKey: qp.event,
        dbPath: buildEventDbPath(effectiveUid, qp.event),
        displayName: qp.event.replace(/_/g, ' '),
      };
    }
    if (qp.event && !effectiveUid) {
      return {
        uid: '',
        eventKey: qp.event,
        dbPath: firebaseKeySanitize(qp.event),
        displayName: qp.event.replace(/_/g, ' '),
      };
    }

    const all = await discoverEvents();
    if (all.length === 0) {
      throw new Error('Không tìm thấy giải chạy. Đăng nhập hoặc thêm ?event=... vào URL.');
    }

    if (effectiveUid && !qp.event) {
      const forUid = all.filter(
        (e) => e.uid === effectiveUid || firebaseKeySanitize(e.uid) === firebaseKeySanitize(effectiveUid)
      );
      if (forUid.length === 0) {
        throw new Error('Không có giải nào cho tài khoản đã đăng nhập. Tạo giải trên app iOS trước.');
      }
      if (forUid.length === 1) return forUid[0];
      renderEventPicker(forUid, forUid[0].dbPath);
      return forUid[0];
    }

    if (all.length === 1) return all[0];
    renderEventPicker(all, all[0].dbPath);
    return all[0];
  }

  function pickField(raw, keys) {
    for (const key of keys) {
      if (raw[key] != null && String(raw[key]).trim() !== '') {
        return String(raw[key]).trim();
      }
    }
    return '';
  }

  function readCheckInFields(raw) {
    const nested = (raw && raw.bibCheckIn && typeof raw.bibCheckIn === 'object') ? raw.bibCheckIn : {};
    return {
      status: pickField(raw, ['status', 'Status']) || pickField(nested, ['status']),
      image_checkin: pickField(raw, ['image_checkin', 'imageCheckin', 'checkInImageBase64'])
        || pickField(nested, ['imageBase64', 'image', 'image_checkin']),
      checkInAt: pickField(raw, ['checkInAt', 'checkedInAt']) || pickField(nested, ['checkedInAt', 'at']),
      checkInBy: pickField(raw, ['checkInBy', 'checkedInBy']) || pickField(nested, ['checkedInBy', 'by']),
    };
  }

  function normalizeAthleteRecord(raw, firebaseKey) {
    if (!raw || typeof raw !== 'object') return null;
    const bib = pickField(raw, ['bib', 'BIB', 'Bib']);
    const tagId = pickField(raw, ['tagId', 'TagID', 'tagID', 'TagId']) || firebaseKey;
    const checkIn = readCheckInFields(raw);
    return {
      firebaseKey,
      bib,
      name: pickField(raw, ['name', 'Name', 'NAME']),
      team: pickField(raw, ['team', 'Team', 'TEAM']),
      gen: pickField(raw, ['gen', 'Gen', 'GEN', 'gender', 'Gender']),
      age: pickField(raw, ['age', 'Age', 'AGE']),
      distance: pickField(raw, ['distance', 'Distance', 'DISTANCE']),
      tagId,
      email: pickField(raw, ['email', 'Email', 'EMAIL']),
      phone: pickField(raw, ['phone', 'Phone', 'PHONE']),
      personalId: pickField(raw, ['personalId', 'PersonalId', 'personalID']),
      uid: pickField(raw, ['uid', 'Uid', 'UID']),
      status: checkIn.status,
      image_checkin: checkIn.image_checkin,
      checkInAt: checkIn.checkInAt,
      checkInBy: checkIn.checkInBy,
    };
  }

  function formatCheckInTimestamp(date) {
    const d = date || new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`;
  }

  function toImageDataUrl(base64OrDataUrl) {
    const s = String(base64OrDataUrl || '').trim();
    if (!s) return '';
    if (s.startsWith('data:image/')) return s;
    return `data:image/jpeg;base64,${s}`;
  }

  function stripBase64Prefix(dataUrl) {
    return String(dataUrl || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  }

  function getAthleteCheckIn(athlete) {
    const status = athlete.status || '';
    const image = athlete.image_checkin || '';
    const at = athlete.checkInAt || '';
    const by = athlete.checkInBy || '';
    const received = /received|checked|đã nhận/i.test(status) || !!image;
    return { status, image, at, by, received };
  }

  function compressImageToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxSide = Math.max(img.width, img.height);
          const scale = maxSide > CHECKIN_MAX_IMAGE_WIDTH ? CHECKIN_MAX_IMAGE_WIDTH / maxSide : 1;
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Không thể xử lý ảnh'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', CHECKIN_JPEG_QUALITY));
        };
        img.onerror = () => reject(new Error('Không đọc được ảnh'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Không đọc được file ảnh'));
      reader.readAsDataURL(file);
    });
  }

  function renderCheckInSection(athlete) {
    if (getQueryParams().fixture) return '';

    const ci = getAthleteCheckIn(athlete);
    const previewSrc = pendingCheckInPhoto || (ci.image ? toImageDataUrl(ci.image) : '');
    const previewHtml = previewSrc
      ? `<img src="${previewSrc}" class="checkin-preview" alt="Ảnh nhận BIB">`
      : '<div class="checkin-preview-placeholder">Chưa có ảnh — chụp trước khi xác nhận</div>';

    const statusHtml = ci.received && !pendingCheckInPhoto
      ? `<p class="checkin-done">✓ Đã nhận BIB${ci.at ? ` — ${escapeHtml(ci.at)}` : ''}${ci.by ? ` (${escapeHtml(ci.by)})` : ''}</p>`
      : '';

    const canConfirm = !!previewSrc;

    return `
      <div class="checkin-section">
        <h3>Xác nhận nhận BIB</h3>
        ${statusHtml}
        ${previewHtml}
        <label class="btn btn-secondary btn-block file-label">
          Chụp ảnh người nhận BIB
          <input type="file" class="checkin-photo-input" accept="image/*" capture="user">
        </label>
        <button type="button" class="btn btn-success btn-block checkin-confirm-btn" ${canConfirm ? '' : 'disabled'}>
          Xác nhận đã nhận BIB
        </button>
      </div>`;
  }

  function bindCheckInEvents(card, athlete) {
    const section = card.querySelector('.checkin-section');
    if (!section) return;

    const fileInput = section.querySelector('.checkin-photo-input');
    const confirmBtn = section.querySelector('.checkin-confirm-btn');
    const previewBox = section.querySelector('.checkin-preview, .checkin-preview-placeholder');

    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          showStatus('Đang xử lý ảnh...', 'info');
          pendingCheckInPhoto = await compressImageToBase64(file);
          if (previewBox) {
            const img = document.createElement('img');
            img.src = pendingCheckInPhoto;
            img.className = 'checkin-preview';
            img.alt = 'Ảnh nhận BIB';
            previewBox.replaceWith(img);
          }
          if (confirmBtn) confirmBtn.disabled = false;
          showStatus('Đã chụp ảnh — nhấn xác nhận để lưu', 'info');
        } catch (err) {
          showStatus(err.message || 'Không xử lý được ảnh', 'error');
        }
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const imageData = pendingCheckInPhoto || toImageDataUrl(getAthleteCheckIn(athlete).image);
        if (!imageData) {
          showStatus('Vui lòng chụp ảnh trước khi xác nhận', 'error');
          return;
        }
        if (!getAuthUid()) {
          showStatus('Cần đăng nhập để lưu xác nhận nhận BIB', 'error');
          return;
        }
        confirmBtn.disabled = true;
        const oldText = confirmBtn.textContent;
        confirmBtn.textContent = 'Đang lưu...';
        try {
          await saveCheckInToFirebase(athlete, imageData);
          pendingCheckInPhoto = null;
          renderAthleteCard(athlete);
          showStatus(`Đã xác nhận nhận BIB ${athlete.bib}`, 'success');
          if (navigator.vibrate) navigator.vibrate(100);
        } catch (err) {
          showStatus(err.message || 'Lưu thất bại', 'error');
          confirmBtn.disabled = false;
          confirmBtn.textContent = oldText;
          console.error('check-in save error:', err);
        }
      });
    }
  }

  async function saveCheckInToFirebase(athlete, imageDataUrl) {
    if (!window.firebaseUpdate || !window.firebaseRef || !window.firebaseDatabase) {
      throw new Error('Chưa kết nối máy chủ');
    }
    if (!activeContext.dbPath) throw new Error('Chưa chọn giải');
    const key = athlete.firebaseKey;
    if (!key) throw new Error('Không xác định được VĐV');

    const base64 = stripBase64Prefix(imageDataUrl);
    if (!base64) throw new Error('Ảnh không hợp lệ');
    if (base64.length > 900000) {
      throw new Error('Ảnh quá lớn. Thử chụp lại gần hơn hoặc đủ sáng.');
    }

    const payload = {
      status: 'received',
      image_checkin: base64,
      checkInAt: formatCheckInTimestamp(new Date()),
      checkInBy: (window.authCurrentUser && window.authCurrentUser.email) || getAuthUid(),
    };

    const path = `${activeContext.dbPath}/Athletes/${key}`;
    const dataRef = window.firebaseRef(window.firebaseDatabase, path);
    await window.firebaseUpdate(dataRef, payload);

    Object.assign(athlete, payload);
    const idx = allAthletes.findIndex((a) => a.firebaseKey === key);
    if (idx >= 0) allAthletes[idx] = { ...allAthletes[idx], ...payload };
    bibAliases(athlete.bib).forEach((b) => athletesByBib.set(b, athlete));
    updateMetaCounts();
  }

  function countReceivedBibs() {
    return allAthletes.filter((a) => getAthleteCheckIn(a).received).length;
  }

  function updateMetaCounts() {
    const countEl = document.getElementById('athlete-count');
    const checkinEl = document.getElementById('checkin-count');
    const statTotal = document.getElementById('stat-total');
    const statReceived = document.getElementById('stat-received');
    const total = allAthletes.length;
    const received = countReceivedBibs();

    if (countEl) {
      countEl.textContent = total ? `${total} VĐV` : '0 VĐV';
    }
    if (checkinEl) {
      checkinEl.textContent = `Đã nhận BIB: ${received}${total ? `/${total}` : ''}`;
    }
    if (statTotal) {
      statTotal.textContent = total ? String(total) : '0';
    }
    if (statReceived) {
      statReceived.textContent = total ? `${received}/${total}` : '0';
    }
  }

  function bibAliases(bib) {
    const norm = normalizeBib(bib);
    if (!norm) return [];
    const aliases = new Set([norm]);
    const noLeadingZeros = norm.replace(/^0+(\d)/, '$1');
    if (noLeadingZeros) aliases.add(noLeadingZeros);
    if (/^\d+\.0$/.test(norm)) aliases.add(norm.replace(/\.0$/, ''));
    return [...aliases];
  }

  function buildAthleteIndex(athletesNode) {
    const byBib = new Map();
    const list = [];
    if (!athletesNode || typeof athletesNode !== 'object') return { byBib, list };

    Object.entries(athletesNode).forEach(([firebaseKey, raw]) => {
      const record = normalizeAthleteRecord(raw, firebaseKey);
      if (!record) return;
      list.push(record);

      const keys = new Set();
      bibAliases(record.bib).forEach((k) => keys.add(k));
      bibAliases(record.tagId).forEach((k) => keys.add(k));
      bibAliases(firebaseKey).forEach((k) => keys.add(k));

      keys.forEach((key) => {
        if (key && !byBib.has(key)) byBib.set(key, record);
      });
    });

    return { byBib, list };
  }

  function findAthleteByBib(bib) {
    const aliases = bibAliases(bib);
    for (const key of aliases) {
      const hit = athletesByBib.get(key);
      if (hit) return hit;
    }
    return allAthletes.find((a) => {
      const athleteAliases = bibAliases(a.bib);
      return aliases.some((key) => athleteAliases.includes(key));
    }) || null;
  }

  function normalizeDigits(s) {
    return String(s || '').replace(/\D/g, '');
  }

  function normalizeSearchQuery(raw) {
    return String(raw || '').trim();
  }

  function findAthletesByQuery(rawQuery) {
    const query = normalizeSearchQuery(rawQuery);
    if (!query) return [];

    const bibHit = findAthleteByBib(query);
    if (bibHit) return [bibHit];

    const extractedBib = extractBibFromQr(query);
    if (extractedBib) {
      const fromQr = findAthleteByBib(normalizeBib(extractedBib));
      if (fromQr) return [fromQr];
    }

    const qLower = query.toLowerCase();
    const qDigits = normalizeDigits(query);
    const results = [];
    const seen = new Set();

    const add = (a) => {
      const key = a.firebaseKey || normalizeBib(a.bib);
      if (!key || seen.has(key)) return;
      seen.add(key);
      results.push(a);
    };

    allAthletes.forEach((a) => {
      const name = (a.name || '').toLowerCase();
      if (name && name.includes(qLower)) add(a);
    });

    if (qDigits.length >= 6) {
      allAthletes.forEach((a) => {
        const phone = normalizeDigits(a.phone);
        const pid = normalizeDigits(a.personalId);
        if (phone && phone.includes(qDigits)) add(a);
        if (pid && pid.includes(qDigits)) add(a);
      });
    }

    if (/^[0-9A-Za-z-]+$/.test(query)) {
      const qUpper = query.toUpperCase();
      allAthletes.forEach((a) => {
        const bib = normalizeBib(a.bib);
        if (bib && bib.includes(qUpper)) add(a);
      });
    }

    return results.sort((a, b) => normalizeBib(a.bib).localeCompare(normalizeBib(b.bib)));
  }

  function renderSearchResultsList(athletes, query) {
    const card = document.getElementById('athlete-card');
    if (!card) return;

    const items = athletes.map((a) => `
      <button type="button" class="search-result-item" data-bib="${escapeHtml(normalizeBib(a.bib))}">
        <strong>${escapeHtml(a.bib || '—')}</strong> — ${escapeHtml(a.name || '—')}
        ${a.phone ? `<span class="member-meta">SĐT: ${escapeHtml(a.phone)}</span>` : ''}
        ${a.personalId ? `<span class="member-meta">CCCD: ${escapeHtml(a.personalId)}</span>` : ''}
      </button>`).join('');

    card.innerHTML = `
      <h3 class="search-results-title">Tìm thấy ${athletes.length} VĐV — chọn để xem chi tiết</h3>
      <div class="search-results-list">${items}</div>`;
    card.classList.add('visible');
    card.classList.remove('error');

    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    card.querySelectorAll('.search-result-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bib = btn.getAttribute('data-bib');
        const athlete = findAthleteByBib(bib);
        if (athlete) renderAthleteCard(athlete);
      });
    });

    showStatus(`Tìm thấy ${athletes.length} VĐV cho "${query}"`, 'info');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function getTeamPrefix(bib) {
    const parts = bib.split('-');
    return parts.length > 1 ? parts[0] : bib;
  }

  function findTeamMembers(teamBib) {
    const prefix = getTeamPrefix(teamBib);
    return allAthletes
      .filter((a) => {
        const bib = normalizeBib(a.bib);
        if (!bib || bib === teamBib) return false;
        if (!bib.startsWith(prefix + '-')) return false;
        return !bib.endsWith('-T');
      })
      .sort((a, b) => normalizeBib(a.bib).localeCompare(normalizeBib(b.bib)));
  }

  function renderField(label, value, options) {
    const opts = options || {};
    const text = value != null && String(value).trim() !== '' ? String(value).trim() : '';
    if (!text && opts.hideEmpty) return '';
    const display = text || '—';
    const href = opts.href;
    const valueHtml = href && text
      ? `<a href="${href}" class="field-link">${escapeHtml(display)}</a>`
      : `<span class="field-value">${escapeHtml(display)}</span>`;
    return `
      <div class="info-row">
        <span class="info-label">${escapeHtml(label)}</span>
        ${valueHtml}
      </div>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderAthleteCard(athlete) {
    pendingCheckInPhoto = null;
    const bib = normalizeBib(athlete.bib);
    const isTeam = bib.endsWith('-T');
    const members = isTeam ? findTeamMembers(bib) : [];

    const rows = [
      renderField('BIB', athlete.bib),
      renderField('Họ tên', athlete.name),
      renderField('Đội / Team', athlete.team, { hideEmpty: true }),
      renderField('Giới tính', formatGender(athlete.gen)),
      renderField('Nhóm tuổi', athlete.age),
      renderField('Cự ly', athlete.distance),
      renderField('Tag ID', athlete.tagId, { hideEmpty: true }),
      renderField('Email', athlete.email, { hideEmpty: true, href: athlete.email ? `mailto:${athlete.email}` : null }),
      renderField('Điện thoại', athlete.phone, { hideEmpty: true, href: athlete.phone ? `tel:${athlete.phone}` : null }),
      renderField('CMND/CCCD', athlete.personalId, { hideEmpty: true }),
      renderField('UID', athlete.uid, { hideEmpty: true }),
    ].join('');

    let membersHtml = '';
    if (isTeam) {
      if (members.length) {
        const items = members.map((m) => `
          <li>
            <strong>${escapeHtml(normalizeBib(m.bib))}</strong>
            — ${escapeHtml(m.name || '—')}
            ${m.gen ? `<span class="member-meta">(${escapeHtml(formatGender(m.gen))})</span>` : ''}
          </li>`).join('');
        membersHtml = `
          <div class="team-members">
            <h3>Thành viên đội (${members.length})</h3>
            <ul>${items}</ul>
          </div>`;
      } else {
        membersHtml = `
          <div class="team-members empty">
            <p>Chưa có dữ liệu thành viên cho đội này.</p>
          </div>`;
      }
    }

    const card = document.getElementById('athlete-card');
    if (!card) return;

    card.innerHTML = `
      <div class="bib-badge">${escapeHtml(bib)}</div>
      <h2 class="athlete-name">${escapeHtml(athlete.name || '—')}</h2>
      <div class="info-grid">${rows}</div>
      ${membersHtml}
      ${renderCheckInSection(athlete)}`;
    card.classList.add('visible');
    card.classList.remove('error');

    bindCheckInEvents(card, athlete);

    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    showStatus(`Đã tìm thấy VĐV: ${athlete.name || bib}`, 'success');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showNotFound(query) {
    const card = document.getElementById('athlete-card');
    if (card) {
      card.innerHTML = `
        <div class="not-found">
          <div class="not-found-icon">?</div>
          <h2>Không tìm thấy VĐV</h2>
          <p>Không có kết quả cho <strong>${escapeHtml(query)}</strong> trong danh sách giải.</p>
        </div>`;
      card.classList.add('visible', 'error');
    }
    showStatus(`Không tìm thấy VĐV cho "${query}"`, 'error');
  }

  function executeLookup(rawQuery, options) {
    const opts = options || {};
    const fromQr = !!opts.fromQr;
    const query = fromQr
      ? normalizeSearchQuery(extractBibFromQr(rawQuery) || rawQuery)
      : normalizeSearchQuery(rawQuery);

    if (!query) {
      showStatus(fromQr ? 'Mã QR không hợp lệ' : 'Vui lòng nhập BIB, Tên, SĐT hoặc CCCD', 'error');
      return;
    }

    const manual = document.getElementById('manual-search');
    if (manual) manual.value = fromQr ? normalizeBib(query) : query;

    if (firebaseLoadState !== 'ready') {
      pendingSearch = query;
      showStatus(`Đã nhận "${query}" — đang tải danh sách VĐV...`, 'info');
      return;
    }

    if (!allAthletes.length) {
      pendingSearch = query;
      showStatus(
        `Đã nhận "${query}" — giải này chưa có VĐV (0 VĐV). Upload danh sách từ app iOS hoặc chọn đúng giải.`,
        'error'
      );
      return;
    }

    pendingSearch = '';
    let matches = [];
    if (fromQr) {
      const hit = findAthleteByBib(normalizeBib(query));
      if (hit) matches = [hit];
    } else {
      matches = findAthletesByQuery(query);
    }

    if (matches.length === 1) {
      renderAthleteCard(matches[0]);
    } else if (matches.length > 1) {
      renderSearchResultsList(matches, query);
    } else {
      showNotFound(query);
    }
  }

  function lookupAndShow(rawQuery, options) {
    executeLookup(rawQuery, options);
  }

  function onQrDecoded(text) {
    const extracted = extractBibFromQr(text);
    const bib = normalizeBib(extracted);
    if (!bib) return;

    const now = Date.now();
    if (bib === lastScannedBib && now - lastScanAt < SCAN_DEBOUNCE_MS) return;
    lastScannedBib = bib;
    lastScanAt = now;

    console.log('QR decoded:', text, '→ BIB:', bib);
    lookupAndShow(text, { fromQr: true });

    if (navigator.vibrate) navigator.vibrate(80);
  }

  function getScannerConfig() {
    return {
      fps: 15,
      disableFlip: false,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const w = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.9);
        const size = Math.max(150, Math.min(w, 400));
        return { width: size, height: size };
      },
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
    };
  }

  function stopNativeBarcodeLoop() {
    if (nativeScanFrameId) {
      cancelAnimationFrame(nativeScanFrameId);
      nativeScanFrameId = null;
    }
  }

  function startNativeBarcodeLoop() {
    stopNativeBarcodeLoop();
    if (!('BarcodeDetector' in window)) return;

    const video = document.querySelector('#qr-reader video');
    if (!video) return;

    let detector;
    try {
      detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) {
      return;
    }

    let lastNativeScan = 0;
    const scan = async () => {
      if (!cameraRunning) return;
      nativeScanFrameId = requestAnimationFrame(scan);

      const now = Date.now();
      if (now - lastNativeScan < 120) return;
      if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return;

      try {
        const codes = await detector.detect(video);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          lastNativeScan = now;
          onQrDecoded(codes[0].rawValue);
        }
      } catch (_) {}
    };

    nativeScanFrameId = requestAnimationFrame(scan);
  }

  function fixVideoForMobile() {
    document.querySelectorAll('#qr-reader video').forEach((video) => {
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.style.objectFit = 'cover';
      video.style.width = '100%';
    });
  }

  function setCameraUi(running) {
    cameraRunning = running;
    const prompt = document.getElementById('camera-prompt');
    const reader = document.getElementById('qr-reader');
    const actions = document.getElementById('camera-actions');
    if (prompt) prompt.style.display = running ? 'none' : 'block';
    if (reader) reader.classList.toggle('active', running);
    if (actions) actions.classList.toggle('active', running);
  }

  async function stopQrScanner() {
    stopNativeBarcodeLoop();
    if (!qrScanner) {
      setCameraUi(false);
      return;
    }
    try {
      const state = qrScanner.getState();
      if (state === 2) await qrScanner.stop();
    } catch (_) {}
    setCameraUi(false);
  }

  async function tryStartCamera(facingMode) {
    const readerId = 'qr-reader';
    if (!qrScanner) qrScanner = new Html5Qrcode(readerId);
    const config = getScannerConfig();
    await qrScanner.start(
      { facingMode },
      config,
      onQrDecoded,
      undefined
    );
    currentFacingMode = facingMode;
    fixVideoForMobile();
    startNativeBarcodeLoop();
  }

  async function startQrScanner() {
    if (!window.Html5Qrcode) {
      showStatus('Thư viện quét QR chưa tải xong', 'error');
      return false;
    }

    if (!window.isSecureContext) {
      showStatus('Camera cần HTTPS. Mở trang qua https:// hoặc localhost.', 'error');
      return false;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showStatus('Trình duyệt không hỗ trợ camera. Dùng "Chụp ảnh QR" hoặc nhập BIB.', 'error');
      return false;
    }

    await stopQrScanner();
    setCameraUi(true);

    const strategies = [
      () => tryStartCamera('environment'),
      () => tryStartCamera('user'),
      async () => {
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || !cameras.length) throw new Error('Không có camera');
        const backCam = cameras.find((c) => /back|rear|environment/i.test(c.label));
        const cameraId = (backCam || cameras[cameras.length - 1]).id;
        const config = getScannerConfig();
        await qrScanner.start(cameraId, config, onQrDecoded, undefined);
        fixVideoForMobile();
        startNativeBarcodeLoop();
      },
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        showStatus('Đưa mã QR vào giữa khung hình, giữ ổn định 1–2 giây', 'info');
        return true;
      } catch (err) {
        console.warn('Camera strategy failed:', err);
        try {
          const state = qrScanner.getState();
          if (state === 2) await qrScanner.stop();
        } catch (_) {}
      }
    }

    setCameraUi(false);
    const msg = 'Không mở được camera. Hãy cấp quyền Camera trong Cài đặt trình duyệt, hoặc dùng "Chụp ảnh QR".';
    showStatus(msg, 'error');
    return false;
  }

  async function switchCamera() {
    if (!cameraRunning) return;
    const next = currentFacingMode === 'environment' ? 'user' : 'environment';
    await stopQrScanner();
    setCameraUi(true);
    try {
      await tryStartCamera(next);
      showStatus(`Đã chuyển sang camera ${next === 'environment' ? 'sau' : 'trước'}`, 'info');
    } catch (err) {
      console.error('Switch camera error:', err);
      setCameraUi(false);
      showStatus('Không đổi được camera. Thử "Mở camera" lại.', 'error');
    }
  }

  async function scanFromFile(file) {
    if (!file || !window.Html5Qrcode) return;
    const readerId = 'qr-reader';
    await stopQrScanner();
    if (!qrScanner) qrScanner = new Html5Qrcode(readerId);
    try {
      const text = await qrScanner.scanFile(file, true);
      onQrDecoded(text);
      showStatus('Đã đọc QR từ ảnh', 'success');
    } catch (err) {
      console.error('scanFile error:', err);
      showStatus('Không đọc được mã QR trong ảnh. Thử chụp lại hoặc nhập BIB.', 'error');
    }
  }

  function applyEventData(data, eventKey, displayHint) {
    eventData = data;
    firebaseLoadState = 'ready';
    const indexed = buildAthleteIndex(getAthletesNode(data));
    athletesByBib = indexed.byBib;
    allAthletes = indexed.list;

    const title = getEventDisplayName(data, displayHint || eventKey);
    document.title = `Quét BIB — ${title}`;

    const titleEl = document.getElementById('event-title');
    if (titleEl) titleEl.textContent = title;

    updateMetaCounts();

    updateFirebasePathLabel();

    showLoading(false);

    const qp = getQueryParams();
    const cardVisible = document.getElementById('athlete-card')?.classList.contains('visible');

    if (pendingSearch) {
      executeLookup(pendingSearch, { fromQr: false });
    } else if (qp.bib) {
      executeLookup(qp.bib, { fromQr: true });
    } else if (!allAthletes.length) {
      showStatus('Chưa có VĐV cho giải này. Upload Athletes từ app iOS hoặc chọn giải khác.', 'error');
    } else if (!cardVisible) {
      showStatus(`Đã tải ${allAthletes.length} VĐV — nhấn "Mở camera" để quét QR`, 'info');
    }
  }

  async function loadFixture(fileName) {
    const res = await fetch(`fixtures/${fileName}`);
    if (!res.ok) throw new Error(`Không thể tải fixture: ${fileName}`);
    const data = await res.json();
    if (!isEventPayload(data)) throw new Error('Fixture không hợp lệ');
    activeContext = { uid: '', eventKey: fileName, dbPath: '' };
    applyEventData(data, fileName, fileName.replace(/_/g, ' '));
  }

  function loadFromFirebase(uid, eventKey, displayHint) {
    const dbPath = buildEventDbPath(uid, eventKey);
    if (!dbPath) throw new Error('Thiếu tham số giải (event)');

    detachFirebaseListener();
    firebaseLoadState = 'loading';
    activeContext = { uid: uid || '', eventKey, dbPath };
    updateFirebasePathLabel();

    const countEl = document.getElementById('athlete-count');
    if (countEl) countEl.textContent = 'Đang tải...';

    const dataRef = window.firebaseRef(window.firebaseDatabase, dbPath);

    return window.firebaseGet(dataRef).then((snapshot) => {
      if (!snapshot.exists()) {
        firebaseLoadState = 'error';
        throw new Error('Không tìm thấy dữ liệu giải. Kiểm tra tên giải hoặc đăng nhập đúng tài khoản.');
      }
      const val = snapshot.val();
      const athleteCount = Object.keys(getAthletesNode(val)).length;
      console.log('Firebase loaded:', dbPath, 'Athletes:', athleteCount);
      applyEventData(val, eventKey, displayHint);

      firebaseValueUnsubscribe = window.firebaseOnValue(dataRef, (live) => {
        const liveVal = live.val();
        if (!liveVal) return;
        applyEventData(liveVal, eventKey, displayHint);
      });
    });
  }

  async function resolveAndLoad() {
    const qp = getQueryParams();

    if (qp.fixture) {
      firebaseLoadState = 'ready';
      await loadFixture(qp.fixture);
      return;
    }

    const target = await resolveEventTarget();
    if (!target.dbPath) {
      throw new Error('Không xác định được dữ liệu giải');
    }
    await loadFromFirebase(target.uid, target.eventKey, target.displayName);
  }

  function bindUi() {
    const form = document.getElementById('manual-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('manual-search');
        executeLookup(input ? input.value : '', { fromQr: false });
      });
    }

    const startBtn = document.getElementById('start-camera-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        startQrScanner();
      });
    }

    const stopBtn = document.getElementById('stop-camera-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        stopQrScanner();
        showStatus('Camera đã tắt. Nhấn "Mở camera" để quét tiếp.', 'info');
      });
    }

    const switchBtn = document.getElementById('switch-camera-btn');
    if (switchBtn) {
      switchBtn.addEventListener('click', () => {
        switchCamera();
      });
    }

    const fileInput = document.getElementById('qr-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) scanFromFile(file);
        e.target.value = '';
      });
    }

    const rescanBtn = document.getElementById('rescan-btn');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', () => {
        lastScannedBib = '';
        pendingCheckInPhoto = null;
        const card = document.getElementById('athlete-card');
        if (card) {
          card.classList.remove('visible');
          card.innerHTML = '';
        }
        const empty = document.getElementById('empty-state');
        if (empty) empty.style.display = 'block';
        const manual = document.getElementById('manual-search');
        if (manual) manual.value = '';
        if (cameraRunning) {
          showStatus('Đưa mã QR vào giữa khung hình, giữ ổn định 1–2 giây', 'info');
        } else {
          showStatus('Nhấn "Mở camera" để quét QR', 'info');
        }
      });
    }

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const emailEl = document.getElementById('login-email');
        const passEl = document.getElementById('login-password');
        const btn = document.getElementById('login-btn');
        const email = emailEl ? emailEl.value.trim() : '';
        const password = passEl ? passEl.value : '';
        if (!email || !password) {
          showAuthError('Vui lòng nhập email và mật khẩu');
          return;
        }
        showAuthError('');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Đang đăng nhập...';
        }
        try {
          if (!window.firebaseSignIn) throw new Error('Chức năng đăng nhập chưa sẵn sàng');
          await window.firebaseSignIn(email, password);
        } catch (err) {
          showAuthError(authErrorMessage(err));
          console.error('Login error:', err);
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Đăng nhập';
          }
        }
      });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await stopQrScanner();
          detachFirebaseListener();
          pendingSearch = '';
          firebaseLoadState = 'idle';
          athletesByBib = new Map();
          allAthletes = [];
          if (window.firebaseSignOut) await window.firebaseSignOut();
        } catch (err) {
          showStatus(authErrorMessage(err), 'error');
        }
      });
    }
  }

  async function init() {
    bindUi();
    attachAuthListener();
    updateMetaCounts();
    showLoading(true);

    const waitFirebase = () => new Promise((resolve, reject) => {
      let tries = 0;
      const t = setInterval(() => {
        tries += 1;
        if (window.firebaseDatabase && window.firebaseRef && window.firebaseGet && window.firebaseSignIn && window.firebaseUpdate) {
          clearInterval(t);
          resolve();
        } else if (tries > 50) {
          clearInterval(t);
          reject(new Error('Không thể kết nối máy chủ'));
        }
      }, 100);
    });

    try {
      const qp = getQueryParams();
      if (qp.fixture) {
        setAuthUi(null);
        await loadFixture(qp.fixture);
        return;
      }

      await waitFirebase();
      await waitForAuthInit();
      await handleAuthChange(window.authCurrentUser);
    } catch (err) {
      firebaseLoadState = 'error';
      showLoading(false);
      const countEl = document.getElementById('athlete-count');
      if (countEl) countEl.textContent = 'Lỗi tải';
      showStatus(err.message || 'Lỗi tải dữ liệu', 'error');
      console.error(err);
    }
  }

  window.addEventListener('beforeunload', () => {
    stopQrScanner();
    detachFirebaseListener();
  });

  window.addEventListener('DOMContentLoaded', init);
})();
