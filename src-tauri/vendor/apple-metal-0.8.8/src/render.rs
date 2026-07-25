use crate::{
    ffi, texture_usage, util::take_optional_string, MetalDevice, MetalFunction, TextureDescriptor,
};
use core::ffi::c_void;

/// `MTLPrimitiveType` enum values.
pub mod primitive_type {
    /// Mirrors the `Metal` framework constant `POINT`.
    pub const POINT: usize = 0;
    /// Mirrors the `Metal` framework constant `LINE`.
    pub const LINE: usize = 1;
    /// Mirrors the `Metal` framework constant `LINE_STRIP`.
    pub const LINE_STRIP: usize = 2;
    /// Mirrors the `Metal` framework constant `TRIANGLE`.
    pub const TRIANGLE: usize = 3;
    /// Mirrors the `Metal` framework constant `TRIANGLE_STRIP`.
    pub const TRIANGLE_STRIP: usize = 4;
}

/// `MTLLoadAction` enum values.
pub mod load_action {
    /// Mirrors the `Metal` framework constant `DONT_CARE`.
    pub const DONT_CARE: usize = 0;
    /// Mirrors the `Metal` framework constant `LOAD`.
    pub const LOAD: usize = 1;
    /// Mirrors the `Metal` framework constant `CLEAR`.
    pub const CLEAR: usize = 2;
}

/// `MTLStoreAction` enum values.
pub mod store_action {
    /// Mirrors the `Metal` framework constant `DONT_CARE`.
    pub const DONT_CARE: usize = 0;
    /// Mirrors the `Metal` framework constant `STORE`.
    pub const STORE: usize = 1;
    /// Mirrors the `Metal` framework constant `MULTISAMPLE_RESOLVE`.
    pub const MULTISAMPLE_RESOLVE: usize = 2;
    /// Mirrors the `Metal` framework constant `STORE_AND_MULTISAMPLE_RESOLVE`.
    pub const STORE_AND_MULTISAMPLE_RESOLVE: usize = 3;
}

/// Apple's `id<MTLRenderPipelineState>` — a compiled render pipeline.
pub struct RenderPipelineState {
    ptr: *mut c_void,
}

// SAFETY: `id<MTLRenderPipelineState>` is immutable after creation and
// thread-safe per Apple documentation.
unsafe impl Send for RenderPipelineState {}
unsafe impl Sync for RenderPipelineState {}

impl Drop for RenderPipelineState {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_object_release(self.ptr) };
            self.ptr = core::ptr::null_mut();
        }
    }
}

impl RenderPipelineState {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    fn wrap(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self { ptr })
        }
    }

    pub(crate) const unsafe fn from_retained_ptr(ptr: *mut c_void) -> Self {
        Self { ptr }
    }

    /// Metal's label for this pipeline, if one was set.
    #[must_use]
    pub fn label(&self) -> Option<String> {
        unsafe { take_optional_string(ffi::am_object_copy_label(self.ptr)) }
    }
}

impl MetalDevice {
    /// Compile a render pipeline state from `vertex` and `fragment` functions.
    ///
    /// # Errors
    ///
    /// Returns Metal's localized pipeline compiler error on failure.
    pub fn new_render_pipeline_state(
        &self,
        vertex: &MetalFunction,
        fragment: &MetalFunction,
        color_pixel_format: usize,
        sample_count: usize,
    ) -> Result<RenderPipelineState, String> {
        let mut err: *mut core::ffi::c_char = core::ptr::null_mut();
        let ptr = unsafe {
            ffi::am_device_new_render_pipeline_state(
                self.as_ptr(),
                vertex.as_ptr(),
                fragment.as_ptr(),
                color_pixel_format,
                sample_count,
                &mut err,
            )
        };
        RenderPipelineState::wrap(ptr).ok_or_else(|| unsafe {
            take_optional_string(err)
                .unwrap_or_else(|| "MTLDevice.makeRenderPipelineState returned nil".to_string())
        })
    }
}

impl TextureDescriptor {
    /// Sensible defaults for an offscreen 2D render target texture.
    #[must_use]
    pub const fn render_target_2d(width: usize, height: usize, pixel_format: usize) -> Self {
        Self {
            pixel_format,
            width,
            height,
            mipmapped: false,
            usage: texture_usage::RENDER_TARGET | texture_usage::SHADER_READ,
            storage_mode: crate::storage_mode::PRIVATE,
        }
    }
}
