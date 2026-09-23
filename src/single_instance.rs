//! Ensures only one copy of the app runs at a time. A second launch just
//! activates the already-running window and exits immediately.

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE};

/// The window class name this app registers its main window under
/// (set via `WindowBuilderExtWindows::with_window_classname`), used here to
/// find an already-running instance without depending on the (dynamic)
/// window title.
pub const WINDOW_CLASS_NAME: &str = "YoutubeGlassMainWindow";

const MUTEX_NAME: &str = "Local\\YoutubeGlass-SingleInstance-Mutex";

/// Returned handle must be kept alive for the process's lifetime (letting it
/// drop at the end of `main` when the event loop exits is fine - the OS
/// releases it on process exit either way).
pub struct InstanceLock(HANDLE);

impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// If another instance is already running, brings its window to the front
/// and returns `None` (caller should exit immediately without creating any
/// window). Otherwise returns `Some(lock)` and the caller should proceed
/// with normal startup.
pub fn acquire() -> Option<InstanceLock> {
    let name = HSTRING::from(MUTEX_NAME);
    let handle = unsafe { CreateMutexW(None, false, &name) };

    let Ok(handle) = handle else {
        // Couldn't even create the mutex; fail open rather than block startup.
        return Some(InstanceLock(HANDLE::default()));
    };

    if unsafe { windows::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS {
        activate_existing();
        unsafe {
            let _ = CloseHandle(handle);
        }
        return None;
    }

    Some(InstanceLock(handle))
}

fn activate_existing() {
    let class_name = HSTRING::from(WINDOW_CLASS_NAME);
    if let Ok(hwnd) = unsafe { FindWindowW(&class_name, None) } {
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
    }
}
