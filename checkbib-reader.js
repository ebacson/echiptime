/**
 * UHF RFID USB reader — WebHID (ưu tiên) + WebUSB fallback.
 * Port protocol WriteTag / SW_SDK_V4.0 — VID 0x1A86, PID 0xE010
 */
(function (global) {
  'use strict';

  const VENDOR_ID = 0x1A86;
  const PRODUCT_ID = 0xE010;
  const POLL_MS = 50;

  const PARAM_WORK_MODE = 0x02;
  const WORKMODE_ACTIVE = 0x01;
  const PARAM_SCAN_AREA = 0x0A;
  const SCANAREA_EPC = 0x00;
  const PARAM_BEEP_ENABLE = 0x06;

  function checksumTwosComplement(buf, checksumIndex, startIndex) {
    let sum = 0;
    for (let i = startIndex; i < checksumIndex; i++) sum += buf[i] & 0xFF;
    return (~sum + 1) & 0xFF;
  }

  function buildSetDeviceOneParamSw(paramAddr, value) {
    const sw = new Uint8Array(9);
    sw[0] = 0x53;
    sw[1] = 0x57;
    sw[2] = 0x00;
    sw[3] = 0x05;
    sw[4] = 0xFF;
    sw[5] = 0x24;
    sw[6] = paramAddr;
    sw[7] = value;
    sw[8] = checksumTwosComplement(sw, 8, 0);
    return sw;
  }

  function wrapOut(swFrame, framing) {
    if (!swFrame || !swFrame.length) return new Uint8Array(0);
    if (framing === 'REPORT_ID_WITH_LEN') {
      const out = new Uint8Array(swFrame.length + 2);
      out[0] = 0x00;
      out[1] = swFrame.length;
      out.set(swFrame, 2);
      return out;
    }
    const out = new Uint8Array(swFrame.length + 1);
    out[0] = out.length;
    out.set(swFrame, 1);
    return out;
  }

  function padToPacketSize(frame, packetSize) {
    const pkt = packetSize > 0 ? packetSize : 64;
    if (!frame || frame.length >= pkt) return frame;
    const out = new Uint8Array(pkt);
    out.set(frame);
    return out;
  }

  function extractTagHexFromCt45(pkt) {
    if (!pkt || pkt.length < 20) return null;
    if (pkt[1] !== 0x43 || pkt[2] !== 0x54 || pkt[6] !== 0x45) return null;
    const singleTagLen = pkt[16] & 0xFF;
    const bPackLength = singleTagLen - 3;
    if (bPackLength <= 0) return null;
    const start = 19;
    const endExclusive = start + bPackLength;
    if (endExclusive > pkt.length) return null;
    let hex = '';
    for (let i = start; i < endExclusive; i++) {
      hex += (pkt[i] & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    }
    return hex || null;
  }

  function parseTagFromBuffer(raw) {
    if (!raw || !raw.length) return null;
    const attempts = [raw];
    if (raw[0] === 0x00 && raw.length > 1) attempts.push(raw.subarray(1));
    if (raw.length > 2 && raw[0] === 0x00) attempts.push(raw.subarray(2));
    for (const buf of attempts) {
      const tag = extractTagHexFromCt45(buf);
      if (tag) return tag;
    }
    return null;
  }

  function detectFramingFromIn(buf) {
    if (!buf || buf.length < 3) return null;
    if (buf[1] === 0x43 && buf[2] === 0x54) return 'LENGTH_PREFIX_TOTAL';
    if (buf[0] === 0x00 && buf[1] === 0x43 && buf[2] === 0x54) return 'REPORT_ID_WITH_LEN';
    return null;
  }

  function hidReportPayload(frame) {
    if (!frame || !frame.length) return new Uint8Array(0);
    if (frame[0] === 0x00) return frame.subarray(1);
    return frame;
  }

  function hidReportId(frame) {
    return (frame && frame.length) ? (frame[0] & 0xFF) : 0;
  }

  class UhfUsbReader {
    constructor(options) {
      this.onTag = (options && options.onTag) || (() => {});
      this.onStatus = (options && options.onStatus) || (() => {});
      this.onError = (options && options.onError) || (() => {});
      this.device = null;
      this.transport = null; // 'hid' | 'usb'
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;
      this.outPacketSize = 64;
      this.outFraming = 'REPORT_ID_WITH_LEN';
      this.polling = false;
      this.pollTimer = null;
      this.inputHandler = null;
      this.lastEmittedTag = '';
      this.lastEmittedAt = 0;
      this.tagDebounceMs = (options && options.tagDebounceMs) || 1500;
      this.beepEnabled = options && options.beepEnabled !== false;
    }

    static isHidSupported() {
      return typeof navigator !== 'undefined' && !!navigator.hid;
    }

    static isUsbSupported() {
      return typeof navigator !== 'undefined' && !!navigator.usb;
    }

    static isSupported() {
      return UhfUsbReader.isHidSupported() || UhfUsbReader.isUsbSupported();
    }

    static preferredTransport() {
      return UhfUsbReader.isHidSupported() ? 'hid' : 'usb';
    }

    get connected() {
      if (!this.device) return false;
      if (this.transport === 'hid') return this.device.opened;
      return !!this.device.opened;
    }

    async connect() {
      if (!UhfUsbReader.isSupported()) {
        throw new Error('Trình duyệt không hỗ trợ WebHID/WebUSB. Dùng Chrome hoặc Edge trên máy tính.');
      }
      if (!window.isSecureContext) {
        throw new Error('Cần HTTPS hoặc localhost.');
      }

      if (UhfUsbReader.isHidSupported()) {
        try {
          await this.connectHid();
          return this.device;
        } catch (err) {
          if (err && err.name === 'NotFoundError') throw err;
          console.warn('WebHID failed, trying WebUSB:', err);
          if (!UhfUsbReader.isUsbSupported()) throw err;
        }
      }

      await this.connectUsb();
      return this.device;
    }

    async connectHid() {
      this.onStatus('Chọn đầu đọc USB (WebHID)...');
      const [device] = await navigator.hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
      });
      if (!device) throw new DOMException('Không chọn thiết bị', 'NotFoundError');
      await this.openHidDevice(device);
      this.onStatus('Đã kết nối (WebHID) — đưa tag BIB vào vùng đọc');
    }

    async connectUsb() {
      this.onStatus('Chọn đầu đọc USB (WebUSB)...');
      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
      });
      await this.openUsbDevice(device);
      this.onStatus('Đã kết nối (WebUSB) — đưa tag BIB vào vùng đọc');
    }

    async openHidDevice(device) {
      await this.disconnect();
      this.device = device;
      this.transport = 'hid';
      this.outFraming = 'REPORT_ID_WITH_LEN';

      if (!device.opened) await device.open();

      this.inputHandler = (event) => {
        const buf = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        const framing = detectFramingFromIn(buf);
        if (framing) this.outFraming = framing;
        const tag = parseTagFromBuffer(buf);
        if (tag) this.emitTag(tag);
      };
      device.addEventListener('inputreport', this.inputHandler);

      await this.sendHidFeatureInit();
      await this.sendSetDeviceOneParam(PARAM_WORK_MODE, WORKMODE_ACTIVE);
      await this.sendSetDeviceOneParam(PARAM_SCAN_AREA, SCANAREA_EPC);
      await this.sendSetDeviceOneParam(PARAM_BEEP_ENABLE, this.beepEnabled ? 0x01 : 0x00);
    }

    async openUsbDevice(device) {
      await this.disconnect();
      this.device = device;
      this.transport = 'usb';
      await device.open();

      if (!device.configuration) {
        await device.selectConfiguration(1);
      }

      const found = this.findReaderInterface(device);
      if (!found) {
        throw new Error('Không tìm thấy giao diện đầu đọc trên thiết bị USB.');
      }

      this.interfaceNumber = found.interfaceNumber;
      this.epIn = found.epIn;
      this.epOut = found.epOut;
      this.outPacketSize = found.outPacketSize;

      await device.claimInterface(this.interfaceNumber);
      await this.sendUsbHidFeatureInit();
      await this.sendSetDeviceOneParam(PARAM_WORK_MODE, WORKMODE_ACTIVE);
      await this.sendSetDeviceOneParam(PARAM_SCAN_AREA, SCANAREA_EPC);
      await this.sendSetDeviceOneParam(PARAM_BEEP_ENABLE, this.beepEnabled ? 0x01 : 0x00);

      this.startUsbPolling();
    }

    findReaderInterface(device) {
      const config = device.configuration;
      if (!config) return null;

      for (const iface of config.interfaces) {
        const alt = iface.alternates[0];
        if (!alt) continue;
        if (alt.interfaceSubclass !== 0 || alt.interfaceProtocol !== 0) continue;

        let epIn = null;
        let epOut = null;
        let outPacketSize = 64;
        for (const ep of alt.endpoints) {
          if (ep.direction === 'in' && epIn == null) epIn = ep.endpointNumber;
          if (ep.direction === 'out' && epOut == null) {
            epOut = ep.endpointNumber;
            outPacketSize = ep.packetSize || 64;
          }
        }
        if (epIn != null) {
          return { interfaceNumber: iface.interfaceNumber, epIn, epOut, outPacketSize };
        }
      }
      return null;
    }

    async sendHidFeatureInit() {
      if (!this.device || this.transport !== 'hid') return;
      const data = new Uint8Array([0xFF, 0xC7, 0x83, 0xCC, 0x30, 0x00]);
      try {
        await this.device.sendFeatureReport(0, data);
      } catch (err) {
        console.warn('HID feature init:', err);
      }
    }

    async sendUsbHidFeatureInit() {
      if (!this.device || this.transport !== 'usb' || this.interfaceNumber == null) return;
      const data = new Uint8Array([0x00, 0xFF, 0xC7, 0x83, 0xCC, 0x30, 0x00]);
      try {
        await this.device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x09,
          value: (3 << 8) | 0x00,
          index: this.interfaceNumber,
        }, data);
      } catch (err) {
        console.warn('USB HID feature init:', err);
      }
    }

    async sendSetDeviceOneParam(paramAddr, value) {
      const frame = wrapOut(buildSetDeviceOneParamSw(paramAddr, value), this.outFraming);
      const tx = padToPacketSize(frame, this.outPacketSize);

      if (this.transport === 'hid') {
        const reportId = hidReportId(tx);
        const payload = hidReportPayload(tx);
        await this.device.sendReport(reportId, payload);
        return;
      }

      if (this.device && this.epOut != null) {
        await this.device.transferOut(this.epOut, tx);
      }
    }

    startUsbPolling() {
      this.stopUsbPolling();
      this.polling = true;
      this.scheduleUsbPoll();
    }

    scheduleUsbPoll() {
      if (!this.polling) return;
      this.pollTimer = setTimeout(() => this.pollUsbOnce(), POLL_MS);
    }

    async pollUsbOnce() {
      if (!this.polling || this.transport !== 'usb' || !this.device || this.epIn == null) return;
      try {
        const result = await this.device.transferIn(this.epIn, 64);
        if (result.data && result.data.byteLength > 0) {
          const buf = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
          const framing = detectFramingFromIn(buf);
          if (framing) this.outFraming = framing;
          const tag = parseTagFromBuffer(buf);
          if (tag) this.emitTag(tag);
        }
      } catch (err) {
        if (this.polling) console.warn('USB poll error:', err);
      } finally {
        this.scheduleUsbPoll();
      }
    }

    stopUsbPolling() {
      this.polling = false;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    }

    emitTag(tagHex) {
      const now = Date.now();
      if (tagHex === this.lastEmittedTag && now - this.lastEmittedAt < this.tagDebounceMs) {
        return;
      }
      this.lastEmittedTag = tagHex;
      this.lastEmittedAt = now;
      this.onTag(tagHex);
    }

    async disconnect() {
      this.stopUsbPolling();
      if (this.device && this.inputHandler) {
        try {
          this.device.removeEventListener('inputreport', this.inputHandler);
        } catch (_) {}
      }
      this.inputHandler = null;

      if (this.device) {
        try {
          if (this.transport === 'usb' && this.device.opened && this.interfaceNumber != null) {
            await this.device.releaseInterface(this.interfaceNumber);
          }
        } catch (_) {}
        try {
          if (this.device.opened) await this.device.close();
        } catch (_) {}
      }

      this.device = null;
      this.transport = null;
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;
    }

    async reconnectKnownDevice() {
      if (UhfUsbReader.isHidSupported()) {
        const hidDevices = await navigator.hid.getDevices();
        const hidKnown = hidDevices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
        if (hidKnown) {
          try {
            await this.openHidDevice(hidKnown);
            this.onStatus('Đã kết nối lại đầu đọc (WebHID)');
            return true;
          } catch (err) {
            console.warn('HID reconnect failed:', err);
          }
        }
      }

      if (!UhfUsbReader.isUsbSupported()) return false;
      const usbDevices = await navigator.usb.getDevices();
      const usbKnown = usbDevices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
      if (!usbKnown) return false;
      try {
        await this.openUsbDevice(usbKnown);
        this.onStatus('Đã kết nối lại đầu đọc (WebUSB)');
        return true;
      } catch (err) {
        this.onError(err.message || 'Không kết nối lại được');
        return false;
      }
    }
  }

  UhfUsbReader.extractTagHexFromCt45 = extractTagHexFromCt45;
  UhfUsbReader.VENDOR_ID = VENDOR_ID;
  UhfUsbReader.PRODUCT_ID = PRODUCT_ID;

  global.UhfUsbReader = UhfUsbReader;
})(typeof window !== 'undefined' ? window : this);
