const test = require('node:test');
const assert = require('node:assert/strict');
const support = require('../questionnaire-support.js');

test('creates deterministic voice names using the MIME extension', () => {
  assert.equal(support.audioExtensionForMime('audio/webm;codecs=opus'), 'webm');
  assert.equal(support.audioExtensionForMime('audio/mp4'), 'm4a');
  assert.equal(support.voiceFilename(2, 'price_rules', 'audio/mp4'), '02-price_rules.m4a');
});

test('builds export metadata with safe sequential voice filenames', () => {
  const recordings = [
    { fieldId: 'price_rules', mimeType: 'audio/webm', question: 'Цена' },
    { fieldId: 'warranty_terms', mimeType: 'audio/mp4', question: 'Гарантия' }
  ];
  const manifest = support.buildVoiceManifest(recordings);
  assert.deepEqual(manifest.map(item => item.file), [
    'voice/01-price_rules.webm',
    'voice/02-warranty_terms.m4a'
  ]);
});

test('rejects corrupted recording field IDs before composing voice filenames', () => {
  for (const fieldId of ['../secret', 'price/rules', 'price rules', 'price\\rules', 'price\0rules']) {
    assert.throws(() => support.buildVoiceManifest([{ fieldId, mimeType: 'audio/webm' }]));
  }
});

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

test('creates a ZIP with matching local and central metadata and content', async () => {
  const archive = support.buildArchive([
    { name: 'README.txt', data: 'Automan' },
    { name: 'voice/01-price_rules.webm', data: new Uint8Array([1, 2, 3]) }
  ]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);

  assert.equal(archive.type, 'application/zip');
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2);

  let centralEntryOffset = centralOffset;
  for (const expected of [
    { name: 'README.txt', data: new TextEncoder().encode('Automan') },
    { name: 'voice/01-price_rules.webm', data: new Uint8Array([1, 2, 3]) }
  ]) {
    const localOffset = view.getUint32(centralEntryOffset + 42, true);
    const centralNameLength = view.getUint16(centralEntryOffset + 28, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const centralCrc = view.getUint32(centralEntryOffset + 16, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const centralSize = view.getUint32(centralEntryOffset + 20, true);
    const localSize = view.getUint32(localOffset + 18, true);

    assert.equal(view.getUint32(centralEntryOffset, true), 0x02014b50);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    assert.equal(new TextDecoder().decode(bytes.slice(centralEntryOffset + 46, centralEntryOffset + 46 + centralNameLength)), expected.name);
    assert.equal(new TextDecoder().decode(bytes.slice(localOffset + 30, localOffset + 30 + localNameLength)), expected.name);
    assert.equal(centralCrc, crc32(expected.data));
    assert.equal(localCrc, centralCrc);
    assert.equal(localSize, expected.data.length);
    assert.equal(view.getUint32(localOffset + 22, true), localSize);
    assert.equal(view.getUint32(centralEntryOffset + 24, true), localSize);
    assert.deepEqual(bytes.slice(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localSize), expected.data);

    centralEntryOffset += 46 + centralNameLength;
  }
  assert.equal(centralEntryOffset, centralOffset + centralSize);
});

test('rejects unsafe archive names and preserves export JSON schema', () => {
  for (const name of ['../secret.txt', 'voice/../secret.txt', '/secret.txt', 'C:\\secret.txt', 'voice/\0secret.txt']) {
    assert.throws(() => support.buildArchive([{ name, data: 'x' }]));
  }

  const exported = JSON.parse(support.buildExportJson({ price_rules: 'По дефектовке' }, [
    { fieldId: 'price_rules', file: 'voice/01-price_rules.webm' }
  ], '2026-07-26T12:00:00.000Z'));
  assert.deepEqual(exported, {
    version: 1,
    exportedAt: '2026-07-26T12:00:00.000Z',
    answers: { price_rules: 'По дефектовке' },
    recordings: [{ fieldId: 'price_rules', file: 'voice/01-price_rules.webm' }]
  });
});

test('exposes a lazy recording store factory without opening IndexedDB on import', () => {
  assert.equal(typeof support.createRecordingStore, 'function');
});

test('recognizes only textarea fields as audio eligible', () => {
  const textarea = { tagName: 'TEXTAREA', matches: selector => selector === 'textarea[data-field]' };
  const textInput = { tagName: 'INPUT', matches: () => true };
  assert.equal(support.isAudioField(textarea), true);
  assert.equal(support.isAudioField(textInput), false);
});

test('reserves exactly one pending recording until it is released', () => {
  const gate = support.createRecordingGate();
  assert.equal(gate.isReserved(), false);
  assert.equal(gate.reserve(), true);
  assert.equal(gate.isReserved(), true);
  assert.equal(gate.reserve(), false);
  gate.release();
  assert.equal(gate.isReserved(), false);
  assert.equal(gate.reserve(), true);
});
