const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/audio_engine.js'), 'utf8');

function load(stored) {
    const store = { 'lg-audio-preset': stored };
    const window = {};
    vm.runInNewContext(script, {
        window,
        document: { addEventListener() {}, querySelector: () => null },
        localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
        setInterval() { return 1; }
    });
    return { audio: window.__ygAudio, store };
}

test('every preset is a full 9-band curve with a calibrated starting level', () => {
    const { audio } = load();
    assert.equal(audio.order.length, 8);
    for (const name of audio.order) {
        const p = audio.presets[name];
        assert.equal(p.gains.length, 9, name);
        assert.ok(p.gains.every(g => Math.abs(g) <= 6), name + ': curves stay within +-6 dB');
        assert.ok(typeof p.start === 'number' && p.start <= 0 && p.start >= -6, name + ': start');
        assert.ok(p.label && p.desc, name);
    }
});
test('saved preset: legacy "flat" maps to music, unknown names to off', () => {
    assert.equal(load('flat').audio.saved(), 'music');
    assert.equal(load('bogus').audio.saved(), 'off');
    assert.equal(load(undefined).audio.saved(), 'off');
    assert.equal(load('night').audio.saved(), 'night');
});
test('applying without a video only records the choice', () => {
    const { audio, store } = load();
    audio.apply('vocal');
    assert.equal(store['lg-audio-preset'], 'vocal');
    assert.equal(audio.current(), 'vocal');
    audio.apply('nope');
    assert.equal(audio.current(), 'off');
    assert.equal(audio.label('off'), 'Выкл');
    assert.equal(audio.label('spatial'), 'Пространство');
});
test('the engine never mirrors element volume (Chromium applies it before the graph)', () => {
    assert.doesNotMatch(script, /\.volume\b/);
    assert.doesNotMatch(script, /volumechange/);
});
