//! nsh-o11y's native part (`nsh-o11y/native`): time series storage, level-of-detail and path tracing in
//! Rust.
//!
//! An app that adds the nsh-o11y nshm imports it and hands it to nsh-o11y once:
//!
//! ```ts
//! import * as native from "nsh-o11y/native";
//! import { setNativeBackend } from "nsh-o11y";
//! setNativeBackend(native);
//! ```
//!
//! From then on `createTimeSeries` keeps samples here: they cross into Rust once, when appended, and each
//! frame only the viewport goes in and one SVG path per series comes out. Bulk data crosses as
//! little-endian `f64` buffers in `Uint8Array`s.

use nsh_core::prelude::*;

pub mod lod;

use lod::{Series, Trace};

#[native_module("nsh-o11y/native")]
fn native(registry: &mut Registry) {
    registry.class::<SeriesBuffer>();
}

fn f64s(bytes: &[u8]) -> Vec<f64> {
    bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}

/// Splits `values` (series after series, `k` each) into columns.
fn columns(values: Vec<f64>, series: usize, k: usize) -> Result<Vec<Vec<f64>>, String> {
    if k == 0 {
        return Ok(vec![Vec::new(); series]);
    }
    if values.len() % k != 0 || values.len() / k > series {
        return Err(format!("expected up to {series} series of {k} values, got {} values", values.len()));
    }
    Ok(values.chunks_exact(k).map(|c| c.to_vec()).collect())
}

/// Samples of one or more series sharing their times, with a min/max pyramid for drawing any viewport
/// in time proportional to its width. nsh-o11y's `createTimeSeries` wraps it.
#[class]
pub struct SeriesBuffer {
    inner: Series,
}

#[class]
impl SeriesBuffer {
    /// `series` y columns; keep at most `maxPoints` samples (0: no limit).
    pub fn new(series: f64, max_points: f64) -> Self {
        let max = if max_points.is_finite() && max_points > 0. { max_points as usize } else { 0 };
        SeriesBuffer { inner: Series::new(series.clamp(1., 1024.) as usize, max) }
    }

    /// How many series (y columns) it holds.
    pub fn series_count(&self) -> f64 {
        self.inner.series_count() as f64
    }

    /// How many samples each series has.
    pub fn length(&self) -> f64 {
        self.inner.len() as f64
    }

    /// Replaces everything: `x` the times, `ys` the series one after another, each as long as `x` (f64 LE).
    pub fn set_data(&mut self, x: Vec<u8>, ys: Vec<u8>) -> Result<(), String> {
        let x = f64s(&x);
        let cols = columns(f64s(&ys), self.inner.series_count(), x.len())?;
        self.inner.set_data(x, cols);
        Ok(())
    }

    /// Adds samples: `x` their times, `ys` the series one after another, as many each (f64 LE).
    pub fn append(&mut self, x: Vec<u8>, ys: Vec<u8>) -> Result<(), String> {
        let x = f64s(&x);
        let cols = columns(f64s(&ys), self.inner.series_count(), x.len())?;
        self.inner.append(&x, &cols);
        Ok(())
    }

    /// Adds one sample: its time and each series' value.
    pub fn append_row(&mut self, x: f64, ys: Vec<f64>) {
        let cols: Vec<Vec<f64>> = ys.into_iter().map(|v| vec![v]).collect();
        self.inner.append(&[x], &cols);
    }

    /// Drops every sample.
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// The time of sample `i` (NaN past the end).
    pub fn x(&self, i: f64) -> f64 {
        self.inner.x.get(i as usize).copied().unwrap_or(f64::NAN)
    }

    /// Series `s`'s value at sample `i` (NaN: none).
    pub fn y(&self, s: f64, i: f64) -> f64 {
        self.inner.y.get(s as usize).and_then(|c| c.get(i as usize)).copied().unwrap_or(f64::NAN)
    }

    /// Every series' value at sample `i`.
    pub fn row(&self, i: f64) -> Vec<f64> {
        self.inner.y.iter().map(|c| c.get(i as usize).copied().unwrap_or(f64::NAN)).collect()
    }

    /// The first sample at or after `x` (the length when none).
    pub fn lower_bound(&self, x: f64) -> f64 {
        self.inner.lower_bound(x) as f64
    }

    /// The first sample after `x` (the length when none).
    pub fn upper_bound(&self, x: f64) -> f64 {
        self.inner.upper_bound(x) as f64
    }

    /// The sample nearest `x`, -1 when empty.
    pub fn nearest(&self, x: f64) -> f64 {
        self.inner.nearest(x).map_or(-1., |i| i as f64)
    }

    /// [min, max] of series `s` over samples [i0, i1), NaNs skipped.
    pub fn extent(&self, s: f64, i0: f64, i1: f64) -> Vec<f64> {
        let s = s as usize;
        if s >= self.inner.series_count() {
            return vec![f64::INFINITY, f64::NEG_INFINITY];
        }
        let (a, b) = (i0.max(0.) as usize, (i1.max(0.) as usize).min(self.inner.len()));
        let (lo, hi) = self.inner.range_min_max(s, a, b);
        vec![lo, hi]
    }

    /// Series `s` as SVG path data. `o`: x0, x1, y0, y1, left, top, width, height, density, baseline (NaN:
    /// a line), spanGaps (1/0), step (1/0), and optionally scale (integers in 1/scale points; 0: decimals).
    pub fn trace(&mut self, s: f64, o: Vec<f64>) -> Result<String, String> {
        let [x0, x1, y0, y1, left, top, width, height, density, baseline, span_gaps, step, ref rest @ ..] = o[..] else {
            return Err(format!("trace takes 12 or 13 values, not {}", o.len()));
        };
        let scale = rest.first().copied().unwrap_or(0.);
        let t = Trace { x0, x1, y0, y1, left, top, width, height, density, baseline, span_gaps: span_gaps != 0., step: step != 0., scale };
        Ok(self.inner.trace(s as usize, &t))
    }

    /// The last trace's samples, points and whether it decimated (1/0).
    pub fn stats(&self) -> Vec<f64> {
        let s = self.inner.stats;
        vec![s.samples as f64, s.points as f64, if s.decimated { 1. } else { 0. }]
    }
}
