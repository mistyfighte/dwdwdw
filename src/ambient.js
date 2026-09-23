(function () {
    'use strict';
    if (window.__lgAmbilight) return;
    const stats = window.__lgAmbilight = { frames: 0 };
    // How it works (the approach of Philips Ambilight and YouTube's own
    // ambient mode): the light around the player is the video's colour
    // carried past its edges. On every video frame (up to 60 fps):
    //   1. the visible picture (black bars cropped) is drawn into `frame`;
    //   2. each side is reduced to strips of zone colours - `zonesX` points
    //      along the top/bottom, `zonesY` along the left/right - twice: the
    //      edge band (`depth`) and a deeper band (`deepDepth`) that gathers
    //      the colours further inside the picture;
    //   3. the zone canvas gets the frame in the middle (under the player),
    //      the deep colours across each margin and the edge colours right
    //      beside the picture, so every point lights the area next to it;
    //   4. blur, colour and the outward fade are applied inside a small
    //      output canvas, so the page composites a plain image (no CSS
    //      filter or mask to re-run on every frame).
    // Black-bar detection and brightness run on a small read-back copy
    // (`raw`) twice a second; the drawing path needs no pixel reads.
    const sampleWidth = 96, sampleHeight = 54;
    const zonesX = 96, zonesY = 54;
    const frameWidth = zonesX * 2, frameHeight = zonesY * 2;
    const depth = 0.06, deepDepth = 0.24;
    // Output canvas budget (pixels); the page scales it up.
    const outputPixels = 120000;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let root, canvas, context, frame, frameContext, raw, rawContext, strips, deepStrips;
    let zones, zonesContext, mask, maskContext;
    let video = null, callback = null, fallback = null;
    let lastFrame = 0, lastMedia = -1, lastAnalysis = 0, source = '';
    let readBlocked = false, failed = false, bounds = [0, 0, sampleWidth, sampleHeight];
    let crop = [0, 0, sampleWidth, sampleHeight];
    let luminance = 0.35, edgeLuminance = 0.35, geometry = '', layoutFrame = null;
    let blurPx = 0, gain = 1, appliedFilter = 'none', marginX = 8, marginY = 8;
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
            const output = makeCanvas(64, 36);
            canvas = output.canvas; context = output.context;
            canvas.style.cssText = 'position:absolute;pointer-events:none;';
            const zoneCanvas = makeCanvas(zonesX + 16, zonesY + 16);
            zones = zoneCanvas.canvas; zonesContext = zoneCanvas.context;
            const fadeMask = makeCanvas(64, 36);
            mask = fadeMask.canvas; maskContext = fadeMask.context;
            const picture = makeCanvas(frameWidth, frameHeight);
            frame = picture.canvas; frameContext = picture.context;
            const analysis = makeCanvas(sampleWidth, sampleHeight, { willReadFrequently: true });
            raw = analysis.canvas; rawContext = analysis.context;
            const stripSet = function () {
                return {
                    left: makeCanvas(1, zonesY), right: makeCanvas(1, zonesY),
                    top: makeCanvas(zonesX, 1), bottom: makeCanvas(zonesX, 1)
                };
            };
            strips = stripSet();
            deepStrips = stripSet();
            root.appendChild(canvas);
        }
        if (!root.isConnected) document.body.appendChild(root);
        return !!(context && zonesContext && maskContext && frameContext && rawContext &&
            [strips, deepStrips].every(function (set) {
                return set.left.context && set.right.context && set.top.context && set.bottom.context;
            }));
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
            // Zone canvas: one pixel per zone along the edges, margins in the
            // same scale, so zone i lights exactly the area beside point i.
            marginX = Math.max(2, Math.round(zonesX * mX / rect.width));
            marginY = Math.max(2, Math.round(zonesY * mY / rect.height));
            zones.width = zonesX + marginX * 2;
            zones.height = zonesY + marginY * 2;
            // Output canvas: a fraction of the CSS size (the light is soft,
            // upscaling costs nothing), with the fade baked into `mask`.
            const scale = Math.min(0.25, Math.sqrt(outputPixels / (canvasWidth * canvasHeight)));
            canvas.width = Math.max(16, Math.round(canvasWidth * scale));
            canvas.height = Math.max(16, Math.round(canvasHeight * scale));
            buildMask(canvas.width, canvas.height, mX * canvas.width / canvasWidth, mY * canvas.height / canvasHeight);
            // Enough to melt neighbouring zones together, not so much that
            // every side turns into one average colour.
            blurPx = Math.min(34, Math.max(8, Math.min(mX, mY) * 0.15)) * canvas.width / canvasWidth;
            applyFilter();
            // Resizing clears the canvases; repaint from the last frame at
            // once, or a paused video (no new frames) would lose its light.
            if (lastFrame) drawGlow();
            const leftHole = mX + inset, rightHole = mX + rect.width - inset;
            const topHole = mY + inset, bottomHole = mY + rect.height - inset;
            // Outer ring well beyond the box: clipping at 0%/100% cut the
            // blur off in a hard line at the canvas edge.
            canvas.style.clipPath = 'polygon(evenodd,-50% -50%,150% -50%,150% 150%,-50% 150%,-50% -50%,' + leftHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + topHole + 'px)';
            Object.assign(canvas.style, {
                left: (pageLeft - mX) + 'px', top: (pageTop - mY) + 'px',
                width: canvasWidth + 'px', height: canvasHeight + 'px'
            });
        }
        return true;
    }
    // The light keeps full strength next to the player and fades out over
    // the outer part of the spread. Linear fades only (a radial mask darkened
    // the corners); intersected, so the corners fade diagonally.
    const fadeStops = [[0, 0], [0.2, 0.14], [0.42, 0.5], [0.66, 0.86], [0.85, 0.98], [1, 1]];
    function buildMask(w, h, mx, my) {
        mask.width = w; mask.height = h;
        const m = maskContext;
        function gradient(horizontal, span, total) {
            const g = horizontal ? m.createLinearGradient(0, 0, total, 0) : m.createLinearGradient(0, 0, 0, total);
            const edge = Math.min(0.5, span / total);
            fadeStops.forEach(function (s) { g.addColorStop(s[0] * edge, 'rgba(0,0,0,' + s[1] + ')'); });
            fadeStops.slice().reverse().forEach(function (s) { g.addColorStop(1 - s[0] * edge, 'rgba(0,0,0,' + s[1] + ')'); });
            return g;
        }
        m.globalCompositeOperation = 'source-over';
        m.clearRect(0, 0, w, h);
        m.fillStyle = gradient(true, mx, w);
        m.fillRect(0, 0, w, h);
        m.globalCompositeOperation = 'destination-in';
        m.fillStyle = gradient(false, my, h);
        m.fillRect(0, 0, w, h);
        m.globalCompositeOperation = 'source-over';
    }
    // Blur plus gentle saturation and auto-gain towards a target level
    // (black stays black - brightness() only scales), applied while drawing
    // into the output canvas.
    function applyFilter() {
        appliedFilter = 'blur(' + blurPx.toFixed(2) + 'px) saturate(1.25) brightness(' + gain.toFixed(2) + ')';
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
            fallback = setTimeout(function () { fallback = null; render(false); }, motion.matches ? 125 : 16);
        }
    }
    function glowOpacity() {
        return String(Math.min(1, 0.86 + Math.sqrt(Math.max(0, luminance)) * 0.14) * (video.paused || video.ended ? 0.85 : 1));
    }
    function reduce(set, bandX, bandY) {
        set.left.context.drawImage(frame, 0, 0, bandX, frameHeight, 0, 0, 1, zonesY);
        set.right.context.drawImage(frame, frameWidth - bandX, 0, bandX, frameHeight, 0, 0, 1, zonesY);
        set.top.context.drawImage(frame, 0, 0, frameWidth, bandY, 0, 0, zonesX, 1);
        set.bottom.context.drawImage(frame, 0, frameHeight - bandY, frameWidth, bandY, 0, 0, zonesX, 1);
    }
    // Strips out from the four sides of the picture, `ix`/`iy` deep, plus the
    // corners (the two neighbouring end zones mixed half and half).
    function extend(set, ix, iy) {
        const c = zonesContext, mx = marginX, my = marginY, right = mx + zonesX, bottom = my + zonesY;
        c.globalAlpha = 1;
        c.drawImage(set.left.canvas, 0, 0, 1, zonesY, mx - ix, my, ix, zonesY);
        c.drawImage(set.right.canvas, 0, 0, 1, zonesY, right, my, ix, zonesY);
        c.drawImage(set.top.canvas, 0, 0, zonesX, 1, mx, my - iy, zonesX, iy);
        c.drawImage(set.bottom.canvas, 0, 0, zonesX, 1, mx, bottom, zonesX, iy);
        [[set.left, 0, set.top, 0, mx - ix, my - iy], [set.right, 0, set.top, zonesX - 1, right, my - iy],
            [set.left, zonesY - 1, set.bottom, 0, mx - ix, bottom], [set.right, zonesY - 1, set.bottom, zonesX - 1, right, bottom]
        ].forEach(function (corner) {
            c.globalAlpha = 1;
            c.drawImage(corner[0].canvas, 0, corner[1], 1, 1, corner[4], corner[5], ix, iy);
            c.globalAlpha = 0.5;
            c.drawImage(corner[2].canvas, corner[3], 0, 1, 1, corner[4], corner[5], ix, iy);
        });
        c.globalAlpha = 1;
    }
    function drawGlow() {
        // 2. Zone strips: the edge band and the deeper band of each side,
        //    averaged into one colour per point.
        reduce(strips, Math.max(2, Math.round(frameWidth * depth)), Math.max(2, Math.round(frameHeight * depth)));
        reduce(deepStrips, Math.max(2, Math.round(frameWidth * deepDepth)), Math.max(2, Math.round(frameHeight * deepDepth)));
        // 3. Zones: the picture under the player, the deeper colours across
        //    the whole spread, the edge colours over its inner half.
        zonesContext.globalAlpha = 1;
        zonesContext.clearRect(0, 0, zones.width, zones.height);
        zonesContext.drawImage(frame, 0, 0, frameWidth, frameHeight, marginX, marginY, zonesX, zonesY);
        extend(deepStrips, marginX, marginY);
        extend(strips, Math.max(1, Math.round(marginX * 0.5)), Math.max(1, Math.round(marginY * 0.5)));
        // 4. Output: blur and colour while scaling up, then the fade.
        context.globalCompositeOperation = 'source-over';
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.filter = appliedFilter;
        context.drawImage(zones, 0, 0, zones.width, zones.height, 0, 0, canvas.width, canvas.height);
        context.filter = 'none';
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(mask, 0, 0);
        context.globalCompositeOperation = 'source-over';
    }
    function render(force) {
        if (!eligible() || !video || video.readyState < 2 || !video.videoWidth || !ensureDom()) { hide(); return; }
        if (source !== video.currentSrc) { source = video.currentSrc; reset(); }
        if (failed) { hide(); return; }
        if (!layout()) { hide(); return; }
        const now = performance.now();
        if (lastFrame) root.style.opacity = glowOpacity();
        // Every new video frame is painted (up to the video's own 60 fps);
        // reduced motion caps it at 8 fps.
        if (!force && ((motion.matches && now - lastFrame < 125) || video.currentTime === lastMedia)) { schedule(); return; }
        try {
            analyze(now);
            // 1. Visible picture, blended over the previous one: a short,
            //    time-based settle (~50 ms) that removes flicker but keeps
            //    up with cuts and flashes.
            const vw = video.videoWidth, vh = video.videoHeight;
            frameContext.globalAlpha = lastFrame ? 1 - Math.exp(-Math.max(1, now - lastFrame) / (motion.matches ? 450 : 50)) : 1;
            frameContext.drawImage(video, crop[0] / sampleWidth * vw, crop[1] / sampleHeight * vh,
                crop[2] / sampleWidth * vw, crop[3] / sampleHeight * vh, 0, 0, frameWidth, frameHeight);
            drawGlow();
            stats.frames++;
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
