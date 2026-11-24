//! Columnar time series with a min/max pyramid, and the M4 tracer: the same algorithm as `src/store.ts`,
//! step for step, so both draw the same paths.
//!
//! Level L keeps the min and max of each block of 8^L samples. The min and max of any index range come
//! from at most 2 × 7 entries per level, so tracing a viewport costs about the plot's width in pixel
//! columns times a few dozen reads, whatever the number of samples in it.

use std::fmt::Write;

const FAN_BITS: u32 = 3;
const FAN: usize = 1 << FAN_BITS;
const MASK: usize = FAN - 1;
const MAX_LEVELS: usize = 10;

/// The viewport and how to trace it (see `TraceOptions` in store.ts).
#[derive(Clone, Copy, Debug)]
pub struct Trace {
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub density: f64,
    /// NaN: a line; else the y each run closes down to.
    pub baseline: f64,
    pub span_gaps: bool,
    pub step: bool,
    /// Above 0: coordinates as integers in 1/scale points; else points to 1 decimal.
    pub scale: f64,
}

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct Stats {
    pub samples: usize,
    pub points: usize,
    pub decimated: bool,
}

#[derive(Default)]
struct Pyramid {
    /// min[L - 1], max[L - 1]: level L.
    min: Vec<Vec<f64>>,
    max: Vec<Vec<f64>>,
}

pub struct Series {
    pub x: Vec<f64>,
    pub y: Vec<Vec<f64>>,
    pyr: Vec<Pyramid>,
    levels: usize,
    max_points: usize,
    pub stats: Stats,
}

#[inline]
fn r1(v: f64) -> f64 {
    (v * 10.).round() / 10.
}

/// Writes a coordinate as JS's `String(number)` would for values rounded to 1 decimal.
#[inline]
fn num(d: &mut String, v: f64) {
    if v == v.trunc() && v.abs() < 1e15 {
        let _ = write!(d, "{}", v as i64);
    } else {
        let _ = write!(d, "{}", v);
    }
}

#[inline]
fn blocks(n: usize, level: usize) -> usize {
    let shift = FAN_BITS as usize * level;
    (n + (1 << shift) - 1) >> shift
}

fn levels_for(n: usize) -> usize {
    let mut l = 0;
    while n > 1 << (FAN_BITS as usize * l) && l < MAX_LEVELS {
        l += 1;
    }
    l
}

impl Series {
    pub fn new(series: usize, max_points: usize) -> Self {
        let series = series.max(1);
        Series {
            x: Vec::new(),
            y: vec![Vec::new(); series],
            pyr: (0..series).map(|_| Pyramid::default()).collect(),
            levels: 0,
            max_points: if max_points == 0 { usize::MAX } else { max_points },
            stats: Stats::default(),
        }
    }

