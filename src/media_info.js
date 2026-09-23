(function () {
    'use strict';
    if (window.__ygMediaInfo) return;
    // What YouTube is actually playing, from the player's own "Stats for
    // nerds" (codecs + itags, colour) and the formats in its player response
    // (channel count, spatial audio). Shown as compact badges in the control
    // bar - HDR10 / HLG / Dolby Vision, 5.1 / 7.1 / Dolby Digital (Plus) /
    // Dolby Atmos / spatial - only when there is something beyond SDR stereo.
    // Decoding and output are Windows' job (HDR display mode, Dolby Access /
    // Windows Sonic spatial sound); this only reports and never changes the
    // stream YouTube picked.
    const VIDEO_DV = /^(dvh1|dvhe|dav1|dva1|dvav)\b/i;
    let lastKey = '', current = { video: null, audio: null }, timer = null, formatsFor = '', formats = [];

    function parseCodecs(text) {
        // "vp09.02.51.10.01.09.16.09.00 (337) / opus (251)"; audio-only or
        // live streams can have a single entry.
        const parts = String(text || '').split('/').map(function (part) {
            const m = /^\s*([^\s(]+)\s*(?:\((\d+)\))?/.exec(part);
            return m ? { codec: m[1], itag: m[2] ? Number(m[2]) : null } : null;
        }).filter(Boolean);
        const isAudio = function (p) { return /^(opus|mp4a|ec-3|ac-3|ac-4|flac|vorbis|iamf)/i.test(p.codec); };
        return { video: parts.find(function (p) { return !isAudio(p); }) || null, audio: parts.find(isAudio) || null };
    }
    function describe(stats, formatList) {
        const out = { video: null, audio: null };
        if (!stats) return out;
        const codecs = parseCodecs(stats.codecs);
        const color = String(stats.color || '').toLowerCase();
        if (codecs.video && VIDEO_DV.test(codecs.video.codec)) out.video = 'Dolby Vision';
        else if (/smpte2084|\bpq\b/.test(color)) out.video = 'HDR10';
        else if (/arib-std-b67|hlg/.test(color)) out.video = 'HLG';
        if (codecs.audio) {
            const fmt = (formatList || []).find(function (f) { return f && f.itag === codecs.audio.itag; }) || {};
            const channels = Number(fmt.audioChannels) || 0;
            const spatial = String(fmt.spatialAudioType || '');
            const codec = codecs.audio.codec.toLowerCase();
            let label = null;
            if (/atmos|joc/i.test(spatial)) label = 'Dolby Atmos';
            else if (/ambisonic/i.test(spatial)) label = 'Пространственный';
            else if (codec.indexOf('ac-4') === 0) label = 'Dolby AC-4';
            else if (codec === 'ec-3') label = 'Dolby Digital Plus';
            else if (codec === 'ac-3') label = 'Dolby Digital';
            else if (channels >= 8) label = '7.1';
            else if (channels >= 6) label = '5.1';
            out.audio = { label: label, channels: channels || 2, codec: codec };
        }
        return out;
    }
    function playerFormats(player) {
        let response = null;
        try { response = player.getPlayerResponse ? player.getPlayerResponse() : null; } catch (_) { response = null; }
        const id = response && response.videoDetails && response.videoDetails.videoId || '';
        if (id && id === formatsFor) return formats;
        formatsFor = id;
        formats = response && response.streamingData && response.streamingData.adaptiveFormats || [];
        return formats;
    }
    function badgeHost() {
        return document.querySelector('#movie_player .ytp-right-controls');
    }
    const CSS =
        '#yg-format-badges{display:none;align-items:center;gap:4px;height:100%;margin:0 6px 0 2px;}' +
        '#yg-format-badges.yg-has-badges{display:inline-flex;}' +
        '.yg-format-badge{font:700 10.5px/1 "Roboto","Segoe UI",sans-serif;letter-spacing:.3px;color:#fff;' +
            'padding:4px 6px;border-radius:5px;background:rgba(255,255,255,.16);white-space:nowrap;' +
            'box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);animation:yg-badge-in .35s cubic-bezier(.22,1,.36,1) both;}' +
        '.yg-format-video{background:linear-gradient(135deg,rgba(255,196,86,.34),rgba(255,120,64,.26));}' +
        '@keyframes yg-badge-in{from{opacity:0;transform:translateY(3px) scale(.92);}to{opacity:1;transform:none;}}' +
        '@media (prefers-reduced-motion: reduce){.yg-format-badge{animation:none;}}';
    function ensureStyle() {
        if (document.getElementById('yg-format-style')) return;
        const target = document.head || document.documentElement;
        if (!target) return;
        const style = document.createElement('style');
        style.id = 'yg-format-style';
        style.textContent = CSS;
        target.appendChild(style);
    }
    function render(info) {
        ensureStyle();
        const labels = [];
        if (info.video) labels.push({ text: info.video, kind: 'video' });
        if (info.audio && info.audio.label) labels.push({ text: info.audio.label, kind: 'audio' });
        const key = labels.map(function (l) { return l.text; }).join('|');
        const host = badgeHost();
        let box = document.getElementById('yg-format-badges');
        if (!host) return;
        if (!box) {
            box = document.createElement('div');
            box.id = 'yg-format-badges';
            box.setAttribute('role', 'status');
        }
        if (box.parentNode !== host) host.insertBefore(box, host.firstChild);
        if (key === lastKey) return;
        lastKey = key;
        box.replaceChildren();
        labels.forEach(function (l) {
            const pill = document.createElement('span');
            pill.className = 'yg-format-badge yg-format-' + l.kind;
            pill.textContent = l.text;
            box.appendChild(pill);
        });
        box.classList.toggle('yg-has-badges', labels.length > 0);
        box.setAttribute('aria-label', labels.length ? 'Формат: ' + key.replace(/\|/g, ', ') : '');
    }
    function update() {
        const player = document.getElementById('movie_player');
        if (!player || typeof player.getStatsForNerds !== 'function' || !/^\/watch/.test(location.pathname)) return;
        let stats = null;
        try { stats = player.getStatsForNerds(); } catch (_) { stats = null; }
        current = describe(stats, playerFormats(player));
        render(current);
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(update, 400);
    }
    ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (name) { document.addEventListener(name, schedule); });
    ['playing', 'loadedmetadata', 'resize'].forEach(function (name) {
        document.addEventListener(name, function (event) { if (event.target && event.target.tagName === 'VIDEO') schedule(); }, true);
    });
    // Adaptive streaming can switch formats mid-video (e.g. to HDR once the
    // bandwidth estimate settles).
    setInterval(function () { if (!document.hidden) update(); }, 3000);
    window.__ygMediaInfo = { describe: describe, parseCodecs: parseCodecs, current: function () { return current; } };
})();
