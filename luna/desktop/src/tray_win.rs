//! Windows system tray: a hidden message window + `Shell_NotifyIconW` +
//! a right-click menu with "Open Luna" / "Quit Luna". Commands go to the GTK
//! main thread through the same `TrayCmd` channel the ksni tray uses.
//!
//! Pure win32 so it works without D-Bus, which Windows does not have.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::sync::mpsc::Sender;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu,
    DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, HICON, HMENU, HWND_MESSAGE,
    IMAGE_ICON, LR_DEFAULTSIZE, LoadImageW, MF_STRING, MSG, PostMessageW, PostQuitMessage,
    RegisterClassW, SetForegroundWindow, TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RIGHTBUTTON,
    TrackPopupMenu, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_LBUTTONDBLCLK, WM_LBUTTONUP,
    WM_NULL, WM_RBUTTONUP, WNDCLASSW,
};

use crate::tray::TrayCmd;

const WM_TRAYICON: u32 = WM_APP + 1;
const ID_OPEN: usize = 1;
const ID_QUIT: usize = 2;
const TRAY_UID: u32 = 1;
/// MAKEINTRESOURCEW(IDI_APPLICATION)
const IDI_APPLICATION: windows_sys::core::PCWSTR = 32512usize as _;

static TX: OnceLock<Sender<TrayCmd>> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

/// Owns the tray thread; dropping it removes the icon (via WM_CLOSE) and
/// joins the thread so the icon does not linger after quit.
pub struct WinTray {
    hwnd: HWND,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WinTray {
    fn drop(&mut self) {
        unsafe {
            if !self.hwnd.is_null() {
                PostMessageW(self.hwnd, WM_CLOSE, 0, 0);
            }
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Start the tray on its own thread; `None` if the window/icon setup fails.
pub fn spawn(tx: Sender<TrayCmd>) -> Option<WinTray> {
    if TX.set(tx).is_err() {
        return None; // a tray already exists
    }
    // HWND is a raw pointer (not Send) — pass it through the channel as usize.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<usize>();
    let thread = std::thread::spawn(move || run(ready_tx));
    match ready_rx.recv() {
        Ok(hwnd) if hwnd != 0 => Some(WinTray {
            hwnd: hwnd as HWND,
            thread: Some(thread),
        }),
        _ => {
            let _ = thread.join();
            None
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            m if m == WM_TRAYICON => {
                match lparam as u32 {
                    WM_LBUTTONUP | WM_LBUTTONDBLCLK => {
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(TrayCmd::Show);
                        }
                    }
                    WM_RBUTTONUP => show_menu(hwnd),
                    _ => {}
                }
                0
            }
            m if m == WM_COMMAND => {
                match wparam & 0xffff {
                    ID_OPEN => {
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(TrayCmd::Show);
                        }
                    }
                    ID_QUIT => {
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(TrayCmd::Quit);
                        }
                    }
                    _ => {}
                }
                0
            }
            m if m == WM_CLOSE => {
                remove_icon(hwnd);
                DestroyWindow(hwnd);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

fn show_menu(hwnd: HWND) {
    unsafe {
        let menu: HMENU = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        let open = wide("Open Luna");
        let quit = wide("Quit Luna");
        AppendMenuW(menu, MF_STRING, ID_OPEN, open.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_QUIT, quit.as_ptr());
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        // Required so the menu dismisses when clicking away.
        SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN,
            pt.x,
            pt.y,
            0,
            hwnd,
            null(),
        );
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(menu);
    }
}

fn icon_data(hwnd: HWND, hicon: HICON) -> NOTIFYICONDATAW {
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = TRAY_UID;
    data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = WM_TRAYICON;
    data.hIcon = hicon;
    let tip = wide(crate::product_name());
    let n = tip.len().min(127);
    data.szTip[..n].copy_from_slice(&tip[..n]);
    data
}

fn remove_icon(hwnd: HWND) {
    unsafe {
        let mut data: NOTIFYICONDATAW = std::mem::zeroed();
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = hwnd;
        data.uID = TRAY_UID;
        Shell_NotifyIconW(NIM_DELETE, &data);
    }
}

fn run(ready: Sender<usize>) {
    unsafe {
        let hinst = GetModuleHandleW(null());
        let class = wide("LunaDesktopTrayWindow");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            let _ = ready.send(0);
            return;
        }
        let title = wide(crate::product_name());
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            null_mut(),
            hinst,
            null(),
        );
        if hwnd.is_null() {
            let _ = ready.send(0);
            return;
        }

        // Prefer the app's own icon: build.rs embeds it as resource ID 1.
        // Fall back to the predefined system application icon (null module) —
        // a shared icon that must not be DestroyIcon'd.
        let (hicon, own_icon): (HICON, bool) = {
            let h = LoadImageW(hinst, 1usize as _, IMAGE_ICON, 0, 0, LR_DEFAULTSIZE);
            if !h.is_null() {
                (h, true)
            } else {
                (
                    LoadImageW(
                        null_mut(),
                        IDI_APPLICATION,
                        IMAGE_ICON,
                        0,
                        0,
                        LR_DEFAULTSIZE,
                    ),
                    false,
                )
            }
        };
        if hicon.is_null() {
            let _ = ready.send(0);
            DestroyWindow(hwnd);
            return;
        }

        let mut data = icon_data(hwnd, hicon);
        if Shell_NotifyIconW(NIM_ADD, &mut data) == 0 {
            let _ = ready.send(0);
            if own_icon {
                DestroyIcon(hicon);
            }
            DestroyWindow(hwnd);
            return;
        }
        let _ = ready.send(hwnd as usize);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if own_icon {
            DestroyIcon(hicon);
        }
    }
}
