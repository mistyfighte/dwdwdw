//! Liquid Glass theme CSS injected into YouTube.
//!
//! The ambient backlight (formerly a disabled canvas variant plus a native
//! GDI screen-sampler that lived here and in native_ambient.rs) was rewritten
//! from scratch as `ambient.rs` - a pure in-page Ambilight that samples the
//! video frames themselves. This module is now just the theme.

pub fn injection_script() -> String {
    let css_json = json_string(CSS);
    format!(
        r#"
        (function() {{
            var CSS = {css_json};

            /* ---------- CSS injection (survives YouTube head replacement) ---------- */
            function injectCSS() {{
                var old = document.getElementById('liquid-glass-theme');
                if (old && old.isConnected) return;
                if (old) old.remove();
                var target = document.head || document.documentElement;
                if (!target) return;
                var style = document.createElement('style');
                style.id = 'liquid-glass-theme';
                style.textContent = CSS;
                target.appendChild(style);
            }}

            function forceDark() {{
                var h = document.documentElement;
                if (!h) return;
                if (!h.hasAttribute('dark')) h.setAttribute('dark', '');
            }}

            // Forcing the `dark` attribute is not enough when YouTube served
            // the light theme: its light tokens also ship as `:root:root`
            // rules that outrank `[dark]` (e.g. white text on the white
            // Subscribe button). YouTube keeps the appearance choice in the
            // PREF cookie (f6 bit 0x400 = dark), so select dark there and
            // reload once when this page was served light.
            function preferDarkCookie() {{
                var m = /(?:^|;\s*)PREF=([^;]*)/.exec(document.cookie || '');
                var params = m ? m[1].split('&').filter(Boolean) : [];
                var f6 = 0, rest = [];
                params.forEach(function (p) {{
                    if (p.indexOf('f6=') === 0) f6 = parseInt(p.slice(3), 16) || 0;
                    else rest.push(p);
                }});
                if (f6 & 0x400) return false;
                f6 = (f6 | 0x400) & ~0x80000;
                rest.push('f6=' + f6.toString(16));
                document.cookie = 'PREF=' + rest.join('&') +
                    '; domain=.youtube.com; path=/; max-age=63072000; secure; samesite=lax';
                return true;
            }}
            if (preferDarkCookie() && window === window.top) {{
                var reloaded = false;
                try {{
                    reloaded = sessionStorage.getItem('lg-dark-reload') === '1';
                    sessionStorage.setItem('lg-dark-reload', '1');
                }} catch (e) {{ reloaded = true; }}
                if (!reloaded) location.reload();
            }}

            // The palette only works on YouTube's dark variables. YouTube
            // removes `dark` itself (light account preference, appearance
            // menu), which left dark-on-dark text until the next navigation.
            var darkObserved = false;
            function observeDark() {{
                if (darkObserved || !document.documentElement) return;
                darkObserved = true;
                new MutationObserver(forceDark).observe(document.documentElement, {{
                    attributes: true,
                    attributeFilter: ['dark'],
                }});
            }}

            function onNav() {{
                injectCSS();
                forceDark();
                observeDark();
            }}

            injectCSS();
            forceDark();
            observeDark();
            document.addEventListener('readystatechange', onNav);
            document.addEventListener('DOMContentLoaded', onNav);
            document.addEventListener('yt-navigate-finish', onNav);
            setInterval(function() {{
                var tag = document.getElementById('liquid-glass-theme');
                if (!tag || !tag.isConnected) injectCSS();
            }}, 1500);
        }})();
        "#
    )
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

const CSS: &str = r#"
:root {
    --lg-accent: #ffffff;
    --lg-focus: #a8d4ff;
    --lg-bg: rgba(22, 22, 22, 0.62);
    --lg-bg-soft: rgba(255, 255, 255, 0.06);
    --lg-border: rgba(255, 255, 255, 0.12);
    --lg-text: #f5f5f5;
    --lg-shadow-soft: 0 4px 18px rgba(0, 0, 0, 0.38);
    --lg-blur: blur(20px) saturate(1.2);
    --lg-radius: 16px;
    --lg-ease: cubic-bezier(0.22, 1, 0.36, 1);
}

html {
    color-scheme: dark !important;
    --yt-spec-base-background: #0a0a0a !important;
    --yt-spec-raised-background: #202020 !important;
    --yt-spec-menu-background: rgba(16, 16, 16, 0.95) !important;
    --yt-spec-brand-background-solid: #0a0a0a !important;
    --yt-spec-general-background-a: transparent !important;
    --yt-spec-general-background-b: transparent !important;
    --yt-spec-general-background-c: transparent !important;
}

/* The backdrop is a fixed pseudo-element on <body> in the root stacking
   context. The previous variant hung it off ytd-app with z-index:-1, which
   required ytd-app to be a stacking context (isolation + z-index:1). That
   trapped YouTube's dialogs and menus (z-index ~2202) below body-level layers
   - the modal backdrop, cinema veil and ambilight - so dialogs were dimmed
   and unclickable. Never make ytd-app a stacking context again. */
html {
    background: #0a0a0a !important;
    background-color: #0a0a0a !important;
}
body {
    background: transparent !important;
}
body::before {
    content: "";
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
        radial-gradient(1000px 420px at 46% 90px, rgba(255,255,255,0.08), transparent 62%),
        radial-gradient(820px 520px at 78% 170px, rgba(255,255,255,0.045), transparent 68%),
        linear-gradient(180deg, #101010 0%, #0c0c0c 42%, #080808 100%);
}
ytd-app, yt-app, #content, #page-manager, ytd-page-manager, ytd-browse,
ytd-watch-flexy, #primary, #secondary, #related {
    background: transparent !important;
    background-color: transparent !important;
}

/* Anchor for the ::before below. Without it the glow was positioned against
   ytd-watch-flexy, and in theater mode (player above #columns) it lay across
   the top 160px of the video as a translucent white band. */
ytd-watch-flexy:not([fullscreen]) #columns {
    position: relative;
}

