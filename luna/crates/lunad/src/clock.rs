//! One thread for lunad's slow timers (seconds to hours), so an idle Luna
//! wakes once per due time instead of several times (D3).
//!
//! tokio keeps long timers in a coarse wheel: a 15-minute sleep wakes the
//! runtime three or four times as it moves down the wheel's levels before it
//! fires. This thread instead waits on a condition variable with the exact
//! time left, so each due time costs one wake. Timers that fall due close
//! together share that wake: each may run a little late (1/16 of its length,
//! at most a minute), never early.
//!
//! - [`every`] runs blocking work on this thread on a fixed grid counted from
//!   process start, so jobs with related periods (15, 30, 60 minutes) fall due
//!   together. Keep these quick: a slow job delays every other timer here.
//! - [`sleep`] and [`tick`] are futures for async loops whose work is slow or
//!   needs the runtime; dropping one cancels its timer.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

/// The latest a timer may fire after its due time, so neighbours share a wake.
pub fn slack(len: Duration) -> Duration {
    (len / 16).min(Duration::from_secs(60))
}

/// The next point after `now` on a `period` grid that starts at `epoch`.
pub fn next_on_grid(epoch: Instant, period: Duration, now: Instant) -> Instant {
    let period = period.max(Duration::from_millis(1));
    let since = now.saturating_duration_since(epoch);
    let steps = since.as_nanos() / period.as_nanos() + 1;
    epoch + period * u32::try_from(steps).unwrap_or(u32::MAX)
}

/// Run `job` on the clock thread every `period`, on the grid counted from
/// process start (first at the grid point after now, or at once with `now`).
pub fn every(period: Duration, now: bool, job: impl FnMut() + Send + 'static) {
    let c = clock();
    let due = if now {
        Instant::now()
    } else {
        next_on_grid(c.epoch, period, Instant::now())
    };
    c.add(
        due,
        slack(period),
        Work::Every {
            period,
            job: Some(Box::new(job)),
        },
    );
}

/// A future that resolves `len` from now (up to [`slack`] later).
pub fn sleep(len: Duration) -> Sleep {
    Sleep::at(Instant::now() + len, slack(len))
}

/// A future that resolves at the next `period` grid point counted from
/// process start, for async loops that should line up with [`every`] jobs.
pub fn tick(period: Duration) -> Sleep {
    let c = clock();
    Sleep::at(next_on_grid(c.epoch, period, Instant::now()), slack(period))
}

/// Like `tokio::time::interval`: the first [`Interval::tick`] resolves at
/// once, later ones at the next `period` grid point (missed ones are skipped,
/// never run in a burst).
pub fn interval(period: Duration) -> Interval {
    Interval {
        period,
        first: true,
    }
}

/// See [`interval`].
pub struct Interval {
    period: Duration,
    first: bool,
}

impl Interval {
    pub async fn tick(&mut self) {
        if std::mem::take(&mut self.first) {
            return;
        }
        tick(self.period).await;
    }
}

type Job = Box<dyn FnMut() + Send>;

enum Work {
    Every { period: Duration, job: Option<Job> },
    Wake(Arc<Fired>),
}

#[derive(Default)]
struct Fired {
    done: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

struct Entry {
    id: u64,
    due: Instant,
    slack: Duration,
    work: Work,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    next_id: u64,
    /// When the thread will next wake by itself; `None` while it waits with no
    /// timer (or runs a job and plans again afterwards).
    planned: Option<Instant>,
    started: bool,
}

struct Clock {
    epoch: Instant,
    state: Mutex<State>,
    cv: Condvar,
}

static CLOCK: LazyLock<Clock> = LazyLock::new(|| Clock {
    epoch: Instant::now(),
    state: Mutex::default(),
    cv: Condvar::new(),
});

fn clock() -> &'static Clock {
    &CLOCK
}

impl Clock {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn add(&'static self, due: Instant, slack: Duration, work: Work) -> u64 {
        let mut g = self.lock();
        let id = g.next_id;
        g.next_id += 1;
        g.entries.push(Entry {
            id,
            due,
            slack,
            work,
        });
        if !g.started {
            g.started = true;
            std::thread::Builder::new()
                .name("luna-clock".into())
                .spawn(move || self.run())
                .expect("start the luna-clock thread");
        } else if g.planned.is_none_or(|at| due + slack < at) {
            self.cv.notify_one();
        }
        id
    }

    fn remove(&self, id: u64) {
        // No notify: a wake planned for a removed timer only finds nothing due.
        self.lock().entries.retain(|e| e.id != id);
    }

