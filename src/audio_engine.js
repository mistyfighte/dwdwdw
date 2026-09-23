(function () {
    'use strict';
    if (window.__ygAudio) return;
    // Sound processing for the player (presets chosen from the EQ button).
    //
    //   video ─► source ─┬─► dry ──────────────────────────────────────┐
    //                    └─► EQ (9 bands) ─► [compressor] ─► [spatial] │
    //                        ─► match gain ─► limiter ─► wet ──────────┴─► speakers
    //
    // * Chromium applies the element's volume and mute BEFORE the source
    //   node, so nothing here mirrors them. (The old graph did, which applied
    //   the volume twice: 50% became 25% as soon as the EQ was on.)
    // * Loudness match: the input and the processed output are measured with
    //   a K-weighting filter (ITU-R BS.1770: high-pass + high-shelf) and the
    //   match gain slowly steers the output to the input's loudness, so no
    //   preset is quieter or louder than the original - only different.
    // * A transparent peak limiter after the match gain keeps boosted
    //   presets from clipping.
    // * 'off' crossfades to the dry path: bit-for-bit what YouTube outputs.
    // * The compressor and limiter are stereo-only Web Audio nodes; a
    //   surround source (5.1/7.1) skips them and the spatial stage and keeps
    //   all channels (the destination is opened with the device's count).
    const BANDS = [
        { type: 'lowshelf', f: 60 }, { type: 'peaking', f: 125, q: 1.1 }, { type: 'peaking', f: 250, q: 1.1 },
        { type: 'peaking', f: 500, q: 1.1 }, { type: 'peaking', f: 1000, q: 1.1 }, { type: 'peaking', f: 2000, q: 1.1 },
        { type: 'peaking', f: 4000, q: 1.1 }, { type: 'peaking', f: 8000, q: 1.1 }, { type: 'highshelf', f: 12000 }];
    const GENTLE = { threshold: -24, knee: 18, ratio: 2.5, attack: 0.012, release: 0.25 };
    // Band gains in dB, 60 Hz ... 12 kHz. Loudness is matched afterwards, so
    // a curve only changes the balance, never the level. `start` is the match
    // gain (dB) each preset settles at on pink noise - the starting point, so
    // switching lands within ~1 dB right away.
    const PRESETS = {
        music:   { label: 'Музыка', desc: 'Сочный бас и воздух', start: -1.9, gains: [3, 1.5, 0, -1, -1, 0, 1, 2, 3] },
        bass:    { label: 'Бас', desc: 'Глубокий низ', start: -2.2, gains: [6, 4, 1.5, 0, -0.5, 0, 0, 0, 0.5] },
        vocal:   { label: 'Вокал', desc: 'Голос вперёд', start: -2.2, gains: [-1, -1, -0.5, 0.5, 2, 3, 2.5, 1, 0] },
        cinema:  { label: 'Кино', desc: 'Объём и динамика', start: -4.7, gains: [4, 2, 0, -0.5, 0, 1, 1.5, 1.5, 2], comp: GENTLE },
        spatial: { label: 'Пространство', desc: 'Колонки в наушниках', start: -4.4, gains: [1, 0.5, 0, 0, 0, 0, 0.5, 1, 1.5], spatial: true },
        treble:  { label: 'Высокие', desc: 'Яркий верх', start: -3.0, gains: [-1, -0.5, 0, 0, 0, 1, 2.5, 4, 5] },
        voice:   { label: 'Речь', desc: 'Подкасты, интервью', start: -4.4, gains: [-6, -3, -1, 1, 3, 4, 3, 1, -1],
                   comp: { threshold: -30, knee: 12, ratio: 4, attack: 0.006, release: 0.2 } },
        night:   { label: 'Ночной', desc: 'Тихо и ровно', start: -0.6, gains: [-4, -2, 0, 1, 2, 2, 1, 0, -1],
                   comp: { threshold: -38, knee: 8, ratio: 10, attack: 0.003, release: 0.35 } }
    };
    const ORDER = ['music', 'bass', 'vocal', 'cinema', 'spatial', 'treble', 'voice', 'night'];
    const LEGACY = { flat: 'music' };
    const RAMP = 0.06;
    const MATCH_MIN = Math.pow(10, -12 / 20), MATCH_MAX = Math.pow(10, 12 / 20);

    let ctx = null, current = 'off';
    const graphs = new WeakMap();
    let active = null, meterTimer = null;

    function saved() {
        let name = 'off';
        try { name = localStorage.getItem('lg-audio-preset') || 'off'; } catch (_) { name = 'off'; }
        name = LEGACY[name] || name;
        return name === 'off' || PRESETS[name] ? name : 'off';
    }
    function ramp(param, value) {
        const t = ctx.currentTime;
        try {
            param.cancelScheduledValues(t);
            param.setValueAtTime(param.value, t);
            param.linearRampToValueAtTime(value, t + RAMP);
        } catch (_) { param.value = value; }
    }
    function context() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        // 'interactive' (the default) keeps output latency minimal, so the
        // processed sound stays in sync with the picture.
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { return null; }
        try {
            ctx.destination.channelCount = Math.max(2, Math.min(8, ctx.destination.maxChannelCount || 2));
            ctx.destination.channelInterpretation = 'speakers';
        } catch (_) { /* keep stereo */ }
        return ctx;
    }
    function kWeighted(input) {
        // BS.1770 K-weighting approximated with two biquads.
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
        const shelf = ctx.createBiquadFilter();
        shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
        const meter = ctx.createAnalyser();
        meter.fftSize = 2048;
        input.connect(hp); hp.connect(shelf); shelf.connect(meter);
        return meter;
    }
    // Short procedural room (early reflections + a quick diffuse tail) that
    // gives the virtual speakers a place to sit instead of inside the head.
    function roomImpulse() {
        const rate = ctx.sampleRate, length = Math.round(rate * 0.32);
        const buffer = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            let seed = ch ? 0x9e3779b9 : 0x7f4a7c15, smooth = 0;
            for (let i = 0; i < length; i++) {
                seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                const noise = ((seed >>> 0) / 4294967296) * 2 - 1;
                smooth += (noise - smooth) * (0.35 - 0.25 * i / length);
                data[i] = smooth * Math.exp(-i / (rate * 0.075));
            }
            [[0.007, 0.5], [0.013, 0.32], [0.021, 0.22]].forEach(function (tap, k) {
                const at = Math.round(rate * (tap[0] + (ch ? 0.0017 * (k + 1) : 0)));
                if (at < length) data[at] += tap[1];
            });
        }
        return buffer;
    }
    function speaker(azimuth) {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'linear';
        p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 0;
        const x = Math.sin(azimuth), z = -Math.cos(azimuth);
        if (p.positionX) { p.positionX.value = x; p.positionY.value = 0; p.positionZ.value = z; }
        else p.setPosition(x, 0, z);
        return p;
    }
    // Headphone virtualiser: bass below 120 Hz stays direct (HRTF filtering
    // thins it out), everything above is played from two virtual speakers at
    // +-30 degrees - the standard stereo triangle - inside a small room.
    function spatialStage(input) {
        const out = ctx.createGain();
        const lowA = ctx.createBiquadFilter(), lowB = ctx.createBiquadFilter();
        const highA = ctx.createBiquadFilter(), highB = ctx.createBiquadFilter();
        [lowA, lowB].forEach(function (f) { f.type = 'lowpass'; f.frequency.value = 120; f.Q.value = Math.SQRT1_2; });
        [highA, highB].forEach(function (f) { f.type = 'highpass'; f.frequency.value = 120; f.Q.value = Math.SQRT1_2; });
        input.connect(lowA); lowA.connect(lowB); lowB.connect(out);
        input.connect(highA); highA.connect(highB);
        const split = ctx.createChannelSplitter(2);
        highB.connect(split);
        const direct = ctx.createGain();
        direct.gain.value = 1;
        [-Math.PI / 6, Math.PI / 6].forEach(function (azimuth, index) {
            const s = speaker(azimuth);
            split.connect(s, index);
            s.connect(direct);
        });
        direct.connect(out);
        const room = ctx.createConvolver();
        room.normalize = true;
        room.buffer = roomImpulse();
        const roomLevel = ctx.createGain();
        roomLevel.gain.value = 0.16;
        highB.connect(room); room.connect(roomLevel); roomLevel.connect(out);
        return out;
    }
    function limiterNode() {
        const l = ctx.createDynamicsCompressor();
        l.threshold.value = -1.5; l.knee.value = 1.5; l.ratio.value = 20;
        l.attack.value = 0.002; l.release.value = 0.12;
        return l;
    }
    function build(video) {
        if (graphs.has(video)) return graphs.get(video);
        if (!context()) return null;
        // One source per element, ever (a second createMediaElementSource
        // throws); graphs are cached per element and share one context.
        let source;
        try { source = ctx.createMediaElementSource(video); } catch (_) { return null; }
        const g = { video: video, source: source };
        g.dry = ctx.createGain();
        g.wet = ctx.createGain(); g.wet.gain.value = 0;
        source.connect(g.dry); g.dry.connect(ctx.destination);
        g.bands = BANDS.map(function (band) {
            const f = ctx.createBiquadFilter();
            f.type = band.type; f.frequency.value = band.f;
            if (band.q) f.Q.value = band.q;
            f.gain.value = 0;
            return f;
        });
        let node = source;
        g.bands.forEach(function (f) { node.connect(f); node = f; });
        // Stereo effects (compressor, spatial) with a bypass for surround.
        g.comp = ctx.createDynamicsCompressor();
        g.compOn = ctx.createGain(); g.compOn.gain.value = 0;
        g.compOff = ctx.createGain();
        node.connect(g.comp); g.comp.connect(g.compOn);
        node.connect(g.compOff);
        const afterComp = ctx.createGain();
        g.compOn.connect(afterComp); g.compOff.connect(afterComp);
        g.spatialOn = ctx.createGain(); g.spatialOn.gain.value = 0;
        g.spatialOff = ctx.createGain();
        spatialStage(afterComp).connect(g.spatialOn);
        afterComp.connect(g.spatialOff);
        g.match = ctx.createGain();
        g.spatialOn.connect(g.match); g.spatialOff.connect(g.match);
        g.limiter = limiterNode();
        g.limitOn = ctx.createGain();
        g.limitOff = ctx.createGain(); g.limitOff.gain.value = 0;
        g.match.connect(g.limiter); g.limiter.connect(g.limitOn);
        g.match.connect(g.limitOff);
        g.limitOn.connect(g.wet); g.limitOff.connect(g.wet);
        g.wet.connect(ctx.destination);
        g.inMeter = kWeighted(source);
        g.outMeter = kWeighted(g.wet);
        g.buffer = new Float32Array(g.inMeter.fftSize);
        graphs.set(video, g);
        return g;
    }
    function rms(meter, buffer) {
        meter.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        return Math.sqrt(sum / buffer.length);
    }
    // Loudness match: every 100 ms compare K-weighted input and output and
    // move the match gain towards equality, ~2 s to settle so it never pumps.
    // Silence and near-silence (< -50 dBFS) are ignored.
    function meterTick() {
        const g = active;
        if (!g || current === 'off' || g.video.paused) return;
        const input = rms(g.inMeter, g.buffer), output = rms(g.outMeter, g.buffer);
        if (input < 0.003 || output < 1e-5) return;
        const target = Math.min(MATCH_MAX, Math.max(MATCH_MIN, g.match.gain.value * input / output));
        // Faster while far off (> 2 dB), then slow and inaudible.
        const off = Math.abs(20 * Math.log10(target / g.match.gain.value));
        const next = g.match.gain.value * Math.pow(target / g.match.gain.value, off > 2 ? 0.2 : 0.05);
        g.match.gain.setTargetAtTime(next, ctx.currentTime, 0.05);
        learned[current] = next;
    }
    function surround(video) {
        const info = window.__ygMediaInfo && window.__ygMediaInfo.current();
        return !!(info && info.audio && info.audio.channels > 2);
    }
    // Per session, the level a preset last settled at wins over the default.
    const learned = {};
    function initialMatch(name) {
        return learned[name] || Math.pow(10, (PRESETS[name].start || 0) / 20);
    }
    function apply(name, video) {
        name = LEGACY[name] || name;
        if (name !== 'off' && !PRESETS[name]) name = 'off';
        current = name;
        try { localStorage.setItem('lg-audio-preset', name); } catch (_) { /* private mode */ }
        video = video || document.querySelector('#movie_player video') || document.querySelector('video');
        if (!video) return;
        if (name === 'off') {
            const g = graphs.get(video);
            if (g) { ramp(g.wet.gain, 0); ramp(g.dry.gain, 1); }
            return;
        }
        const g = build(video);
        if (!g) return;
        active = g;
        const preset = PRESETS[name];
        const multi = surround(video);
        g.bands.forEach(function (f, i) { ramp(f.gain, preset.gains[i] || 0); });
        const c = preset.comp;
        if (c && !multi) {
            g.comp.threshold.value = c.threshold; g.comp.knee.value = c.knee; g.comp.ratio.value = c.ratio;
            g.comp.attack.value = c.attack; g.comp.release.value = c.release;
        }
        ramp(g.compOn.gain, c && !multi ? 1 : 0); ramp(g.compOff.gain, c && !multi ? 0 : 1);
        const sp = !!preset.spatial && !multi;
        ramp(g.spatialOn.gain, sp ? 1 : 0); ramp(g.spatialOff.gain, sp ? 0 : 1);
        ramp(g.limitOn.gain, multi ? 0 : 1); ramp(g.limitOff.gain, multi ? 1 : 0);
        g.match.gain.cancelScheduledValues(ctx.currentTime);
        ramp(g.match.gain, initialMatch(name));
        ramp(g.wet.gain, 1); ramp(g.dry.gain, 0);
        if (!meterTimer) meterTimer = setInterval(meterTick, 100);
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    }
    // Chromium suspends idle contexts; wake it with playback.
    document.addEventListener('play', function (event) {
        if (ctx && ctx.state === 'suspended' && event.target && event.target.tagName === 'VIDEO') ctx.resume().catch(function () {});
    }, true);

    window.__ygAudio = {
        order: ORDER.slice(),
        presets: PRESETS,
        saved: saved,
        current: function () { return current; },
        apply: apply,
        label: function (name) { return name === 'off' ? 'Выкл' : (PRESETS[name] ? PRESETS[name].label : name); },
        _graph: function (video) { return graphs.get(video); }
    };
})();
