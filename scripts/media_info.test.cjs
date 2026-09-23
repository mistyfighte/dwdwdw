const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/media_info.js'), 'utf8');

function load() {
    const window = {};
    const context = { window, location: { pathname: '/watch' },
        document: { hidden: false, addEventListener() {}, getElementById: () => null, querySelector: () => null },
        setInterval() {}, setTimeout() {}, clearTimeout() {} };
    vm.runInNewContext(script, context);
    return window.__ygMediaInfo;
}
const info = load();
const plain = value => JSON.parse(JSON.stringify(value));

test('codec strings from Stats for nerds split into video and audio with itags', () => {
    assert.deepEqual(plain(info.parseCodecs('vp09.02.51.10.01.09.16.09.00 (337) / opus (251)')),
        { video: { codec: 'vp09.02.51.10.01.09.16.09.00', itag: 337 }, audio: { codec: 'opus', itag: 251 } });
    assert.equal(info.parseCodecs('mp4a.40.2 (140)').audio.itag, 140);
    assert.equal(info.parseCodecs('mp4a.40.2 (140)').video, null);
    assert.deepEqual(plain(info.parseCodecs('')), { video: null, audio: null });
});
test('SDR stereo shows nothing', () => {
    const d = info.describe({ codecs: 'av01.0.04M.08 (397) / opus (251)', color: 'bt709 / bt709' },
        [{ itag: 251, audioChannels: 2 }]);
    assert.equal(d.video, null);
    assert.equal(d.audio.label, null);
    assert.equal(d.audio.channels, 2);
});
test('HDR10 (PQ), HLG and Dolby Vision are told apart', () => {
    assert.equal(info.describe({ codecs: 'vp09.02.51.10.01.09.16.09.00 (337) / opus (251)', color: 'bt2020 / smpte2084' }).video, 'HDR10');
    assert.equal(info.describe({ codecs: 'av01.0.12M.10.0.110.09.18.09.0 (701) / opus (251)', color: 'bt2020 / arib-std-b67' }).video, 'HLG');
    assert.equal(info.describe({ codecs: 'dvh1.08.06 (999) / ec-3 (328)', color: 'bt2020 / smpte2084' }).video, 'Dolby Vision');
});
test('surround and Dolby audio formats are labelled from codec and channel count', () => {
    const label = (codecs, format) => info.describe({ codecs, color: 'bt709 / bt709' }, [format]).audio;
    assert.deepEqual(plain(label('avc1 (137) / ec-3 (328)', { itag: 328, audioChannels: 6 })),
        { label: 'Dolby Digital Plus', channels: 6, codec: 'ec-3' });
    assert.equal(label('avc1 (137) / ac-3 (380)', { itag: 380, audioChannels: 6 }).label, 'Dolby Digital');
    assert.equal(label('avc1 (137) / opus (338)', { itag: 338, audioChannels: 6 }).label, '5.1');
    assert.equal(label('avc1 (137) / opus (339)', { itag: 339, audioChannels: 8 }).label, '7.1');
    assert.equal(label('avc1 (137) / opus (338)', { itag: 338, audioChannels: 4, spatialAudioType: 'SPATIAL_AUDIO_TYPE_AMBISONICS_QUAD' }).label, 'Пространственный');
    assert.equal(label('avc1 (137) / ec-3 (328)', { itag: 328, audioChannels: 6, spatialAudioType: 'SPATIAL_AUDIO_TYPE_DOLBY_ATMOS_JOC' }).label, 'Dolby Atmos');
});
