#![doc = include_str!("../README.md")]
//!
//! ---
//!
//! # API Documentation

#![cfg_attr(docsrs, feature(doc_cfg))]
#![allow(clippy::missing_const_for_fn)]

use core::ffi::c_void;
use core::ptr;

pub(crate) mod advanced;
pub(crate) mod argument;
pub(crate) mod command;
pub(crate) mod exhaustive;
/// Groups `Metal` framework constants for `ffi`.
pub mod ffi;
pub(crate) mod metalfx;
pub(crate) mod pipeline;
pub(crate) mod render;
pub(crate) mod state;
pub(crate) mod util;

/// Re-exports the `Metal` framework surface for this item.
pub use advanced::*;
/// Re-exports the `Metal` framework surface for this item.
pub use argument::*;
/// Re-exports the `Metal` framework surface for this item.
pub use command::*;
/// Re-exports the `Metal` framework surface for this item.
pub use exhaustive::*;
/// Re-exports the `Metal` framework surface for this item.
pub use metalfx::*;
/// Re-exports the `Metal` framework surface for this item.
pub use pipeline::*;
/// Re-exports the `Metal` framework surface for this item.
pub use render::*;
/// Re-exports the `Metal` framework surface for this item.
pub use state::*;

/// Common `MTLPixelFormat` constants.
pub mod pixel_format {
    /// Mirrors the `Metal` framework constant `A8UNORM`.
    pub const A8UNORM: usize = 1;
    /// Mirrors the `Metal` framework constant `R8UNORM`.
    pub const R8UNORM: usize = 10;
    /// Mirrors the `Metal` framework constant `R8SNORM`.
    pub const R8SNORM: usize = 12;
    /// Mirrors the `Metal` framework constant `R8UINT`.
    pub const R8UINT: usize = 13;
    /// Mirrors the `Metal` framework constant `R8SINT`.
    pub const R8SINT: usize = 14;
    /// Mirrors the `Metal` framework constant `R16UNORM`.
    pub const R16UNORM: usize = 20;
    /// Mirrors the `Metal` framework constant `R16SNORM`.
    pub const R16SNORM: usize = 22;
    /// Mirrors the `Metal` framework constant `R16UINT`.
    pub const R16UINT: usize = 23;
    /// Mirrors the `Metal` framework constant `R16SINT`.
    pub const R16SINT: usize = 24;
    /// Mirrors the `Metal` framework constant `R16FLOAT`.
    pub const R16FLOAT: usize = 25;
    /// Mirrors the `Metal` framework constant `RG8UNORM`.
    pub const RG8UNORM: usize = 30;
    /// Mirrors the `Metal` framework constant `RG8SNORM`.
    pub const RG8SNORM: usize = 32;
    /// Mirrors the `Metal` framework constant `RG8UINT`.
    pub const RG8UINT: usize = 33;
    /// Mirrors the `Metal` framework constant `RG8SINT`.
    pub const RG8SINT: usize = 34;
    /// Mirrors the `Metal` framework constant `RGBA8UNORM`.
    pub const RGBA8UNORM: usize = 70;
    /// Mirrors the `Metal` framework constant `RGBA8UNORM_SRGB`.
    pub const RGBA8UNORM_SRGB: usize = 71;
    /// Mirrors the `Metal` framework constant `RGBA8SNORM`.
    pub const RGBA8SNORM: usize = 72;
    /// Mirrors the `Metal` framework constant `RGBA8UINT`.
    pub const RGBA8UINT: usize = 73;
    /// Mirrors the `Metal` framework constant `RGBA8SINT`.
    pub const RGBA8SINT: usize = 74;
    /// Mirrors the `Metal` framework constant `BGRA8UNORM`.
    pub const BGRA8UNORM: usize = 80;
    /// Mirrors the `Metal` framework constant `BGRA8UNORM_SRGB`.
    pub const BGRA8UNORM_SRGB: usize = 81;
    /// Mirrors the `Metal` framework constant `R32FLOAT`.
    pub const R32FLOAT: usize = 55;
    /// Mirrors the `Metal` framework constant `RG16FLOAT`.
    pub const RG16FLOAT: usize = 65;
    /// Mirrors the `Metal` framework constant `RGBA16FLOAT`.
    pub const RGBA16FLOAT: usize = 115;
    /// Mirrors the `Metal` framework constant `RGBA32FLOAT`.
    pub const RGBA32FLOAT: usize = 125;
    /// Mirrors the `Metal` framework constant `DEPTH32FLOAT`.
    pub const DEPTH32FLOAT: usize = 252;
    /// Mirrors the `Metal` framework constant `STENCIL8`.
    pub const STENCIL8: usize = 253;
    /// Mirrors the `Metal` framework constant `BGRA10_XR`.
    pub const BGRA10_XR: usize = 552;
    /// Mirrors the `Metal` framework constant `BGR10_XR`.
    pub const BGR10_XR: usize = 554;
}

