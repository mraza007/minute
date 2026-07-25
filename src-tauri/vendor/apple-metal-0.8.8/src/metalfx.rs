use crate::{ffi, CommandBuffer, Fence, MetalDevice, MetalTexture};
use core::ffi::c_void;

macro_rules! opaque_metalfx_handle {
    ($(#[$meta:meta])* pub struct $name:ident;) => {
        $(#[$meta])*
/// Mirrors the `Metal` framework counterpart for this type.
        pub struct $name {
            ptr: *mut c_void,
        }

        impl Drop for $name {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { ffi::am_object_release(self.ptr) };
                    self.ptr = core::ptr::null_mut();
                }
            }
        }

        impl $name {
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
        }
    };
}

/// `MTLFXSpatialScalerColorProcessingMode` enum values.
pub mod spatial_scaler_color_processing_mode {
    /// Mirrors the `Metal` framework constant `PERCEPTUAL`.
    pub const PERCEPTUAL: isize = 0;
    /// Mirrors the `Metal` framework constant `LINEAR`.
    pub const LINEAR: isize = 1;
    /// Mirrors the `Metal` framework constant `HDR`.
    pub const HDR: isize = 2;
}

/// Marker trait for `MetalFX` scalers that conform to `MTLFXFrameInterpolatableScaler`.
pub trait FrameInterpolatableScaler {}

/// Safe Rust description of `MTLFXSpatialScalerDescriptor`.
#[derive(Debug, Clone, Copy)]
pub struct SpatialScalerDescriptor {
    /// Mirrors the `Metal` framework property for `color_texture_format`.
    pub color_texture_format: usize,
    /// Mirrors the `Metal` framework property for `output_texture_format`.
    pub output_texture_format: usize,
    /// Mirrors the `Metal` framework property for `input_width`.
    pub input_width: usize,
    /// Mirrors the `Metal` framework property for `input_height`.
    pub input_height: usize,
    /// Mirrors the `Metal` framework property for `output_width`.
    pub output_width: usize,
    /// Mirrors the `Metal` framework property for `output_height`.
    pub output_height: usize,
    /// Mirrors the `Metal` framework property for `color_processing_mode`.
    pub color_processing_mode: isize,
}

impl SpatialScalerDescriptor {
    /// Create a `MetalFX` spatial-scaler descriptor.
    #[must_use]
    pub const fn new(
        color_texture_format: usize,
        output_texture_format: usize,
        input_width: usize,
        input_height: usize,
        output_width: usize,
        output_height: usize,
    ) -> Self {
        Self {
            color_texture_format,
            output_texture_format,
            input_width,
            input_height,
            output_width,
            output_height,
            color_processing_mode: spatial_scaler_color_processing_mode::PERCEPTUAL,
        }
    }

    /// Query whether the given device supports `MetalFX` spatial scaling.
    #[must_use]
    pub fn supports_device(device: &MetalDevice) -> bool {
        unsafe { ffi::am_spatial_scaler_supports_device(device.as_ptr()) }
    }
}

/// Safe Rust description of `MTLFXTemporalScalerDescriptor`.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy)]
pub struct TemporalScalerDescriptor {
    /// Mirrors the `Metal` framework property for `color_texture_format`.
    pub color_texture_format: usize,
    /// Mirrors the `Metal` framework property for `depth_texture_format`.
    pub depth_texture_format: usize,
    /// Mirrors the `Metal` framework property for `motion_texture_format`.
    pub motion_texture_format: usize,
    /// Mirrors the `Metal` framework property for `output_texture_format`.
    pub output_texture_format: usize,
    /// Mirrors the `Metal` framework property for `input_width`.
    pub input_width: usize,
    /// Mirrors the `Metal` framework property for `input_height`.
    pub input_height: usize,
    /// Mirrors the `Metal` framework property for `output_width`.
    pub output_width: usize,
    /// Mirrors the `Metal` framework property for `output_height`.
    pub output_height: usize,
    /// Mirrors the `Metal` framework property for `auto_exposure_enabled`.
    pub auto_exposure_enabled: bool,
    /// Mirrors the `Metal` framework property for `requires_synchronous_initialization`.
    pub requires_synchronous_initialization: bool,
    /// Mirrors the `Metal` framework property for `input_content_properties_enabled`.
    pub input_content_properties_enabled: bool,
    /// Mirrors the `Metal` framework property for `input_content_min_scale`.
    pub input_content_min_scale: f32,
    /// Mirrors the `Metal` framework property for `input_content_max_scale`.
    pub input_content_max_scale: f32,
    /// Mirrors the `Metal` framework property for `reactive_mask_texture_enabled`.
    pub reactive_mask_texture_enabled: bool,
    /// Mirrors the `Metal` framework property for `reactive_mask_texture_format`.
    pub reactive_mask_texture_format: usize,
}

