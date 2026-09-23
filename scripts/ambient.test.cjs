const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/ambient.js'), 'utf8');
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
    const body = { appendChild: element => { element.isConnected = true; } };
    const document = { body, hidden: false, fullscreenElement: null,
        addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); },
        querySelector: selector => selector.includes('video') ? document.video : selector === '#movie_player' ? { classList: { contains: () => false } } : selector.includes('#secondary') ? { getBoundingClientRect: () => ({ left: 904, top: 120, bottom: 900, width: 350 }) } : null,
        createElement: tag => {
            const element = { tagName: tag, style: {}, setAttribute() {}, appendChild() {},
                getContext: () => ({ clearRect() {}, fillRect() {},
                    createLinearGradient(...coords) {
                        const gradient = { coords, stops: [], addColorStop(offset, color) { this.stops.push([offset, color]); } };
                        if (options.gradients) options.gradients.push({ target: element, gradient, op: this.globalCompositeOperation });
                        return gradient;
                    },
                    drawImage(...args) { draws++; if (options.calls) options.calls.push({ target: element, source: args[0], args: args.slice(1), alpha: this.globalAlpha, filter: this.filter, op: this.globalCompositeOperation }); },
                    getImageData() { if (options.blockRead) throw Error('SecurityError'); return { data: options.pixels || new Uint8ClampedArray(96 * 54 * 4).fill(100) }; } }) };
            elements.push(element); return element;
        }, video };
    const location = { pathname: '/watch' };
    const window = { scrollX: 0, scrollY: options.scrollY || 0, addEventListener: (name, listener) => { windows[name] = listener; } };
    const timers = new Map();
    const context = { document, window, location, innerWidth: 1280, innerHeight: 900,
        getComputedStyle: () => ({ borderTopLeftRadius: (options.radius ?? 16) + 'px' }),
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        performance: { now: () => now },
        setInterval: callback => intervals.push(callback),
        setTimeout: callback => { const id = nextId++; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => { animation = callback; return 1; } };
    vm.runInNewContext(script, context);
    return { document, video, location, pending, timers, rect, window,
        root: () => elements.find(element => element.id === 'lg-ambilight'),
        // Output canvas (on the page), zone canvas and fade mask, in creation order.
        canvas: () => elements.filter(element => element.tagName === 'canvas')[0],
        zones: () => elements.filter(element => element.tagName === 'canvas')[1],
        mask: () => elements.filter(element => element.tagName === 'canvas')[2],
        stats: () => window.__lgAmbilight,
        draws: () => draws, tick: () => { now += 1000; intervals.forEach(callback => callback()); },
        frame: (ms = 40) => { now += ms; video.currentTime += ms / 1000; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); },
        emit: name => (listeners[name] || []).forEach(listener => listener({ target: video })),
        scroll: () => { windows.scroll(); if (animation) { const callback = animation; animation = null; callback(); } } };
}
function framePixels(pattern) {
    const data = new Uint8ClampedArray(96 * 54 * 4);
    for (let row = 0; row < 54; row++) for (let col = 0; col < 96; col++) {
        const level = pattern(row, col);
        const offset = (row * 96 + col) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = level;
        data[offset + 3] = 255;
    }
    return data;
}
function nums(value) { return String(value).match(/-?\d+(?:\.\d+)?/g).map(Number); }
function near(actual, expected, tolerance = 0.01) { assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' !~ ' + expected); }
function marginFor(w, h) { return Math.min(320, Math.max(60, Math.min(w, h) * 0.4)); }
test('glow is painted behind the page and not clipped away from the sidebar', () => {
    const app = harness();
    assert.ok(Number(app.root().style.opacity) > 0);
    assert.match(app.root().style.cssText, /position:absolute/);
    assert.match(app.root().style.cssText, /z-index:-1/);
    assert.equal(app.root().style.clipPath, undefined);
    assert.equal(app.root().style.maskImage, undefined);
    assert.match(app.canvas().style.clipPath, /^polygon\(evenodd/);
    assert.equal(app.pending.size, 1);
});
test('hole stays inside the rounded video so corners and edges keep their glow', () => {
    const app = harness({ radius: 16 });
    const margin = marginFor(800, 450);
    const hole = nums(app.canvas().style.clipPath).slice(10);
    near(hole[0], margin + 18); near(hole[1], margin + 18);
    near(hole[4], margin + 800 - 18); near(hole[5], margin + 450 - 18);
});
test('canvas uses document coordinates so scrolling needs no repositioning', () => {
    const app = harness({ scrollY: 300 });
    const margin = marginFor(800, 450);
    near(parseFloat(app.canvas().style.top), 120 + 300 - margin);
    const before = app.canvas().style.top;
    // Scrolling by 100px moves the viewport rect but not the page position.
    app.window.scrollY = 400; app.rect.top = 20; app.rect.bottom = 470; app.scroll();
    assert.equal(app.canvas().style.top, before);
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
});
test('navigation and fullscreen remove light', () => {
    const app = harness(); app.location.pathname = '/'; app.emit('yt-navigate-finish');
    assert.equal(app.root().style.opacity, '0'); assert.equal(app.pending.size, 0);
    app.location.pathname = '/watch'; app.document.fullscreenElement = {}; app.emit('fullscreenchange');
    assert.equal(app.root().style.opacity, '0');
});
test('video replacement cancels old callback and resumes sampling', () => {
    const app = harness(); app.document.video = { ...app.video, currentSrc: 'video-b' }; app.tick();
    assert.equal(app.pending.size, 1); assert.ok(Number(app.root().style.opacity) > 0);
});
test('blocked pixel read does not disable drawable ambient light', () => {
    const app = harness({ blockRead: true });
    assert.ok(Number(app.root().style.opacity) > 0); assert.equal(app.pending.size, 1);
});
test('fallback timer is cancelled when page is hidden', () => {
    const app = harness({ fallback: true }); assert.equal(app.timers.size, 1);
    app.document.hidden = true; app.emit('visibilitychange'); assert.equal(app.timers.size, 0);
});
test('paused video keeps its light when the layout changes (canvas resize)', () => {
    const calls = [];
    const app = harness({ calls });
    app.video.paused = true; app.emit('pause');
    const before = app.canvas().width;
    calls.length = 0;
    app.rect.bottom = 420; app.rect.height = 300; app.tick();
    assert.notEqual(app.canvas().width, before, 'canvas was resized');
    assert.ok(calls.filter(call => call.target === app.zones()).length >= 9, 'zones repainted after resize');
    assert.ok(calls.filter(call => call.target === app.canvas()).length >= 2, 'output repainted after resize');
    assert.equal(calls.filter(call => call.source === app.video).length, 0, 'no new video sampling while paused');
});
test('paused glow returns after scrolling back into view', () => {
    const app = harness(); app.video.paused = true; app.emit('pause');
    app.rect.top = -600; app.rect.bottom = -150; app.scroll();
    assert.equal(app.root().style.opacity, '0');
    app.rect.top = 120; app.rect.bottom = 570; app.scroll();
    assert.ok(Number(app.root().style.opacity) > 0);
});
test('letterboxed video places canvas and hole over the content rect', () => {
    const app = harness({ pixels: framePixels((row) => (row < 7 || row > 46) ? 0 : 100) });
    app.frame();
    const contentWidth = 800, contentHeight = 40 / 54 * 450, contentTop = 120 + 7 / 54 * 450;
    const margin = marginFor(contentWidth, contentHeight);
    near(parseFloat(app.canvas().style.left), 80 - margin);
    near(parseFloat(app.canvas().style.top), contentTop - margin);
    near(parseFloat(app.canvas().style.width), contentWidth + margin * 2);
    near(parseFloat(app.canvas().style.height), contentHeight + margin * 2);
    const hole = nums(app.canvas().style.clipPath).slice(10);
    near(hole[0], margin + 18); near(hole[1], margin + 18);
    near(hole[4], margin + contentWidth - 18); near(hole[5], margin + contentHeight - 18);
    assert.ok(contentHeight < 450 - 1, 'content rect must be shorter than the element rect');
    assert.ok(Number(app.root().style.opacity) > 0);
});
test('pillarbox bars wider than the old 19-column cap are detected; light fills the free sides', () => {
    const app = harness({ video: { videoWidth: 1080, videoHeight: 1920 },
        pixels: framePixels((row, col) => (col < 34 || col > 61) ? 0 : 100) });
    app.frame();
    const contentLeft = 80 + 34 / 96 * 800, contentWidth = 28 / 96 * 800;
    const margin = marginFor(contentWidth, 450);
    // Free space on both sides: the light spreads sideways up to the nearer
    // window edge instead of stopping at the base spread.
    const sideways = Math.min(480, Math.max(margin, Math.min(contentLeft, 1280 - contentLeft - contentWidth)));
    near(parseFloat(app.canvas().style.left), contentLeft - sideways);
    near(parseFloat(app.canvas().style.width), contentWidth + sideways * 2);
    near(parseFloat(app.canvas().style.top), 120 - margin);
    assert.ok(contentLeft - 80 > 19 / 96 * 800, 'detected bar must exceed the legacy 19-column scan cap');
});
test('glow fades outward with two intersected linear fades baked into the canvas', () => {
    const gradients = [], calls = [];
    const app = harness({ gradients, calls });
    // No per-frame CSS filter or mask for the compositor to re-run.
    assert.equal(app.canvas().style.maskImage, undefined);
    assert.equal(app.canvas().style.filter, undefined);
    assert.ok(!/radial/.test(app.canvas().style.cssText || ''));
    const fades = gradients.filter(entry => entry.target === app.mask());
    assert.equal(fades.length, 2);
    assert.deepEqual(fades.map(entry => entry.op), ['source-over', 'destination-in']);
    const [horizontal, vertical] = fades.map(entry => entry.gradient);
    assert.equal(horizontal.coords[1], 0); assert.equal(horizontal.coords[3], 0);
    assert.equal(vertical.coords[0], 0); assert.equal(vertical.coords[2], 0);
    for (const g of [horizontal, vertical]) {
        const offsets = g.stops.map(stop => stop[0]);
        assert.deepEqual(offsets, offsets.slice().sort((a, b) => a - b), 'monotonic stops');
        assert.equal(g.stops[0][1], 'rgba(0,0,0,0)'); assert.equal(g.stops[g.stops.length - 1][1], 'rgba(0,0,0,0)');
    }
    calls.length = 0; app.frame();
    const out = calls.filter(call => call.target === app.canvas());
    assert.equal(out.length, 2);
    assert.equal(out[0].source, app.zones()); assert.match(out[0].filter, /^blur\([\d.]+px\) saturate\(1\.25\) brightness\([\d.]+\)$/);
    assert.equal(out[1].source, app.mask()); assert.equal(out[1].op, 'destination-in');
});
test('every zone colour is carried straight out from its point on the edge', () => {
    const calls = [];
    const app = harness({ calls });
    calls.length = 0; app.frame();
    const zones = app.zones();
    const frame = calls.find(call => call.source === app.video).target;
    const strips = calls.filter(call => call.source === frame && call.target !== zones);
    assert.equal(strips.length, 8);
    // 96 points along top/bottom, 54 along the sides; the edge band is 6%
    // deep (12 of 192 frame columns, 6 of 108 rows), the deep band 24%.
    assert.deepEqual(strips.map(call => call.args), [
        [0, 0, 12, 108, 0, 0, 1, 54], [180, 0, 12, 108, 0, 0, 1, 54],
        [0, 0, 192, 6, 0, 0, 96, 1], [0, 102, 192, 6, 0, 0, 96, 1],
        [0, 0, 46, 108, 0, 0, 1, 54], [146, 0, 46, 108, 0, 0, 1, 54],
        [0, 0, 192, 26, 0, 0, 96, 1], [0, 82, 192, 26, 0, 0, 96, 1]]);
    const [left, right, top, bottom, deepLeft, deepRight, deepTop, deepBottom] = strips.map(call => call.target);
    const mx = Math.round(96 * marginFor(800, 450) / 800), my = Math.round(54 * marginFor(800, 450) / 450);
    const ix = Math.round(mx * 0.5), iy = Math.round(my * 0.5);
    assert.equal(zones.width, 96 + 2 * mx); assert.equal(zones.height, 54 + 2 * my);
    const into = source => calls.filter(call => call.target === zones && call.source === source).map(call => call.args);
    assert.deepEqual(into(frame), [[0, 0, 192, 108, mx, my, 96, 54]]);
    // Deep colours across the whole spread...
    assert.deepEqual(into(deepLeft)[0], [0, 0, 1, 54, 0, my, mx, 54]);
    assert.deepEqual(into(deepRight)[0], [0, 0, 1, 54, mx + 96, my, mx, 54]);
    assert.deepEqual(into(deepTop)[0], [0, 0, 96, 1, mx, 0, 96, my]);
    assert.deepEqual(into(deepBottom)[0], [0, 0, 96, 1, mx, my + 54, 96, my]);
    // ...edge colours over the inner half, right beside the picture.
    assert.deepEqual(into(left)[0], [0, 0, 1, 54, mx - ix, my, ix, 54]);
    assert.deepEqual(into(right)[0], [0, 0, 1, 54, mx + 96, my, ix, 54]);
    assert.deepEqual(into(top)[0], [0, 0, 96, 1, mx, my - iy, 96, iy]);
    assert.deepEqual(into(bottom)[0], [0, 0, 96, 1, mx, my + 54, 96, iy]);
    // Corners mix the two neighbouring end zones half and half, per band.
    const corners = calls.filter(call => call.target === zones && call.args[2] === 1 && call.args[3] === 1);
    assert.equal(corners.length, 16);
    assert.deepEqual(corners.map(call => call.alpha), Array(8).fill([1, 0.5]).flat());
});
test('every video frame is painted (no 30 fps cap)', () => {
    const app = harness();
    const start = app.stats().frames;
    for (let i = 0; i < 12; i++) app.frame(16);
    assert.equal(app.stats().frames - start, 12);
});
test('the light settles on a new frame within ~50 ms instead of trailing behind', () => {
    const calls = [];
    const app = harness({ calls });
    calls.length = 0; app.frame(16);
    const blend = calls.find(call => call.source === app.video && call.args.length === 8).alpha;
    near(blend, 1 - Math.exp(-16 / 50), 1e-9);
    assert.ok(blend > 0.25, '16 ms frame moves the light by more than a quarter: ' + blend);
});
test('the picture is read from the video with black bars cropped', () => {
    const calls = [];
    const app = harness({ calls, pixels: framePixels((row) => (row < 7 || row > 46) ? 0 : 100) });
    calls.length = 0; app.frame();
    const draw = calls.find(call => call.source === app.video && call.args.length === 8);
    near(draw.args[0], 0); near(draw.args[1], 7 / 54 * 1080); near(draw.args[2], 1920); near(draw.args[3], 40 / 54 * 1080);
});
test('auto-gain keeps edge colours: dim lifted a little, white toned down slightly', () => {
    const settle = app => { for (let i = 0; i < 12; i++) { app.tick(); app.frame(); } };
    const gainOf = pixels => {
        const calls = [];
        const app = harness({ calls, pixels }); settle(app);
        const last = calls.filter(call => call.target === app.canvas() && call.filter && call.filter !== 'none').pop();
        return { app, filter: last.filter, gain: Number(/brightness\(([\d.]+)\)/.exec(last.filter)[1]) };
    };
    const dim = gainOf(framePixels(() => 30));
    assert.ok(dim.gain >= 1.45 && dim.gain <= 1.5, 'dim frame gain ' + dim.gain);
    assert.match(dim.filter, /saturate\(1\.25\)/);
    const bright = gainOf(framePixels(() => 220));
    assert.ok(bright.gain >= 0.85 && bright.gain <= 0.9, 'bright frame toned down: ' + bright.gain);
    const black = gainOf(framePixels(() => 0));
    assert.ok(Number(black.app.root().style.opacity) > 0 && Number(black.app.root().style.opacity) < 0.9);
});
test('subtitles inside a letterbox bar do not stop the bar from being cropped', () => {
    const calls = [];
    // Bars of 7 rows; the bottom bar carries sparse white "subtitle" pixels.
    const app = harness({ calls, pixels: framePixels((row, col) => row < 7 ? 0 : row > 46 ? (row === 50 && col % 8 === 0 ? 255 : 0) : 100) });
    calls.length = 0; app.frame();
    const draw = calls.find(call => call.source === app.video && call.args.length === 8);
    near(draw.args[1], 7 / 54 * 1080); near(draw.args[3], 40 / 54 * 1080);
});
test('asymmetric dark edge is not treated as a bar', () => {
    const app = harness({ pixels: framePixels((row, col) => (col < 20 ? 0 : 100)) });
    app.frame();
    const margin = marginFor(800, 450);
    near(parseFloat(app.canvas().style.left), 80 - margin);
    near(parseFloat(app.canvas().style.top), 120 - margin);
    near(parseFloat(app.canvas().style.width), 800 + margin * 2);
    near(parseFloat(app.canvas().style.height), 450 + margin * 2);
});
