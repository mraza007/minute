use crate::{ffi, util::take_optional_string, MetalDevice};
use core::ffi::c_void;
use std::ffi::CString;

macro_rules! opaque_state {
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

/// `MTLCompareFunction` enum values.
pub mod compare_function {
    /// Mirrors the `Metal` framework constant `NEVER`.
    pub const NEVER: usize = 0;
    /// Mirrors the `Metal` framework constant `LESS`.
    pub const LESS: usize = 1;
    /// Mirrors the `Metal` framework constant `EQUAL`.
    pub const EQUAL: usize = 2;
    /// Mirrors the `Metal` framework constant `LESS_EQUAL`.
    pub const LESS_EQUAL: usize = 3;
    /// Mirrors the `Metal` framework constant `GREATER`.
    pub const GREATER: usize = 4;
    /// Mirrors the `Metal` framework constant `NOT_EQUAL`.
    pub const NOT_EQUAL: usize = 5;
    /// Mirrors the `Metal` framework constant `GREATER_EQUAL`.
    pub const GREATER_EQUAL: usize = 6;
    /// Mirrors the `Metal` framework constant `ALWAYS`.
    pub const ALWAYS: usize = 7;
}

/// `MTLStencilOperation` enum values.
pub mod stencil_operation {
    /// Mirrors the `Metal` framework constant `KEEP`.
    pub const KEEP: usize = 0;
    /// Mirrors the `Metal` framework constant `ZERO`.
    pub const ZERO: usize = 1;
    /// Mirrors the `Metal` framework constant `REPLACE`.
    pub const REPLACE: usize = 2;
    /// Mirrors the `Metal` framework constant `INCREMENT_CLAMP`.
    pub const INCREMENT_CLAMP: usize = 3;
    /// Mirrors the `Metal` framework constant `DECREMENT_CLAMP`.
    pub const DECREMENT_CLAMP: usize = 4;
    /// Mirrors the `Metal` framework constant `INVERT`.
    pub const INVERT: usize = 5;
    /// Mirrors the `Metal` framework constant `INCREMENT_WRAP`.
    pub const INCREMENT_WRAP: usize = 6;
    /// Mirrors the `Metal` framework constant `DECREMENT_WRAP`.
    pub const DECREMENT_WRAP: usize = 7;
}

/// `MTLSamplerMinMagFilter` enum values.
pub mod sampler_min_mag_filter {
    /// Mirrors the `Metal` framework constant `NEAREST`.
    pub const NEAREST: usize = 0;
    /// Mirrors the `Metal` framework constant `LINEAR`.
    pub const LINEAR: usize = 1;
}

/// `MTLSamplerMipFilter` enum values.
pub mod sampler_mip_filter {
    /// Mirrors the `Metal` framework constant `NOT_MIPMAPPED`.
    pub const NOT_MIPMAPPED: usize = 0;
    /// Mirrors the `Metal` framework constant `NEAREST`.
    pub const NEAREST: usize = 1;
    /// Mirrors the `Metal` framework constant `LINEAR`.
    pub const LINEAR: usize = 2;
}

/// `MTLSamplerAddressMode` enum values.
pub mod sampler_address_mode {
    /// Mirrors the `Metal` framework constant `CLAMP_TO_EDGE`.
    pub const CLAMP_TO_EDGE: usize = 0;
    /// Mirrors the `Metal` framework constant `MIRROR_CLAMP_TO_EDGE`.
    pub const MIRROR_CLAMP_TO_EDGE: usize = 1;
    /// Mirrors the `Metal` framework constant `REPEAT`.
    pub const REPEAT: usize = 2;
    /// Mirrors the `Metal` framework constant `MIRROR_REPEAT`.
    pub const MIRROR_REPEAT: usize = 3;
    /// Mirrors the `Metal` framework constant `CLAMP_TO_ZERO`.
    pub const CLAMP_TO_ZERO: usize = 4;
    /// Mirrors the `Metal` framework constant `CLAMP_TO_BORDER_COLOR`.
    pub const CLAMP_TO_BORDER_COLOR: usize = 5;
}

/// `MTLSamplerBorderColor` enum values.
pub mod sampler_border_color {
    /// Mirrors the `Metal` framework constant `TRANSPARENT_BLACK`.
    pub const TRANSPARENT_BLACK: usize = 0;
    /// Mirrors the `Metal` framework constant `OPAQUE_BLACK`.
    pub const OPAQUE_BLACK: usize = 1;
    /// Mirrors the `Metal` framework constant `OPAQUE_WHITE`.
    pub const OPAQUE_WHITE: usize = 2;
}

/// `MTLSamplerReductionMode` enum values.
pub mod sampler_reduction_mode {
    /// Mirrors the `Metal` framework constant `WEIGHTED_AVERAGE`.
    pub const WEIGHTED_AVERAGE: usize = 0;
    /// Mirrors the `Metal` framework constant `MINIMUM`.
    pub const MINIMUM: usize = 1;
    /// Mirrors the `Metal` framework constant `MAXIMUM`.
    pub const MAXIMUM: usize = 2;
}

/// Rust description of `MTLStencilDescriptor`.
#[derive(Debug, Clone, Copy)]
pub struct StencilDescriptor {
    /// Mirrors the `Metal` framework property for `stencil_compare_function`.
    pub stencil_compare_function: usize,
    /// Mirrors the `Metal` framework property for `stencil_failure_operation`.
    pub stencil_failure_operation: usize,
    /// Mirrors the `Metal` framework property for `depth_failure_operation`.
    pub depth_failure_operation: usize,
    /// Mirrors the `Metal` framework property for `depth_stencil_pass_operation`.
    pub depth_stencil_pass_operation: usize,
    /// Mirrors the `Metal` framework property for `read_mask`.
    pub read_mask: u32,
    /// Mirrors the `Metal` framework property for `write_mask`.
    pub write_mask: u32,
}

impl Default for StencilDescriptor {
    fn default() -> Self {
        Self {
            stencil_compare_function: compare_function::ALWAYS,
            stencil_failure_operation: stencil_operation::KEEP,
            depth_failure_operation: stencil_operation::KEEP,
            depth_stencil_pass_operation: stencil_operation::KEEP,
            read_mask: u32::MAX,
            write_mask: u32::MAX,
        }
    }
}

impl StencilDescriptor {
    /// Create a descriptor with Metal's default compare and update behavior.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            stencil_compare_function: compare_function::ALWAYS,
            stencil_failure_operation: stencil_operation::KEEP,
            depth_failure_operation: stencil_operation::KEEP,
            depth_stencil_pass_operation: stencil_operation::KEEP,
            read_mask: u32::MAX,
            write_mask: u32::MAX,
        }
    }
}

