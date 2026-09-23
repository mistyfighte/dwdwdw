//! Build-time packaging so the release EXE is self-contained:
//!
//! * Copies bundled extensions next to the executable (dev runs from
//!   `target/debug` / `target/release`).
//! * Embeds the bundled extensions into the binary (`embedded_extensions.rs`);
//!   `extension.rs` unpacks them to %LOCALAPPDATA% when no copy sits next to
//!   the EXE.
//! * GNU toolchain only: links WebView2Loader.dll as a *delay-loaded* import
//!   and embeds the DLL. A normal import made Windows refuse to start the EXE
//!   ("WebView2Loader.dll not found") before `main` could do anything; with
//!   delay loading `webview_loader::preload()` writes the embedded copy out and
//!   loads it first. (MSVC links the static loader and needs none of this.)

use std::path::{Path, PathBuf};
use std::process::Command;

/// Keep in sync with `extension::BUNDLED`.
const BUNDLED: &[&str] = &["sponsorblock", "return-youtube-dislike"];

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let target_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("target dir from OUT_DIR")
        .to_path_buf();

    let src_ext = manifest_dir.join("extensions");
    if src_ext.is_dir() {
        let _ = copy_dir_recursive(&src_ext, &target_dir.join("extensions"));
    }
    write_embedded_extensions(&src_ext, &out_dir);

    println!("cargo::rustc-check-cfg=cfg(ytg_embedded_loader)");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" && target_env == "gnu" && target_arch == "x86_64" {
        setup_delay_loaded_webview2(&manifest_dir, &out_dir);
    }

    println!("cargo:rerun-if-changed=extensions");
    println!("cargo:rerun-if-changed=vendor/webview2");
    println!("cargo:rerun-if-env-changed=DLLTOOL");
}

fn setup_delay_loaded_webview2(manifest_dir: &Path, out_dir: &Path) {
    let vendor = manifest_dir.join("vendor").join("webview2");
    let def = vendor.join("WebView2Loader.def");
    let dll = vendor.join("WebView2Loader.x64.dll");
    let lib_dir = out_dir.join("delayload");
    std::fs::create_dir_all(&lib_dir).expect("create delayload dir");
    // rustc passes `-lWebView2Loader.dll`; GNU ld tries `lib<name>.dll.a`
    // first in each directory, and our search path precedes the one
    // webview2-com-sys adds (checked with objdump: the DLL must appear under
    // "delay import", not in the regular import table).
    let lib = lib_dir.join("libWebView2Loader.dll.dll.a");

    let candidates: Vec<String> = std::env::var("DLLTOOL")
        .ok()
        .into_iter()
        .chain(["x86_64-w64-mingw32-dlltool".to_string(), "dlltool".to_string()])
        .collect();
    let built = candidates.iter().any(|tool| {
        Command::new(tool)
            .arg("-d")
            .arg(&def)
            .arg("-D")
            .arg("WebView2Loader.dll")
            .arg("-y")
            .arg(&lib)
            .status()
            .is_ok_and(|s| s.success())
    });
    if !built {
        println!(
            "cargo:warning=dlltool not found: WebView2Loader.dll stays a normal import and must ship next to the EXE"
        );
        return;
    }
    std::fs::copy(&dll, out_dir.join("WebView2Loader.dll")).expect("copy WebView2Loader.dll");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-cfg=ytg_embedded_loader");
}

fn write_embedded_extensions(src_ext: &Path, out_dir: &Path) {
    let mut files = Vec::new();
    for name in BUNDLED {
        let root = src_ext.join(name);
        if root.join("manifest.json").is_file() {
            collect_files(&root, &mut files);
        }
    }
    files.sort();
    // FNV-1a over paths and contents: a changed extension gets re-extracted.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    };
    let mut entries = String::new();
    for path in &files {
        let rel = path
            .strip_prefix(src_ext)
            .expect("under extensions/")
            .to_string_lossy()
            .replace('\\', "/");
        feed(rel.as_bytes());
        feed(&std::fs::read(path).expect("read extension file"));
        entries.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            path.to_string_lossy()
        ));
    }
    let code = format!(
        "pub const STAMP: &str = \"{hash:016x}\";\npub static FILES: &[(&str, &[u8])] = &[\n{entries}];\n"
    );
    std::fs::write(out_dir.join("embedded_extensions.rs"), code).expect("write embedded list");
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_files(&path, out),
            Ok(t) if t.is_file() => out.push(path),
            _ => {}
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
