/**
 * UHF RFID USB reader — WebUSB port of WriteTag (SW_SDK_V4.0 protocol).
 * Device: VID 0x1A86 (6790), PID 0xE010 (57360)
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

  function padToOutPacketSize(frame, packetSize) {
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

  function detectFramingFromIn(buf) {
    if (!buf || buf.length < 3) return null;
    if (buf[1] === 0x43 && buf[2] === 0x54) return 'LENGTH_PREFIX_TOTAL';
    if (buf[0] === 0x00 && buf[1] === 0x43 && buf[2] === 0x54) return 'REPORT_ID_WITH_LEN';
    return null;
  }

  class UhfUsbReader {
    constructor(options) {
      this.onTag = (options && options.onTag) || (() => {});
      this.onStatus = (options && options.onStatus) || (() => {});
      this.onError = (options && options.onError) || (() => {});
      this.device = null;
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;
      this.outPacketSize = 64;
      this.outFraming = 'LENGTH_PREFIX_TOTAL';
      this.polling = false;
      this.pollTimer = null;
      this.lastEmittedTag = '';
      this.lastEmittedAt = 0;
      this.tagDebounceMs = (options && options.tagDebounceMs) || 1500;
      this.beepEnabled = options && options.beepEnabled !== false;
    }

    static isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.usb;
    }

    get connected() {
      return !!(this.device && this.device.opened);
    }

    async connect() {
      if (!UhfUsbReader.isSupported()) {
        throw new Error('Trình duyệt không hỗ trợ WebUSB. Dùng Chrome hoặc Edge trên máy tính.');
      }
      if (!window.isSecureContext) {
        throw new Error('WebUSB cần HTTPS hoặc localhost.');
      }

      this.onStatus('Chọn đầu đọc USB...');
      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
      });

      await this.openDevice(device);
      this.onStatus('Đã kết nối — đưa tag BIB vào vùng đọc');
      return device;
    }

    async openDevice(device) {
      await this.disconnect();
      this.device = device;
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
      await this.sendHidFeatureInit();
      await this.sendSetDeviceOneParam(PARAM_WORK_MODE, WORKMODE_ACTIVE);
      await this.sendSetDeviceOneParam(PARAM_SCAN_AREA, SCANAREA_EPC);
      await this.sendSetDeviceOneParam(PARAM_BEEP_ENABLE, this.beepEnabled ? 0x01 : 0x00);

      this.startPolling();
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
      if (this.interfaceNumber == null) return;
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
        console.warn('HID feature init:', err);
      }
    }

    async sendSetDeviceOneParam(paramAddr, value) {
      if (!this.device || this.epOut == null) return;
      const frame = wrapOut(buildSetDeviceOneParamSw(paramAddr, value), this.outFraming);
      const tx = padToOutPacketSize(frame, this.outPacketSize);
      await this.device.transferOut(this.epOut, tx);
    }

    startPolling() {
      this.stopPolling();
      this.polling = true;
      this.schedulePoll();
    }

    schedulePoll() {
      if (!this.polling) return;
      this.pollTimer = setTimeout(() => this.pollOnce(), POLL_MS);
    }

    async pollOnce() {
      if (!this.polling || !this.device || this.epIn == null) return;
      try {
        const result = await this.device.transferIn(this.epIn, 64);
        if (result.data && result.data.byteLength > 0) {
          const buf = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
          const framing = detectFramingFromIn(buf);
          if (framing) this.outFraming = framing;
          const tag = extractTagHexFromCt45(buf);
          if (tag) this.emitTag(tag);
        }
      } catch (err) {
        if (this.polling) {
          console.warn('USB poll error:', err);
        }
      } finally {
        this.schedulePoll();
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

    stopPolling() {
      this.polling = false;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    }

    async disconnect() {
      this.stopPolling();
      if (this.device) {
        try {
          if (this.device.opened && this.interfaceNumber != null) {
            await this.device.releaseInterface(this.interfaceNumber);
          }
        } catch (_) {}
        try {
          if (this.device.opened) await this.device.close();
        } catch (_) {}
      }
      this.device = null;
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;
    }

    async reconnectKnownDevice() {
      if (!UhfUsbReader.isSupported()) return false;
      const devices = await navigator.usb.getDevices();
      const known = devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
      if (!known) return false;
      try {
        await this.openDevice(known);
        this.onStatus('Đã kết nối lại đầu đọc USB');
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
