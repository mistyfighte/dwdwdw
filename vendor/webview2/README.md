`WebView2Loader.x64.dll` is the x64 loader shipped in the `webview2-com-sys` 0.33.0
crate (Microsoft WebView2 SDK redistributable). On the GNU toolchain `build.rs`
delay-loads it and embeds this copy, so the release EXE runs without the DLL
next to it. Keep it in sync when upgrading `webview2-com`.
