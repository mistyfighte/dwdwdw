(function () {
    'use strict';
    // Custom window frame: the native caption is hidden and its controls live
    // in YouTube's masthead (or a slim bar on the settings page). Rust owns
    // the real window; this script only draws controls, marks drag regions
    // and reports clicks through `window.ipc`:
    //   win:min | win:max | win:close | win:drag | win:resize:<dir>
    // Rust pushes state back via window.__ygFrame.set({ custom, max, nc }).
    if (window.__ygFrame) return;
    const onYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
    const state = { custom: window.__YG_CUSTOM_FRAME !== false, max: false, nc: false };
    const SVG = 'http://www.w3.org/2000/svg';
    const ICONS = {
        min: 'M5 11.5h14v1H5z',
        max: 'M6 6h12v12H6V6zm1 1v10h10V7H7z',
        restore: 'M8 5h11v11h-3v3H5V8h3V5zm1 3h7v7h2V6H9v2zM6 9v9h9V9H6z',
        close: 'M6.7 6 12 11.3 17.3 6l.7.7-5.3 5.3 5.3 5.3-.7.7-5.3-5.3L6.7 18l-.7-.7 5.3-5.3L6 6.7z'
    };
    // Interactive masthead parts that must stay clickable inside the drag area.
    const NO_DRAG = 'a, button, input, [role="button"], [role="combobox"], [role="link"], yt-icon-button, ' +
        'ytd-topbar-logo-renderer, ytd-searchbox, #voice-search-button, yt-searchbox, ytd-topbar-menu-button-renderer, ' +
        'ytd-notification-topbar-button-renderer, ytd-button-renderer, yt-button-shape, tp-yt-paper-icon-button, #yg-window-controls';
    const CSS =
        'html.yg-custom-frame #masthead-container, html.yg-custom-frame #yg-titlebar { app-region: drag; }' +
        'html.yg-custom-frame #masthead-container :is(' + NO_DRAG + '),' +
        'html.yg-custom-frame :is(tp-yt-app-drawer, ytd-popup-container, tp-yt-iron-dropdown, tp-yt-paper-dialog, ' +
            'ytd-consent-bump-v2-lightbox, .yg-resize) { app-region: no-drag; }' +
        '#yg-window-controls { display: none; align-items: center; gap: 2px; margin-left: 8px; flex: none; }' +
        'html.yg-custom-frame #yg-window-controls { display: flex; }' +
        '#yg-window-controls button { all: unset; box-sizing: border-box; width: 40px; height: 40px; border-radius: 50%;' +
            'display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: #f1f1f1;' +
            'transition: background-color .15s ease; }' +
        '#yg-window-controls button:hover { background: rgba(255,255,255,.1); }' +
        '#yg-window-controls button:active { background: rgba(255,255,255,.2); }' +
        '#yg-window-controls button.yg-btn-close:hover { background: #c42b1c; color: #fff; }' +
        '#yg-window-controls button:focus-visible { outline: 2px solid #a8d4ff; outline-offset: -2px; }' +
        '#yg-window-controls svg { width: 20px; height: 20px; fill: currentColor; pointer-events: none; }' +
        '#yg-titlebar { display: none; position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 50;' +
            'align-items: center; justify-content: flex-end; padding: 0 8px; background: rgba(13,13,13,.92);' +
            'border-bottom: 1px solid rgba(255,255,255,.08); }' +
        'html.yg-custom-frame #yg-titlebar { display: flex; }' +
        'html.yg-custom-frame.yg-own-titlebar body { padding-top: 40px; }' +
        '.yg-resize { position: fixed; z-index: 2147483647; display: none; }' +
        'html.yg-custom-frame:not(.yg-max):not(.yg-fs) .yg-resize { display: block; }' +
        '.yg-resize[data-dir="n"] { top: 0; left: 10px; right: 10px; height: 4px; cursor: n-resize; }' +
        '.yg-resize[data-dir="s"] { bottom: 0; left: 10px; right: 10px; height: 4px; cursor: s-resize; }' +
        '.yg-resize[data-dir="w"] { left: 0; top: 10px; bottom: 10px; width: 4px; cursor: w-resize; }' +
        '.yg-resize[data-dir="e"] { right: 0; top: 10px; bottom: 10px; width: 4px; cursor: e-resize; }' +
        '.yg-resize[data-dir="nw"] { top: 0; left: 0; width: 10px; height: 10px; cursor: nw-resize; }' +
        '.yg-resize[data-dir="ne"] { top: 0; right: 0; width: 10px; height: 10px; cursor: ne-resize; }' +
        '.yg-resize[data-dir="sw"] { bottom: 0; left: 0; width: 10px; height: 10px; cursor: sw-resize; }' +
        '.yg-resize[data-dir="se"] { bottom: 0; right: 0; width: 10px; height: 10px; cursor: se-resize; }';

    function post(message) { if (window.ipc) window.ipc.postMessage(message); }

    function icon(path) {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const p = document.createElementNS(SVG, 'path');
        p.setAttribute('d', path);
        svg.appendChild(p);
        return svg;
    }

    let controls = null, maxButton = null;
    function buildControls() {
        controls = document.createElement('div');
        controls.id = 'yg-window-controls';
        [['min', 'Свернуть', 'win:min'], ['max', 'Развернуть', 'win:max'], ['close', 'Закрыть', 'win:close']].forEach(function (spec) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'yg-btn-' + spec[0];
            button.title = spec[1];
            button.setAttribute('aria-label', spec[1]);
            button.appendChild(icon(ICONS[spec[0]]));
            button.addEventListener('click', function (event) { event.stopPropagation(); post(spec[2]); });
            if (spec[0] === 'max') maxButton = button;
            controls.appendChild(button);
        });
        syncMaxButton();
    }

    function syncMaxButton() {
        if (!maxButton) return;
        const label = state.max ? 'Восстановить' : 'Развернуть';
        maxButton.title = label;
        maxButton.setAttribute('aria-label', label);
        maxButton.replaceChildren(icon(state.max ? ICONS.restore : ICONS.max));
    }

    function ensureStyle() {
        if (document.getElementById('yg-frame-style')) return;
        const target = document.head || document.documentElement;
        if (!target) return;
        const style = document.createElement('style');
        style.id = 'yg-frame-style';
        style.textContent = CSS;
        target.appendChild(style);
    }

    function ensureResizeEdges() {
        if (!document.body || document.querySelector('.yg-resize')) return;
        ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (dir) {
            const edge = document.createElement('div');
            edge.className = 'yg-resize';
            edge.dataset.dir = dir;
            edge.setAttribute('aria-hidden', 'true');
            edge.addEventListener('pointerdown', function (event) {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                post('win:resize:' + dir);
            });
            document.body.appendChild(edge);
        });
    }

    // Where the controls live: the end of YouTube's masthead, or our own
    // slim bar on pages without one (the settings page).
    function ensureControls() {
        if (!document.body) return;
        if (!controls) buildControls();
        let host = null;
        if (onYouTube) {
            host = document.querySelector('ytd-masthead #end') || document.querySelector('#masthead #end');
        } else {
            host = document.getElementById('yg-titlebar');
            if (!host) {
                host = document.createElement('div');
                host.id = 'yg-titlebar';
                document.body.prepend(host);
            }
            document.documentElement.classList.add('yg-own-titlebar');
        }
        if (host && controls.parentNode !== host) host.appendChild(controls);
    }

    function apply() {
        const root = document.documentElement;
        if (!root) return;
        root.classList.toggle('yg-custom-frame', state.custom);
        root.classList.toggle('yg-max', state.max);
        root.classList.toggle('yg-fs', !!document.fullscreenElement);
        syncMaxButton();
    }

    // Fallback for WebView2 runtimes without non-client region support: the
    // drag area then behaves like a normal element, so move the window from
    // script. With support, `app-region: drag` areas never deliver these
    // events to the page.
    function dragArea(target) {
        if (!state.custom || state.nc || !target || !target.closest) return false;
        const area = target.closest('#masthead-container, #yg-titlebar');
        return !!area && !target.closest(NO_DRAG);
    }
    // mousedown carries the click count; the OS drag loop started by the
    // first press would swallow a later dblclick event.
    document.addEventListener('mousedown', function (event) {
        if (event.button !== 0 || !dragArea(event.target)) return;
        event.preventDefault();
        post(event.detail >= 2 ? 'win:max' : 'win:drag');
    }, true);

    let queued = false;
    function sync() {
        queued = false;
        ensureStyle();
        ensureControls();
        ensureResizeEdges();
        apply();
    }
    function queue() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(sync);
    }

    window.__ygFrame = {
        set: function (next) {
            Object.assign(state, next || {});
            sync();
        }
    };

    function start() {
        sync();
        // YouTube re-renders the masthead on some navigations.
        new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
    }
    ensureStyle();
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    document.addEventListener('fullscreenchange', apply);
})();
