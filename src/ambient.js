(function () {
    'use strict';
    if (window.__lgAmbilight) return;
    window.__lgAmbilight = true;
    const sampleWidth = 96, sampleHeight = 54;
    const width = 256, height = 144;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let root, canvas, context, sample, sampleContext, raw, rawContext;
    let video = null, callback = null, fallback = null;
    let lastFrame = 0, lastMedia = -1, lastAnalysis = 0, source = '';
    let readBlocked = false, failed = false, bounds = [0, 0, sampleWidth, sampleHeight];
    let crop = [0, 0, sampleWidth, sampleHeight];
    let luminance = 0.35, edgeLuminance = 0.35, geometry = '', layoutFrame = null;
    let blurPx = 0, gain = 1, appliedFilter = '';
    // Depth of the frame border the glow is built from (fraction of the
    // content per side). A 4px strip gave thin, noisy colour; a band gives the
    // average colour along each part of the perimeter.
    const band = 0.14;
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
        if (sample) sample.width = sampleWidth;
        if (raw) raw.width = sampleWidth;
    }
    function ensureDom() {
        if (!document.body) return false;
        if (!root) {
            root = document.createElement('div');
            root.id = 'lg-ambilight';
            root.setAttribute('aria-hidden', 'true');
            // Painted BEHIND the page (z-index:-1 in the root stacking
            // context) and positioned in document coordinates. The old fixed
            // overlay above the page needed a video-shaped hole (rectangular,
            // so the player's rounded corners showed dark notches), had to be
            // clipped away from the sidebar, and was repositioned from a
            // scroll handler a frame behind the compositor, so it swam while
            // scrolling. overflow-x:clip keeps the glow from widening the page.
            root.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0;overflow-x:clip;pointer-events:none;z-index:-1;opacity:0;transition:opacity .65s ease;mix-blend-mode:screen;';
            canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.style.cssText = 'position:absolute;pointer-events:none;';
            context = canvas.getContext('2d');
            sample = document.createElement('canvas');
            sample.width = sampleWidth; sample.height = sampleHeight;
            sampleContext = sample.getContext('2d');
            raw = document.createElement('canvas');
            raw.width = sampleWidth; raw.height = sampleHeight;
            rawContext = raw.getContext('2d', { willReadFrequently: true });
            root.appendChild(canvas);
        }
        if (!root.isConnected) document.body.appendChild(root);
        return !!(context && sampleContext && rawContext);
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
        if (!video || !root) return null;
        const element = video.getBoundingClientRect();
        if (element.width < 160 || element.height < 90 || element.bottom <= 0 || element.top >= innerHeight || element.right <= 0 || element.left >= innerWidth) return null;
        const player = document.querySelector('#movie_player');
        if (player && (player.classList.contains('ytp-player-minimized') || player.classList.contains('ytp-player-minimized-by-user'))) return null;
        crop = effectiveBounds(element);
        const rect = contentRect(element, crop);
        if (rect.width < 24 || rect.height < 24) return null;
        const margin = Math.min(230, Math.max(48, Math.min(rect.width, rect.height) * 0.34));
        const canvasWidth = rect.width + margin * 2, canvasHeight = rect.height + margin * 2;
        const pageLeft = rect.left + (window.scrollX || 0), pageTop = rect.top + (window.scrollY || 0);
        // The hole only has to hide blur bleeding under the opaque frame, so
        // it sits inside the content rect (by the player's corner radius):
        // an outward hole left a dark seam and dark rounded corners.
        const radius = player ? parseFloat(getComputedStyle(player).borderTopLeftRadius) || 0 : 0;
        const inset = Math.min(Math.min(rect.width, rect.height) / 4, radius + 2);
        const key = [pageLeft, pageTop, rect.width, rect.height, inset].join(':');
        if (key !== geometry) {
            geometry = key;
            const leftHole = margin + inset, rightHole = margin + rect.width - inset;
            const topHole = margin + inset, bottomHole = margin + rect.height - inset;
            // Outer ring well beyond the box: clipping at 0%/100% cut the
            // blur off in a hard line at the canvas edge.
            canvas.style.clipPath = 'polygon(evenodd,-50% -50%,150% -50%,150% 150%,-50% 150%,-50% -50%,' + leftHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + bottomHole + 'px,' + rightHole + 'px ' + topHole + 'px,' + leftHole + 'px ' + topHole + 'px)';
            // Light fades out with distance from the frame: full strength at
            // the video edge, zero at the canvas edge. Two linear masks
            // intersected, so corners next to the video keep full strength.
            const fade = function (dir) {
                return 'linear-gradient(to ' + dir + ',transparent 0,rgba(0,0,0,.35) ' + (margin * 0.35).toFixed(1) +
                    'px,#000 ' + margin.toFixed(1) + 'px,#000 calc(100% - ' + margin.toFixed(1) + 'px),rgba(0,0,0,.35) calc(100% - ' +
                    (margin * 0.35).toFixed(1) + 'px),transparent 100%)';
            };
            Object.assign(canvas.style, {
                left: (pageLeft - margin) + 'px', top: (pageTop - margin) + 'px',
                width: canvasWidth + 'px', height: canvasHeight + 'px',
                maskImage: fade('right') + ',' + fade('bottom'),
                maskComposite: 'intersect'
            });
            blurPx = Math.min(58, margin * 0.26);
            applyFilter();
        }
        return { edgeX: width * margin / canvasWidth, edgeY: height * margin / canvasHeight };
    }
    // Saturation plus auto-gain towards a target level (black stays black -
    // brightness() only scales). Quantized so the style
    // is not rewritten every frame.
    function applyFilter() {
        const value = 'blur(' + blurPx.toFixed(1) + 'px) saturate(1.25) brightness(' + gain.toFixed(2) + ')';
        if (value !== appliedFilter) { appliedFilter = value; canvas.style.filter = value; }
    }
    function analyze(now) {
        if (readBlocked || now - lastAnalysis < 500) return;
        lastAnalysis = now;
        let pixels;
        try { pixels = rawContext.getImageData(0, 0, sampleWidth, sampleHeight).data; }
        catch (_) { readBlocked = true; return; }
        const maxTop = Math.floor(sampleHeight * 0.45), maxLeft = Math.floor(sampleWidth * 0.45);
        function bright(horizontal, position) {
            const count = horizontal ? sampleWidth : sampleHeight;
            let lit = 0;
            for (let index = 0; index < count; index++) {
                const offset = (horizontal ? position * sampleWidth + index : index * sampleWidth + position) * 4;
                if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 18) lit++;
            }
            return lit > count * 0.08;
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
        const next = total / (sampleWidth * sampleHeight * 255);
        luminance += (next - luminance) * 0.25;
        const bx = bounds[0], by = bounds[1], bw = bounds[2], bh = bounds[3];
        const dx = Math.max(1, bw * band), dy = Math.max(1, bh * band);
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
        // Two-sided: bright (white) frames are toned down too, otherwise the glow
        // washes out the white title/metadata text next to the player.
        // Kept close to 1 so the glow next to the frame matches the frame's
        // own colours; strong gain/saturation turned dark teal edges into a
        // flat bright green.
        const target = Math.min(1.6, Math.max(0.7, 0.32 / Math.max(0.04, edgeLuminance)));
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
    function mirror(sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY) {
        context.setTransform(flipX ? -1 : 1, 0, 0, flipY ? -1 : 1, flipX ? dx + dw : dx, flipY ? dy + dh : dy);
        context.drawImage(sample, sx, sy, sw, sh, 0, 0, dw, dh);
    }
    function glowOpacity() {
        return String((0.74 + Math.sqrt(Math.max(0, luminance)) * 0.22) * (video.paused || video.ended ? 0.85 : 1));
    }
    function render(force) {
        if (!eligible() || !video || video.readyState < 2 || !video.videoWidth || !ensureDom()) { hide(); return; }
        if (source !== video.currentSrc) { source = video.currentSrc; reset(); }
        if (failed) { hide(); return; }
        const metrics = layout();
        if (!metrics) { hide(); return; }
        const now = performance.now();
        if (lastFrame) root.style.opacity = glowOpacity();
        if (!force && (now - lastFrame < (motion.matches ? 125 : 32) || video.currentTime === lastMedia)) { schedule(); return; }
        try {
            rawContext.drawImage(video, 0, 0, sampleWidth, sampleHeight);
            analyze(now);
            sampleContext.globalAlpha = lastFrame ? 1 - Math.exp(-Math.max(1, now - lastFrame) / (motion.matches ? 450 : 140)) : 1;
            sampleContext.drawImage(raw, crop[0], crop[1], crop[2], crop[3], 0, 0, sampleWidth, sampleHeight);
            const edgeX = metrics.edgeX, edgeY = metrics.edgeY;
            const middleWidth = width - 2 * edgeX, middleHeight = height - 2 * edgeY;
            const bandX = Math.max(2, Math.round(sampleWidth * band)), bandY = Math.max(2, Math.round(sampleHeight * band));
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, width, height);
            // The frame itself fills the centre (hidden by the clip hole), so
            // the blur blends into real colour at the video edge instead of
            // fading to transparent - the old empty centre darkened the
            // edge and the corners.
            context.drawImage(sample, 0, 0, sampleWidth, sampleHeight, edgeX, edgeY, middleWidth, middleHeight);
            // Each side and corner: the border band mirrored outwards, so the
            // pixel next to the video is the frame's own edge pixel and every
            // point of the perimeter lights the area right beside it.
            mirror(0, 0, bandX, sampleHeight, 0, edgeY, edgeX, middleHeight, true, false);
            mirror(sampleWidth - bandX, 0, bandX, sampleHeight, width - edgeX, edgeY, edgeX, middleHeight, true, false);
            mirror(0, 0, sampleWidth, bandY, edgeX, 0, middleWidth, edgeY, false, true);
            mirror(0, sampleHeight - bandY, sampleWidth, bandY, edgeX, height - edgeY, middleWidth, edgeY, false, true);
            mirror(0, 0, bandX, bandY, 0, 0, edgeX, edgeY, true, true);
            mirror(sampleWidth - bandX, 0, bandX, bandY, width - edgeX, 0, edgeX, edgeY, true, true);
            mirror(0, sampleHeight - bandY, bandX, bandY, 0, height - edgeY, edgeX, edgeY, true, true);
            mirror(sampleWidth - bandX, sampleHeight - bandY, bandX, bandY, width - edgeX, height - edgeY, edgeX, edgeY, true, true);
            context.setTransform(1, 0, 0, 1, 0, 0);
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
