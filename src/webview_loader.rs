//! Ships WebView2Loader.dll inside the EXE (GNU builds, see build.rs).
//!
//! The DLL is linked as a delay-loaded import, so Windows only resolves it on
//! the first WebView2 call. `preload` must run before that: it writes the
//! embedded copy to %LOCALAPPDATA%\YoutubeGlass\runtime and loads it by full
//! path; the later delay-load by bare name then reuses the loaded module.

#[cfg(ytg_embedded_loader)]
static LOADER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/WebView2Loader.dll"));

#[cfg(ytg_embedded_loader)]
pub fn preload() {
    use windows::core::HSTRING;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;

    // A copy next to the EXE (zip distribution) wins the normal search order.
    if let Some(local) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("WebView2Loader.dll")))
        .filter(|p| p.is_file())
    {
        crate::logging::log(format!("webview2 loader: using {}", local.display()));
        return;
    }
    let Some(dir) = crate::extension::local_data_dir().map(|d| d.join("runtime")) else {
        crate::logging::log("webview2 loader: LOCALAPPDATA unavailable");
        return;
    };
    let path = dir.join("WebView2Loader.dll");
    if std::fs::read(&path).map(|b| b != LOADER).unwrap_or(true) {
        if let Err(e) = write_atomic(&dir, &path, LOADER) {
            crate::logging::log(format!("webview2 loader: write {} failed: {e}", path.display()));
        }
    }
    match unsafe { LoadLibraryW(&HSTRING::from(path.as_os_str())) } {
        Ok(_) => {}
        Err(e) => crate::logging::log(format!("webview2 loader: load {} failed: {e}", path.display())),
    }
}

#[cfg(not(ytg_embedded_loader))]
pub fn preload() {}

#[cfg(ytg_embedded_loader)]
fn write_atomic(dir: &std::path::Path, path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("WebView2Loader.{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}
