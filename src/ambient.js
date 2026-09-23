(function () {
    'use strict';
    if (window.__lgAmbilight) return;
    const stats = window.__lgAmbilight = { renderer: '', frames: 0 };
    // Ambient light as a continuation of the picture: the space around the
    // player shows the video carried on past its edges, out of focus, like a
    // wider shot of the same scene - not a colour wash.
    //
    // WebGL2 renderer, run on every video frame (the video's own 24-60 fps,
    // no smoothing, so it changes exactly when the picture does):
    //   1. the visible picture (black bars cropped) is uploaded and scaled
    //      into a small texture whose mipmaps are rebuilt each frame;
    //   2. each pixel around the player samples the picture mirrored across
    //      the nearest edge - the edge continues without a seam - from a mip
    //      level that grows with the distance from the edge: detail right at
    //      the edge, only colour and shape further out (depth of field);
    //   3. brightness and opacity fall off with distance, so the extension
    //      melts into the page; very bright extensions are capped so text on
    //      the page stays readable.
    // Letterbox bars encoded in the video are clipped away (theme CSS,
    // html.lg-bars) once they are stable and match a standard aspect ratio,
    // so the extension fills them too.
    // Without WebGL2, or when frames can't be uploaded, a 2D renderer
    // extends per-zone edge colours instead (64 zones along the top and
    // bottom, 36 along the sides).
    // Analysis grid (bars, brightness): fine enough that a bar edge lands
    // within ~3 px of the player, where a coarser grid left a thin strip of
    // the black bar in the picture and mirrored it out as a dark line.
    const sampleWidth = 192, sampleHeight = 216;
    const zonesX = 64, zonesY = 36;
    const depth = 0.1;
    const ASPECTS = [2.76, 2.39, 2.35, 2.2, 2, 1.85, 16 / 9, 1.66, 1.5, 4 / 3, 1, 0.8, 9 / 16];
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let root = null, canvas = null, renderer = null, raw = null, rawContext = null;
    let video = null, callback = null, fallback = null;
    let lastFrame = 0, lastMedia = -1, lastAnalysis = 0, source = '';
    let readBlocked = false, failed = false, glBroken = false;
    let bounds = [0, 0, sampleWidth, sampleHeight], crop = bounds.slice();
    let stableBounds = null, barHits = 0, barsApplied = '';
    let luminance = 0.35, edgeLuminance = 0.35, gain = 1;
    let geometryKey = '', layoutFrame = null;

    function eligible() {
        return location.pathname === '/watch' && !document.hidden && !document.fullscreenElement;
    }
    function setOn(on) {
        const html = document.documentElement;
        if (html) html.classList.toggle('lg-ambient-on', on);
    }
    function hide() {
        if (root) root.style.opacity = '0';
        setBars(null);
        setOn(false);
    }
    function cancel() {
        if (callback !== null && video && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
        callback = null;
        if (fallback !== null) clearTimeout(fallback);
        fallback = null;
    }
    function reset() {
        lastFrame = 0; lastMedia = -1; lastAnalysis = 0; readBlocked = false; failed = false;
        luminance = 0.35; edgeLuminance = 0.35; gain = 1;
        bounds = [0, 0, sampleWidth, sampleHeight]; crop = bounds.slice();
        stableBounds = null; barHits = 0;
    }
    function makeCanvas(w, h, options) {
        const element = document.createElement('canvas');
        element.width = w; element.height = h;
        const context = element.getContext('2d', options);
        // Downscaling into zones must average, not pick single pixels.
        if (context) { context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; }
        return { canvas: element, context: context };
    }

    // ---------- WebGL2 renderer ----------
    const VERTEX = '#version 300 es\nlayout(location = 0) in vec2 a;\nout vec2 v;\n' +
        'void main() { v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }';
    // Cropped video -> small picture texture; 4 bilinear taps per texel so
    // the 3-4x downscale averages instead of aliasing.
    const DOWNSAMPLE = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
uniform sampler2D src;
uniform vec4 crop;
uniform vec2 quarter;
// Taps stay inside the crop (by half a source texel): the first row of the
// picture must not average in the black bar next to it.
vec3 at(vec2 uv, vec2 lo, vec2 hi) { return texture(src, clamp(uv, lo, hi)).rgb; }
void main() {
    vec2 half_ = 0.5 / vec2(textureSize(src, 0));
    vec2 lo = crop.xy + half_, hi = crop.xy + crop.zw - half_;
    vec2 uv = crop.xy + v * crop.zw;
    vec3 c = at(uv - quarter, lo, hi) + at(uv + quarter, lo, hi) +
        at(uv + vec2(quarter.x, -quarter.y), lo, hi) + at(uv + vec2(-quarter.x, quarter.y), lo, hi);
    o = vec4(c * 0.25, 1.0);
}`;
    // Canvas coordinates are CSS px with a top-left origin; `rect` is the
    // picture inside the canvas, `reach` the extension on each side.
    const EXTEND = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
uniform sampler2D pic;
uniform vec2 size;
uniform vec4 rect;
uniform vec4 reach;
uniform vec2 texPerPx;
uniform float gain;
vec3 tap(vec2 uv, float lod) { return textureLod(pic, clamp(uv, 0.0, 1.0), lod).rgb; }
void main() {
    vec2 p = vec2(v.x, 1.0 - v.y) * size;
    vec2 q = (p - rect.xy) / rect.zw;
    vec2 before = rect.xy - p;
    vec2 after = p - rect.xy - rect.zw;
    vec2 outside = max(max(before, after), 0.0);
    // Mirror across the nearest edge (q < 0 -> -q, q > 1 -> 2 - q).
    vec2 m = clamp(1.0 - abs(1.0 - abs(q)), 0.0, 1.0);
    float d = length(outside);
    // Out-of-focus radius grows with distance from the picture.
    float r = (1.0 + d * 0.3) * max(texPerPx.x, texPerPx.y);
    float lod = log2(max(r, 1.0));
    // Trilinear mip plus four diagonal taps: smooth without a blur pass.
    vec2 s = r * 0.5 / vec2(textureSize(pic, 0));
    vec3 c = tap(m, lod) * 0.36
        + (tap(m + s, lod) + tap(m - s, lod) + tap(m + vec2(s.x, -s.y), lod) + tap(m + vec2(-s.x, s.y), lod)) * 0.16;
    vec2 span = vec2(before.x > 0.0 ? reach.x : reach.z, before.y > 0.0 ? reach.y : reach.w);
    float f = length(outside / max(span, vec2(1.0)));
    float alpha = 1.0 - smoothstep(0.3, 1.0, f);
    c *= gain * mix(1.0, 0.72, smoothstep(0.0, 1.0, f));
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c *= mix(1.0, min(1.0, 0.72 / max(luma, 1e-4)), smoothstep(0.0, 40.0, d));
    o = vec4(c * alpha, alpha);
}`;
    function createGLRenderer() {
        const element = document.createElement('canvas');
        let gl = null;
        try {
            gl = element.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false,
                depth: false, stencil: false, powerPreference: 'low-power' });
        } catch (_) { gl = null; }
        if (!gl) return null;
        function compile(type, text) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, text);
            gl.compileShader(shader);
            return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
        }
        function link(fragment) {
            const vs = compile(gl.VERTEX_SHADER, VERTEX), fs = compile(gl.FRAGMENT_SHADER, fragment);
            if (!vs || !fs) return null;
            const program = gl.createProgram();
            gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
            const uniforms = {};
            for (let i = 0, n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i < n; i++) {
                const info = gl.getActiveUniform(program, i);
                uniforms[info.name] = gl.getUniformLocation(program, info.name);
            }
            return { program: program, u: uniforms };
        }
        const down = link(DOWNSAMPLE), extend = link(EXTEND);
        if (!down || !extend) return null;
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        function texture(minFilter) {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        }
        const frameTexture = texture(gl.LINEAR);
        const framebuffer = gl.createFramebuffer();
        let picture = null, pictureWidth = 0, pictureHeight = 0, hasFrame = false, params = null, lost = false;
        element.addEventListener('webglcontextlost', function (event) {
            event.preventDefault();
            lost = true;
            glBroken = true;
            if (renderer && renderer.canvas === element) { renderer = null; geometryKey = ''; }
        });
        return {
            canvas: element,
            kind: 'webgl2',
            resize: function (g) {
                // The extension is soft; ~250k pixels are plenty and keep the
                // per-frame cost low on weak GPUs.
                const scale = Math.min(0.5, Math.sqrt(250000 / (g.width * g.height)));
                const w = Math.max(16, Math.round(g.width * scale)), h = Math.max(16, Math.round(g.height * scale));
                if (element.width !== w) element.width = w;
                if (element.height !== h) element.height = h;
                const pw = 384, ph = Math.max(32, Math.min(384, Math.round(384 * g.rect.height / g.rect.width)));
                if (pw !== pictureWidth || ph !== pictureHeight) {
                    if (picture) gl.deleteTexture(picture);
                    picture = texture(gl.LINEAR_MIPMAP_LINEAR);
                    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(pw, ph))) + 1, gl.RGBA8, pw, ph);
                    pictureWidth = pw; pictureHeight = ph; hasFrame = false;
                }
                params = g;
            },
            // Throws (SecurityError) for frames WebGL may not read.
            frame: function (source, box) {
                if (lost) throw new Error('WebGL context lost');
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, frameTexture);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, picture, 0);
                gl.viewport(0, 0, pictureWidth, pictureHeight);
                gl.useProgram(down.program);
                const cw = box[2] / sampleWidth, ch = box[3] / sampleHeight;
                gl.uniform1i(down.u.src, 0);
                gl.uniform4f(down.u.crop, box[0] / sampleWidth, box[1] / sampleHeight, cw, ch);
                gl.uniform2f(down.u.quarter, cw / pictureWidth * 0.25, ch / pictureHeight * 0.25);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.bindTexture(gl.TEXTURE_2D, picture);
                gl.generateMipmap(gl.TEXTURE_2D);
                hasFrame = true;
            },
            draw: function () {
                if (lost || !hasFrame || !params) return;
                const g = params;
                gl.viewport(0, 0, element.width, element.height);
                gl.useProgram(extend.program);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, picture);
                gl.uniform1i(extend.u.pic, 0);
                gl.uniform2f(extend.u.size, g.width, g.height);
                gl.uniform4f(extend.u.rect, g.reach[0], g.reach[1], g.rect.width, g.rect.height);
                gl.uniform4f(extend.u.reach, g.reach[0], g.reach[1], g.reach[2], g.reach[3]);
                gl.uniform2f(extend.u.texPerPx, pictureWidth / g.rect.width, pictureHeight / g.rect.height);
                gl.uniform1f(extend.u.gain, Math.min(1.25, Math.max(1, gain)));
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
        };
    }

    // ---------- 2D fallback renderer ----------
    function fade(dir, near, far) {
        const stops = [[0, 0], [0.2, 0.14], [0.42, 0.5], [0.66, 0.86], [0.85, 0.98], [1, 1]];
        const start = stops.map(function (s) { return 'rgba(0,0,0,' + s[1] + ') ' + (near * s[0]).toFixed(1) + 'px'; });
        const end = stops.slice().reverse().map(function (s) { return 'rgba(0,0,0,' + s[1] + ') calc(100% - ' + (far * s[0]).toFixed(1) + 'px)'; });
        return 'linear-gradient(to ' + dir + ',transparent 0,' + start.slice(1).join(',') + ',' + end.slice(0, -1).join(',') + ',transparent 100%)';
    }
    function create2DRenderer() {
        const glow = makeCanvas(zonesX + 16, zonesY + 16);
        const pw = zonesX * 2, ph = zonesY * 2;
        const picture = makeCanvas(pw, ph);
        const strips = {
            left: makeCanvas(1, zonesY), right: makeCanvas(1, zonesY),
            top: makeCanvas(zonesX, 1), bottom: makeCanvas(zonesX, 1)
        };
        const context = glow.context, element = glow.canvas;
        if (!context || !picture.context || !strips.left.context || !strips.right.context ||
            !strips.top.context || !strips.bottom.context) return null;
        let margins = [8, 8, 8, 8], blurPx = 8, applied = '', hasFrame = false;
        function applyFilter() {
            // Gentle saturation plus auto-gain (black stays black -
            // brightness() only scales); quantized in analyze().
            const value = 'blur(' + blurPx.toFixed(1) + 'px) saturate(1.2) brightness(' + gain.toFixed(2) + ')';
            if (value !== applied) { applied = value; element.style.filter = value; }
        }
        return {
            canvas: element,
            kind: '2d',
            resize: function (g) {
                // One pixel per zone along the edges, margins in the same
                // scale, so zone i lights exactly the area beside point i.
                margins = [
                    Math.max(2, Math.round(zonesX * g.reach[0] / g.rect.width)),
                    Math.max(2, Math.round(zonesY * g.reach[1] / g.rect.height)),
                    Math.max(2, Math.round(zonesX * g.reach[2] / g.rect.width)),
                    Math.max(2, Math.round(zonesY * g.reach[3] / g.rect.height))];
                element.width = zonesX + margins[0] + margins[2];
                element.height = zonesY + margins[1] + margins[3];
                element.style.maskImage = fade('right', g.reach[0], g.reach[2]) + ',' + fade('bottom', g.reach[1], g.reach[3]);
                element.style.maskComposite = 'intersect';
                blurPx = Math.min(34, Math.max(8, Math.min(g.reach[0], g.reach[1], g.reach[2], g.reach[3]) * 0.15));
            },
            frame: function (src, box) {
                const vw = src.videoWidth, vh = src.videoHeight;
                picture.context.globalAlpha = 1;
                picture.context.drawImage(src, box[0] / sampleWidth * vw, box[1] / sampleHeight * vh,
                    box[2] / sampleWidth * vw, box[3] / sampleHeight * vh, 0, 0, pw, ph);
                hasFrame = true;
            },
            draw: function () {
                if (!hasFrame) return;
                applyFilter();
                const bandX = Math.max(2, Math.round(pw * depth)), bandY = Math.max(2, Math.round(ph * depth));
                strips.left.context.drawImage(picture.canvas, 0, 0, bandX, ph, 0, 0, 1, zonesY);
                strips.right.context.drawImage(picture.canvas, pw - bandX, 0, bandX, ph, 0, 0, 1, zonesY);
                strips.top.context.drawImage(picture.canvas, 0, 0, pw, bandY, 0, 0, zonesX, 1);
                strips.bottom.context.drawImage(picture.canvas, 0, ph - bandY, pw, bandY, 0, 0, zonesX, 1);
                const l = margins[0], t = margins[1], r = margins[2], b = margins[3];
                const right = l + zonesX, bottom = t + zonesY;
                context.globalAlpha = 1;
                context.clearRect(0, 0, element.width, element.height);
                context.drawImage(picture.canvas, 0, 0, pw, ph, l, t, zonesX, zonesY);
                context.drawImage(strips.left.canvas, 0, 0, 1, zonesY, 0, t, l, zonesY);
                context.drawImage(strips.right.canvas, 0, 0, 1, zonesY, right, t, r, zonesY);
                context.drawImage(strips.top.canvas, 0, 0, zonesX, 1, l, 0, zonesX, t);
                context.drawImage(strips.bottom.canvas, 0, 0, zonesX, 1, l, bottom, zonesX, b);
                // Corners: the two neighbouring end zones mixed half and half.
                [[strips.left, 0, strips.top, 0, 0, 0, l, t], [strips.right, 0, strips.top, zonesX - 1, right, 0, r, t],
                    [strips.left, zonesY - 1, strips.bottom, 0, 0, bottom, l, b],
                    [strips.right, zonesY - 1, strips.bottom, zonesX - 1, right, bottom, r, b]
                ].forEach(function (c) {
                    context.globalAlpha = 1;
                    context.drawImage(c[0].canvas, 0, c[1], 1, 1, c[4], c[5], c[6], c[7]);
                    context.globalAlpha = 0.5;
                    context.drawImage(c[2].canvas, c[3], 0, 1, 1, c[4], c[5], c[6], c[7]);
                });
                context.globalAlpha = 1;
            }
        };
    }

    function ensureDom() {
        if (!document.body) return false;
        if (!root) {
            root = document.createElement('div');
            root.id = 'lg-ambilight';
            root.setAttribute('aria-hidden', 'true');
            // Painted BEHIND the page (z-index:-1 in the root stacking
            // context) in document coordinates, so it scrolls natively and
            // never covers text; overflow-x:clip keeps it from widening the page.
            root.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0;overflow-x:clip;pointer-events:none;z-index:-1;opacity:0;transition:opacity .45s ease;';
            const analysis = makeCanvas(sampleWidth, sampleHeight, { willReadFrequently: true });
            raw = analysis.canvas; rawContext = analysis.context;
        }
        if (!renderer) {
            if (canvas) canvas.remove();
            renderer = (!glBroken && createGLRenderer()) || create2DRenderer();
            if (!renderer) return false;
            canvas = renderer.canvas;
            canvas.style.position = 'absolute';
            canvas.style.pointerEvents = 'none';
            root.appendChild(canvas);
            stats.renderer = renderer.kind;
            geometryKey = '';
        }
        if (!root.isConnected) document.body.appendChild(root);
        return !!rawContext;
    }
    function predictedBounds(rect) {
        if (!video || !(video.videoWidth > 0) || !(video.videoHeight > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
        const videoAspect = video.videoWidth / video.videoHeight;
        const elementAspect = rect.width / rect.height;
        if (Math.abs(videoAspect - elementAspect) <= elementAspect * 0.02) return null;
        if (videoAspect > elementAspect) {
            const bar = (1 - elementAspect / videoAspect) / 2 * sampleHeight;
            if (bar < 1.5 || bar > sampleHeight * 0.45) return null;
            return [0, bar, sampleWidth, sampleHeight - bar * 2];
        }
        const bar = (1 - videoAspect / elementAspect) / 2 * sampleWidth;
        if (bar < 1.5 || bar > sampleWidth * 0.45) return null;
        return [bar, 0, sampleWidth - bar * 2, sampleHeight];
    }
    function effectiveBounds(rect) {
        const predicted = predictedBounds(rect);
        if (!predicted) return bounds;
        const left = Math.max(bounds[0], predicted[0]);
        const top = Math.max(bounds[1], predicted[1]);
        const right = Math.min(bounds[0] + bounds[2], predicted[0] + predicted[2]);
        const bottom = Math.min(bounds[1] + bounds[3], predicted[1] + predicted[3]);
        if (right - left < 8 || bottom - top < 8) return predicted;
        return [left, top, right - left, bottom - top];
    }
    function contentRect(rect, box) {
        return {
            left: rect.left + box[0] / sampleWidth * rect.width,
            top: rect.top + box[1] / sampleHeight * rect.height,
            width: box[2] / sampleWidth * rect.width,
            height: box[3] / sampleHeight * rect.height
        };
    }
    // Encoded letterbox/pillarbox bars to clip off the video element, in px
    // of its box: only once stable (three analyses) and when the remaining
    // picture has a standard aspect ratio - a dark scene must never be cut.
    function barsFor(element) {
        if (barHits < 2) return null;
        const bx = bounds[0], by = bounds[1], bw = bounds[2], bh = bounds[3];
        if (bx < 1 && by < 1) return null;
        const t = by / sampleHeight * element.height, b = (sampleHeight - by - bh) / sampleHeight * element.height;
        const l = bx / sampleWidth * element.width, r = (sampleWidth - bx - bw) / sampleWidth * element.width;
        const aspect = (element.width - l - r) / Math.max(1, element.height - t - b);
        if (!ASPECTS.some(function (a) { return Math.abs(aspect - a) / a < 0.03; })) return null;
        return [t, r, b, l];
    }
    function setBars(insets) {
        const html = document.documentElement;
        if (!html) return;
        const key = insets ? insets.map(function (n) { return n.toFixed(1); }).join(' ') : '';
        if (key === barsApplied) return;
        barsApplied = key;
        html.classList.toggle('lg-bars', !!insets);
        // Whole pixels, rounded up: an anti-aliased clip edge let a hairline
        // of the bar show through.
        if (insets) ['t', 'r', 'b', 'l'].forEach(function (side, i) {
            html.style.setProperty('--lg-bar-' + side, Math.ceil(insets[i] - 0.05) + 'px');
        });
    }
    function repaint() {
        try { renderer.frame(video, crop); renderer.draw(); } catch (_) { /* the next paint() handles it */ }
    }
    function layout() {
        if (!video || !root || !renderer) return false;
        const element = video.getBoundingClientRect();
        if (element.width < 160 || element.height < 90 || element.bottom <= 0 || element.top >= innerHeight || element.right <= 0 || element.left >= innerWidth) return false;
        const player = document.querySelector('#movie_player');
        if (player && (player.classList.contains('ytp-player-minimized') || player.classList.contains('ytp-player-minimized-by-user'))) return false;
        crop = effectiveBounds(element);
        const rect = contentRect(element, crop);
        if (rect.width < 24 || rect.height < 24) return false;
        // Sideways the extension reaches the window edges (the world goes on
        // off-screen); vertically about half a picture.
        const base = Math.min(360, Math.max(80, Math.min(rect.width, rect.height) * 0.5));
        const vertical = Math.min(420, Math.max(80, rect.height * 0.55));
        const reach = [
            Math.min(1000, Math.max(base, rect.left)), vertical,
            Math.min(1000, Math.max(base, innerWidth - rect.left - rect.width)), vertical];
        const pageLeft = rect.left + (window.scrollX || 0), pageTop = rect.top + (window.scrollY || 0);
        const key = [pageLeft, pageTop, rect.width, rect.height].concat(reach)
            .map(function (n) { return n.toFixed(1); }).join(':') + renderer.kind;
        if (key !== geometryKey) {
            geometryKey = key;
            const g = { rect: { width: rect.width, height: rect.height }, reach: reach,
                width: rect.width + reach[0] + reach[2], height: rect.height + reach[1] + reach[3] };
            Object.assign(canvas.style, {
                left: (pageLeft - reach[0]) + 'px', top: (pageTop - reach[1]) + 'px',
                width: g.width + 'px', height: g.height + 'px'
            });
            renderer.resize(g);
            // Resizing clears the canvas; repaint from the current frame at
            // once, or a paused video (no new frames) would lose its light.
            if (lastFrame) repaint();
        }
        setBars(barsFor(element));
        return true;
    }
    function analyze(now) {
        if (readBlocked || now - lastAnalysis < 500) return;
        lastAnalysis = now;
        let pixels;
        try {
            rawContext.drawImage(video, 0, 0, sampleWidth, sampleHeight);
            pixels = rawContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
        } catch (_) { readBlocked = true; return; }
        const maxTop = Math.floor(sampleHeight * 0.45), maxLeft = Math.floor(sampleWidth * 0.45);
        function bright(horizontal, position) {
            const count = horizontal ? sampleWidth : sampleHeight;
            let lit = 0;
            for (let index = 0; index < count; index++) {
                const offset = (horizontal ? position * sampleWidth + index : index * sampleWidth + position) * 4;
                if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 18) lit++;
            }
            // A quarter of the row lit: subtitles inside a letterbox bar are
            // not picture (they made the bars asymmetric, so none were cut).
            return lit > count * 0.25;
        }
        let top = 0, bottom = sampleHeight - 1, left = 0, right = sampleWidth - 1;
        while (top < maxTop && !bright(true, top)) top++;
        while (bottom > sampleHeight - 1 - maxTop && !bright(true, bottom)) bottom--;
        while (left < maxLeft && !bright(false, left)) left++;
        while (right > sampleWidth - 1 - maxLeft && !bright(false, right)) right--;
        const verticalBars = top > 1 && top < maxTop && Math.abs(top - (sampleHeight - 1 - bottom)) <= 3;
        const horizontalBars = left > 1 && left < maxLeft && Math.abs(left - (sampleWidth - 1 - right)) <= 3;
        // One extra row/column inwards: the soft, dark first line of the
        // picture after a bar must not become the edge the light continues.
        bounds = [horizontalBars ? left + 1 : 0, verticalBars ? top + 1 : 0,
            horizontalBars ? right - left - 1 : sampleWidth, verticalBars ? bottom - top - 1 : sampleHeight];
        const steady = stableBounds && bounds.every(function (n, i) { return Math.abs(n - stableBounds[i]) <= 2; });
        barHits = steady ? barHits + 1 : 0;
        stableBounds = bounds.slice();
        let total = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) total += pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        luminance += (total / (sampleWidth * sampleHeight * 255) - luminance) * 0.25;
        // Brightness of the frame's border band drives the auto-gain.
        const bx = bounds[0], by = bounds[1], bw = bounds[2], bh = bounds[3];
        const dx = Math.max(1, bw * depth), dy = Math.max(1, bh * depth);
        let edgeTotal = 0, edgeCount = 0;
        for (let row = Math.floor(by); row < Math.min(sampleHeight, by + bh); row++) {
            for (let col = Math.floor(bx); col < Math.min(sampleWidth, bx + bw); col++) {
                if (col >= bx + dx && col < bx + bw - dx && row >= by + dy && row < by + bh - dy) continue;
                const offset = (row * sampleWidth + col) * 4;
                edgeTotal += pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
                edgeCount++;
            }
        }
        if (edgeCount) edgeLuminance += (edgeTotal / (edgeCount * 255) - edgeLuminance) * 0.3;
        const target = Math.min(1.5, Math.max(0.85, 0.36 / Math.max(0.04, edgeLuminance)));
        gain = Math.round(target * 20) / 20;
    }
    function schedule() {
        if (!eligible() || !video || video.paused || video.ended || failed || callback !== null || fallback !== null) return;
        if (video.requestVideoFrameCallback) {
            callback = video.requestVideoFrameCallback(function () { callback = null; render(false); });
        } else {
            fallback = setTimeout(function () { fallback = null; render(false); }, motion.matches ? 125 : 16);
        }
    }
    function paint(now) {
        try {
            analyze(now);
            renderer.frame(video, crop);
            renderer.draw();
        } catch (_) {
            if (renderer && renderer.kind === 'webgl2') {
                // Frames WebGL can't read (e.g. tainted) still render in 2D.
                glBroken = true;
                renderer = null;
                if (!ensureDom() || !layout()) return false;
                return paint(now);
            }
            failed = true;
            hide();
            return false;
        }
        lastFrame = now; lastMedia = video.currentTime;
        stats.frames++;
        root.style.opacity = video.paused || video.ended ? '0.9' : '1';
        setOn(true);
        return true;
    }
    function render(force) {
        if (!eligible() || !video || video.readyState < 2 || !video.videoWidth || !ensureDom()) { hide(); return; }
        if (source !== video.currentSrc) { source = video.currentSrc; reset(); }
        if (failed) { hide(); return; }
        if (!layout()) { hide(); return; }
        const now = performance.now();
        // Every new video frame is painted; reduced motion caps it at 8 fps.
        if (!force && ((motion.matches && now - lastFrame < 125) || video.currentTime === lastMedia)) { schedule(); return; }
        if (paint(now)) schedule();
    }
    function refresh() {
        cancel();
        const next = document.querySelector('#movie_player video') || document.querySelector('video');
        if (next !== video) { video = next; source = ''; reset(); }
        render(true);
    }
    function showIfPainted() {
        if (!lastFrame) return;
        root.style.opacity = video.paused || video.ended ? '0.9' : '1';
        setOn(true);
    }
    function requestLayout() {
        if (layoutFrame !== null) return;
        layoutFrame = requestAnimationFrame(function () {
            layoutFrame = null;
            if (!eligible() || !video || !renderer) return;
            if (!layout()) hide();
            else showIfPainted();
        });
    }
    ['yt-navigate-finish', 'DOMContentLoaded', 'fullscreenchange', 'visibilitychange'].forEach(function (name) {
        document.addEventListener(name, refresh);
    });
    document.addEventListener('yt-navigate-start', function () { cancel(); hide(); });
    ['play', 'pause', 'seeked', 'loadeddata', 'emptied', 'ended'].forEach(function (name) {
        document.addEventListener(name, function (event) { if (event.target.tagName === 'VIDEO') refresh(); }, true);
    });
    window.addEventListener('resize', requestLayout);
    window.addEventListener('scroll', requestLayout, { capture: true, passive: true });
    window.addEventListener('pagehide', function () { cancel(); hide(); });
    window.addEventListener('pageshow', refresh);
    motion.addEventListener('change', refresh);
    setInterval(function () {
        if (!eligible()) { cancel(); hide(); return; }
        const current = document.querySelector('#movie_player video') || document.querySelector('video');
        if (current !== video || (video && (!root || !root.isConnected || source !== video.currentSrc))) refresh();
        else if (video && renderer) {
            if (!layout()) hide();
            else if (callback === null && fallback === null && !video.paused && !video.ended) render(false);
            else showIfPainted();
        } else hide();
    }, 1000);
    refresh();
})();
