//! BlueZ transport for the BLE bootstrap (feature `ble`).
//!
//! Advertises the same service UUIDs as LibreServ and wires characteristic
//! writes directly into `BleCore`. Notification frames are delivered through
//! bluer's CharacteristicNotifyMethod::Fun sessions.

#![cfg(feature = "ble")]

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bluer::adv::Advertisement;
use bluer::gatt::local::{
    Application, Characteristic, CharacteristicNotify, CharacteristicNotifyMethod,
    CharacteristicWrite, CharacteristicWriteMethod, Service,
};
use futures_util::FutureExt;
use tokio::sync::mpsc;

use crate::ble::BleTransport;
use crate::ble::{
    BleCore, CHAR_AUTH, CHAR_AUTH_STATUS, CHAR_PROXY_REQ, CHAR_PROXY_RESP, SERVICE_UUID,
};

pub struct BlueZTransport {
    core: Arc<BleCore>,
    shutdown: Arc<AtomicBool>,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BlueZTransport {
    pub fn new(core: Arc<BleCore>) -> Self {
        Self {
            core,
            shutdown: Arc::new(AtomicBool::new(false)),
            handle: Mutex::new(None),
        }
    }
}

impl BleTransport for BlueZTransport {
    fn start(&self) -> anyhow::Result<()> {
        let core = self.core.clone();
        let shutdown = self.shutdown.clone();
        let handle = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("ble runtime");
            runtime.block_on(async move {
                if let Err(err) = run(core, shutdown.clone()).await {
                    tracing::warn!(error = %err, "BLE transport stopped");
                }
            });
        });
        *self.handle.lock().unwrap() = Some(handle);
        Ok(())
    }

    fn stop(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

async fn run(core: Arc<BleCore>, shutdown: Arc<AtomicBool>) -> bluer::Result<()> {
    let session = bluer::Session::new().await?;
    let adapter = session.default_adapter().await?;
    adapter.set_powered(true).await?;

    let (auth_tx, auth_rx) = mpsc::channel::<Vec<u8>>(16);
    let (resp_tx, resp_rx) = mpsc::channel::<Vec<u8>>(64);
    let auth_rx = Arc::new(tokio::sync::Mutex::new(auth_rx));
    let resp_rx = Arc::new(tokio::sync::Mutex::new(resp_rx));

    let core_auth = core.clone();
    let core_req = core.clone();

    let app = Application {
        services: vec![Service {
            uuid: SERVICE_UUID.parse().expect("valid service uuid"),
            primary: true,
            characteristics: vec![
                Characteristic {
                    uuid: CHAR_AUTH.parse().expect("valid uuid"),
                    write: Some(CharacteristicWrite {
                        write: true,
                        method: CharacteristicWriteMethod::Fun(Box::new(move |value, _req| {
                            let core = core_auth.clone();
                            let auth_tx = auth_tx.clone();
                            async move {
                                let frame = core.handle_auth_write(&value).await;
                                let _ = auth_tx.send(frame).await;
                                Ok(())
                            }
                            .boxed()
                        })),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                Characteristic {
                    uuid: CHAR_AUTH_STATUS.parse().expect("valid uuid"),
                    notify: Some(CharacteristicNotify {
                        notify: true,
                        method: CharacteristicNotifyMethod::Fun(Box::new(move |mut notifier| {
                            let auth_rx = auth_rx.clone();
                            async move {
                                while let Some(frame) = auth_rx.lock().await.recv().await {
                                    if notifier.notify(frame).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            .boxed()
                        })),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                Characteristic {
                    uuid: CHAR_PROXY_REQ.parse().expect("valid uuid"),
                    write: Some(CharacteristicWrite {
                        write: true,
                        method: CharacteristicWriteMethod::Fun(Box::new(move |value, _req| {
                            let core = core_req.clone();
                            let resp_tx = resp_tx.clone();
                            async move {
                                let frames = core.handle_request_write(&value).await;
                                for frame in frames {
                                    if resp_tx.send(frame).await.is_err() {
                                        break;
                                    }
                                }
                                Ok(())
                            }
                            .boxed()
                        })),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                Characteristic {
                    uuid: CHAR_PROXY_RESP.parse().expect("valid uuid"),
                    notify: Some(CharacteristicNotify {
                        notify: true,
                        method: CharacteristicNotifyMethod::Fun(Box::new(move |mut notifier| {
                            let resp_rx = resp_rx.clone();
                            async move {
                                while let Some(frame) = resp_rx.lock().await.recv().await {
                                    if notifier.notify(frame).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            .boxed()
                        })),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }],
        ..Default::default()
    };

    let app_handle = adapter.serve_gatt_application(app).await?;
    let advertisement = Advertisement {
        service_uuids: vec![SERVICE_UUID.parse().expect("valid uuid")]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        discoverable: Some(true),
        local_name: Some("Luna".to_string()),
        ..Default::default()
    };
    let adv_handle = adapter.advertise(advertisement).await?;
    tracing::info!(adapter = %adapter.name(), "BLE bootstrap advertising as Luna");

    while !shutdown.load(Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    drop(app_handle);
    drop(adv_handle);
    Ok(())
}