/* In theater mode the player sits above #columns, so this glow started in a
   hard line right under the video (a visible seam). */
ytd-watch-flexy[theater] #columns::before {
    display: none !important;
}

ytd-watch-flexy:not([fullscreen]) #columns::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 160px;
    pointer-events: none;
    z-index: 0;
    background:
        radial-gradient(760px 160px at 34% 80%, rgba(255,255,255,0.055), transparent 72%),
        linear-gradient(180deg, rgba(255,255,255,0.035), transparent 86%);
}

ytd-watch-flexy:not([fullscreen]) #primary,
ytd-watch-flexy:not([fullscreen]) #secondary {
    position: relative;
    z-index: 1;
}

#masthead-container {
    background: rgba(15, 15, 15, 0.78) !important;
    -webkit-backdrop-filter: var(--lg-blur) !important;
    backdrop-filter: var(--lg-blur) !important;
    border-bottom: 1px solid rgba(255,255,255,0.10) !important;
    box-shadow: 0 4px 28px rgba(0,0,0,0.55) !important;
}

/* In theater mode the video starts right under the masthead; its shadow
   darkened the top ~30px of the picture. */
html:has(ytd-watch-flexy[theater]:not([fullscreen])) #masthead-container {
    box-shadow: none !important;
}

ytd-searchbox#search {
    background: rgba(255,255,255,0.07) !important;
    border-radius: 999px !important;
}
ytd-searchbox#search:focus-within {
    background: rgba(255,255,255,0.10) !important;
    outline: 2px solid var(--lg-focus);
    outline-offset: 2px;
}
ytd-searchbox#search #container,
ytd-searchbox#search #search-icon-legacy {
    background-color: transparent !important;
    border: none !important;
    box-shadow: none !important;
}

tp-yt-app-drawer#guide[opened] {
    background: rgba(16, 16, 16, 0.97) !important;
}
tp-yt-app-drawer#guide:not([opened]) {
    background: transparent !important;
    visibility: hidden !important;
}

yt-chip-cloud-chip-renderer {
    background: rgba(255,255,255,0.08) !important;
    border-radius: 10px !important;
}
yt-chip-cloud-chip-renderer[selected], yt-chip-cloud-chip-renderer[aria-selected="true"] {
    background: #f1f1f1 !important;
    color: #0d0d0d !important;
}

ytd-rich-grid-media #thumbnail, ytd-thumbnail, ytd-thumbnail img {
    border-radius: 12px !important;
    overflow: hidden !important;
}

ytd-watch-flexy #secondary,
#secondary,
#related {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
}

/* Dark glass: the ambilight is painted behind these cards, and on bright
   videos a light card left white text on near-white glow. */
ytd-comments#comments, ytd-watch-metadata {
    background: rgba(14,14,14,0.72) !important;
    -webkit-backdrop-filter: blur(18px) saturate(1.1) !important;
    backdrop-filter: blur(18px) saturate(1.1) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: var(--lg-radius) !important;
    box-shadow: var(--lg-shadow-soft) !important;
}

.html5-video-player, #player .html5-video-player,
ytd-player#ytd-player .html5-video-player {
    border-radius: var(--lg-radius) !important;
    overflow: hidden !important;
    /* No dark drop shadow: the ambilight is painted behind the page, so a
       shadow would darken exactly the brightest part of the glow. */
    box-shadow: 0 0 0 1px rgba(255,255,255,0.08) !important;
}

