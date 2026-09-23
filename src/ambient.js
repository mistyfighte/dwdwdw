(function () {
    'use strict';
    if (window.__lgAmbilight) return;
    window.__lgAmbilight = true;
    // How it works (the approach of Philips Ambilight and YouTube's own
    // ambient mode): the light around the player is the video itself carried
    // past its edges. Every frame:
    //   1. the visible picture (black bars cropped) is drawn into `frame`;
    //   2. each side is reduced to a strip of zone colours - `zonesX` points
    //      along the top/bottom, `zonesY` along the left/right - each the
    //      average of a band `depth` deep at that part of the edge;
    //   3. the glow canvas gets the frame in the middle (under the player)
    //      and every zone colour extended straight outwards from its point,
    //      so the light next to any part of the edge is that part's colour;
    //   4. CSS blur, an outward fade and auto-gain turn that into soft light.
    // Black-bar detection and brightness run on a small read-back copy
    // (`raw`) twice a second; the drawing path needs no pixel reads.
    const sampleWidth = 96, sampleHeight = 54;
    const zonesX = 64, zonesY = 36;
    const frameWidth = zonesX * 2, frameHeight = zonesY * 2;
    const depth = 0.1;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let root, canvas, context, frame, frameContext, raw, rawContext, strips;
    let video = null, callback = null, fallback = null;
    let lastFrame = 0, lastMedia = -1, lastAnalysis = 0, source = '';
    let readBlocked = false, failed = false, bounds = [0, 0, sampleWidth, sampleHeight];
    let crop = [0, 0, sampleWidth, sampleHeight];
    let luminance = 0.35, edgeLuminance = 0.35, geometry = '', layoutFrame = null;
    let blurPx = 0, gain = 1, appliedFilter = '', marginX = 8, marginY = 8;
    // Spread of the light around the picture (CSS px).
    function baseMargin(w, h) { return Math.min(320, Math.max(60, Math.min(w, h) * 0.4)); }
    function eligible() {
        return location.pathname === '/watch' && !document.hidden && !document.fullscreenElement;
    }
    function hide() { if (root) root.style.opacity = '0'; }
    function cancel() {
        if (callback !== null && video && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
        callback = null;
        if (fallback !== null) clearTimeout(fallback);
        fallback = null;
    }
    function reset() {
        lastFrame = 0; lastMedia = -1; lastAnalysis = 0; readBlocked = false; failed = false;
        luminance = 0.35; edgeLuminance = 0.35; gain = 1; bounds = [0, 0, sampleWidth, sampleHeight]; crop = bounds.slice();
    }
    function makeCanvas(w, h, options) {
        const element = document.createElement('canvas');
        element.width = w; element.height = h;
        const ctx = element.getContext('2d', options);
        // Downscaling into zones must average, not pick single pixels.
        if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
        return { canvas: element, context: ctx };
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
            root.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0;overflow-x:clip;pointer-events:none;z-index:-1;opacity:0;transition:opacity .65s ease;mix-blend-mode:screen;';
            const glow = makeCanvas(zonesX + 16, zonesY + 16);
            canvas = glow.canvas; context = glow.context;
            canvas.style.cssText = 'position:absolute;pointer-events:none;';
            const picture = makeCanvas(frameWidth, frameHeight);
            frame = picture.canvas; frameContext = picture.context;
            const analysis = makeCanvas(sampleWidth, sampleHeight, { willReadFrequently: true });
            raw = analysis.canvas; rawContext = analysis.context;
            strips = {
                left: makeCanvas(1, zonesY), right: makeCanvas(1, zonesY),
                top: makeCanvas(zonesX, 1), bottom: makeCanvas(zonesX, 1)
            };
            root.appendChild(canvas);
        }
        if (!root.isConnected) document.body.appendChild(root);
        return !!(context && frameContext && rawContext && strips.left.context && strips.right.context &&
            strips.top.context && strips.bottom.context);
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
    function layout() {
        if (!video || !root) return false;
        const element = video.getBoundingClientRect();
        if (element.width < 160 || element.height < 90 || element.bottom <= 0 || element.top >= innerHeight || element.right <= 0 || element.left >= innerWidth) return false;
        const player = document.querySelector('#movie_player');
        if (player && (player.classList.contains('ytp-player-minimized') || player.classList.contains('ytp-player-minimized-by-user'))) return false;
        crop = effectiveBounds(element);
        const rect = contentRect(element, crop);
        if (rect.width < 24 || rect.height < 24) return false;
        const margin = baseMargin(rect.width, rect.height);
        // Sideways the light reaches the window edges when the player has
        // free space on both sides (theater mode), instead of stopping short
        // and leaving dark strips at the edges.
        const sideGap = Math.min(rect.left, innerWidth - (rect.left + rect.width));
        const mX = Math.min(480, Math.max(margin, sideGap)), mY = margin;
        const canvasWidth = rect.width + mX * 2, canvasHeight = rect.height + mY * 2;
        const pageLeft = rect.left + (window.scrollX || 0), pageTop = rect.top + (window.scrollY || 0);
        // The hole only has to hide blur bleeding under the opaque frame, so
        // it sits inside the content rect (by the player's corner radius):
        // an outward hole left a dark seam and dark rounded corners.
        const radius = player ? parseFloat(getComputedStyle(player).borderTopLeftRadius) || 0 : 0;
        const inset = Math.min(Math.min(rect.width, rect.height) / 4, radius + 2);
        const key = [pageLeft, pageTop, rect.width, rect.height, inset, mX].join(':');
        if (key !== geometry) {
            geometry = key;
            // Glow canvas: one pixel per zone along the edges, margins in the
            // same scale, so zone i lights exactly the area beside point i.
            const nextX = Math.max(2, Math.round(zonesX * mX / rect.width));
            const nextY = Math.max(2, Math.round(zonesY * mY / rect.height));
            if (nextX !== marginX || nextY !== marginY || canvas.width !== zonesX + nextX * 2 || canvas.height !== zonesY + nextY * 2) {
                marginX = nextX; marginY = nextY;
                // Resizing clears the canvas; repaint from the last frame at
                // once, or a paused video (no new frames) would lose its light.
                canvas.width = zonesX + marginX * 2;
                canvas.height = zonesY + marginY * 2;
                if (lastFrame) drawGlow();
            }
            const leftHole = mX + inset, rightHole = mX + rect.width - inset;
            const topHole = mY + inset, bottomHole = mY + rect.height - inset;
            // Outer ring well beyond the box: clipping at 0%/100% cut the
            // blur off in a hard line at the canvas edge.
            canvas.style.clipPath = 'polygon(evenodd,-50% -50%,150% -50%,150% 150%,-50% 150%,-50% -50%,' + leftHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + topHole + 'px)';
            // The picture continues at full strength next to the player and
            // fades out over the outer part of the spread (a narrow halo read
            // as a grey outline, not as the video carried on). Linear masks
            // only (a radial mask darkened the corners); intersected, so the
            // corners fade diagonally.
            const stops = [[0, 0], [0.2, 0.14], [0.42, 0.5], [0.66, 0.86], [0.85, 0.98], [1, 1]];
            const fade = function (dir, m) {
                const near = stops.map(function (s) { return 'rgba(0,0,0,' + s[1] + ') ' + (m * s[0]).toFixed(1) + 'px'; });
                const far = stops.slice().reverse().map(function (s) { return 'rgba(0,0,0,' + s[1] + ') calc(100% - ' + (m * s[0]).toFixed(1) + 'px)'; });
                return 'linear-gradient(to ' + dir + ',transparent 0,' + near.slice(1).join(',') + ',' + far.slice(0, -1).join(',') + ',transparent 100%)';
            };
            Object.assign(canvas.style, {
                left: (pageLeft - mX) + 'px', top: (pageTop - mY) + 'px',
                width: canvasWidth + 'px', height: canvasHeight + 'px',
                maskImage: fade('right', mX) + ',' + fade('bottom', mY),
                maskComposite: 'intersect'
            });
            // Enough to melt neighbouring zones together, not so much that
            // every side turns into one average colour.
            blurPx = Math.min(34, Math.max(8, Math.min(mX, mY) * 0.15));
            applyFilter();
        }
        return true;
    }
    // Gentle saturation plus auto-gain towards a target level (black stays
    // black - brightness() only scales). Quantized so the style is not
    // rewritten every frame.
    function applyFilter() {
        const value = 'blur(' + blurPx.toFixed(1) + 'px) saturate(1.2) brightness(' + gain.toFixed(2) + ')';
        if (value !== appliedFilter) { appliedFilter = value; canvas.style.filter = value; }
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
        const verticalBars = top > 0 && top < maxTop && Math.abs(top - (sampleHeight - 1 - bottom)) <= 2;
        const horizontalBars = left > 0 && left < maxLeft && Math.abs(left - (sampleWidth - 1 - right)) <= 2;
        bounds = [horizontalBars ? left : 0, verticalBars ? top : 0,
            horizontalBars ? right - left + 1 : sampleWidth, verticalBars ? bottom - top + 1 : sampleHeight];
        let total = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) total += pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        luminance += (total / (sampleWidth * sampleHeight * 255) - luminance) * 0.25;
        // Brightness of the same edge bands the zones are built from.
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
        // Close to 1 so the light keeps the edge's own colour: dim edges are
        // lifted a little, white ones toned down slightly (text next to the
        // player stays readable on its dark cards).
        const target = Math.min(1.5, Math.max(0.85, 0.36 / Math.max(0.04, edgeLuminance)));
        gain = Math.round(target * 20) / 20;
        applyFilter();
    }
    function schedule() {
        if (!eligible() || !video || video.paused || video.ended || failed || callback !== null || fallback !== null) return;
        if (video.requestVideoFrameCallback) {
            callback = video.requestVideoFrameCallback(function () { callback = null; render(false); });
        } else {
            fallback = setTimeout(function () { fallback = null; render(false); }, motion.matches ? 125 : 34);
        }
    }
    function glowOpacity() {
        return String(Math.min(1, 0.86 + Math.sqrt(Math.max(0, luminance)) * 0.14) * (video.paused || video.ended ? 0.85 : 1));
    }
    function drawGlow() {
        // 2. Zone strips: each side's band averaged into one colour per point.
        const bandX = Math.max(2, Math.round(frameWidth * depth)), bandY = Math.max(2, Math.round(frameHeight * depth));
        strips.left.context.drawImage(frame, 0, 0, bandX, frameHeight, 0, 0, 1, zonesY);
        strips.right.context.drawImage(frame, frameWidth - bandX, 0, bandX, frameHeight, 0, 0, 1, zonesY);
        strips.top.context.drawImage(frame, 0, 0, frameWidth, bandY, 0, 0, zonesX, 1);
        strips.bottom.context.drawImage(frame, 0, frameHeight - bandY, frameWidth, bandY, 0, 0, zonesX, 1);
        // 3. Glow: the picture under the player, zone colours carried outwards.
        const mx = marginX, my = marginY, right = mx + zonesX, bottom = my + zonesY;
        context.globalAlpha = 1;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(frame, 0, 0, frameWidth, frameHeight, mx, my, zonesX, zonesY);
        context.drawImage(strips.left.canvas, 0, 0, 1, zonesY, 0, my, mx, zonesY);
        context.drawImage(strips.right.canvas, 0, 0, 1, zonesY, right, my, mx, zonesY);
        context.drawImage(strips.top.canvas, 0, 0, zonesX, 1, mx, 0, zonesX, my);
        context.drawImage(strips.bottom.canvas, 0, 0, zonesX, 1, mx, bottom, zonesX, my);
        // Corners: the two neighbouring end zones mixed half and half.
        [[strips.left, 0, strips.top, 0, 0, 0], [strips.right, 0, strips.top, zonesX - 1, right, 0],
            [strips.left, zonesY - 1, strips.bottom, 0, 0, bottom], [strips.right, zonesY - 1, strips.bottom, zonesX - 1, right, bottom]
        ].forEach(function (corner) {
            context.globalAlpha = 1;
            context.drawImage(corner[0].canvas, 0, corner[1], 1, 1, corner[4], corner[5], mx, my);
            context.globalAlpha = 0.5;
            context.drawImage(corner[2].canvas, corner[3], 0, 1, 1, corner[4], corner[5], mx, my);
        });
        context.globalAlpha = 1;
    }
    function render(force) {
        if (!eligible() || !video || video.readyState < 2 || !video.videoWidth || !ensureDom()) { hide(); return; }
        if (source !== video.currentSrc) { source = video.currentSrc; reset(); }
        if (failed) { hide(); return; }
        if (!layout()) { hide(); return; }
        const now = performance.now();
        if (lastFrame) root.style.opacity = glowOpacity();
        if (!force && (now - lastFrame < (motion.matches ? 125 : 32) || video.currentTime === lastMedia)) { schedule(); return; }
        try {
            analyze(now);
            // 1. Visible picture, blended over the previous one so the light
            //    changes smoothly (time-based, not frame-rate based).
            const vw = video.videoWidth, vh = video.videoHeight;
            frameContext.globalAlpha = lastFrame ? 1 - Math.exp(-Math.max(1, now - lastFrame) / (motion.matches ? 450 : 140)) : 1;
            frameContext.drawImage(video, crop[0] / sampleWidth * vw, crop[1] / sampleHeight * vh,
                crop[2] / sampleWidth * vw, crop[3] / sampleHeight * vh, 0, 0, frameWidth, frameHeight);
            drawGlow();
            lastFrame = now; lastMedia = video.currentTime;
            root.style.opacity = glowOpacity();
        } catch (_) { failed = true; hide(); return; }
        schedule();
    }
    function refresh() {
        cancel();
        const next = document.querySelector('#movie_player video') || document.querySelector('video');
        if (next !== video) { video = next; source = ''; reset(); }
        render(true);
    }
    function requestLayout() {
        if (layoutFrame !== null) return;
        layoutFrame = requestAnimationFrame(function () { layoutFrame = null; render(false); });
    }
    ['yt-navigate-finish','DOMContentLoaded','fullscreenchange','visibilitychange'].forEach(function (name) {
        document.addEventListener(name, refresh);
    });
    document.addEventListener('yt-navigate-start', function () { cancel(); hide(); });
    ['play','pause','seeked','loadeddata','emptied','ended'].forEach(function (name) {
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
        else if (video) {
            if (!layout()) hide();
            else if (callback === null && fallback === null && !video.paused && !video.ended) render(false);
        } else hide();
    }, 1000);
    refresh();
})();
