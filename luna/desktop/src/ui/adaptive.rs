//! Responsive layout helpers for narrow screens (Linux Mobile, small windows).

use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;

/// Width below which we treat the UI as phone-sized.
pub const NARROW_BREAKPOINT: i32 = 600;

/// Minimum comfortable touch target (GNOME HIG).
const TOUCH_TARGET: i32 = 44;

/// Set default window size from the primary monitor (full screen on phones).
pub fn apply_window_defaults(window: &adw::ApplicationWindow) {
    let Some(display) = gtk::gdk::Display::default() else {
        window.set_default_size(960, 640);
        return;
    };
    let monitors = display.monitors();
    let monitor = (0..monitors.n_items())
        .filter_map(|i| monitors.item(i).and_downcast::<gtk::gdk::Monitor>())
        .next();
    let Some(monitor) = monitor else {
        window.set_default_size(960, 640);
        return;
    };
    let geometry = monitor.geometry();
    let w = geometry.width();
    let h = geometry.height();
    if w < NARROW_BREAKPOINT {
        window.set_default_size(w, h);
    } else {
        window.set_default_size(w.min(960), h.min(640));
    }
}

/// Current allocated width of `widget`, or 0 if not yet realized.
pub fn widget_width(widget: &impl IsA<gtk::Widget>) -> i32 {
    let w = widget.clone().upcast::<gtk::Widget>().width();
    if w > 0 {
        w
    } else {
        widget
            .clone()
            .upcast::<gtk::Widget>()
            .width_request()
            .max(0)
    }
}

/// Width of the top-level window containing `widget`.
fn window_width(widget: &gtk::Widget) -> i32 {
    widget
        .root()
        .map(|root| root.width())
        .unwrap_or_else(|| widget.width())
}

/// Size a form dialog for the current parent width.
pub fn configure_form_dialog(dialog: &adw::Dialog, parent: &impl IsA<gtk::Widget>, tall: bool) {
    let w = widget_width(parent);
    if w > 0 && w < NARROW_BREAKPOINT {
        dialog.set_content_width((w - 16).max(280));
        dialog.set_content_height(-1);
    } else {
        dialog.set_content_width(520);
        dialog.set_content_height(if tall { 580 } else { 560 });
    }
}

/// Size a small prompt dialog (e.g. create folder).
pub fn configure_prompt_dialog(dialog: &adw::Dialog, parent: &impl IsA<gtk::Widget>) {
    let w = widget_width(parent);
    if w > 0 && w < NARROW_BREAKPOINT {
        dialog.set_content_width((w - 16).max(280));
        dialog.set_content_height(-1);
    } else {
        dialog.set_content_width(360);
        dialog.set_content_height(-1);
    }
}

fn apply_toolbar_layout(
    toolbar: &gtk::Box,
    blurb: &gtk::Label,
    action: &gtk::Button,
    narrow: bool,
) {
    if narrow {
        toolbar.set_orientation(gtk::Orientation::Vertical);
        toolbar.set_spacing(10);
        blurb.set_hexpand(false);
        action.set_halign(gtk::Align::Start);
    } else {
        toolbar.set_orientation(gtk::Orientation::Horizontal);
        toolbar.set_spacing(8);
        blurb.set_hexpand(true);
        action.set_halign(gtk::Align::End);
    }
}

/// Page toolbar: blurb + primary action. Stacks vertically on narrow widths.
pub fn make_page_toolbar(
    host: &impl IsA<gtk::Widget>,
    blurb: &gtk::Label,
    action: &gtk::Button,
) -> gtk::Box {
    let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    toolbar.set_margin_top(12);
    toolbar.set_margin_bottom(8);
    toolbar.set_margin_start(16);
    toolbar.set_margin_end(16);
    toolbar.append(blurb);
    toolbar.append(action);

    let toolbar_c = toolbar.clone();
    let blurb_c = blurb.clone();
    let action_c = action.clone();
    let update = Rc::new(move |narrow: bool| {
        apply_toolbar_layout(&toolbar_c, &blurb_c, &action_c, narrow);
    });
    bind_narrow(host, update);

    toolbar
}

fn apply_action_row_layout(
    row: &gtk::Box,
    create: &gtk::Button,
    use_btn: &gtk::Button,
    narrow: bool,
) {
    if narrow {
        row.set_orientation(gtk::Orientation::Vertical);
        row.set_spacing(8);
        create.set_halign(gtk::Align::Fill);
        use_btn.set_halign(gtk::Align::Fill);
    } else {
        row.set_orientation(gtk::Orientation::Horizontal);
        row.set_spacing(8);
        create.set_halign(gtk::Align::Fill);
        use_btn.set_halign(gtk::Align::Fill);
    }
}

/// Pair of folder-browser actions that stack on narrow parents.
pub fn make_action_row(
    host: &impl IsA<gtk::Widget>,
    create: &gtk::Button,
    use_btn: &gtk::Button,
) -> gtk::Box {
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.append(create);
    row.append(use_btn);

    let row_c = row.clone();
    let create_c = create.clone();
    let use_c = use_btn.clone();
    let update = Rc::new(move |narrow: bool| {
        apply_action_row_layout(&row_c, &create_c, &use_c, narrow);
    });
    bind_narrow(host, update);

    row
}

/// Call `on_change(true)` when the host's window is narrower than [`NARROW_BREAKPOINT`].
pub fn bind_narrow(host: &impl IsA<gtk::Widget>, on_change: Rc<dyn Fn(bool)>) {
    let host = host.clone().upcast::<gtk::Widget>();
    let last_narrow = Rc::new(RefCell::new(None::<bool>));

    let check = {
        let host = host.clone();
        let on_change = on_change.clone();
        let last_narrow = last_narrow.clone();
        Rc::new(move || {
            let w = window_width(&host);
            if w <= 0 {
                return;
            }
            let narrow = w < NARROW_BREAKPOINT;
            let mut last = last_narrow.borrow_mut();
            if *last != Some(narrow) {
                *last = Some(narrow);
                on_change(narrow);
            }
        })
    };

    check();
    host.connect_map({
        let host = host.clone();
        let check = check.clone();
        move |_| {
            check();
            if let Some(root) = host.root() {
                root.connect_notify_local(Some("width"), {
                    let check = check.clone();
                    move |_, _| check()
                });
            }
        }
    });
}

/// Horizontal scroll wrapper for overflowing rows (breadcrumbs, drive chips).
pub fn horizontal_scroll(child: &impl IsA<gtk::Widget>) -> gtk::ScrolledWindow {
    gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Automatic)
        .vscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(TOUCH_TARGET)
        .child(child)
        .build()
}

/// Action row suffix button with a comfortable touch target.
pub fn touch_icon_button(icon_name: &str, tooltip: &str) -> gtk::Button {
    let btn = gtk::Button::from_icon_name(icon_name);
    btn.add_css_class("flat");
    btn.add_css_class("touch-target");
    btn.set_tooltip_text(Some(tooltip));
    btn
}