/// `MTLStorageMode` enum values — memory residency hints.
pub mod storage_mode {
    /// Mirrors the `Metal` framework constant `SHARED`.
    pub const SHARED: usize = 0;
    /// Mirrors the `Metal` framework constant `MANAGED`.
    pub const MANAGED: usize = 1;
    /// Mirrors the `Metal` framework constant `PRIVATE`.
    pub const PRIVATE: usize = 2;
    /// Mirrors the `Metal` framework constant `MEMORYLESS`.
    pub const MEMORYLESS: usize = 3;
}

/// `MTLCPUCacheMode` enum values.
pub mod cpu_cache_mode {
    /// Mirrors the `Metal` framework constant `DEFAULT_CACHE`.
    pub const DEFAULT_CACHE: usize = 0;
    /// Mirrors the `Metal` framework constant `WRITE_COMBINED`.
    pub const WRITE_COMBINED: usize = 1;
}

/// `MTLHazardTrackingMode` enum values.
pub mod hazard_tracking_mode {
    /// Mirrors the `Metal` framework constant `DEFAULT`.
    pub const DEFAULT: usize = 0;
    /// Mirrors the `Metal` framework constant `UNTRACKED`.
    pub const UNTRACKED: usize = 1;
    /// Mirrors the `Metal` framework constant `TRACKED`.
    pub const TRACKED: usize = 2;
}

/// `MTLResourceOptions` bitmask values.
pub mod resource_options {
    /// Mirrors the `Metal` framework constant `CPU_CACHE_MODE_DEFAULT`.
    pub const CPU_CACHE_MODE_DEFAULT: usize = 0;
    /// Mirrors the `Metal` framework constant `CPU_CACHE_MODE_WRITE_COMBINED`.
    pub const CPU_CACHE_MODE_WRITE_COMBINED: usize = 1;
    /// Mirrors the `Metal` framework constant `STORAGE_MODE_SHARED`.
    pub const STORAGE_MODE_SHARED: usize = 0;
    /// Mirrors the `Metal` framework constant `STORAGE_MODE_MANAGED`.
    pub const STORAGE_MODE_MANAGED: usize = 1 << 4;
    /// Mirrors the `Metal` framework constant `STORAGE_MODE_PRIVATE`.
    pub const STORAGE_MODE_PRIVATE: usize = 2 << 4;
    /// Mirrors the `Metal` framework constant `HAZARD_TRACKING_MODE_DEFAULT`.
    pub const HAZARD_TRACKING_MODE_DEFAULT: usize = 0;
    /// Mirrors the `Metal` framework constant `HAZARD_TRACKING_MODE_UNTRACKED`.
    pub const HAZARD_TRACKING_MODE_UNTRACKED: usize = 1 << 8;
    /// Mirrors the `Metal` framework constant `HAZARD_TRACKING_MODE_TRACKED`.
    pub const HAZARD_TRACKING_MODE_TRACKED: usize = 2 << 8;
}

/// `MTLTextureUsage` bitmask.
pub mod texture_usage {
    /// Mirrors the `Metal` framework constant `SHADER_READ`.
    pub const SHADER_READ: usize = 0x01;
    /// Mirrors the `Metal` framework constant `SHADER_WRITE`.
    pub const SHADER_WRITE: usize = 0x02;
    /// Mirrors the `Metal` framework constant `RENDER_TARGET`.
    pub const RENDER_TARGET: usize = 0x04;
}