    fn run(&self) {
        let mut g = self.lock();
        loop {
            let now = Instant::now();
            if let Some(i) = g.entries.iter().position(|e| e.due <= now) {
                let entry = &mut g.entries[i];
                match &mut entry.work {
                    Work::Wake(fired) => {
                        let fired = fired.clone();
                        g.entries.swap_remove(i);
                        fired.done.store(true, Ordering::Release);
                        let waker = fired.waker.lock().unwrap_or_else(|e| e.into_inner()).take();
                        if let Some(w) = waker {
                            w.wake();
                        }
                    }
                    Work::Every { period, job } => {
                        let (id, period) = (entry.id, *period);
                        let mut next = entry.due + period;
                        while next <= now {
                            next += period;
                        }
                        entry.due = next;
                        let Some(mut run) = job.take() else { continue };
                        g.planned = None;
                        drop(g);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&mut run));
                        g = self.lock();
                        if let Some(e) = g.entries.iter_mut().find(|e| e.id == id)
                            && let Work::Every { job, .. } = &mut e.work
                        {
                            *job = Some(run);
                        }
                    }
                }
                continue;
            }
            let wake = g.entries.iter().map(|e| e.due + e.slack).min();
            g.planned = wake;
            g = match wake {
                None => self.cv.wait(g).unwrap_or_else(|e| e.into_inner()),
                Some(at) => {
                    self.cv
                        .wait_timeout(g, at.saturating_duration_since(now))
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
            };
            g.planned = None;
        }
    }
}

/// See [`sleep`] and [`tick`].
pub struct Sleep {
    id: Option<u64>,
    fired: Arc<Fired>,
}

impl Sleep {
    fn at(due: Instant, slack: Duration) -> Self {
        let fired = Arc::new(Fired::default());
        if due <= Instant::now() {
            fired.done.store(true, Ordering::Release);
            return Self { id: None, fired };
        }
        let id = clock().add(due, slack, Work::Wake(fired.clone()));
        Self {
            id: Some(id),
            fired,
        }
    }
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.fired.done.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        *self.fired.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(cx.waker().clone());
        // The clock may have fired between the check and storing the waker.
        if self.fired.done.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        Poll::Pending
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        if let Some(id) = self.id
            && !self.fired.done.load(Ordering::Acquire)
        {
            clock().remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn slack_is_a_sixteenth_capped_at_a_minute() {
        assert_eq!(slack(Duration::from_secs(16)), Duration::from_secs(1));
        assert_eq!(
            slack(Duration::from_secs(15 * 60)),
            Duration::from_secs(56250) / 1000
        );
        assert_eq!(slack(Duration::from_secs(3600)), Duration::from_secs(60));
    }

    #[test]
    fn grid_points_line_up_across_periods() {
        let epoch = Instant::now();
        let m = Duration::from_secs(60);
        let now = epoch + 31 * m;
        assert_eq!(next_on_grid(epoch, 15 * m, now), epoch + 45 * m);
        assert_eq!(next_on_grid(epoch, 30 * m, now), epoch + 60 * m);
        assert_eq!(next_on_grid(epoch, 60 * m, now), epoch + 60 * m);
        // Exactly on a point: the next one, never now.
        assert_eq!(next_on_grid(epoch, 15 * m, epoch + 45 * m), epoch + 60 * m);
    }

    #[tokio::test]
    async fn sleep_resolves_after_its_time() {
        let start = Instant::now();
        sleep(Duration::from_millis(50)).await;
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test]
    async fn a_dropped_sleep_leaves_no_timer_behind() {
        let s = sleep(Duration::from_secs(3600));
        let id = s.id.expect("registered");
        drop(s);
        assert!(!clock().lock().entries.iter().any(|e| e.id == id));
    }

    #[tokio::test]
    async fn an_earlier_sleep_cuts_a_long_wait_short() {
        let _long = sleep(Duration::from_secs(3600));
        tokio::time::timeout(Duration::from_secs(5), sleep(Duration::from_millis(20)))
            .await
            .expect("woke for the short timer");
    }

    #[test]
    fn every_runs_now_and_again() {
        let runs = Arc::new(AtomicUsize::new(0));
        let r = runs.clone();
        every(Duration::from_millis(30), true, move || {
            r.fetch_add(1, Ordering::SeqCst);
        });
        let start = Instant::now();
        while runs.load(Ordering::SeqCst) < 3 {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "job ran {runs:?} times"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
