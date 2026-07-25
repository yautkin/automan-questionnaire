(function exposeSupport(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutomanQuestionnaireSupport = api;
}(globalThis, function createSupport() {
  const textEncoder = new TextEncoder();

  function audioExtensionForMime(mimeType) {
    return typeof mimeType === 'string' && mimeType.toLowerCase().includes('mp4') ? 'm4a' : 'webm';
  }

  function voiceFilename(order, fieldId, mimeType) {
    return `${String(order).padStart(2, '0')}-${fieldId}.${audioExtensionForMime(mimeType)}`;
  }

  function buildVoiceManifest(recordings) {
    return recordings.map(({ blob, ...recording }, index) => {
      if (typeof recording.fieldId !== 'string' || !/^[a-z0-9_]+$/.test(recording.fieldId)) {
        throw new Error('Recording field ID must be a safe identifier');
      }
      return {
        ...recording,
        file: `voice/${voiceFilename(index + 1, recording.fieldId, recording.mimeType)}`
      };
    });
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function uint16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function uint32(value) {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    ]);
  }

  function joinBytes(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function entryData(data) {
    if (typeof data === 'string') return textEncoder.encode(data);
    if (data instanceof Uint8Array) return data;
    throw new TypeError('Archive entry data must be a string or Uint8Array');
  }

  function validateEntryName(name) {
    if (
      typeof name !== 'string' ||
      !name ||
      /^[A-Za-z]:/.test(name) ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    ) {
      throw new Error('Archive entry name must be a safe relative path');
    }
  }

  function buildArchive(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      validateEntryName(entry.name);
      const name = textEncoder.encode(entry.name);
      const data = entryData(entry.data);
      const checksum = crc32(data);
      const localHeader = joinBytes([
        uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
        uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name
      ]);
      localParts.push(localHeader, data);
      centralParts.push(joinBytes([
        uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
        uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
        uint16(0), uint16(0), uint32(0), uint32(offset), name
      ]));
      offset += localHeader.length + data.length;
    }

    const centralDirectory = joinBytes(centralParts);
    const endOfDirectory = joinBytes([
      uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
      uint32(centralDirectory.length), uint32(offset), uint16(0)
    ]);
    return new Blob([joinBytes([...localParts, centralDirectory, endOfDirectory])], { type: 'application/zip' });
  }

  function buildExportJson(textState, recordings, exportedAt) {
    return JSON.stringify({ version: 1, exportedAt, answers: textState, recordings });
  }

  function createRecordingStore() {
    let database;

    function open() {
      if (database) return Promise.resolve(database);
      if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
      return new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open('automan-questionnaire', 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('recordings')) {
            request.result.createObjectStore('recordings', { keyPath: 'fieldId' });
          }
        };
        request.onsuccess = () => {
          database = request.result;
          resolve(database);
        };
        request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
      });
    }

    function transact(mode, operation) {
      return open().then(db => new Promise((resolve, reject) => {
        const transaction = db.transaction('recordings', mode);
        const request = operation(transaction.objectStore('recordings'));
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error('IndexedDB operation failed'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      }));
    }

    return {
      get(fieldId) { return transact('readonly', store => store.get(fieldId)); },
      put(record) { return transact('readwrite', store => store.put(record)); },
      delete(fieldId) { return transact('readwrite', store => store.delete(fieldId)); },
      clear() { return transact('readwrite', store => store.clear()); },
      list() { return transact('readonly', store => store.getAll()); }
    };
  }

  function isAudioField(field) {
    return Boolean(
      field && field.tagName === 'TEXTAREA' &&
      typeof field.matches === 'function' && field.matches('textarea[data-field]')
    );
  }

  function createRecordingGate() {
    let reserved = false;
    return {
      reserve() {
        if (reserved) return false;
        reserved = true;
        return true;
      },
      isReserved() { return reserved; },
      release() { reserved = false; }
    };
  }

  return {
    audioExtensionForMime, voiceFilename, buildVoiceManifest, buildArchive, buildExportJson, createRecordingStore,
    isAudioField, createRecordingGate
  };
}));