/// `MTLGPUFamily` — feature-family identifiers.
pub mod gpu_family {
    /// Mirrors the `Metal` framework constant `APPLE1`.
    pub const APPLE1: i64 = 1001;
    /// Mirrors the `Metal` framework constant `APPLE2`.
    pub const APPLE2: i64 = 1002;
    /// Mirrors the `Metal` framework constant `APPLE3`.
    pub const APPLE3: i64 = 1003;
    /// Mirrors the `Metal` framework constant `APPLE4`.
    pub const APPLE4: i64 = 1004;
    /// Mirrors the `Metal` framework constant `APPLE5`.
    pub const APPLE5: i64 = 1005;
    /// Mirrors the `Metal` framework constant `APPLE6`.
    pub const APPLE6: i64 = 1006;
    /// Mirrors the `Metal` framework constant `APPLE7`.
    pub const APPLE7: i64 = 1007;
    /// Mirrors the `Metal` framework constant `APPLE8`.
    pub const APPLE8: i64 = 1008;
    /// Mirrors the `Metal` framework constant `APPLE9`.
    pub const APPLE9: i64 = 1009;
    /// Mirrors the `Metal` framework constant `MAC1`.
    pub const MAC1: i64 = 2001;
    /// Mirrors the `Metal` framework constant `MAC2`.
    pub const MAC2: i64 = 2002;
    /// Mirrors the `Metal` framework constant `COMMON1`.
    pub const COMMON1: i64 = 3001;
    /// Mirrors the `Metal` framework constant `COMMON2`.
    pub const COMMON2: i64 = 3002;
    /// Mirrors the `Metal` framework constant `COMMON3`.
    pub const COMMON3: i64 = 3003;
    /// Mirrors the `Metal` framework constant `METAL3`.
    pub const METAL3: i64 = 5001;
}

// ---- Device ----

/// Apple's `id<MTLDevice>` — handle to a Metal GPU.
pub struct MetalDevice {
    ptr: *mut c_void,
    drop_on_release: bool,
}

// SAFETY: `id<MTLDevice>` is thread-safe: creation, capability queries, and
// resource allocation all synchronize internally via ObjC ARC + Metal's own locks.
unsafe impl Send for MetalDevice {}
unsafe impl Sync for MetalDevice {}

