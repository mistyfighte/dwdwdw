(function () {
    'use strict';
    // Launch screen: covers the page from the first moment of the document
    // until YouTube has actually drawn its app (feed, watch page or search),
    // then fades away. Plain DOM with inline styles so it needs nothing from
    // the page and appears before YouTube's own CSS loads. Full page loads
    // only (app start, reload); in-app navigation never shows it.
    if (window.__ygSplash) return;
    window.__ygSplash = true;
    const MAX_MS = 12000;
    const started = performance.now();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Long enough for the intro to finish; the shine loop covers the rest.
    const MIN_MS = reduced ? 200 : 1150;
    let overlay = null, done = false;

    const SVG = 'http://www.w3.org/2000/svg';
    const SHAPE = 'M66.5 7.7c-.8-2.9-3-5.2-6-6C55.3.3 34 .3 34 .3S12.7.3 7.5 1.7c-3 .8-5.2 3.1-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3c.8 2.9 3 5.2 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4c3-.8 5.2-3.1 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z';
    // Logo animation, ~1.1 s: the outline draws itself, the red body fills
    // in with a slight overshoot, the play triangle pops in, a ring ripples
    // out. While waiting: a light sweep across the logo and a slow breathing
    // glow. Exit: the logo grows a little as the screen fades.
    const CSS =
        '#yg-splash{--e:cubic-bezier(.22,1,.36,1);--o:cubic-bezier(.34,1.56,.64,1)}' +
        '#yg-splash .mark{position:relative;width:112px;height:79px;transition:transform .45s var(--e);' +
            'animation:yg-breathe 2.6s ease-in-out 1.2s infinite}' +
        '#yg-splash.out .mark{transform:scale(1.14)}' +
        '#yg-splash svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
        '#yg-splash svg *{transform-box:fill-box;transform-origin:center}' +
        '#yg-splash .outline{fill:none;stroke:#ff2d4a;stroke-width:1.4;stroke-linejoin:round;' +
            'stroke-dasharray:1;stroke-dashoffset:1;animation:yg-draw .7s var(--e) forwards,yg-fade .3s ease .75s forwards}' +
        '#yg-splash .body{fill:#ff0033;opacity:0;animation:yg-fill .55s var(--o) .4s forwards}' +
        '#yg-splash .play{fill:#fff;opacity:0;animation:yg-play .5s var(--o) .72s forwards}' +
        '#yg-splash .ring{fill:none;stroke:#ff3355;stroke-width:1;opacity:0;animation:yg-ring .9s var(--e) .9s forwards}' +
        '#yg-splash .shine{opacity:0;animation:yg-shine 2.6s var(--e) 1.3s infinite}' +
        '@keyframes yg-draw{to{stroke-dashoffset:0}}' +
        '@keyframes yg-fade{to{opacity:0}}' +
        '@keyframes yg-fill{0%{opacity:0;transform:scale(.86)}60%{opacity:1}100%{opacity:1;transform:scale(1)}}' +
        '@keyframes yg-play{0%{opacity:0;transform:scale(0) rotate(-25deg)}100%{opacity:1;transform:none}}' +
        '@keyframes yg-ring{0%{opacity:.55;transform:scale(1)}100%{opacity:0;transform:scale(1.55)}}' +
        '@keyframes yg-shine{0%{opacity:0;transform:translateX(-120%) skewX(-18deg)}12%{opacity:1}' +
            '45%{opacity:1;transform:translateX(220%) skewX(-18deg)}46%,100%{opacity:0;transform:translateX(220%) skewX(-18deg)}}' +
        '@keyframes yg-breathe{0%,100%{filter:drop-shadow(0 4px 14px rgba(255,0,51,.18))}' +
            '50%{filter:drop-shadow(0 8px 34px rgba(255,0,51,.45))}}' +
        '@keyframes yg-bg{0%,100%{opacity:.55}50%{opacity:1}}' +
        '#yg-splash .halo{position:absolute;inset:0;pointer-events:none;' +
            'background:radial-gradient(520px 320px at 50% 50%,rgba(255,20,50,.13),transparent 70%);' +
            'animation:yg-bg 2.6s ease-in-out infinite}' +
        '@media (prefers-reduced-motion: reduce){#yg-splash *{animation:none!important;transition:none!important}' +
            '#yg-splash .body,#yg-splash .play{opacity:1}#yg-splash .outline,#yg-splash .ring,#yg-splash .shine{display:none}}';
    function node(tag, attrs) {
        const el = document.createElementNS(SVG, tag);
        Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
        return el;
    }
    function build() {
        const el = document.createElement('div');
        el.id = 'yg-splash';
        el.setAttribute('role', 'progressbar');
        el.setAttribute('aria-label', 'Загрузка YouTube');
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;' +
            'align-items:center;justify-content:center;background:#0b0b0b;' +
            'transition:opacity .45s cubic-bezier(.22,1,.36,1);user-select:none;';
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);
        const halo = document.createElement('div');
        halo.className = 'halo';
        el.appendChild(halo);
        const mark = document.createElement('div');
        mark.className = 'mark';
        const svg = node('svg', { viewBox: '0 0 68 48', 'aria-hidden': 'true' });
        const defs = node('defs', {});
        const clip = node('clipPath', { id: 'yg-splash-clip' });
        clip.appendChild(node('path', { d: SHAPE }));
        const grad = node('linearGradient', { id: 'yg-splash-shine', x1: '0', x2: '1', y1: '0', y2: '0' });
        [['0', 0], ['0.5', 0.55], ['1', 0]].forEach(function (stop) {
            grad.appendChild(node('stop', { offset: stop[0], 'stop-color': '#fff', 'stop-opacity': String(stop[1]) }));
        });
        defs.appendChild(clip); defs.appendChild(grad);
        svg.appendChild(defs);
        svg.appendChild(node('path', { class: 'ring', d: SHAPE }));
        svg.appendChild(node('path', { class: 'body', d: SHAPE }));
        const shineGroup = node('g', { 'clip-path': 'url(#yg-splash-clip)' });
        shineGroup.appendChild(node('rect', { class: 'shine', x: '0', y: '-4', width: '26', height: '56', fill: 'url(#yg-splash-shine)' }));
        svg.appendChild(shineGroup);
        svg.appendChild(node('path', { class: 'play', d: 'M45 24 27 14v20z' }));
        svg.appendChild(node('path', { class: 'outline', d: SHAPE, pathLength: '1' }));
        mark.appendChild(svg);
        el.appendChild(mark);
        return el;
    }
    function attach() {
        if (done) return true;
        const root = document.documentElement;
        if (!root) return false;
        if (!overlay) overlay = build();
        if (overlay.parentNode !== root) root.appendChild(overlay);
        return true;
    }
    // YouTube announces a finished page with these events (every page type,
    // including an empty signed-out home feed); content selectors are a
    // second signal, and a fully loaded document with the app shell a third.
    let pageEvent = false, completeAt = 0;
    ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (name) {
        document.addEventListener(name, function () { pageEvent = true; }, { once: true });
    });
    function ready() {
        if (pageEvent) return true;
        if (document.readyState === 'complete' && document.querySelector('ytd-app ytd-masthead')) {
            if (!completeAt) completeAt = performance.now();
            if (performance.now() - completeAt > 1500) return true;
        }
        return !!(document.querySelector('ytd-rich-grid-renderer #contents > ytd-rich-item-renderer, ytd-rich-grid-renderer #contents > ytd-rich-section-renderer') ||
            document.querySelector('ytd-watch-flexy #movie_player video') ||
            document.querySelector('ytd-search ytd-video-renderer, ytd-search ytd-channel-renderer') ||
            document.querySelector('ytd-browse ytd-two-column-browse-results-renderer #primary > *, ytd-browse ytd-section-list-renderer #contents > *') ||
            document.querySelector('ytd-consent-bump-v2-lightbox tp-yt-paper-dialog, form[action*="consent"]'));
    }
    function finish() {
        if (done) return;
        done = true;
        if (!overlay || !overlay.parentNode) return;
        overlay.style.pointerEvents = 'none';
        overlay.classList.add('out');
        overlay.style.opacity = '0';
        setTimeout(function () { if (overlay) overlay.remove(); overlay = null; }, reduced ? 50 : 460);
    }
    function check() {
        if (done) return;
        attach();
        const elapsed = performance.now() - started;
        if (elapsed > MAX_MS || (ready() && elapsed >= MIN_MS)) { finish(); return; }
        setTimeout(check, 80);
    }
    if (!attach()) {
        new MutationObserver(function (_, observer) {
            if (attach()) observer.disconnect();
        }).observe(document, { childList: true });
    }
    check();
    // Leaving the page (a real navigation) must not strand the overlay.
    window.addEventListener('pagehide', finish);
})();
