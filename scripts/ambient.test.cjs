const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/ambient.js'), 'utf8');
const [SW, SH] = /sampleWidth = (\d+), sampleHeight = (\d+)/.exec(script).slice(1).map(Number);

function harness(options = {}) {
    const listeners = {}, windows = {}, intervals = [], elements = [], pending = new Map();
    let now = 1000, nextId = 0, draws = 0, animation = null;
    const rect = { left: 80, top: 120, right: 880, bottom: 570, width: 800, height: 450 };
    const video = { tagName: 'VIDEO', readyState: 4, videoWidth: 1920, videoHeight: 1080, currentTime: 1,
        currentSrc: 'video-a', paused: false, ended: false,
        getBoundingClientRect: () => rect,
        requestVideoFrameCallback: callback => { const id = nextId++; pending.set(id, callback); return id; },
        cancelVideoFrameCallback: id => pending.delete(id) };
    Object.assign(video, options.video);
    if (options.fallback) delete video.requestVideoFrameCallback;
    const classes = new Set(), props = {};
    const documentElement = {
        classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
        style: { setProperty: (name, value) => { props[name] = value; }, getPropertyValue: name => props[name] || '' }
    };
    const body = { appendChild: element => { element.isConnected = true; } };
    const document = { body, documentElement, hidden: false, fullscreenElement: null,
        addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); },
        querySelector: selector => selector.includes('video') ? document.video : selector === '#movie_player' ? { classList: { contains: () => false } } : null,
        createElement: tag => {
            const element = { tagName: tag, style: {}, setAttribute() {}, remove() { element.parentNode = null; },
                appendChild(child) { child.parentNode = element; },
                addEventListener() {},
                getContext: type => {
                    if (type === 'webgl2') return options.gl ? options.gl(element) : null;
                    return { clearRect() {},
                        drawImage(...args) { draws++; if (options.calls) options.calls.push({ target: element, source: args[0], args: args.slice(1), alpha: this.globalAlpha }); },
                        getImageData() { if (options.blockRead) throw Error('SecurityError'); return { data: options.pixels || framePixels(() => 100) }; } };
                } };
            elements.push(element); return element;
        }, video };
    const location = { pathname: '/watch' };
    const window = { scrollX: 0, scrollY: options.scrollY || 0, addEventListener: (name, listener) => { windows[name] = listener; } };
    const timers = new Map();
    const context = { document, window, location, innerWidth: 1280, innerHeight: 900,
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        performance: { now: () => now },
        setInterval: callback => intervals.push(callback),
        setTimeout: callback => { const id = nextId++; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => { animation = callback; return 1; } };
    vm.runInNewContext(script, context);
    const root = () => elements.find(element => element.id === 'lg-ambilight');
    return { document, video, location, pending, timers, rect, window, classes, props,
        root, stats: () => window.__lgAmbilight,
        canvas: () => elements.find(element => element.tagName === 'canvas' && element.parentNode === root()),
        draws: () => draws, advance: ms => { now += ms; },
        tick: () => { now += 1000; intervals.forEach(callback => callback()); },
        frame: (ms = 40) => { now += ms; video.currentTime += ms / 1000; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); },
        emit: name => (listeners[name] || []).forEach(listener => listener({ target: video })),
        scroll: () => { windows.scroll(); if (animation) { const callback = animation; animation = null; callback(); } } };
}
function framePixels(pattern) {
    const data = new Uint8ClampedArray(SW * SH * 4);
    for (let row = 0; row < SH; row++) for (let col = 0; col < SW; col++) {
        const level = pattern(row, col);
        const offset = (row * SW + col) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = level;
        data[offset + 3] = 255;
    }
    return data;
}
function near(actual, expected, tolerance = 0.01) { assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' !~ ' + expected); }
function reachFor(left, width, height) {
    const base = Math.min(360, Math.max(80, Math.min(width, height) * 0.5));
    const vertical = Math.min(420, Math.max(80, height * 0.55));
    return [Math.min(1000, Math.max(base, left)), vertical, Math.min(1000, Math.max(base, 1280 - left - width)), vertical];
}
// Letterbox: rows [0, bar) and [SH - bar, SH) black.
const letterbox = bar => framePixels(row => (row < bar || row >= SH - bar) ? 0 : 100);
// Content rows after one safety row inwards on each side.
const contentRows = bar => [bar + 1, SH - 2 * bar - 2];