/// Rust description of `MTLDepthStencilDescriptor`.
#[derive(Debug, Clone, Default)]
pub struct DepthStencilDescriptor {
    /// Mirrors the `Metal` framework property for `depth_compare_function`.
    pub depth_compare_function: usize,
    /// Mirrors the `Metal` framework property for `depth_write_enabled`.
    pub depth_write_enabled: bool,
    /// Mirrors the `Metal` framework property for `front_face_stencil`.
    pub front_face_stencil: Option<StencilDescriptor>,
    /// Mirrors the `Metal` framework property for `back_face_stencil`.
    pub back_face_stencil: Option<StencilDescriptor>,
    /// Mirrors the `Metal` framework property for `label`.
    pub label: Option<String>,
}

impl DepthStencilDescriptor {
    /// Create a descriptor with Metal's default depth-test behavior.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            depth_compare_function: compare_function::ALWAYS,
            depth_write_enabled: false,
            front_face_stencil: None,
            back_face_stencil: None,
            label: None,
        }
    }
}

/// Rust description of `MTLSamplerDescriptor`.
#[derive(Debug, Clone)]
pub struct SamplerDescriptor {
    /// Mirrors the `Metal` framework property for `min_filter`.
    pub min_filter: usize,
    /// Mirrors the `Metal` framework property for `mag_filter`.
    pub mag_filter: usize,
    /// Mirrors the `Metal` framework property for `mip_filter`.
    pub mip_filter: usize,
    /// Mirrors the `Metal` framework property for `max_anisotropy`.
    pub max_anisotropy: usize,
    /// Mirrors the `Metal` framework property for `s_address_mode`.
    pub s_address_mode: usize,
    /// Mirrors the `Metal` framework property for `t_address_mode`.
    pub t_address_mode: usize,
    /// Mirrors the `Metal` framework property for `r_address_mode`.
    pub r_address_mode: usize,
    /// Mirrors the `Metal` framework property for `border_color`.
    pub border_color: usize,
    /// Mirrors the `Metal` framework property for `reduction_mode`.
    pub reduction_mode: usize,
    /// Mirrors the `Metal` framework property for `normalized_coordinates`.
    pub normalized_coordinates: bool,
    /// Mirrors the `Metal` framework property for `lod_min_clamp`.
    pub lod_min_clamp: f32,
    /// Mirrors the `Metal` framework property for `lod_max_clamp`.
    pub lod_max_clamp: f32,
    /// Mirrors the `Metal` framework property for `lod_average`.
    pub lod_average: bool,
    /// Mirrors the `Metal` framework property for `lod_bias`.
    pub lod_bias: f32,
    /// Mirrors the `Metal` framework property for `compare_function`.
    pub compare_function: usize,
    /// Mirrors the `Metal` framework property for `support_argument_buffers`.
    pub support_argument_buffers: bool,
    /// Mirrors the `Metal` framework property for `label`.
    pub label: Option<String>,
}

