use std::rc::Rc;

use adw::prelude::*;

pub struct AuthFailedView {
    root: gtk::Widget,
}

impl AuthFailedView {
    pub fn new(on_continue: Rc<dyn Fn()>) -> Self {
        let clamp = adw::Clamp::new();
        clamp.set_maximum_size(420);

        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 18);
        box_.set_valign(gtk::Align::Center);
        box_.set_margin_top(48);
        box_.set_margin_bottom(48);
        box_.set_margin_start(24);
        box_.set_margin_end(24);

        let title = gtk::Label::new(Some("Authentication Failed"));
        title.add_css_class("title-1");
        title.set_halign(gtk::Align::Start);

        let body = gtk::Label::new(Some(
            "The configured credentials don't seem to work anymore. Let's reconfigure them.",
        ));
        body.set_wrap(true);
        body.set_halign(gtk::Align::Start);
        body.add_css_class("body");

        let continue_btn = gtk::Button::builder()
            .label("Continue")
            .halign(gtk::Align::End)
            .build();
        continue_btn.add_css_class("suggested-action");
        continue_btn.add_css_class("pill");

        continue_btn.connect_clicked({
            let on_continue = on_continue.clone();
            move |_| on_continue()
        });

        box_.append(&title);
        box_.append(&body);
        box_.append(&continue_btn);
        clamp.set_child(Some(&box_));

        Self {
            root: clamp.upcast(),
        }
    }

    pub fn root(&self) -> &gtk::Widget {
        &self.root
    }
}
