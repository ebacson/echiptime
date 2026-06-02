// Core Firebase + checkpoint timing helpers extracted from index.html
// This file intentionally uses globals defined in index.html:
// - window.firebaseDatabase / window.firebaseRef / window.firebaseGet / window.firebaseOnValue
// - parseDistance / parseFirebaseDateTime / formatTime / calculatePace

(function () {
  'use strict';

  // Keep in sync with iOS ResultsConverter.allCheckpoints
  window.ALL_CHECKPOINTS = window.ALL_CHECKPOINTS || ['START', 'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'CP7', 'CP8', 'FINISH'];

  window.firebaseKeySanitize = window.firebaseKeySanitize || function firebaseKeySanitize(s) {
    return String(s || '').replace(/[.#$\[\]\/]/g, '_');
  };

  window.buildEventDbPath = window.buildEventDbPath || function buildEventDbPath(uid, eventKey) {
    const ev = window.firebaseKeySanitize(eventKey);
    const u = (uid || '').trim();
    if (u) return `${window.firebaseKeySanitize(u)}/${ev}`;
    return ev;
  };

  window.isEventPayload = window.isEventPayload || function isEventPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.Athletes || data.RACE_CONFIG) return true;
    return window.ALL_CHECKPOINTS.some((cp) => data[cp] != null);
  };

  window.loadCpDistancesCumulativeKm = window.loadCpDistancesCumulativeKm || function loadCpDistancesCumulativeKm(eventData) {
    const script = (eventData && eventData.RACE_SCRIPT) || {};
    const out = {};
    for (let i = 1; i <= 8; i++) {
      const cp = `CP${i}`;
      const key = `${cp.toLowerCase()}_distance`;
      const raw = script[key];
      if (raw == null || !String(raw).trim()) continue;
      const km = window.parseDistance(String(raw));
      if (km > 0) out[cp] = km;
    }
    return out;
  };

  window.getCumulativeKmAtCheckpoint = window.getCumulativeKmAtCheckpoint || function getCumulativeKmAtCheckpoint(cp, cpDistancesCumulative, athleteDistanceKm) {
    if (cp === 'START') return 0;
    if (cp === 'FINISH') return athleteDistanceKm;
    return (cpDistancesCumulative && cpDistancesCumulative[cp]) || 0;
  };

  window.getSegmentKm = window.getSegmentKm || function getSegmentKm(prevCp, cp, cpDistancesCumulative, athleteDistanceKm) {
    const endKm = window.getCumulativeKmAtCheckpoint(cp, cpDistancesCumulative, athleteDistanceKm);
    const startKm = window.getCumulativeKmAtCheckpoint(prevCp, cpDistancesCumulative, athleteDistanceKm);
    const seg = endKm - startKm;
    return seg > 0 ? seg : 0;
  };

  window.formatDurationSeconds = window.formatDurationSeconds || function formatDurationSeconds(totalSeconds) {
    const sec = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  window.formatCumulativeSplit = window.formatCumulativeSplit || function formatCumulativeSplit(startTime, endTime) {
    if (!startTime || !endTime) return '';
    const diff = (endTime - startTime) / 1000;
    if (diff < 0) return '';
    return `+${window.formatDurationSeconds(diff)}`;
  };

  // iOS line format: "CP#yyyy-MM-dd HH:mm:ss:SSS#rssi#antenna"
  window.parseResultLine = window.parseResultLine || function parseResultLine(raw) {
    if (typeof raw !== 'string') return null;
    const parts = raw.split('#');
    if (parts.length < 4) return null;
    return { checkpoint: parts[0], timestampRaw: parts[1], rssi: parts[2], antenna: parts[3] };
  };

  window.getEarliestTime = window.getEarliestTime || function getEarliestTime(lines) {
    if (!lines || typeof lines !== 'object') return null;
    let earliest = null;
    Object.values(lines).forEach((line) => {
      const parsed = window.parseResultLine(line);
      if (!parsed) return;
      const dt = window.parseFirebaseDateTime(parsed.timestampRaw);
      if (dt && (!earliest || dt < earliest)) earliest = dt;
    });
    return earliest;
  };

  window.buildCheckpointTimingLines = window.buildCheckpointTimingLines || function buildCheckpointTimingLines(times, checkpoints, cpDistancesCumulative, athlete) {
    if (!times || !times.START || !Array.isArray(checkpoints)) return [];
    const athleteDistanceKm = window.parseDistance(athlete && athlete.distance);
    const ordered = window.ALL_CHECKPOINTS.filter((cp) => checkpoints.includes(cp) && times[cp]);
    const out = [];
    let prevCp = 'START';
    let prevTime = times.START;

    ordered.forEach((cp) => {
      if (cp === 'START') return;
      const t = times[cp];
      const segmentSec = (t - prevTime) / 1000;
      const cumulativeSec = (t - times.START) / 1000;
      const segmentKm = window.getSegmentKm(prevCp, cp, cpDistancesCumulative, athleteDistanceKm);
      const cumulativeKm = window.getCumulativeKmAtCheckpoint(cp, cpDistancesCumulative, athleteDistanceKm);

      out.push({
        fromCp: prevCp,
        cp,
        clock: window.formatTime(t),
        cumulative: window.formatCumulativeSplit(times.START, t),
        segment: segmentSec >= 0 ? window.formatDurationSeconds(segmentSec) : '',
        segmentKm,
        segmentPace: segmentKm > 0 && segmentSec >= 0 ? window.calculatePace(segmentSec, segmentKm) : '',
        cumulativeKm,
        cumulativePace: cumulativeKm > 0 && cumulativeSec >= 0 ? window.calculatePace(cumulativeSec, cumulativeKm) : '',
      });

      prevCp = cp;
      prevTime = t;
    });

    return out;
  };

  // Debug fixtures (local testing)
  window.__loadFixture = async function __loadFixture(fileName, eventKeyForLogic = 'FIXTURE') {
    const res = await fetch(`fixtures/${fileName}`);
    if (!res.ok) throw new Error(`Không thể tải fixture: ${fileName}`);
    const data = await res.json();
    if (!window.applyFirebaseEventData) throw new Error('applyFirebaseEventData chưa sẵn sàng');
    window.applyFirebaseEventData(data, eventKeyForLogic, data?.RACE_CONFIG?.event_name || eventKeyForLogic);
  };
})();

