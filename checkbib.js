(function () {
  'use strict';

  const ALL_CHECKPOINTS = ['START', 'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'CP7', 'CP8', 'FINISH'];
  const TAG_DEBOUNCE_MS = 1500;

  let eventData = null;
  let athletesByKey = new Map();
  let allAthletes = [];
  let activeContext = { uid: '', eventKey: '', dbPath: '' };
  let firebaseLoadState = 'loading';
  let firebaseValueUnsubscribe = null;
  let discoveredEvents = [];
  let authListenerAttached = false;
  let usbReader = null;
  let lastLookupTag = '';
  let lastLookupAt = 0;

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
      updateMetaCounts();
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
      tag: (params.get('tag') || '').trim(),
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

  function normalizeTagHex(raw) {
    return String(raw || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
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

  function setReaderStatus(text, state) {
    const el = document.getElementById('reader-status');
    if (!el) return;
    el.textContent = text || '—';
    el.className = 'reader-status' + (state ? ` ${state}` : '');
  }

  function setLastTag(text) {
    const el = document.getElementById('last-tag');
    if (el) el.textContent = text || '—';
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

  function getAthleteCheckIn(athlete) {
    const status = athlete.status != null ? String(athlete.status).trim() : '';
    const image = athlete.image_checkin || '';
    const received = /received|checked|đã nhận|true|1|yes|ok/i.test(status) || !!image;
    return { received, at: athlete.checkInAt || '', by: athlete.checkInBy || '' };
  }

  function keyAliases(key) {
    const norm = normalizeBib(key);
    if (!norm) return [];
    const aliases = new Set([norm]);
    const noLeadingZeros = norm.replace(/^0+(\d)/, '$1');
    if (noLeadingZeros) aliases.add(noLeadingZeros);
    if (/^\d+\.0$/.test(norm)) aliases.add(norm.replace(/\.0$/, ''));
    return [...aliases];
  }

  function tagLookupVariants(rawTag) {
    const variants = new Set();
    const hex = normalizeTagHex(rawTag);
    if (hex) variants.add(hex);

    const plain = String(rawTag || '').trim().toUpperCase();
    if (plain) variants.add(plain);

    keyAliases(plain).forEach((a) => variants.add(a));
    if (hex) keyAliases(hex).forEach((a) => variants.add(a));

    if (hex.length >= 4 && hex.length % 2 === 0) {
      let ascii = '';
      let printable = true;
      for (let i = 0; i < hex.length; i += 2) {
        const b = parseInt(hex.substr(i, 2), 16);
        if (Number.isNaN(b) || b < 32 || b > 126) {
          printable = false;
          break;
        }
        ascii += String.fromCharCode(b);
      }
      if (printable && ascii) {
        variants.add(ascii.toUpperCase());
        keyAliases(ascii).forEach((a) => variants.add(a));
      }
    }

    return [...variants].filter(Boolean);
  }

  function buildAthleteIndex(athletesNode) {
    const byKey = new Map();
    const list = [];
    if (!athletesNode || typeof athletesNode !== 'object') return { byKey, list };

    Object.entries(athletesNode).forEach(([firebaseKey, raw]) => {
      const record = normalizeAthleteRecord(raw, firebaseKey);
      if (!record) return;
      list.push(record);

      const keys = new Set();
      keyAliases(record.bib).forEach((k) => keys.add(k));
      keyAliases(record.tagId).forEach((k) => keys.add(k));
      keyAliases(firebaseKey).forEach((k) => keys.add(k));
      tagLookupVariants(record.tagId).forEach((k) => keys.add(k));
      tagLookupVariants(firebaseKey).forEach((k) => keys.add(k));

      keys.forEach((key) => {
        if (key && !byKey.has(key)) byKey.set(key, record);
      });
    });

    return { byKey, list };
  }

  function findAthleteByTag(rawTag) {
    const variants = tagLookupVariants(rawTag);
    for (const key of variants) {
      const hit = athletesByKey.get(key);
      if (hit) return hit;
    }
    return allAthletes.find((a) => {
      const athleteVariants = new Set([
        ...tagLookupVariants(a.tagId),
        ...tagLookupVariants(a.firebaseKey),
        ...keyAliases(a.bib),
      ]);
      return variants.some((v) => athleteVariants.has(v));
    }) || null;
  }

  function updateMetaCounts() {
    const statTotal = document.getElementById('stat-total');
    const total = allAthletes.length;
    const loading = firebaseLoadState === 'loading';
    const errored = firebaseLoadState === 'error';

    if (statTotal) {
      if (loading) statTotal.textContent = '…';
      else if (errored) statTotal.textContent = '—';
      else statTotal.textContent = String(total);
    }
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

  function renderAthleteCard(athlete, tagRead) {
    const bib = normalizeBib(athlete.bib);
    const isTeam = bib.endsWith('-T');
    const members = isTeam ? findTeamMembers(bib) : [];
    const received = getAthleteCheckIn(athlete).received;

    const rows = [
      renderField('BIB', athlete.bib),
      renderField('Họ tên', athlete.name),
      renderField('Đội / Team', athlete.team, { hideEmpty: true }),
      renderField('Giới tính', formatGender(athlete.gen)),
      renderField('Nhóm tuổi', athlete.age),
      renderField('Cự ly', athlete.distance),
      renderField('Tag ID', athlete.tagId, { hideEmpty: true }),
      renderField('Tag đọc được', tagRead, { hideEmpty: !tagRead }),
      renderField('Email', athlete.email, { hideEmpty: true, href: athlete.email ? `mailto:${athlete.email}` : null }),
      renderField('Điện thoại', athlete.phone, { hideEmpty: true, href: athlete.phone ? `tel:${athlete.phone}` : null }),
      renderField('CMND/CCCD', athlete.personalId, { hideEmpty: true }),
    ].join('');

    let membersHtml = '';
    if (isTeam && members.length) {
      const items = members.map((m) => `
        <li>
          <strong>${escapeHtml(normalizeBib(m.bib))}</strong>
          — ${escapeHtml(m.name || '—')}
        </li>`).join('');
      membersHtml = `
        <div class="team-members">
          <h3>Thành viên đội (${members.length})</h3>
          <ul>${items}</ul>
        </div>`;
    }

    const card = document.getElementById('athlete-card');
    if (!card) return;

    card.innerHTML = `
      <div class="athlete-badges">
        <div class="bib-badge">${escapeHtml(bib)}</div>
        ${received ? '<div class="received-badge">✓ Đã nhận BIB</div>' : ''}
      </div>
      <h2 class="athlete-name">${escapeHtml(athlete.name || '—')}</h2>
      <div class="info-grid">${rows}</div>
      ${membersHtml}`;
    card.classList.add('visible');
    card.classList.remove('error');

    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    showStatus(`Đã tìm thấy VĐV: ${athlete.name || bib}`, 'success');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showNotFound(tagQuery) {
    const card = document.getElementById('athlete-card');
    if (card) {
      card.innerHTML = `
        <div class="not-found">
          <div class="not-found-icon">?</div>
          <h2>Không tìm thấy VĐV</h2>
          <p>Không có VĐV nào khớp tag <strong>${escapeHtml(tagQuery)}</strong> trong giải này.</p>
        </div>`;
      card.classList.add('visible', 'error');
    }
    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';
    showStatus(`Không tìm thấy VĐV cho tag "${tagQuery}"`, 'error');
  }

  function clearAthleteCard() {
    const card = document.getElementById('athlete-card');
    if (card) {
      card.innerHTML = '';
      card.classList.remove('visible', 'error');
    }
    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'block';
    setLastTag('—');
    showStatus('', '');
  }

  function executeTagLookup(rawTag, options) {
    const opts = options || {};
    const tag = String(rawTag || '').trim();
    if (!tag) return;

    const now = Date.now();
    if (!opts.force && tag === lastLookupTag && now - lastLookupAt < TAG_DEBOUNCE_MS) {
      return;
    }
    lastLookupTag = tag;
    lastLookupAt = now;

    setLastTag(tag);

    if (firebaseLoadState === 'loading') {
      showStatus(`Đã đọc tag "${tag}" — đang tải danh sách VĐV...`, 'info');
      return;
    }

    if (!allAthletes.length) {
      showStatus('Giải này chưa có VĐV. Upload danh sách từ app iOS.', 'error');
      return;
    }

    const athlete = findAthleteByTag(tag);
    if (athlete) {
      renderAthleteCard(athlete, tag);
      if (navigator.vibrate) navigator.vibrate(80);
    } else {
      showNotFound(tag);
    }
  }

  function applyEventData(data, eventKey, displayHint) {
    eventData = data;
    firebaseLoadState = 'ready';
    const indexed = buildAthleteIndex(getAthletesNode(data));
    athletesByKey = indexed.byKey;
    allAthletes = indexed.list;

    const title = getEventDisplayName(data, displayHint || eventKey);
    document.title = `Đọc tag BIB — ${title}`;

    updateMetaCounts();
    showLoading(false);

    const qp = getQueryParams();
    if (qp.tag) {
      executeTagLookup(qp.tag, { force: true });
    } else if (!allAthletes.length) {
      showStatus('Chưa có VĐV cho giải này. Upload Athletes từ app iOS hoặc chọn giải khác.', 'error');
    } else if (!document.getElementById('athlete-card')?.classList.contains('visible')) {
      const usbHint = window.UhfUsbReader && UhfUsbReader.isSupported()
        ? 'Kết nối đầu đọc USB và đưa tag BIB vào vùng đọc'
        : 'Nhập Tag ID thủ công (cần Chrome/Edge trên máy tính)';
      showStatus(`Đã tải ${allAthletes.length} VĐV — ${usbHint}`, 'info');
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
    updateMetaCounts();

    const dataRef = window.firebaseRef(window.firebaseDatabase, dbPath);

    return window.firebaseGet(dataRef).then((snapshot) => {
      if (!snapshot.exists()) {
        firebaseLoadState = 'error';
        throw new Error('Không tìm thấy dữ liệu giải. Kiểm tra tên giải hoặc đăng nhập đúng tài khoản.');
      }
      applyEventData(snapshot.val(), eventKey, displayHint);

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
    if (!target.dbPath) throw new Error('Không xác định được dữ liệu giải');
    await loadFromFirebase(target.uid, target.eventKey, target.displayName);
  }

  function updateUsbButtons() {
    const connectBtn = document.getElementById('connect-usb-btn');
    const disconnectBtn = document.getElementById('disconnect-usb-btn');
    const connected = usbReader && usbReader.connected;
    if (connectBtn) connectBtn.style.display = connected ? 'none' : 'block';
    if (disconnectBtn) disconnectBtn.style.display = connected ? 'block' : 'none';
  }

  async function connectUsbReader() {
    if (!window.UhfUsbReader) {
      showStatus('Thư viện đầu đọc chưa tải xong', 'error');
      return;
    }
    if (!UhfUsbReader.isSupported()) {
      showStatus('Trình duyệt không hỗ trợ WebHID/WebUSB. Dùng Chrome/Edge trên máy tính hoặc nhập Tag ID thủ công.', 'error');
      return;
    }

    try {
      if (!usbReader) {
        usbReader = new UhfUsbReader({
          tagDebounceMs: TAG_DEBOUNCE_MS,
          onTag: (tagHex) => executeTagLookup(tagHex),
          onStatus: (msg) => setReaderStatus(msg, 'info'),
          onError: (msg) => {
            setReaderStatus(msg, 'error');
            showStatus(msg, 'error');
          },
        });
      }
      setReaderStatus('Đang kết nối...', 'info');
      await usbReader.connect();
      setReaderStatus('Đang đọc tag', 'connected');
      updateUsbButtons();
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        setReaderStatus('Chưa chọn thiết bị', 'idle');
        return;
      }
      const msg = (err && err.message) || 'Không kết nối được đầu đọc USB';
      setReaderStatus(msg, 'error');
      showStatus(msg, 'error');
      console.error('USB connect error:', err);
    }
  }

  async function disconnectUsbReader() {
    if (usbReader) {
      await usbReader.disconnect();
    }
    setReaderStatus('Chưa kết nối', 'idle');
    updateUsbButtons();
    showStatus('Đã ngắt kết nối đầu đọc', 'info');
  }

  function bindUi() {
    const connectBtn = document.getElementById('connect-usb-btn');
    if (connectBtn) connectBtn.addEventListener('click', () => connectUsbReader());

    const disconnectBtn = document.getElementById('disconnect-usb-btn');
    if (disconnectBtn) disconnectBtn.addEventListener('click', () => disconnectUsbReader());

    const form = document.getElementById('manual-tag-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('manual-tag');
        executeTagLookup(input ? input.value : '', { force: true });
      });
    }

    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearAthleteCard();
        lastLookupTag = '';
      });
    }

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email')?.value?.trim();
        const password = document.getElementById('login-password')?.value || '';
        if (!email || !password) return;
        showAuthError('');
        try {
          await window.firebaseSignIn(email, password);
        } catch (err) {
          showAuthError(authErrorMessage(err));
        }
      });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await disconnectUsbReader();
          await window.firebaseSignOut();
        } catch (err) {
          console.error(err);
        }
      });
    }

    const onDeviceDisconnect = (e) => {
      if (usbReader && usbReader.device === e.device) {
        disconnectUsbReader();
      }
    };
    if (navigator.usb) navigator.usb.addEventListener('disconnect', onDeviceDisconnect);
    if (navigator.hid) navigator.hid.addEventListener('disconnect', onDeviceDisconnect);
  }

  async function init() {
    bindUi();
    attachAuthListener();
    updateMetaCounts();
    updateUsbButtons();
    setReaderStatus(
      window.UhfUsbReader && UhfUsbReader.isSupported() ? 'Chưa kết nối' : 'Trình duyệt không hỗ trợ đọc USB',
      'idle'
    );
    showLoading(true);

    const waitFirebase = () => new Promise((resolve, reject) => {
      let tries = 0;
      const t = setInterval(() => {
        tries += 1;
        if (window.firebaseDatabase && window.firebaseRef && window.firebaseGet) {
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
      } else {
        await waitFirebase();
        await waitForAuthInit();
        await handleAuthChange(window.authCurrentUser);
      }

      if (window.UhfUsbReader && UhfUsbReader.isSupported() && usbReader == null) {
        usbReader = new UhfUsbReader({
          tagDebounceMs: TAG_DEBOUNCE_MS,
          onTag: (tagHex) => executeTagLookup(tagHex),
          onStatus: (msg) => setReaderStatus(msg, 'info'),
          onError: (msg) => setReaderStatus(msg, 'error'),
        });
        const reconnected = await usbReader.reconnectKnownDevice();
        if (reconnected) updateUsbButtons();
      }
    } catch (err) {
      firebaseLoadState = 'error';
      showLoading(false);
      updateMetaCounts();
      showStatus(err.message || 'Lỗi tải dữ liệu', 'error');
      console.error(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
