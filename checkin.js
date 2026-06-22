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
  let pendingBib = '';
  let firebaseLoadState = 'loading';
  let firebaseValueUnsubscribe = null;
  let discoveredEvents = [];

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
    const el = document.getElementById('firebase-path');
    if (!el) return;
    if (activeContext.dbPath) {
      el.textContent = `Firebase: ${activeContext.dbPath}`;
    } else {
      el.textContent = '';
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
    if (qp.fixture) {
      return {
        uid: '',
        eventKey: qp.fixture,
        dbPath: '',
        displayName: qp.fixture.replace(/_/g, ' '),
      };
    }
    if (qp.uid && qp.event) {
      return {
        uid: qp.uid,
        eventKey: qp.event,
        dbPath: buildEventDbPath(qp.uid, qp.event),
        displayName: qp.event.replace(/_/g, ' '),
      };
    }
    if (qp.event && !qp.uid) {
      return {
        uid: '',
        eventKey: qp.event,
        dbPath: firebaseKeySanitize(qp.event),
        displayName: qp.event.replace(/_/g, ' '),
      };
    }

    const all = await discoverEvents();
    if (all.length === 0) {
      throw new Error('Không tìm thấy giải chạy trên Firebase. Thêm ?uid=...&event=... vào URL.');
    }

    if (qp.uid && !qp.event) {
      const forUid = all.filter(
        (e) => e.uid === qp.uid || firebaseKeySanitize(e.uid) === firebaseKeySanitize(qp.uid)
      );
      if (forUid.length === 0) {
        throw new Error('Không có giải nào cho uid đã chỉ định');
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

  function normalizeAthleteRecord(raw, firebaseKey) {
    if (!raw || typeof raw !== 'object') return null;
    const bib = pickField(raw, ['bib', 'BIB', 'Bib']);
    const tagId = pickField(raw, ['tagId', 'TagID', 'tagID', 'TagId']) || firebaseKey;
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
    };
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
      ${membersHtml}`;
    card.classList.add('visible');
    card.classList.remove('error');

    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    showStatus(`Đã tìm thấy VĐV: ${athlete.name || bib}`, 'success');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showNotFound(bib) {
    const card = document.getElementById('athlete-card');
    if (card) {
      card.innerHTML = `
        <div class="not-found">
          <div class="not-found-icon">?</div>
          <h2>Không tìm thấy BIB</h2>
          <p>Mã <strong>${escapeHtml(bib)}</strong> không có trong danh sách vận động viên của giải.</p>
        </div>`;
      card.classList.add('visible', 'error');
    }
    showStatus(`Đã quét mã "${bib}" — không có trong danh sách giải`, 'error');
  }

  function lookupAndShow(rawBib) {
    const extracted = extractBibFromQr(rawBib);
    const bib = normalizeBib(extracted);
    if (!bib) {
      showStatus('Mã BIB không hợp lệ', 'error');
      return;
    }

    const manual = document.getElementById('manual-bib');
    if (manual) manual.value = bib;

    if (firebaseLoadState !== 'ready') {
      pendingBib = bib;
      showStatus(`Đã quét BIB ${bib} — đang kết nối Firebase...`, 'info');
      return;
    }

    if (!athletesByBib.size) {
      pendingBib = bib;
      showStatus(
        `Đã quét BIB ${bib} — giải này chưa có VĐV trên Firebase (0 VĐV). Upload danh sách từ app iOS hoặc chọn đúng giải ở trên.`,
        'error'
      );
      return;
    }

    pendingBib = '';
    const athlete = findAthleteByBib(bib);
    if (athlete) {
      renderAthleteCard(athlete);
    } else {
      showNotFound(bib);
    }
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
    lookupAndShow(bib);

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

    const countEl = document.getElementById('athlete-count');
    if (countEl) {
      countEl.textContent = allAthletes.length ? `${allAthletes.length} VĐV` : '0 VĐV';
    }

    updateFirebasePathLabel();

    const resultsLink = document.getElementById('results-link');
    if (resultsLink && activeContext.eventKey && !activeContext.eventKey.endsWith('.json')) {
      const params = new URLSearchParams();
      if (activeContext.uid) params.set('uid', activeContext.uid);
      params.set('event', activeContext.eventKey);
      const qs = params.toString();
      resultsLink.href = `index.html?${qs}`;
      resultsLink.style.display = 'inline-block';
    }

    showLoading(false);

    const qp = getQueryParams();
    const cardVisible = document.getElementById('athlete-card')?.classList.contains('visible');

    if (pendingBib) {
      lookupAndShow(pendingBib);
    } else if (qp.bib) {
      lookupAndShow(qp.bib);
    } else if (!allAthletes.length) {
      showStatus('Firebase đã kết nối nhưng chưa có VĐV. Upload Athletes từ app iOS hoặc chọn giải khác.', 'error');
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
        throw new Error(`Không tìm thấy dữ liệu tại ${dbPath}`);
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
      throw new Error('Không xác định được đường dẫn Firebase');
    }
    await loadFromFirebase(target.uid, target.eventKey, target.displayName);
  }

  function bindUi() {
    const form = document.getElementById('manual-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('manual-bib');
        lookupAndShow(input ? input.value : '');
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
        const card = document.getElementById('athlete-card');
        if (card) {
          card.classList.remove('visible');
          card.innerHTML = '';
        }
        const empty = document.getElementById('empty-state');
        if (empty) empty.style.display = 'block';
        const manual = document.getElementById('manual-bib');
        if (manual) manual.value = '';
        if (cameraRunning) {
          showStatus('Đưa mã QR vào giữa khung hình, giữ ổn định 1–2 giây', 'info');
        } else {
          showStatus('Nhấn "Mở camera" để quét QR', 'info');
        }
      });
    }
  }

  async function init() {
    bindUi();
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
          reject(new Error('Không thể kết nối Firebase'));
        }
      }, 100);
    });

    try {
      const qp = getQueryParams();
      if (!qp.fixture) await waitFirebase();
      await resolveAndLoad();
    } catch (err) {
      firebaseLoadState = 'error';
      showLoading(false);
      const countEl = document.getElementById('athlete-count');
      if (countEl) countEl.textContent = 'Lỗi tải';
      showStatus(err.message || 'Lỗi tải dữ liệu Firebase', 'error');
      console.error(err);
    }
  }

  window.addEventListener('beforeunload', () => {
    stopQrScanner();
    detachFirebaseListener();
  });

  window.addEventListener('DOMContentLoaded', init);
})();