impl Drop for MetalDevice {
    fn drop(&mut self) {
        if self.drop_on_release && !self.ptr.is_null() {
            unsafe { ffi::am_device_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalDevice {
    /// Return the system's default Metal device.
    #[must_use]
    pub fn system_default() -> Option<Self> {
        let p = unsafe { ffi::am_device_system_default() };
        if p.is_null() {
            None
        } else {
            Some(unsafe { Self::from_retained_ptr(p) })
        }
    }

    /// Raw `id<MTLDevice>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    /// True if the GPU uses unified memory (Apple Silicon).
    #[must_use]
    pub fn has_unified_memory(&self) -> bool {
        unsafe { ffi::am_device_has_unified_memory(self.ptr) }
    }

    /// Recommended maximum working-set size in bytes.
    #[must_use]
    pub fn recommended_max_working_set_size(&self) -> u64 {
        unsafe { ffi::am_device_recommended_max_working_set_size(self.ptr) }
    }

    /// True if this device supports the requested feature family —
    /// see [`gpu_family`].
    #[must_use]
    pub fn supports_family(&self, family: i64) -> bool {
        unsafe { ffi::am_device_supports_family(self.ptr, family) }
    }

    /// Allocate a GPU-visible buffer of `length` bytes.
    /// `options` is an `MTLResourceOptions` bitmask (see
    /// [`resource_options`]).
    #[must_use]
    pub fn new_buffer(&self, length: usize, options: usize) -> Option<MetalBuffer> {
        let p = unsafe { ffi::am_device_new_buffer(self.ptr, length, options) };
        if p.is_null() {
            None
        } else {
            Some(MetalBuffer { ptr: p })
        }
    }

    /// Allocate a fresh `MTLTexture` matching `descriptor`.
    #[must_use]
    pub fn new_texture(&self, descriptor: TextureDescriptor) -> Option<MetalTexture> {
        let p = unsafe {
            ffi::am_device_new_texture_2d(
                self.ptr,
                descriptor.pixel_format,
                descriptor.width,
                descriptor.height,
                descriptor.mipmapped,
                descriptor.usage,
                descriptor.storage_mode,
            )
        };
        if p.is_null() {
            None
        } else {
            Some(MetalTexture { ptr: p })
        }
    }

    /// Create a new `MTLCommandQueue` to schedule GPU work.
    #[must_use]
    pub fn new_command_queue(&self) -> Option<CommandQueue> {
        let p = unsafe { ffi::am_device_new_command_queue(self.ptr) };
        if p.is_null() {
            None
        } else {
            Some(CommandQueue { ptr: p })
        }
    }

    /// Compile a Metal Shading Language source string into a runtime
    /// `MTLLibrary`. On error, returns the localized Metal compiler
    /// diagnostic.
    ///
    /// # Errors
    ///
    /// Returns the Metal compiler's localized error string on failure.
    pub fn new_library_with_source(&self, source: &str) -> Result<MetalLibrary, String> {
        let csrc = std::ffi::CString::new(source).map_err(|e| e.to_string())?;
        let mut err_msg: *mut core::ffi::c_char = core::ptr::null_mut();
        let p = unsafe {
            ffi::am_device_new_library_with_source(self.ptr, csrc.as_ptr(), &mut err_msg)
        };
        if p.is_null() {
            let msg = if err_msg.is_null() {
                "MTLDevice.makeLibrary returned nil".to_string()
            } else {
                let s = unsafe { std::ffi::CStr::from_ptr(err_msg) }
                    .to_string_lossy()
                    .into_owned();
                unsafe { libc::free(err_msg.cast()) };
                s
            };
            Err(msg)
        } else {
            Ok(MetalLibrary { ptr: p })
        }
    }

    /// Compile a kernel into a `MTLComputePipelineState` ready for
    /// dispatch on a command buffer.
    ///
    /// # Errors
    ///
    /// Returns the Metal pipeline compiler's localized error string
    /// on failure.
    pub fn new_compute_pipeline_state(
        &self,
        function: &MetalFunction,
    ) -> Result<ComputePipelineState, String> {
        let mut err_msg: *mut core::ffi::c_char = core::ptr::null_mut();
        let p = unsafe {
            ffi::am_device_new_compute_pipeline_state(self.ptr, function.ptr, &mut err_msg)
        };
        if p.is_null() {
            let msg = if err_msg.is_null() {
                "MTLDevice.makeComputePipelineState returned nil".to_string()
            } else {
                let s = unsafe { std::ffi::CStr::from_ptr(err_msg) }
                    .to_string_lossy()
                    .into_owned();
                unsafe { libc::free(err_msg.cast()) };
                s
            };
            Err(msg)
        } else {
            Ok(ComputePipelineState { ptr: p })
        }
    }

    /// Wrap a raw `id<MTLDevice>` pointer **without** taking ownership.
    /// The returned handle will NOT release the underlying object on
    /// drop.
    ///
    /// # Safety
    ///
    /// `ptr` must be a valid `id<MTLDevice>` whose lifetime is managed
    /// by some other owner.
    #[must_use]
    pub unsafe fn from_raw_borrowed(ptr: *mut c_void) -> ManuallyDropDevice {
        ManuallyDropDevice {
            inner: Self {
                ptr,
                drop_on_release: false,
            },
        }
    }
}

/// Borrowed [`MetalDevice`] that does not release on drop.
pub struct ManuallyDropDevice {
    inner: MetalDevice,
}

impl core::ops::Deref for ManuallyDropDevice {
    type Target = MetalDevice;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

// ---- Command queue + command buffer ----

/// Apple's `id<MTLCommandQueue>` — schedules GPU work.
pub struct CommandQueue {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLCommandQueue>` is documented by Apple as thread-safe; multiple
// threads may independently create command buffers from the same queue.
unsafe impl Send for CommandQueue {}
unsafe impl Sync for CommandQueue {}

impl Drop for CommandQueue {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_command_queue_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl CommandQueue {
    /// Create a new command buffer for recording GPU commands.
    #[must_use]
    pub fn new_command_buffer(&self) -> Option<CommandBuffer> {
        let p = unsafe { ffi::am_command_queue_new_command_buffer(self.ptr) };
        if p.is_null() {
            None
        } else {
            Some(CommandBuffer { ptr: p })
        }
    }

    /// Raw `id<MTLCommandQueue>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

/// Apple's `id<MTLCommandBuffer>` — a recorded batch of GPU commands.
pub struct CommandBuffer {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLCommandBuffer>` may be created on one thread and handed to
// another, so `Send` is sound.  We deliberately do NOT implement `Sync`:
// `MTLCommandBuffer` is not thread-safe, and this wrapper exposes encoding
// operations (`commit`, `blit_copy_buffer`, `dispatch_compute_1d`, ...) that
// mutate the underlying buffer through `&self`.  Sharing `&CommandBuffer`
// across threads would therefore allow concurrent mutation — a data race.
unsafe impl Send for CommandBuffer {}

impl Drop for CommandBuffer {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_command_buffer_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl CommandBuffer {
    /// Submit the recorded commands for execution.
    pub fn commit(&self) {
        unsafe { ffi::am_command_buffer_commit(self.ptr) };
    }

    /// Block the current thread until all submitted commands finish.
    pub fn wait_until_completed(&self) {
        unsafe { ffi::am_command_buffer_wait_until_completed(self.ptr) };
    }

    /// Record a blit copy from `src` into `dst` for `size` bytes.
    /// Convenience for GPU↔GPU byte copies.
    #[must_use]
    pub fn blit_copy_buffer(
        &self,
        src: &MetalBuffer,
        src_offset: usize,
        dst: &MetalBuffer,
        dst_offset: usize,
        size: usize,
    ) -> bool {
        unsafe {
            ffi::am_command_buffer_blit_copy_buffer(
                self.ptr,
                src.as_ptr(),
                src_offset,
                dst.as_ptr(),
                dst_offset,
                size,
            )
        }
    }

    /// Record a 1-D compute dispatch: binds `pso`, sets `buffers` at
    /// argument slots `0..buffers.len()`, and dispatches `threadgroups`
    /// of `threads_per_group` threads.
    #[must_use]
    pub fn dispatch_compute_1d(
        &self,
        pso: &ComputePipelineState,
        buffers: &[&MetalBuffer],
        threadgroups: usize,
        threads_per_group: usize,
    ) -> bool {
        let raw: Vec<*mut c_void> = buffers.iter().map(|b| b.as_ptr()).collect();
        unsafe {
            ffi::am_command_buffer_dispatch_compute_1d(
                self.ptr,
                pso.ptr,
                raw.as_ptr(),
                raw.len(),
                threadgroups,
                threads_per_group,
            )
        }
    }

    /// Raw `id<MTLCommandBuffer>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

// ---- Library + Function + ComputePipelineState ----

/// Apple's `id<MTLLibrary>` — compiled MSL source.
pub struct MetalLibrary {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLLibrary>` is immutable after creation; all its methods are
// thread-safe per Apple documentation.
unsafe impl Send for MetalLibrary {}
unsafe impl Sync for MetalLibrary {}

impl Drop for MetalLibrary {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_library_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalLibrary {
    /// Look up a kernel function by its source name.
    #[must_use]
    pub fn new_function(&self, name: &str) -> Option<MetalFunction> {
        let cname = std::ffi::CString::new(name).ok()?;
        let p = unsafe { ffi::am_library_new_function(self.ptr, cname.as_ptr()) };
        if p.is_null() {
            None
        } else {
            Some(MetalFunction { ptr: p })
        }
    }

    /// Raw `id<MTLLibrary>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

/// Apple's `id<MTLFunction>` — a single compiled shader entry point.
pub struct MetalFunction {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLFunction>` is immutable after creation and its handle is safe
// to share across threads.
unsafe impl Send for MetalFunction {}
unsafe impl Sync for MetalFunction {}

impl Drop for MetalFunction {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_function_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalFunction {
    /// Raw `id<MTLFunction>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

/// Apple's `id<MTLComputePipelineState>` — a compiled compute kernel.
pub struct ComputePipelineState {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLComputePipelineState>` is immutable after creation and
// thread-safe per Apple documentation.
unsafe impl Send for ComputePipelineState {}
unsafe impl Sync for ComputePipelineState {}

impl Drop for ComputePipelineState {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_compute_pipeline_state_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl ComputePipelineState {
    /// Raw `id<MTLComputePipelineState>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self { ptr }
    }
}

// ---- Buffer ----

/// Apple's `id<MTLBuffer>` — a GPU-visible byte buffer.
pub struct MetalBuffer {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLBuffer>` is a GPU resource handle.  Reference-count manipulation
// is atomic (ObjC ARC); concurrent reads of immutable state (length, GPU address)
// are safe.  CPU-side writes via `contents()`/`write_bytes()` are the caller's
// responsibility to synchronize: because both take `&self`, the `Sync` impl
// permits concurrent calls from multiple threads, and writing the CPU-visible
// bytes from more than one thread at once (or while the GPU reads them) is a data
// race / UB. Treat the returned pointer like any shared `*mut` and synchronize
// externally.
unsafe impl Send for MetalBuffer {}
unsafe impl Sync for MetalBuffer {}

impl Drop for MetalBuffer {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_buffer_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalBuffer {
    /// Buffer length in bytes.
    #[must_use]
    pub fn length(&self) -> usize {
        unsafe { ffi::am_buffer_length(self.ptr) }
    }

    /// Raw `void *` to the buffer's CPU-visible bytes. `None` for
    /// `MTLStorageMode::Private` (GPU-only) buffers.
    #[must_use]
    pub fn contents(&self) -> Option<*mut c_void> {
        let p = unsafe { ffi::am_buffer_contents(self.ptr) };
        if p.is_null() {
            None
        } else {
            Some(p)
        }
    }

    /// Copy `src` into this buffer at byte offset `0`. Returns the
    /// number of bytes actually written.
    #[must_use]
    pub fn write_bytes(&self, src: &[u8]) -> usize {
        let Some(dst) = self.contents() else {
            return 0;
        };
        let n = core::cmp::min(src.len(), self.length());
        unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), dst.cast::<u8>(), n) };
        n
    }

    /// Raw `id<MTLBuffer>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

// ---- Texture descriptor + texture ----

/// Configuration for `MetalDevice::new_texture`.
#[derive(Debug, Clone, Copy)]
pub struct TextureDescriptor {
    /// Mirrors the `Metal` framework property for `pixel_format`.
    pub pixel_format: usize,
    /// Mirrors the `Metal` framework property for `width`.
    pub width: usize,
    /// Mirrors the `Metal` framework property for `height`.
    pub height: usize,
    /// Mirrors the `Metal` framework property for `mipmapped`.
    pub mipmapped: bool,
    /// Mirrors the `Metal` framework property for `usage`.
    pub usage: usize,
    /// Mirrors the `Metal` framework property for `storage_mode`.
    pub storage_mode: usize,
}

impl TextureDescriptor {
    /// Sensible defaults for a shader-read+write 2D texture in shared storage.
    #[must_use]
    pub const fn new_2d(width: usize, height: usize, pixel_format: usize) -> Self {
        Self {
            pixel_format,
            width,
            height,
            mipmapped: false,
            usage: texture_usage::SHADER_READ | texture_usage::SHADER_WRITE,
            storage_mode: storage_mode::SHARED,
        }
    }
}

/// Apple's `id<MTLTexture>` — a GPU-resident 2D image.
pub struct MetalTexture {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLTexture>` is a GPU resource handle.  ObjC ARC operations are
// atomic; descriptor queries are read-only and thread-safe.
unsafe impl Send for MetalTexture {}
unsafe impl Sync for MetalTexture {}

impl Drop for MetalTexture {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_texture_release(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalTexture {
    /// Texture width in pixels.
    #[must_use]
    pub fn width(&self) -> usize {
        unsafe { ffi::am_texture_width(self.ptr) }
    }

    /// Texture height in pixels.
    #[must_use]
    pub fn height(&self) -> usize {
        unsafe { ffi::am_texture_height(self.ptr) }
    }

    /// Underlying `MTLPixelFormat` enum value — see [`pixel_format`].
    #[must_use]
    pub fn pixel_format(&self) -> usize {
        unsafe { ffi::am_texture_pixel_format(self.ptr) }
    }

    /// Raw `id<MTLTexture>` pointer.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    /// Wrap a raw, **+1-retained** `id<MTLTexture>` pointer. Ownership is
    /// transferred to the returned wrapper and released once on drop (no extra
    /// retain is taken here).
    ///
    /// # Safety
    ///
    /// `ptr` must be a valid `id<MTLTexture>` whose ownership the
    /// caller is transferring.
    #[must_use]
    pub const unsafe fn from_raw(ptr: *mut c_void) -> Self {
        Self { ptr }
    }
}

impl MetalDevice {
    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self {
            ptr,
            drop_on_release: true,
        }
    }
}

impl CommandQueue {
    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self { ptr }
    }
}

impl CommandBuffer {
    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self { ptr }
    }
}

impl MetalBuffer {
    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self { ptr }
    }
}

// ---- IOSurface extension ----

#[cfg(feature = "iosurface")]
#[cfg_attr(docsrs, doc(cfg(feature = "iosurface")))]
mod iosurface_ext {
    use super::{ffi, pixel_format, MetalDevice, MetalTexture};
    use apple_cf::iosurface::IOSurface;
    use core::ffi::c_void;

    /// Add Metal interop methods to [`IOSurface`].
    pub trait IOSurfaceMetalExt {
        /// Wrap the given plane of this `IOSurface` as a zero-copy
        /// [`MetalTexture`] on the given device.
        fn create_metal_texture(
            &self,
            device: &MetalDevice,
            plane_index: usize,
        ) -> Option<MetalTexture>;
    }

    impl IOSurfaceMetalExt for IOSurface {
        fn create_metal_texture(
            &self,
            device: &MetalDevice,
            plane_index: usize,
        ) -> Option<MetalTexture> {
            let format = pixel_format_for_fourcc(self.pixel_format(), plane_index)?;
            let (width, height) = if plane_index == 0 {
                (self.width(), self.height())
            } else {
                (self.width() / 2, self.height() / 2)
            };
            let p = unsafe {
                ffi::am_device_new_texture_from_iosurface(
                    device.as_ptr(),
                    self.as_ptr().cast::<c_void>(),
                    plane_index,
                    format,
                    width,
                    height,
                )
            };
            if p.is_null() {
                None
            } else {
                Some(unsafe { MetalTexture::from_raw(p) })
            }
        }
    }

    fn pixel_format_for_fourcc(fourcc: u32, plane_index: usize) -> Option<usize> {
        const BGRA: u32 = u32::from_be_bytes(*b"BGRA");
        const L10R: u32 = u32::from_be_bytes(*b"l10r");
        const YUV420V: u32 = u32::from_be_bytes(*b"420v");
        const YUV420F: u32 = u32::from_be_bytes(*b"420f");

        match (fourcc, plane_index) {
            (BGRA, 0) => Some(pixel_format::BGRA8UNORM),
            (L10R, 0) => Some(pixel_format::BGRA10_XR),
            (YUV420V | YUV420F, 0) => Some(pixel_format::R8UNORM),
            (YUV420V | YUV420F, 1) => Some(pixel_format::RG8UNORM),
            _ => None,
        }
    }
}

/// Re-exports the `Metal` framework surface for this item.
#[cfg(feature = "iosurface")]
pub use iosurface_ext::IOSurfaceMetalExt;

/// True if `fourcc` identifies a YCbCr biplanar (`Y` + `CbCr`) format.
#[must_use]
pub const fn is_ycbcr_biplanar(fourcc: u32) -> bool {
    const YUV420V: u32 = u32::from_be_bytes(*b"420v");
    const YUV420F: u32 = u32::from_be_bytes(*b"420f");
    matches!(fourcc, YUV420V | YUV420F)
}