    pub fn series_count(&self) -> usize {
        self.y.len()
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    /// Replaces everything: `ys[s]` is series s (shorter ones padded with NaN).
    pub fn set_data(&mut self, x: Vec<f64>, ys: Vec<Vec<f64>>) {
        let n = x.len();
        self.x = x;
        for (s, col) in self.y.iter_mut().enumerate() {
            col.clear();
            if let Some(src) = ys.get(s) {
                col.extend_from_slice(&src[..src.len().min(n)]);
            }
            col.resize(n, f64::NAN);
        }
        self.trim(false);
        self.rebuild(0);
    }

    /// Adds samples at the end: `ys[s]` holds series s's values for them (missing ones NaN).
    pub fn append(&mut self, x: &[f64], ys: &[Vec<f64>]) {
        let start = self.x.len();
        let k = x.len();
        if k == 0 {
            return;
        }
        self.x.extend_from_slice(x);
        for (s, col) in self.y.iter_mut().enumerate() {
            match ys.get(s) {
                Some(src) => {
                    col.extend_from_slice(&src[..src.len().min(k)]);
                    col.resize(start + k, f64::NAN);
                }
                None => col.resize(start + k, f64::NAN),
            }
        }
        // Fold the new samples in first: trimming shifts the pyramid as it is.
        self.extend(start);
        self.trim(true);
    }

    pub fn clear(&mut self) {
        self.x.clear();
        for col in &mut self.y {
            col.clear();
        }
        self.rebuild(0);
    }

    /// Drops old samples past `max_points` (in batches when `batched`); true when the pyramid was redone.
    fn trim(&mut self, batched: bool) -> bool {
        let n = self.x.len();
        if n <= self.max_points {
            return false;
        }
        let over = n - self.max_points;
        if batched && over < (self.max_points >> 3).max(64) {
            return false;
        }
        let mut keep = 0usize;
        while keep < self.levels && (FAN << (FAN_BITS as usize * keep)) <= over {
            keep += 1;
        }
        let block = 1usize << (FAN_BITS as usize * keep);
        let drop = if batched { over - over % block } else { over };
        self.x.drain(..drop);
        for col in &mut self.y {
            col.drain(..drop);
        }
        if !batched || drop % block != 0 {
            self.rebuild(0);
            return true;
        }
        let n = self.x.len();
        for p in &mut self.pyr {
            for l in 1..=keep {
                let shift = drop >> (FAN_BITS as usize * l);
                let count = blocks(n, l);
                p.min[l - 1].drain(..shift);
                p.max[l - 1].drain(..shift);
                p.min[l - 1].truncate(count);
                p.max[l - 1].truncate(count);
            }
        }
        self.rebuild(keep);
        true
    }

    /// Works out every level above `from` again from the one below.
    fn rebuild(&mut self, from: usize) {
        let n = self.x.len();
        let levels = levels_for(n);
        for (s, p) in self.pyr.iter_mut().enumerate() {
            p.min.truncate(levels.max(from));
            p.max.truncate(levels.max(from));
            for l in from + 1..=levels {
                let count = blocks(n, l);
                let (mut mn, mut mx) = (vec![f64::INFINITY; count], vec![f64::NEG_INFINITY; count]);
                if l == 1 {
                    let y = &self.y[s];
                    for (i, &v) in y.iter().enumerate() {
                        let b = i >> FAN_BITS;
                        if v < mn[b] {
                            mn[b] = v;
                        }
                        if v > mx[b] {
                            mx[b] = v;
                        }
                    }
                } else {
                    let (cmn, cmx) = (&p.min[l - 2], &p.max[l - 2]);
                    for i in 0..cmn.len() {
                        let b = i >> FAN_BITS;
                        if cmn[i] < mn[b] {
                            mn[b] = cmn[i];
                        }
                        if cmx[i] > mx[b] {
                            mx[b] = cmx[i];
                        }
                    }
                }
                if p.min.len() >= l {
                    p.min[l - 1] = mn;
                    p.max[l - 1] = mx;
                } else {
                    p.min.push(mn);
                    p.max.push(mx);
                }
            }
        }
        self.levels = levels;
    }

    /// Folds samples from `start` on into the pyramid.
    fn extend(&mut self, start: usize) {
        let n = self.x.len();
        let levels = levels_for(n);
        let old = self.levels;
        let upto = levels.min(old);
        for (s, p) in self.pyr.iter_mut().enumerate() {
            let y = &self.y[s];
            for l in 1..=upto {
                let shift = FAN_BITS as usize * l;
                let count = blocks(n, l);
                let first = start >> shift;
                let (mn, mx) = (&mut p.min[l - 1], &mut p.max[l - 1]);
                mn.resize(count, f64::INFINITY);
                mx.resize(count, f64::NEG_INFINITY);
                if start & ((1 << shift) - 1) == 0 {
                    mn[first] = f64::INFINITY;
                    mx[first] = f64::NEG_INFINITY;
                }
                for (i, &v) in y.iter().enumerate().skip(start) {
                    let b = i >> shift;
                    if b != first && (i & ((1 << shift) - 1)) == 0 {
                        mn[b] = f64::INFINITY;
                        mx[b] = f64::NEG_INFINITY;
                    }
                    if v < mn[b] {
                        mn[b] = v;
                    }
                    if v > mx[b] {
                        mx[b] = v;
                    }
                }
            }
        }
        if levels > old {
            self.rebuild(old);
        }
    }

    pub fn lower_bound(&self, x: f64) -> usize {
        self.x.partition_point(|&v| v < x)
    }

    pub fn upper_bound(&self, x: f64) -> usize {
        self.x.partition_point(|&v| v <= x)
    }

    pub fn nearest(&self, x: f64) -> Option<usize> {
        let n = self.x.len();
        if n == 0 {
            return None;
        }
        let i = self.lower_bound(x);
        if i == 0 {
            return Some(0);
        }
        if i >= n {
            return Some(n - 1);
        }
        Some(if x - self.x[i - 1] <= self.x[i] - x { i - 1 } else { i })
    }

    /// The min and max of series `s` over [a, b), NaNs skipped: (inf, -inf) when none.
    pub fn range_min_max(&self, s: usize, mut a: usize, mut b: usize) -> (f64, f64) {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        let y = &self.y[s];
        let p = &self.pyr[s];
        b = b.min(y.len());
        let mut l = 0;
        let take = |v: f64, lo: &mut f64, hi: &mut f64| {
            if v < *lo {
                *lo = v;
            }
            if v > *hi {
                *hi = v;
            }
        };
        while a < b {
            if l < self.levels && b - a >= FAN * 2 {
                if l == 0 {
                    while a & MASK != 0 {
                        take(y[a], &mut lo, &mut hi);
                        a += 1;
                    }
                    while b & MASK != 0 {
                        b -= 1;
                        take(y[b], &mut lo, &mut hi);
                    }
                } else {
                    let (mn, mx) = (&p.min[l - 1], &p.max[l - 1]);
                    while a & MASK != 0 {
                        if mn[a] < lo { lo = mn[a]; }
                        if mx[a] > hi { hi = mx[a]; }
                        a += 1;
                    }
                    while b & MASK != 0 {
                        b -= 1;
                        if mn[b] < lo { lo = mn[b]; }
                        if mx[b] > hi { hi = mx[b]; }
                    }
                }
                a >>= FAN_BITS;
                b >>= FAN_BITS;
                l += 1;
            } else if l == 0 {
                for &v in &y[a..b] {
                    take(v, &mut lo, &mut hi);
                }
                a = b;
            } else {
                let (mn, mx) = (&p.min[l - 1], &p.max[l - 1]);
                for i in a..b {
                    if mn[i] < lo { lo = mn[i]; }
                    if mx[i] > hi { hi = mx[i]; }
                }
                a = b;
            }
        }
        (lo, hi)
    }

    /// Series `s` for a viewport as SVG path data: every sample when few enough, else M4 per pixel column.
    pub fn trace(&mut self, s: usize, o: &Trace) -> String {
        self.stats = Stats::default();
        let n = self.x.len();
        let mut d = String::new();
        if n == 0 || s >= self.y.len() || !(o.x1 > o.x0) || !(o.width > 0.) || !(o.height > 0.) {
            return d;
        }
        let xs = &self.x;
        let y = &self.y[s];
        let scale = o.scale;
        let rr = move |v: f64| if scale > 0. { (v * scale).round() } else { r1(v) };
        let kx = o.width / (o.x1 - o.x0);
        let ky = if o.y1 == o.y0 { 0. } else { o.height / (o.y1 - o.y0) };
        let bottom = o.top + o.height;
        let mid_y = rr(o.top + o.height / 2.);
        let baseline = if o.baseline.is_nan() { f64::NAN } else { rr(o.baseline) };
        let fill = !baseline.is_nan();
        let py_of = |v: f64| if ky == 0. { mid_y } else { rr(bottom - (v - o.y0) * ky) };
        let mut i0 = self.lower_bound(o.x0);
        i0 = i0.saturating_sub(1);
        let mut i1 = self.upper_bound(o.x1);
        if i1 < n {
            i1 += 1;
        }
        let cols = ((o.width * if o.density > 0. { o.density } else { 1. }).ceil() as usize).max(1);
        let mut stats = Stats { samples: i1 - i0, ..Stats::default() };
        d.reserve(cols * 24);
        let mut open = false;
        let mut run_x = 0.;
        let close = |d: &mut String, run_x: f64| {
            d.push('V');
            num(d, baseline);
            d.push('H');
            num(d, run_x);
            d.push('Z');
        };
        let begin = |d: &mut String, px: f64, py: f64| {
            d.push('M');
            num(d, px);
            d.push(' ');
            if fill {
                num(d, baseline);
                d.push('V');
            }
            num(d, py);
        };
        let join = |d: &mut String, px: f64, py: f64| {
            if o.step {
                d.push('H');
                num(d, px);
                d.push('V');
            } else {
                d.push('L');
                num(d, px);
                d.push(' ');
            }
            num(d, py);
        };
        if i1 - i0 <= cols * 2 {
            for i in i0..i1 {
                let v = y[i];
                if v.is_nan() {
                    if !o.span_gaps && open {
                        if fill {
                            close(&mut d, run_x);
                        }
                        open = false;
                    }
                    continue;
                }
                let px = rr(o.left + (xs[i] - o.x0) * kx);
                let py = py_of(v);
                if !open {
                    begin(&mut d, px, py);
                    open = true;
                    run_x = px;
                } else {
                    join(&mut d, px, py);
                }
                stats.points += 1;
            }
        } else {
            stats.decimated = true;
            let col_w = (o.x1 - o.x0) / cols as f64;
            let px_w = o.width / cols as f64;
            let mut a = i0;
            if xs[a] < o.x0 {
                if !y[a].is_nan() {
                    let px = rr(o.left + (xs[a] - o.x0) * kx);
                    begin(&mut d, px, py_of(y[a]));
                    open = true;
                    run_x = px;
                    stats.points += 1;
                }
                a += 1;
            }
            let c0 = (((xs[a.min(n - 1)] - o.x0) / col_w).floor()).max(0.) as usize;
            let mut c = c0;
            while c <= cols && a < i1 {
                let b = if c == cols {
                    i1
                } else {
                    let edge = o.x0 + (c + 1) as f64 * col_w;
                    a + xs[a..i1].partition_point(|&v| v < edge)
                };
                if b == a {
                    c += 1;
                    continue;
                }
                let px = if c == cols { rr(o.left + (xs[b - 1] - o.x0) * kx) } else { rr(o.left + (c as f64 + 0.5) * px_w) };
                let (first, last) = (y[a], y[b - 1]);
                let (lo, hi) = if b - a == 1 { (first, first) } else { self.range_min_max(s, a, b) };
                a = b;
                c += 1;
                if lo > hi || lo.is_nan() {
                    if !o.span_gaps && open {
                        if fill {
                            close(&mut d, run_x);
                        }
                        open = false;
                    }
                    continue;
                }
                let p_first = if first.is_nan() { lo } else { first };
                let p_last = if last.is_nan() { hi } else { last };
                let (y_first, y_lo, y_hi, y_last) = (py_of(p_first), py_of(lo), py_of(hi), py_of(p_last));
                if !open {
                    begin(&mut d, px, y_first);
                    open = true;
                    run_x = px;
                } else {
                    join(&mut d, px, y_first);
                }
                stats.points += 1;
                if y_lo != y_hi {
                    if y_first != y_lo {
                        d.push('V');
                        num(&mut d, y_lo);
                    }
                    d.push('V');
                    num(&mut d, y_hi);
                    if y_last != y_hi {
                        d.push('V');
                        num(&mut d, y_last);
                    }
                    stats.points += 2;
                } else if y_last != y_first {
                    d.push('V');
                    num(&mut d, y_last);
                    stats.points += 1;
                }
            }
        }
        if open && fill {
            close(&mut d, run_x);
        }
        self.stats = stats;
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave(n: usize) -> (Vec<f64>, Vec<f64>) {
        let x: Vec<f64> = (0..n).map(|i| i as f64 * 10.).collect();
        let y: Vec<f64> = (0..n).map(|i| ((i as f64) * 0.013).sin() * 50. + ((i * 7919) % 101) as f64 * 0.1).collect();
        (x, y)
    }

    fn brute(y: &[f64], a: usize, b: usize) -> (f64, f64) {
        y[a..b].iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| (if v < lo { v } else { lo }, if v > hi { v } else { hi }))
    }

    #[test]
    fn range_min_max_matches_a_scan() {
        let (x, y) = wave(70_000);
        let mut s = Series::new(1, 0);
        s.set_data(x, vec![y.clone()]);
        for &(a, b) in &[(0, 70_000), (3, 9), (5, 4096), (1, 69_999), (12_345, 54_321), (511, 513), (0, 1)] {
            assert_eq!(s.range_min_max(0, a, b), brute(&y, a, b), "{a}..{b}");
        }
    }

    #[test]
    fn appending_builds_the_same_pyramid() {
        let (x, y) = wave(20_000);
        let mut whole = Series::new(1, 0);
        whole.set_data(x.clone(), vec![y.clone()]);
        let mut parts = Series::new(1, 0);
        for (cx, cy) in x.chunks(777).zip(y.chunks(777)) {
            parts.append(cx, &[cy.to_vec()]);
        }
        for &(a, b) in &[(0, 20_000), (100, 19_000), (4095, 4097)] {
            assert_eq!(whole.range_min_max(0, a, b), parts.range_min_max(0, a, b));
        }
        let o = Trace { x0: 0., x1: 200_000., y0: -60., y1: 60., left: 0., top: 0., width: 300., height: 100., density: 1., baseline: f64::NAN, span_gaps: false, step: false, scale: 0. };
        assert_eq!(whole.trace(0, &o), parts.trace(0, &o));
    }

    #[test]
    fn trimming_keeps_the_newest_and_stays_correct() {
        let (x, y) = wave(50_000);
        let mut s = Series::new(1, 10_000);
        for (cx, cy) in x.chunks(500).zip(y.chunks(500)) {
            s.append(cx, &[cy.to_vec()]);
        }
        assert!(s.len() >= 10_000 && s.len() <= 10_000 + 10_000 / 8 + 500, "{}", s.len());
        assert_eq!(*s.x.last().unwrap(), 499_990.);
        let n = s.len();
        let tail = &y[50_000 - n..];
        assert_eq!(s.range_min_max(0, 0, n), brute(tail, 0, n));
        assert_eq!(s.range_min_max(0, 17, n - 3), brute(tail, 17, n - 3));
    }

    #[test]
    fn decimated_trace_covers_each_columns_extremes() {
        let (x, y) = wave(1_000_000);
        let mut s = Series::new(1, 0);
        s.set_data(x, vec![y]);
        let o = Trace { x0: 0., x1: 10_000_000., y0: -60., y1: 60., left: 10., top: 5., width: 800., height: 300., density: 1., baseline: f64::NAN, span_gaps: false, step: false, scale: 0. };
        let d = s.trace(0, &o);
        assert!(s.stats.decimated);
        assert!(s.stats.points <= 801 * 4, "{}", s.stats.points);
        assert!(d.starts_with('M'));
    }

    #[test]
    fn gaps_break_the_line() {
        let x: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let mut y: Vec<f64> = (0..10).map(|i| i as f64).collect();
        y[5] = f64::NAN;
        let mut s = Series::new(1, 0);
        s.set_data(x, vec![y]);
        let o = Trace { x0: 0., x1: 9., y0: 0., y1: 9., left: 0., top: 0., width: 90., height: 90., density: 1., baseline: f64::NAN, span_gaps: false, step: false, scale: 0. };
        let d = s.trace(0, &o);
        assert_eq!(d.matches('M').count(), 2, "{d}");
    }
}