/* Letterbox/pillarbox bars show the ambilight behind the player instead of
   solid black. Windowed only: fullscreen keeps YouTube's black. */
ytd-watch-flexy:not([fullscreen]) #movie_player:not(.ytp-fullscreen),
ytd-watch-flexy:not([fullscreen]) #player-full-bleed-container,
ytd-watch-flexy:not([fullscreen]) #full-bleed-container {
    background: transparent !important;
}

/* YouTube's own cinematic lighting behind the player - superseded by our
   Ambilight (ambient.rs), which derives its light from the actual frames. */
#cinematics-container, #cinematics {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

#cinematics canvas, #cinematics-container canvas {
    display: none !important;
}

/* Ambient light (ambient.js): letterbox bars encoded in the video are cut
   away so the continuation fills them (insets set by the script, windowed
   only), and text next to the player gets a soft shadow so it stays
   readable over bright continuations. */
html.lg-bars ytd-watch-flexy:not([fullscreen]) #movie_player:not(.ytp-fullscreen) video.video-stream {
    clip-path: inset(var(--lg-bar-t, 0px) var(--lg-bar-r, 0px) var(--lg-bar-b, 0px) var(--lg-bar-l, 0px));
}
html.lg-ambient-on ytd-watch-flexy:not([fullscreen]) :is(#secondary, #below) {
    text-shadow: 0 1px 2px rgba(0,0,0,0.55), 0 0 12px rgba(0,0,0,0.35);
}

#player-container-inner, #player-container, #player, #player-wrap,
ytd-player#ytd-player, ytd-player, #primary-inner, ytd-watch-flexy #primary {
    overflow: visible !important;
    background: transparent !important;
}

#player-container-inner > .html5-video-player,
ytd-player#ytd-player .html5-video-player {
    position: relative;
    z-index: 1;
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.38);
    border-radius: 999px;
}
/* tabindex=-1 targets (the player) are focused by script, not by Tab. */
:is(ytd-app, yt-app) :is(a, button, input, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])):focus-visible {
    outline: 2px solid var(--lg-focus) !important;
    outline-offset: -2px !important;
}

yt-chip-cloud-chip-renderer[selected] #text,
yt-chip-cloud-chip-renderer[aria-selected="true"] #text {
    color: #0d0d0d !important;
}

ytd-guide-entry-renderer[active] {
    background: rgba(255,255,255,0.14) !important;
    border-radius: 10px;
}

ytd-menu-popup-renderer, tp-yt-paper-dialog {
    background: var(--yt-spec-menu-background) !important;
    border: 1px solid var(--lg-border);
    border-radius: var(--lg-radius);
    box-shadow: var(--lg-shadow-soft);
}

/* Two ids so these beat `ytd-player#ytd-player .html5-video-player` above;
   with lower specificity the fullscreen player kept rounded corners. */
ytd-watch-flexy[fullscreen] ytd-player#ytd-player #movie_player,
ytd-watch-flexy[theater] ytd-player#ytd-player #movie_player,
ytd-player#ytd-player #movie_player.ytp-fullscreen {
    border-radius: 0 !important;
    box-shadow: none !important;
}

@media (prefers-reduced-motion: reduce) {
    :is(ytd-app, yt-app) :is(ytd-thumbnail, yt-chip-cloud-chip-renderer, ytd-guide-entry-renderer, button, a) {
        transition: none !important;
        animation: none !important;
    }
    html { scroll-behavior: auto !important; }
}

@media (forced-colors: active) {
    :is(ytd-app, yt-app) :focus-visible { outline-color: Highlight !important; }
    yt-chip-cloud-renderer[selected] { outline: 2px solid Highlight !important; }
}

/* ---------- cookie consent dialog (first launch) ----------
   On a fresh profile YouTube shows the "Before you continue to YouTube"
   consent lightbox. In a small WebView window its action buttons can end up
   below the viewport, and YouTube locks the page scroll while the lightbox is
   open - leaving nothing scrollable. Constrain the dialog box itself so it
   fits the viewport and scrolls internally, making the buttons reachable.
   NEVER force display/position on the lightbox host: it is permanently
   present in the DOM, and making it a visible fixed inset:0 flex container
   creates an invisible full-screen overlay that swallows every click on the
   whole page (even with no dialog open). */
ytd-consent-bump-v2-lightbox tp-yt-paper-dialog {
    max-width: min(560px, calc(100vw - 32px)) !important;
    max-height: calc(100vh - 48px) !important;
    overflow-y: auto !important;
    overscroll-behavior: contain !important;
}
"#;