test('light is painted behind the page in document coordinates, with no hole', () => {
    const app = harness({ scrollY: 300 });
    assert.ok(Number(app.root().style.opacity) > 0);
    assert.match(app.root().style.cssText, /position:absolute/);
    assert.match(app.root().style.cssText, /z-index:-1/);
    assert.doesNotMatch(app.root().style.cssText, /mix-blend/);
    assert.equal(app.canvas().style.clipPath, undefined);
    const [l, t, r, b] = reachFor(80, 800, 450);
    near(parseFloat(app.canvas().style.left), 80 - l);
    near(parseFloat(app.canvas().style.top), 120 + 300 - t);
    near(parseFloat(app.canvas().style.width), 800 + l + r);
    near(parseFloat(app.canvas().style.height), 450 + t + b);
    // Scrolling moves the viewport rect but not the page position.
    const before = app.canvas().style.top;
    app.window.scrollY = 400; app.rect.top = 20; app.rect.bottom = 470; app.scroll();
    assert.equal(app.canvas().style.top, before);
    assert.ok(app.classes.has('lg-ambient-on'));
});
test('every video frame is painted, with no smoothing and no 30 fps cap', () => {
    const calls = [];
    const app = harness({ calls });
    const start = app.stats().frames;
    for (let i = 0; i < 10; i++) app.frame(16);
    assert.equal(app.stats().frames - start, 10);
    const pictures = calls.filter(call => call.source === app.video && call.args.length === 8);
    assert.ok(pictures.length >= 10);
    assert.ok(pictures.every(call => call.alpha === 1), 'frames replace the picture instead of blending into it');
});
test('hidden document cancels callback including callback ID zero', () => {
    const app = harness(); app.document.hidden = true; app.emit('visibilitychange');
    assert.equal(app.pending.size, 0); assert.equal(app.root().style.opacity, '0');
    app.document.hidden = false; app.emit('visibilitychange'); assert.equal(app.pending.size, 1);
});
test('paused playback does not repeatedly sample video', () => {
    const app = harness(); app.video.paused = true; app.emit('pause');
    const draws = app.draws(); app.tick(); app.tick();
    assert.equal(app.draws(), draws); assert.equal(app.pending.size, 0);
    assert.equal(app.root().style.opacity, '0.9');
});
test('navigation and fullscreen remove the light and its page classes', () => {
    const app = harness(); app.location.pathname = '/'; app.emit('yt-navigate-finish');
    assert.equal(app.root().style.opacity, '0'); assert.equal(app.pending.size, 0);
    assert.ok(!app.classes.has('lg-ambient-on'));
    app.location.pathname = '/watch'; app.emit('yt-navigate-finish');
    assert.ok(app.classes.has('lg-ambient-on'));
    app.document.fullscreenElement = {}; app.emit('fullscreenchange');
    assert.equal(app.root().style.opacity, '0');
    assert.ok(!app.classes.has('lg-ambient-on'));
});
test('video replacement cancels old callback and resumes sampling', () => {
    const app = harness(); app.document.video = { ...app.video, currentSrc: 'video-b' }; app.tick();
    assert.equal(app.pending.size, 1); assert.ok(Number(app.root().style.opacity) > 0);
});
test('blocked pixel read does not disable the light', () => {
    const app = harness({ blockRead: true });
    assert.ok(Number(app.root().style.opacity) > 0); assert.equal(app.pending.size, 1);
});
test('fallback timer is cancelled when page is hidden', () => {
    const app = harness({ fallback: true }); assert.equal(app.timers.size, 1);
    app.document.hidden = true; app.emit('visibilitychange'); assert.equal(app.timers.size, 0);
});
test('paused light returns after scrolling back into view', () => {
    const app = harness(); app.video.paused = true; app.emit('pause');
    app.rect.top = -600; app.rect.bottom = -150; app.scroll();
    assert.equal(app.root().style.opacity, '0');
    app.rect.top = 120; app.rect.bottom = 570; app.scroll();
    assert.ok(Number(app.root().style.opacity) > 0);
});
test('letterboxed video: the extension is built around the content rect', () => {
    const bar = Math.round(SH * 0.13);
    const app = harness({ pixels: letterbox(bar) });
    app.frame();
    const [firstRow, rows] = contentRows(bar);
    const contentTop = 120 + firstRow / SH * 450, contentHeight = rows / SH * 450;
    const [l, t, r, b] = reachFor(80, 800, contentHeight);
    near(parseFloat(app.canvas().style.left), 80 - l);
    near(parseFloat(app.canvas().style.top), contentTop - t);
    near(parseFloat(app.canvas().style.width), 800 + l + r);
    near(parseFloat(app.canvas().style.height), contentHeight + t + b);
});
test('pillarbox bars are detected and the light spreads to the window edges', () => {
    const bar = Math.round(SW * 0.35);
    const app = harness({ video: { videoWidth: 1080, videoHeight: 1920 },
        pixels: framePixels((row, col) => (col < bar || col >= SW - bar) ? 0 : 100) });
    app.frame();
    const contentLeft = 80 + (bar + 1) / SW * 800, contentWidth = (SW - 2 * bar - 2) / SW * 800;
    const [l, t, r] = reachFor(contentLeft, contentWidth, 450);
    assert.ok(l > 360 && r > 360, 'reaches past the base spread on both sides');
    near(parseFloat(app.canvas().style.left), contentLeft - l);
    near(parseFloat(app.canvas().style.width), contentWidth + l + r);
    near(parseFloat(app.canvas().style.top), 120 - t);
});
test('subtitles inside a letterbox bar do not stop the bar from being cropped', () => {
    const calls = [];
    const bar = Math.round(SH * 0.13);
    const app = harness({ calls, pixels: framePixels((row, col) => row < bar ? 0
        : row >= SH - bar ? (row === SH - Math.round(bar / 2) && col % 8 === 0 ? 255 : 0) : 100) });
    calls.length = 0; app.frame();
    const draw = calls.find(call => call.source === app.video && call.args.length === 8);
    const [firstRow, rows] = contentRows(bar);
    near(draw.args[1], firstRow / SH * 1080); near(draw.args[3], rows / SH * 1080);
});
test('asymmetric dark edge is not treated as a bar', () => {
    const app = harness({ pixels: framePixels((row, col) => (col < SW * 0.2 ? 0 : 100)) });
    app.frame();
    const [l, t] = reachFor(80, 800, 450);
    near(parseFloat(app.canvas().style.left), 80 - l);
    near(parseFloat(app.canvas().style.top), 120 - t);
});
test('stable bars around a standard aspect ratio are clipped off the video; others are not', () => {
    // 2.39:1 film inside a 16:9 file.
    const bar = Math.round(SH * (1 - (16 / 9) / 2.39) / 2);
    const app = harness({ pixels: letterbox(bar) });
    for (let i = 0; i < 2; i++) { app.advance(600); app.frame(); }
    assert.ok(!app.classes.has('lg-bars'), 'not before the bars are stable');
    app.advance(600); app.frame();
    assert.ok(app.classes.has('lg-bars'));
    assert.equal(app.props['--lg-bar-t'], Math.ceil((bar + 1) / SH * 450 - 0.05) + 'px');
    assert.equal(app.props['--lg-bar-b'], Math.ceil((bar + 1) / SH * 450 - 0.05) + 'px');
    assert.equal(app.props['--lg-bar-l'], '0px');
    app.document.fullscreenElement = {}; app.emit('fullscreenchange');
    assert.ok(!app.classes.has('lg-bars'), 'fullscreen keeps the real bars');

    // A dark top and bottom that leave an odd aspect ratio (2.96:1) are a
    // dark scene, not bars: never cut.
    const odd = harness({ pixels: letterbox(Math.round(SH * 0.2)) });
    for (let i = 0; i < 4; i++) { odd.advance(600); odd.frame(); }
    assert.ok(!odd.classes.has('lg-bars'));
});
test('WebGL2 renderer: per-frame upload, downsample, mipmaps and extension pass', () => {
    const log = [];
    const app = harness({ gl: () => fakeGL(log) });
    assert.equal(app.stats().renderer, 'webgl2');
    log.length = 0; app.frame(16);
    assert.deepEqual(log.filter(entry => entry[0] === 'texImage2D').map(entry => entry[1]), [app.video]);
    assert.equal(log.filter(entry => entry[0] === 'drawArrays').length, 2);
    assert.equal(log.filter(entry => entry[0] === 'generateMipmap').length, 1);
    const [l, t, r, b] = reachFor(80, 800, 450);
    const rect = log.find(entry => entry[0] === 'uniform4f' && entry[1] === 'rect');
    assert.deepEqual(rect.slice(2), [l, t, 800, 450]);
    const reach = log.find(entry => entry[0] === 'uniform4f' && entry[1] === 'reach');
    assert.deepEqual(reach.slice(2), [l, t, r, b]);
    // Pixel budget keeps the canvas small; the page scales it up.
    assert.ok(app.canvas().width * app.canvas().height <= 250000 * 1.01);
});
test('WebGL2 falls back to the 2D renderer when frames cannot be uploaded', () => {
    const app = harness({ gl: () => fakeGL([], { throwOnUpload: true }) });
    assert.equal(app.stats().renderer, '2d');
    assert.ok(Number(app.root().style.opacity) > 0);
    app.frame(16);
    assert.equal(app.stats().renderer, '2d');
});
test('2D fallback: every zone colour is carried straight out from its point', () => {
    const calls = [];
    const app = harness({ calls });
    calls.length = 0; app.frame();
    const glow = app.canvas();
    const picture = calls.find(call => call.source === app.video && call.args.length === 8).target;
    const strips = calls.filter(call => call.source === picture && call.target !== glow);
    // 64 points along top/bottom, 36 along the sides, each averaging a band
    // 10% deep (13 of 128 picture columns, 7 of 72 rows).
    assert.deepEqual(strips.map(call => call.args), [
        [0, 0, 13, 72, 0, 0, 1, 36], [115, 0, 13, 72, 0, 0, 1, 36],
        [0, 0, 128, 7, 0, 0, 64, 1], [0, 65, 128, 7, 0, 0, 64, 1]]);
    const [left, right, top, bottom] = strips.map(call => call.target);
    const reach = reachFor(80, 800, 450);
    const ml = Math.round(64 * reach[0] / 800), mt = Math.round(36 * reach[1] / 450);
    const mr = Math.round(64 * reach[2] / 800), mb = Math.round(36 * reach[3] / 450);
    assert.equal(glow.width, 64 + ml + mr); assert.equal(glow.height, 36 + mt + mb);
    const into = source => calls.filter(call => call.target === glow && call.source === source).map(call => call.args);
    assert.deepEqual(into(picture), [[0, 0, 128, 72, ml, mt, 64, 36]]);
    assert.deepEqual(into(left)[0], [0, 0, 1, 36, 0, mt, ml, 36]);
    assert.deepEqual(into(right)[0], [0, 0, 1, 36, ml + 64, mt, mr, 36]);
    assert.deepEqual(into(top)[0], [0, 0, 64, 1, ml, 0, 64, mt]);
    assert.deepEqual(into(bottom)[0], [0, 0, 64, 1, ml, mt + 36, 64, mb]);
    const corners = calls.filter(call => call.target === glow && call.args[2] === 1 && call.args[3] === 1);
    assert.equal(corners.length, 8);
    assert.deepEqual(corners.map(call => call.alpha), [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5]);
    assert.match(glow.style.maskImage, /^linear-gradient\(to right,transparent 0,.*linear-gradient\(to bottom,transparent 0,/);
    assert.doesNotMatch(glow.style.maskImage, /radial/);
    assert.equal(glow.style.maskComposite, 'intersect');
});
test('paused video keeps its light when the layout changes (canvas resize)', () => {
    const calls = [];
    const app = harness({ calls });
    app.video.paused = true; app.emit('pause');
    const before = app.canvas().width;
    calls.length = 0;
    app.rect.bottom = 420; app.rect.height = 300; app.tick();
    assert.notEqual(app.canvas().width, before, 'canvas was resized');
    assert.ok(calls.filter(call => call.target === app.canvas()).length >= 9, 'repainted after resize');
    assert.ok(Number(app.root().style.opacity) > 0);
});
test('2D auto-gain keeps edge colours: dim lifted a little, white toned down slightly', () => {
    const settle = app => { for (let i = 0; i < 12; i++) { app.advance(600); app.frame(); } };
    const dim = harness({ pixels: framePixels(() => 30) }); settle(dim);
    const gainDim = Number(/brightness\(([\d.]+)\)/.exec(dim.canvas().style.filter)[1]);
    assert.ok(gainDim >= 1.45 && gainDim <= 1.5, 'dim frame gain ' + gainDim);
    assert.match(dim.canvas().style.filter, /saturate\(1\.2\)/);
    const bright = harness({ pixels: framePixels(() => 220) }); settle(bright);
    const gainBright = Number(/brightness\(([\d.]+)\)/.exec(bright.canvas().style.filter)[1]);
    assert.ok(gainBright >= 0.85 && gainBright <= 0.9, 'bright frame toned down: ' + gainBright);
});

function fakeGL(log, options = {}) {
    const constants = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ACTIVE_UNIFORMS: 5,
        ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, TEXTURE_2D: 9, TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11,
        TEXTURE_WRAP_S: 12, TEXTURE_WRAP_T: 13, LINEAR: 14, LINEAR_MIPMAP_LINEAR: 15, CLAMP_TO_EDGE: 16, TEXTURE0: 17,
        UNPACK_FLIP_Y_WEBGL: 18, RGBA: 19, UNSIGNED_BYTE: 20, FRAMEBUFFER: 21, COLOR_ATTACHMENT0: 22, RGBA8: 23,
        TRIANGLE_STRIP: 24 };
    const uniforms = { 1: ['src', 'crop', 'quarter'], 2: ['pic', 'size', 'rect', 'reach', 'texPerPx', 'gain'] };
    let programs = 0;
    return new Proxy(constants, { get(target, name) {
        if (name in target) return target[name];
        switch (name) {
            case 'getShaderParameter': return () => true;
            case 'createProgram': return () => ({ id: ++programs });
            case 'getProgramParameter': return (program, what) => what === 5 ? uniforms[program.id].length : true;
            case 'getActiveUniform': return (program, i) => ({ name: uniforms[program.id][i] });
            case 'getUniformLocation': return (program, uniform) => ({ name: uniform });
            case 'texImage2D': return (...args) => {
                if (options.throwOnUpload) throw new Error('SecurityError');
                log.push(['texImage2D', args[5]]);
            };
            case 'uniform1i': case 'uniform1f': case 'uniform2f': case 'uniform4f':
                return (location, ...values) => log.push([name, location && location.name, ...values]);
            case 'drawArrays': case 'generateMipmap': case 'texStorage2D':
                return (...args) => log.push([name, ...args]);
            default: return () => ({});
        }
    } });
}