impl TemporalScalerDescriptor {
    /// Create a `MetalFX` temporal-scaler descriptor.
    #[must_use]
    pub const fn new(
        color_texture_format: usize,
        depth_texture_format: usize,
        motion_texture_format: usize,
        output_texture_format: usize,
        input_size: (usize, usize),
        output_size: (usize, usize),
    ) -> Self {
        Self {
            color_texture_format,
            depth_texture_format,
            motion_texture_format,
            output_texture_format,
            input_width: input_size.0,
            input_height: input_size.1,
            output_width: output_size.0,
            output_height: output_size.1,
            auto_exposure_enabled: false,
            requires_synchronous_initialization: false,
            input_content_properties_enabled: false,
            input_content_min_scale: 1.0,
            input_content_max_scale: 1.0,
            reactive_mask_texture_enabled: false,
            reactive_mask_texture_format: 0,
        }
    }

    /// Query whether the given device supports `MetalFX` temporal scaling.
    #[must_use]
    pub fn supports_device(device: &MetalDevice) -> bool {
        unsafe { ffi::am_temporal_scaler_supports_device(device.as_ptr()) }
    }

    /// Query the smallest supported temporal scale factor for a device.
    #[must_use]
    pub fn supported_input_content_min_scale(device: &MetalDevice) -> f32 {
        unsafe { ffi::am_temporal_scaler_supported_input_content_min_scale(device.as_ptr()) }
    }

    /// Query the largest supported temporal scale factor for a device.
    #[must_use]
    pub fn supported_input_content_max_scale(device: &MetalDevice) -> f32 {
        unsafe { ffi::am_temporal_scaler_supported_input_content_max_scale(device.as_ptr()) }
    }
}

/// Per-frame bindings for `MTLFXTemporalScaler`.
#[derive(Clone, Copy)]
pub struct TemporalScalerTextures<'a> {
    /// Mirrors the `Metal` framework property for `color_texture`.
    pub color_texture: &'a MetalTexture,
    /// Mirrors the `Metal` framework property for `depth_texture`.
    pub depth_texture: &'a MetalTexture,
    /// Mirrors the `Metal` framework property for `motion_texture`.
    pub motion_texture: &'a MetalTexture,
    /// Mirrors the `Metal` framework property for `output_texture`.
    pub output_texture: &'a MetalTexture,
    /// Mirrors the `Metal` framework property for `exposure_texture`.
    pub exposure_texture: Option<&'a MetalTexture>,
    /// Mirrors the `Metal` framework property for `reactive_mask_texture`.
    pub reactive_mask_texture: Option<&'a MetalTexture>,
    /// Mirrors the `Metal` framework property for `fence`.
    pub fence: Option<&'a Fence>,
}

/// Per-frame mutable state for `MTLFXTemporalScaler`.
#[derive(Debug, Clone, Copy)]
pub struct TemporalScalerFrameState {
    /// Mirrors the `Metal` framework property for `input_content_width`.
    pub input_content_width: usize,
    /// Mirrors the `Metal` framework property for `input_content_height`.
    pub input_content_height: usize,
    /// Mirrors the `Metal` framework property for `pre_exposure`.
    pub pre_exposure: f32,
    /// Mirrors the `Metal` framework property for `jitter_offset_x`.
    pub jitter_offset_x: f32,
    /// Mirrors the `Metal` framework property for `jitter_offset_y`.
    pub jitter_offset_y: f32,
    /// Mirrors the `Metal` framework property for `motion_vector_scale_x`.
    pub motion_vector_scale_x: f32,
    /// Mirrors the `Metal` framework property for `motion_vector_scale_y`.
    pub motion_vector_scale_y: f32,
    /// Mirrors the `Metal` framework property for `reset`.
    pub reset: bool,
    /// Mirrors the `Metal` framework property for `depth_reversed`.
    pub depth_reversed: bool,
}

impl TemporalScalerFrameState {
    /// Create a per-frame state payload with default exposure, jitter, and motion-vector scales.
    #[must_use]
    pub const fn new(input_content_width: usize, input_content_height: usize) -> Self {
        Self {
            input_content_width,
            input_content_height,
            pre_exposure: 1.0,
            jitter_offset_x: 0.0,
            jitter_offset_y: 0.0,
            motion_vector_scale_x: 1.0,
            motion_vector_scale_y: 1.0,
            reset: false,
            depth_reversed: false,
        }
    }
}

opaque_metalfx_handle!(
    /// Apple's `id<MTLFXSpatialScaler>` — `MetalFX`'s spatial upscaler.
    pub struct SpatialScaler;
);
opaque_metalfx_handle!(
    /// Apple's `id<MTLFXTemporalScaler>` — `MetalFX`'s temporal upscaler.
    pub struct TemporalScaler;
);

impl FrameInterpolatableScaler for TemporalScaler {}

impl MetalDevice {
    /// Create a `MTLFXSpatialScaler` for this device.
    #[must_use]
    pub fn new_spatial_scaler(
        &self,
        descriptor: &SpatialScalerDescriptor,
    ) -> Option<SpatialScaler> {
        SpatialScaler::wrap(unsafe {
            ffi::am_device_new_spatial_scaler(
                self.as_ptr(),
                descriptor.color_texture_format,
                descriptor.output_texture_format,
                descriptor.input_width,
                descriptor.input_height,
                descriptor.output_width,
                descriptor.output_height,
                descriptor.color_processing_mode,
            )
        })
    }

