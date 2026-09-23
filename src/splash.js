(function () {
    'use strict';
    // Launch screen: covers the page from the first moment of the document
    // until YouTube has actually drawn its app (feed, watch page or search),
    // then fades away. Plain DOM with inline styles so it needs nothing from
    // the page and appears before YouTube's own CSS loads. Full page loads
    // only (app start, reload); in-app navigation never shows it.
    if (window.__ygSplash) return;
    window.__ygSplash = true;
    const MIN_MS = 450, MAX_MS = 12000;
    const started = performance.now();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let overlay = null, done = false;

    function build() {
        const el = document.createElement('div');
        el.id = 'yg-splash';
        el.setAttribute('role', 'progressbar');
        el.setAttribute('aria-label', 'Загрузка YouTube');
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:22px;background:#0b0b0b;' +
            'background-image:radial-gradient(700px 380px at 50% 42%,rgba(255,40,40,.10),transparent 70%);' +
            'transition:opacity .42s cubic-bezier(.22,1,.36,1),transform .42s cubic-bezier(.22,1,.36,1);' +
            'font-family:"Roboto","Segoe UI",sans-serif;color:#f1f1f1;user-select:none;';
        const style = document.createElement('style');
        style.textContent =
            '@keyframes yg-splash-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}' +
            '@keyframes yg-splash-glow{0%,100%{filter:drop-shadow(0 0 0 rgba(255,0,0,0))}50%{filter:drop-shadow(0 6px 28px rgba(255,30,30,.45))}}' +
            '@keyframes yg-splash-bar{from{transform:translateX(-100%)}to{transform:translateX(250%)}}' +
            '#yg-splash .logo{animation:yg-splash-in .5s cubic-bezier(.22,1,.36,1) both,yg-splash-glow 2.4s ease-in-out .5s infinite}' +
            '#yg-splash .name{animation:yg-splash-in .5s cubic-bezier(.22,1,.36,1) .08s both}' +
            '#yg-splash .track{animation:yg-splash-in .5s cubic-bezier(.22,1,.36,1) .16s both}' +
            '#yg-splash .bar{animation:yg-splash-bar 1.15s cubic-bezier(.45,.05,.55,.95) infinite}' +
            '@media (prefers-reduced-motion: reduce){#yg-splash *{animation:none!important}}';
        el.appendChild(style);
        const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        logo.setAttribute('class', 'logo');
        logo.setAttribute('viewBox', '0 0 68 48');
        logo.setAttribute('width', '88');
        logo.setAttribute('height', '62');
        logo.setAttribute('aria-hidden', 'true');
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', 'M66.5 7.7c-.8-2.9-3-5.2-6-6C55.3.3 34 .3 34 .3S12.7.3 7.5 1.7c-3 .8-5.2 3.1-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3c.8 2.9 3 5.2 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4c3-.8 5.2-3.1 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z');
        shape.setAttribute('fill', '#ff0033');
        const play = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        play.setAttribute('d', 'M45 24 27 14v20z');
        play.setAttribute('fill', '#fff');
        logo.appendChild(shape); logo.appendChild(play);
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = 'YouTube';
        name.style.cssText = 'font-size:22px;font-weight:600;letter-spacing:-.2px;opacity:.92;';
        const track = document.createElement('div');
        track.className = 'track';
        track.style.cssText = 'width:132px;height:3px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.cssText = 'width:40%;height:100%;border-radius:999px;background:linear-gradient(90deg,transparent,#f1f1f1,transparent);';
        track.appendChild(bar);
        el.appendChild(logo); el.appendChild(name); el.appendChild(track);
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
        overlay.style.opacity = '0';
        if (!reduced) overlay.style.transform = 'scale(1.03)';
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