impl Default for SamplerDescriptor {
    fn default() -> Self {
        Self {
            min_filter: sampler_min_mag_filter::NEAREST,
            mag_filter: sampler_min_mag_filter::NEAREST,
            mip_filter: sampler_mip_filter::NOT_MIPMAPPED,
            max_anisotropy: 1,
            s_address_mode: sampler_address_mode::CLAMP_TO_EDGE,
            t_address_mode: sampler_address_mode::CLAMP_TO_EDGE,
            r_address_mode: sampler_address_mode::CLAMP_TO_EDGE,
            border_color: sampler_border_color::TRANSPARENT_BLACK,
            reduction_mode: sampler_reduction_mode::WEIGHTED_AVERAGE,
            normalized_coordinates: true,
            lod_min_clamp: 0.0,
            lod_max_clamp: f32::MAX,
            lod_average: false,
            lod_bias: 0.0,
            compare_function: compare_function::NEVER,
            support_argument_buffers: false,
            label: None,
        }
    }
}

impl SamplerDescriptor {
    /// Create a descriptor with Metal's default sampling behavior.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

opaque_state!(
    /// Apple's `id<MTLDepthStencilState>` — compiled depth/stencil test state.
    pub struct DepthStencilState;
);
opaque_state!(
    /// Apple's `id<MTLSamplerState>` — immutable texture-sampling state.
    pub struct SamplerState;
);

impl DepthStencilState {
    /// Metal's label for this state object, if one was set.
    #[must_use]
    pub fn label(&self) -> Option<String> {
        unsafe { take_optional_string(ffi::am_object_copy_label(self.as_ptr())) }
    }
}

impl SamplerState {
    /// Metal's label for this state object, if one was set.
    #[must_use]
    pub fn label(&self) -> Option<String> {
        unsafe { take_optional_string(ffi::am_object_copy_label(self.as_ptr())) }
    }
}

impl MetalDevice {
    /// Query the device for the supported argument-buffer tier.
    #[must_use]
    pub fn argument_buffers_support(&self) -> usize {
        unsafe { ffi::am_device_argument_buffers_support(self.as_ptr()) }
    }

    /// Compile a `MTLDepthStencilState` from the given descriptor.
    #[must_use]
    pub fn new_depth_stencil_state(
        &self,
        descriptor: &DepthStencilDescriptor,
    ) -> Option<DepthStencilState> {
        let label = descriptor
            .label
            .as_deref()
            .and_then(|value| CString::new(value).ok());
        let label_ptr = label
            .as_deref()
            .map_or(core::ptr::null(), core::ffi::CStr::as_ptr);
        let front = descriptor.front_face_stencil.unwrap_or_default();
        let back = descriptor.back_face_stencil.unwrap_or_default();
        DepthStencilState::wrap(unsafe {
            ffi::am_device_new_depth_stencil_state(
                self.as_ptr(),
                descriptor.depth_compare_function,
                descriptor.depth_write_enabled,
                descriptor.front_face_stencil.is_some(),
                front.stencil_compare_function,
                front.stencil_failure_operation,
                front.depth_failure_operation,
                front.depth_stencil_pass_operation,
                front.read_mask,
                front.write_mask,
                descriptor.back_face_stencil.is_some(),
                back.stencil_compare_function,
                back.stencil_failure_operation,
                back.depth_failure_operation,
                back.depth_stencil_pass_operation,
                back.read_mask,
                back.write_mask,
                label_ptr,
            )
        })
    }

    /// Compile a `MTLSamplerState` from the given descriptor.
    #[must_use]
    pub fn new_sampler_state(&self, descriptor: &SamplerDescriptor) -> Option<SamplerState> {
        let label = descriptor
            .label
            .as_deref()
            .and_then(|value| CString::new(value).ok());
        let label_ptr = label
            .as_deref()
            .map_or(core::ptr::null(), core::ffi::CStr::as_ptr);
        SamplerState::wrap(unsafe {
            ffi::am_device_new_sampler_state(
                self.as_ptr(),
                descriptor.min_filter,
                descriptor.mag_filter,
                descriptor.mip_filter,
                descriptor.max_anisotropy,
                descriptor.s_address_mode,
                descriptor.t_address_mode,
                descriptor.r_address_mode,
                descriptor.border_color,
                descriptor.reduction_mode,
                descriptor.normalized_coordinates,
                descriptor.lod_min_clamp,
                descriptor.lod_max_clamp,
                descriptor.lod_average,
                descriptor.lod_bias,
                descriptor.compare_function,
                descriptor.support_argument_buffers,
                label_ptr,
            )
        })
    }
}