    /// Create a `MTLFXTemporalScaler` for this device.
    #[must_use]
    pub fn new_temporal_scaler(
        &self,
        descriptor: &TemporalScalerDescriptor,
    ) -> Option<TemporalScaler> {
        TemporalScaler::wrap(unsafe {
            ffi::am_device_new_temporal_scaler(
                self.as_ptr(),
                descriptor.color_texture_format,
                descriptor.depth_texture_format,
                descriptor.motion_texture_format,
                descriptor.output_texture_format,
                descriptor.input_width,
                descriptor.input_height,
                descriptor.output_width,
                descriptor.output_height,
                descriptor.auto_exposure_enabled,
                descriptor.requires_synchronous_initialization,
                descriptor.input_content_properties_enabled,
                descriptor.input_content_min_scale,
                descriptor.input_content_max_scale,
                descriptor.reactive_mask_texture_enabled,
                descriptor.reactive_mask_texture_format,
            )
        })
    }
}

impl SpatialScaler {
    /// Required texture usage bits for the input color texture.
    #[must_use]
    pub fn color_texture_usage(&self) -> usize {
        unsafe { ffi::am_spatial_scaler_texture_usage(self.as_ptr(), 0) }
    }

    /// Required texture usage bits for the output texture.
    #[must_use]
    pub fn output_texture_usage(&self) -> usize {
        unsafe { ffi::am_spatial_scaler_texture_usage(self.as_ptr(), 1) }
    }

    /// Configure the textures and content size for one upscaling pass.
    pub fn configure(
        &self,
        input_content_width: usize,
        input_content_height: usize,
        color_texture: &MetalTexture,
        output_texture: &MetalTexture,
        fence: Option<&Fence>,
    ) {
        unsafe {
            ffi::am_spatial_scaler_configure(
                self.as_ptr(),
                input_content_width,
                input_content_height,
                color_texture.as_ptr(),
                output_texture.as_ptr(),
                fence.map_or(core::ptr::null_mut(), Fence::as_ptr),
            );
        }
    }

    /// Encode this scaler's work into a command buffer.
    pub fn encode_to_command_buffer(&self, command_buffer: &CommandBuffer) {
        unsafe { ffi::am_spatial_scaler_encode(self.as_ptr(), command_buffer.as_ptr()) };
    }
}

impl TemporalScaler {
    fn texture_usage(&self, kind: usize) -> usize {
        unsafe { ffi::am_temporal_scaler_texture_usage(self.as_ptr(), kind) }
    }

    /// Required texture usage bits for the color input texture.
    #[must_use]
    pub fn color_texture_usage(&self) -> usize {
        self.texture_usage(0)
    }

    /// Required texture usage bits for the depth input texture.
    #[must_use]
    pub fn depth_texture_usage(&self) -> usize {
        self.texture_usage(1)
    }

    /// Required texture usage bits for the motion-vector texture.
    #[must_use]
    pub fn motion_texture_usage(&self) -> usize {
        self.texture_usage(2)
    }

    /// Required texture usage bits for the reactive-mask texture.
    #[must_use]
    pub fn reactive_texture_usage(&self) -> usize {
        self.texture_usage(3)
    }

    /// Required texture usage bits for the output texture.
    #[must_use]
    pub fn output_texture_usage(&self) -> usize {
        self.texture_usage(4)
    }

    /// Bind the textures and optional fence used by this temporal scaler.
    pub fn set_textures(&self, textures: TemporalScalerTextures<'_>) {
        unsafe {
            ffi::am_temporal_scaler_set_textures(
                self.as_ptr(),
                textures.color_texture.as_ptr(),
                textures.depth_texture.as_ptr(),
                textures.motion_texture.as_ptr(),
                textures.output_texture.as_ptr(),
                textures
                    .exposure_texture
                    .map_or(core::ptr::null_mut(), MetalTexture::as_ptr),
                textures
                    .reactive_mask_texture
                    .map_or(core::ptr::null_mut(), MetalTexture::as_ptr),
                textures.fence.map_or(core::ptr::null_mut(), Fence::as_ptr),
            );
        }
    }

    /// Update the temporal scaler's per-frame motion, exposure, and jitter state.
    pub fn set_frame_state(&self, frame_state: TemporalScalerFrameState) {
        unsafe {
            ffi::am_temporal_scaler_set_frame_state(
                self.as_ptr(),
                frame_state.input_content_width,
                frame_state.input_content_height,
                frame_state.pre_exposure,
                frame_state.jitter_offset_x,
                frame_state.jitter_offset_y,
                frame_state.motion_vector_scale_x,
                frame_state.motion_vector_scale_y,
                frame_state.reset,
                frame_state.depth_reversed,
            );
        }
    }

    /// Encode this scaler's work into a command buffer.
    pub fn encode_to_command_buffer(&self, command_buffer: &CommandBuffer) {
        unsafe { ffi::am_temporal_scaler_encode(self.as_ptr(), command_buffer.as_ptr()) };
    }
}
