#![allow(
    clippy::module_name_repetitions,
    clippy::too_many_lines,
    clippy::type_complexity
)]

use crate::{
    ffi,
    util::{c_string, take_optional_string},
    ComputePipelineState, DynamicLibrary, MetalDevice, MetalLibrary, RenderPipelineState,
};
use core::ffi::{c_char, c_void};
use core::ptr;
use std::path::Path;

macro_rules! opaque_symbol_handle {
    ($(#[$meta:meta])* pub struct $name:ident;) => {
        $(#[$meta])*
/// Mirrors the `Metal` framework counterpart for this type.
        pub struct $name {
            ptr: *mut c_void,
        }

        // SAFETY: Metal ObjC objects use atomic reference counting and are safe
        // to move across threads.  All `&self` methods on these types are either
        // read-only or call ObjC methods documented as thread-safe by Apple.
        unsafe impl Send for $name {}
        unsafe impl Sync for $name {}

        impl Drop for $name {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { ffi::am_object_release(self.ptr) };
                    self.ptr = ptr::null_mut();
                }
            }
        }

        impl $name {
/// Mirrors the `Metal` framework constant `fn`.
            #[must_use]
            pub const fn as_ptr(&self) -> *mut c_void {
                self.ptr
            }

            /// Wrap a raw, +1-retained opaque handle returned by the Swift bridge.
            ///
            /// # Safety
            ///
            /// `ptr` must be a valid, non-null, +1-retained Objective-C object pointer
            /// whose ownership is being transferred to this value.  Passing a
            /// pointer that is already owned by another instance causes a
            /// double-release.
            #[must_use]
            pub unsafe fn from_raw(ptr: *mut c_void) -> Self {
                Self { ptr }
            }

            #[allow(dead_code)]
            fn wrap(ptr: *mut c_void) -> Option<Self> {
                if ptr.is_null() {
                    None
                } else {
                    Some(Self { ptr })
                }
            }

/// Calls the `Metal` framework counterpart for `label`.
            #[must_use]
            pub fn label(&self) -> Option<String> {
                unsafe { take_optional_string(ffi::am_object_copy_label(self.ptr)) }
            }
        }
    };
}

macro_rules! opaque_symbol_class {
    ($(#[$meta:meta])* pub struct $name:ident => $objc:literal;) => {
        opaque_symbol_handle!(
            $(#[$meta])*
/// Mirrors the `Metal` framework counterpart for this type.
            pub struct $name;
        );

        impl $name {
/// Calls the `Metal` framework counterpart for `new`.
            #[must_use]
            pub fn new() -> Option<Self> {
                Self::wrap(unsafe {
                    ffi::am_new_class_instance(concat!($objc, "\0").as_ptr().cast())
                })
            }
        }
    };
}

macro_rules! raw_value_type {
    ($(#[$meta:meta])* pub struct $name:ident($ty:ty);) => {
        $(#[$meta])*
/// Mirrors the `Metal` framework counterpart for this type.
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        #[repr(transparent)]
        pub struct $name(pub $ty);

        impl $name {
/// Mirrors the `Metal` framework constant `fn`.
            #[must_use]
            pub const fn from_raw(raw: $ty) -> Self {
                Self(raw)
            }

/// Mirrors the `Metal` framework constant `fn`.
            #[must_use]
            pub const fn as_raw(self) -> $ty {
                self.0
            }
        }
    };
}

macro_rules! metal_string_constant {
    ($(#[$meta:meta])* pub fn $name:ident => $symbol:literal;) => {
        $(#[$meta])*
/// Calls the `Metal` framework counterpart for this method.
        #[must_use]
        pub fn $name() -> Option<String> {
            unsafe {
                take_optional_string(
                    ffi::am_copy_metal_string_constant(concat!($symbol, "\0").as_ptr().cast()),
                )
            }
        }
    };
}

/// Consume a heap-allocated array of retained device pointers produced by
/// `am_copy_all_devices`, wrapping each into a [`MetalDevice`] and freeing
/// the array allocation.
///
/// # Safety
///
/// * `ptr` must be either null or a valid pointer to `count` consecutive
///   `*mut c_void` values, each holding a +1-retained `id<MTLDevice>`.
/// * The array itself must have been allocated with `malloc` (it is freed
///   with `libc::free` here).
/// * `count` must equal the number of elements allocated at `ptr`.
unsafe fn take_device_array(ptr: *mut *mut c_void, count: usize) -> Vec<MetalDevice> {
    if ptr.is_null() || count == 0 {
        return Vec::new();
    }

    let slice = core::slice::from_raw_parts(ptr, count);
    let values = slice
        .iter()
        .copied()
        .map(|device| unsafe { MetalDevice::from_retained_ptr(device) })
        .collect();
    libc::free(ptr.cast());
    values
}

/// Mirrors the `Metal` framework counterpart for `MetalCommonCounter`.
pub type MetalCommonCounter = String;
/// Mirrors the `Metal` framework counterpart for `MetalCommonCounterSet`.
pub type MetalCommonCounterSet = String;
/// Mirrors the `Metal` framework counterpart for `MetalDeviceNotificationName`.
pub type MetalDeviceNotificationName = String;
/// Mirrors the `Metal` framework counterpart for `MetalAutoreleasedArgument`.
pub type MetalAutoreleasedArgument = MetalArgument;
/// Mirrors the `Metal` framework counterpart for `MetalArgumentType`.
pub type MetalArgumentType = MetalBindingType;
/// Mirrors the `Metal` framework counterpart for `MetalAutoreleasedComputePipelineReflection`.
pub type MetalAutoreleasedComputePipelineReflection = MetalComputePipelineReflection;
/// Mirrors the `Metal` framework counterpart for `MetalAutoreleasedRenderPipelineReflection`.
pub type MetalAutoreleasedRenderPipelineReflection = MetalRenderPipelineReflection;
/// Mirrors the `Metal` framework counterpart for `MetalNewLibraryCompletionHandler`.
pub type MetalNewLibraryCompletionHandler =
    Box<dyn FnMut(Result<MetalLibrary, String>) + Send + 'static>;
/// Mirrors the `Metal` framework counterpart for `MetalNewDynamicLibraryCompletionHandler`.
pub type MetalNewDynamicLibraryCompletionHandler =
    Box<dyn FnMut(Result<DynamicLibrary, String>) + Send + 'static>;
/// Mirrors the `Metal` framework counterpart for `MetalNewComputePipelineStateCompletionHandler`.
pub type MetalNewComputePipelineStateCompletionHandler =
    Box<dyn FnMut(Result<ComputePipelineState, String>) + Send + 'static>;
/// Mirrors the `Metal` framework counterpart for `MetalNewComputePipelineStateWithReflectionCompletionHandler`.
pub type MetalNewComputePipelineStateWithReflectionCompletionHandler = Box<
    dyn FnMut(Result<(ComputePipelineState, MetalComputePipelineReflection), String>)
        + Send
        + 'static,
>;
/// Mirrors the `Metal` framework counterpart for `MetalNewRenderPipelineStateCompletionHandler`.
pub type MetalNewRenderPipelineStateCompletionHandler =
    Box<dyn FnMut(Result<RenderPipelineState, String>) + Send + 'static>;
/// Mirrors the `Metal` framework counterpart for `MetalNewRenderPipelineStateWithReflectionCompletionHandler`.
pub type MetalNewRenderPipelineStateWithReflectionCompletionHandler = Box<
    dyn FnMut(Result<(RenderPipelineState, MetalRenderPipelineReflection), String>)
        + Send
        + 'static,
>;
/// Mirrors the `Metal` framework counterpart for `MetalTimestamp`.
pub type MetalTimestamp = u64;

/// Mirrors the `Metal` framework counterpart for `MetalCoordinate2D`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalCoordinate2D;
///
/// let texel = MetalCoordinate2D::new(0.25, 0.75);
/// assert_eq!(texel.x, 0.25);
/// assert_eq!(texel.y, 0.75);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MetalCoordinate2D {
    /// Mirrors the `Metal` framework property for `x`.
    pub x: f32,
    /// Mirrors the `Metal` framework property for `y`.
    pub y: f32,
}

impl MetalCoordinate2D {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalSize`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalSize;
///
/// let threads = MetalSize::new(8, 4, 1);
/// assert_eq!(threads.width * threads.height, 32);
/// assert_eq!(threads.depth, 1);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct MetalSize {
    /// Mirrors the `Metal` framework property for `width`.
    pub width: usize,
    /// Mirrors the `Metal` framework property for `height`.
    pub height: usize,
    /// Mirrors the `Metal` framework property for `depth`.
    pub depth: usize,
}

impl MetalSize {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(width: usize, height: usize, depth: usize) -> Self {
        Self {
            width,
            height,
            depth,
        }
    }
}

raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalGpuAddress`.
    ///
    /// # Examples
    ///
    /// ```
    /// use apple_metal::MetalGpuAddress;
    ///
    /// let address = MetalGpuAddress::from_raw(0x1_0000);
    /// assert_eq!(address.as_raw(), 0x1_0000);
    /// ```
    pub struct MetalGpuAddress(u64);
);

/// Mirrors the `Metal` framework counterpart for `MetalOrigin`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalOrigin;
///
/// let origin = MetalOrigin::new(4, 2, 1);
/// assert_eq!((origin.x, origin.y, origin.z), (4, 2, 1));
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct MetalOrigin {
    /// Mirrors the `Metal` framework property for `x`.
    pub x: usize,
    /// Mirrors the `Metal` framework property for `y`.
    pub y: usize,
    /// Mirrors the `Metal` framework property for `z`.
    pub z: usize,
}

impl MetalOrigin {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(x: usize, y: usize, z: usize) -> Self {
        Self { x, y, z }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalRegion`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalRegion;
///
/// let region = MetalRegion::new_2d(4, 8, 16, 32);
/// assert_eq!(region.origin.x, 4);
/// assert_eq!(region.size.height, 32);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct MetalRegion {
    /// Mirrors the `Metal` framework property for `origin`.
    pub origin: MetalOrigin,
    /// Mirrors the `Metal` framework property for `size`.
    pub size: MetalSize,
}

impl MetalRegion {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(origin: MetalOrigin, size: MetalSize) -> Self {
        Self { origin, size }
    }

    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new_1d(x: usize, width: usize) -> Self {
        Self {
            origin: MetalOrigin::new(x, 0, 0),
            size: MetalSize::new(width, 1, 1),
        }
    }

    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new_2d(x: usize, y: usize, width: usize, height: usize) -> Self {
        Self {
            origin: MetalOrigin::new(x, y, 0),
            size: MetalSize::new(width, height, 1),
        }
    }

    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new_3d(
        x: usize,
        y: usize,
        z: usize,
        width: usize,
        height: usize,
        depth: usize,
    ) -> Self {
        Self {
            origin: MetalOrigin::new(x, y, z),
            size: MetalSize::new(width, height, depth),
        }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalResourceId`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalResourceId;
///
/// let resource_id = MetalResourceId::new(42);
/// assert_eq!(resource_id.value, 42);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct MetalResourceId {
    /// Mirrors the `Metal` framework property for `value`.
    pub value: u64,
}

impl MetalResourceId {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self { value }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalPackedFloat3`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalPackedFloat3;
///
/// let normal = MetalPackedFloat3::new(0.0, 0.0, 1.0);
/// assert_eq!(normal.z, 1.0);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MetalPackedFloat3 {
    /// Mirrors the `Metal` framework property for `x`.
    pub x: f32,
    /// Mirrors the `Metal` framework property for `y`.
    pub y: f32,
    /// Mirrors the `Metal` framework property for `z`.
    pub z: f32,
}

impl MetalPackedFloat3 {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalPackedFloatQuaternion`.
///
/// # Examples
///
/// ```
/// use apple_metal::MetalPackedFloatQuaternion;
///
/// let rotation = MetalPackedFloatQuaternion::default();
/// assert_eq!(rotation, MetalPackedFloatQuaternion::new(0.0, 0.0, 0.0, 1.0));
/// ```
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MetalPackedFloatQuaternion {
    /// Mirrors the `Metal` framework property for `x`.
    pub x: f32,
    /// Mirrors the `Metal` framework property for `y`.
    pub y: f32,
    /// Mirrors the `Metal` framework property for `z`.
    pub z: f32,
    /// Mirrors the `Metal` framework property for `w`.
    pub w: f32,
}

impl Default for MetalPackedFloatQuaternion {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 1.0,
        }
    }
}

impl MetalPackedFloatQuaternion {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(x: f32, y: f32, z: f32, w: f32) -> Self {
        Self { x, y, z, w }
    }
}

/// Mirrors the `Metal` framework counterpart for `MetalPackedFloat4x3`.
///
/// # Examples
///
/// ```
/// use apple_metal::{MetalPackedFloat3, MetalPackedFloat4x3};
///
/// let basis = MetalPackedFloat4x3::new(
///     MetalPackedFloat3::new(1.0, 0.0, 0.0),
///     MetalPackedFloat3::new(0.0, 1.0, 0.0),
///     MetalPackedFloat3::new(0.0, 0.0, 1.0),
///     MetalPackedFloat3::new(4.0, 5.0, 6.0),
/// );
/// assert_eq!(basis.columns[3].y, 5.0);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MetalPackedFloat4x3 {
    /// Mirrors the `Metal` framework property for `columns`.
    pub columns: [MetalPackedFloat3; 4],
}

impl MetalPackedFloat4x3 {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn new(
        column0: MetalPackedFloat3,
        column1: MetalPackedFloat3,
        column2: MetalPackedFloat3,
        column3: MetalPackedFloat3,
    ) -> Self {
        Self {
            columns: [column0, column1, column2, column3],
        }
    }
}

raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalSparseTextureMappingMode`.
    pub struct MetalSparseTextureMappingMode(usize);
);

opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalDeviceObserver`.
    pub struct MetalDeviceObserver;
);

/// Mirrors the `Metal` framework counterpart for `MetalDeviceObserverCallback`.
pub type MetalDeviceObserverCallback = unsafe extern "C" fn(
    device: *mut c_void,
    notification_name: *const c_char,
    user_data: *mut c_void,
);

impl MetalDeviceObserver {
    /// Calls the `Metal` framework counterpart for `remove`.
    pub fn remove(&self) {
        unsafe { ffi::am_remove_device_observer(self.as_ptr()) };
    }
}

/// Calls the `Metal` framework counterpart for `copy_all_devices`.
#[must_use]
pub fn copy_all_devices() -> Vec<MetalDevice> {
    let mut count = 0;
    let ptr = unsafe { ffi::am_copy_all_devices(&mut count) };
    unsafe { take_device_array(ptr, count) }
}

/// Enumerate all Metal devices while registering a hot-plug/removal observer.
///
/// # Safety
///
/// * `callback`, if `Some`, must be a valid function pointer that remains
///   valid for the lifetime of the returned `MetalDeviceObserver`.
/// * `user_data` is forwarded to `callback` without inspection; the caller
///   is responsible for ensuring it remains valid and for any required
///   synchronization.
pub unsafe fn copy_all_devices_with_observer(
    callback: Option<MetalDeviceObserverCallback>,
    user_data: *mut c_void,
) -> (Vec<MetalDevice>, Option<MetalDeviceObserver>) {
    let mut count = 0;
    let mut observer = ptr::null_mut();
    let ptr =
        ffi::am_copy_all_devices_with_observer(&mut count, &mut observer, callback, user_data);
    (
        take_device_array(ptr, count),
        MetalDeviceObserver::wrap(observer),
    )
}

/// Calls the `Metal` framework counterpart for `remove_device_observer`.
pub fn remove_device_observer(observer: &MetalDeviceObserver) {
    observer.remove();
}

/// Mirrors the `Metal` framework counterpart for `MetalIoCompressionContext`.
pub struct MetalIoCompressionContext {
    ptr: *mut c_void,
}

impl Drop for MetalIoCompressionContext {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { ffi::am_io_flush_and_destroy_compression_context(self.ptr) };
            self.ptr = ptr::null_mut();
        }
    }
}

impl MetalIoCompressionContext {
    /// Mirrors the `Metal` framework constant `fn`.
    #[must_use]
    pub const fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    /// Wrap a raw `MTLIOCompressionContext` pointer returned by the Swift bridge.
    ///
    /// # Safety
    ///
    /// `ptr` must be a valid, non-null `MTLIOCompressionContext *` whose
    /// ownership is transferred to this value.  The context will be flushed
    /// and destroyed when this value is dropped or `flush_and_destroy` is
    /// called.  Do not use `ptr` after calling this function.
    #[must_use]
    pub unsafe fn from_raw(ptr: *mut c_void) -> Self {
        Self { ptr }
    }

    /// Calls the `Metal` framework counterpart for `append_data`.
    pub fn append_data(&self, data: &[u8]) {
        unsafe {
            ffi::am_io_compression_context_append_data(self.ptr, data.as_ptr(), data.len());
        }
    }

    /// Calls the `Metal` framework counterpart for `flush_and_destroy`.
    #[must_use]
    pub fn flush_and_destroy(mut self) -> MetalIoCompressionStatus {
        let status = unsafe { ffi::am_io_flush_and_destroy_compression_context(self.ptr) };
        self.ptr = ptr::null_mut();
        MetalIoCompressionStatus::from_raw(status)
    }
}

/// Calls the `Metal` framework counterpart for `io_compression_context_default_chunk_size`.
#[must_use]
pub fn io_compression_context_default_chunk_size() -> usize {
    unsafe { ffi::am_io_compression_context_default_chunk_size() }
}

/// Calls the `Metal` framework counterpart for `create_io_compression_context`.
#[must_use]
pub fn create_io_compression_context(
    path: &Path,
    method: MetalIoCompressionMethod,
    chunk_size: Option<usize>,
) -> Option<MetalIoCompressionContext> {
    let path = c_string(path.to_string_lossy().as_ref()).ok()?;
    let chunk_size = chunk_size.unwrap_or_else(io_compression_context_default_chunk_size);
    let ptr = unsafe {
        ffi::am_io_create_compression_context(path.as_ptr(), method.as_raw(), chunk_size)
    };
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { MetalIoCompressionContext::from_raw(ptr) })
    }
}

metal_string_constant!(pub fn metal4_command_queue_error_domain => "MTL4CommandQueueErrorDomain";);
metal_string_constant!(pub fn metal_binary_archive_domain => "MTLBinaryArchiveDomain";);
metal_string_constant!(pub fn metal_capture_error_domain => "MTLCaptureErrorDomain";);
metal_string_constant!(pub fn metal_command_buffer_encoder_info_error_key => "MTLCommandBufferEncoderInfoErrorKey";);
metal_string_constant!(pub fn metal_command_buffer_error_domain => "MTLCommandBufferErrorDomain";);
metal_string_constant!(pub fn metal_common_counter_clipper_invocations => "MTLCommonCounterClipperInvocations";);
metal_string_constant!(pub fn metal_common_counter_clipper_primitives_out => "MTLCommonCounterClipperPrimitivesOut";);
metal_string_constant!(pub fn metal_common_counter_compute_kernel_invocations => "MTLCommonCounterComputeKernelInvocations";);
metal_string_constant!(pub fn metal_common_counter_fragment_cycles => "MTLCommonCounterFragmentCycles";);
metal_string_constant!(pub fn metal_common_counter_fragment_invocations => "MTLCommonCounterFragmentInvocations";);
metal_string_constant!(pub fn metal_common_counter_fragments_passed => "MTLCommonCounterFragmentsPassed";);
metal_string_constant!(pub fn metal_common_counter_post_tessellation_vertex_cycles => "MTLCommonCounterPostTessellationVertexCycles";);
metal_string_constant!(pub fn metal_common_counter_post_tessellation_vertex_invocations => "MTLCommonCounterPostTessellationVertexInvocations";);
metal_string_constant!(pub fn metal_common_counter_render_target_write_cycles => "MTLCommonCounterRenderTargetWriteCycles";);
metal_string_constant!(pub fn metal_common_counter_set_stage_utilization => "MTLCommonCounterSetStageUtilization";);
metal_string_constant!(pub fn metal_common_counter_set_statistic => "MTLCommonCounterSetStatistic";);
metal_string_constant!(pub fn metal_common_counter_set_timestamp => "MTLCommonCounterSetTimestamp";);
metal_string_constant!(pub fn metal_common_counter_tessellation_cycles => "MTLCommonCounterTessellationCycles";);
metal_string_constant!(pub fn metal_common_counter_tessellation_input_patches => "MTLCommonCounterTessellationInputPatches";);
metal_string_constant!(pub fn metal_common_counter_timestamp => "MTLCommonCounterTimestamp";);
metal_string_constant!(pub fn metal_common_counter_total_cycles => "MTLCommonCounterTotalCycles";);
metal_string_constant!(pub fn metal_common_counter_vertex_cycles => "MTLCommonCounterVertexCycles";);
metal_string_constant!(pub fn metal_common_counter_vertex_invocations => "MTLCommonCounterVertexInvocations";);
metal_string_constant!(pub fn metal_counter_error_domain => "MTLCounterErrorDomain";);
metal_string_constant!(pub fn metal_device_removal_requested_notification => "MTLDeviceRemovalRequestedNotification";);
metal_string_constant!(pub fn metal_device_was_added_notification => "MTLDeviceWasAddedNotification";);
metal_string_constant!(pub fn metal_device_was_removed_notification => "MTLDeviceWasRemovedNotification";);
metal_string_constant!(pub fn metal_dynamic_library_domain => "MTLDynamicLibraryDomain";);
metal_string_constant!(pub fn metal_io_error_domain => "MTLIOErrorDomain";);
metal_string_constant!(pub fn metal_library_error_domain => "MTLLibraryErrorDomain";);
metal_string_constant!(pub fn metal_log_state_error_domain => "MTLLogStateErrorDomain";);
metal_string_constant!(pub fn metal_tensor_domain => "MTLTensorDomain";);

raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4AlphaToCoverageState`.
    pub struct Metal4AlphaToCoverageState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4AlphaToOneState`.
    pub struct Metal4AlphaToOneState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4BinaryFunctionOptions`.
    pub struct Metal4BinaryFunctionOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4BlendState`.
    pub struct Metal4BlendState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommandQueueError`.
    pub struct Metal4CommandQueueError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CompilerTaskStatus`.
    pub struct Metal4CompilerTaskStatus(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CounterHeapType`.
    pub struct Metal4CounterHeapType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4IndirectCommandBufferSupportState`.
    pub struct Metal4IndirectCommandBufferSupportState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4LogicalToPhysicalColorAttachmentMappingState`.
    pub struct Metal4LogicalToPhysicalColorAttachmentMappingState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4PipelineDataSetSerializerConfiguration`.
    pub struct Metal4PipelineDataSetSerializerConfiguration(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4RenderEncoderOptions`.
    pub struct Metal4RenderEncoderOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4ShaderReflection`.
    pub struct Metal4ShaderReflection(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4TimestampGranularity`.
    pub struct Metal4TimestampGranularity(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `Metal4VisibilityOptions`.
    pub struct Metal4VisibilityOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalAccelerationStructureInstanceDescriptorType`.
    pub struct MetalAccelerationStructureInstanceDescriptorType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalAccelerationStructureInstanceOptions`.
    pub struct MetalAccelerationStructureInstanceOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalAccelerationStructureRefitOptions`.
    pub struct MetalAccelerationStructureRefitOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalAccelerationStructureUsage`.
    pub struct MetalAccelerationStructureUsage(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalArgumentAccess`.
    pub struct MetalArgumentAccess(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalAttributeFormat`.
    pub struct MetalAttributeFormat(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalBarrierScope`.
    pub struct MetalBarrierScope(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalBinaryArchiveError`.
    pub struct MetalBinaryArchiveError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalBindingType`.
    pub struct MetalBindingType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalBlitOption`.
    pub struct MetalBlitOption(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalBufferSparseTier`.
    pub struct MetalBufferSparseTier(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCaptureError`.
    pub struct MetalCaptureError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCommandBufferError`.
    pub struct MetalCommandBufferError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCommandBufferErrorOption`.
    pub struct MetalCommandBufferErrorOption(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCommandEncoderErrorState`.
    pub struct MetalCommandEncoderErrorState(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCompileSymbolVisibility`.
    pub struct MetalCompileSymbolVisibility(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCounterSampleBufferError`.
    pub struct MetalCounterSampleBufferError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCullMode`.
    pub struct MetalCullMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCurveBasis`.
    pub struct MetalCurveBasis(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCurveEndCaps`.
    pub struct MetalCurveEndCaps(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalCurveType`.
    pub struct MetalCurveType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalDataType`.
    pub struct MetalDataType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalDepthClipMode`.
    pub struct MetalDepthClipMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalDeviceLocation`.
    pub struct MetalDeviceLocation(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalDispatchType`.
    pub struct MetalDispatchType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalDynamicLibraryError`.
    pub struct MetalDynamicLibraryError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalFeatureSet`.
    pub struct MetalFeatureSet(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionLogType`.
    pub struct MetalFunctionLogType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionOptions`.
    pub struct MetalFunctionOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionType`.
    pub struct MetalFunctionType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalHeapType`.
    pub struct MetalHeapType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIndexType`.
    pub struct MetalIndexType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoCommandQueueType`.
    pub struct MetalIoCommandQueueType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoCompressionMethod`.
    pub struct MetalIoCompressionMethod(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoCompressionStatus`.
    pub struct MetalIoCompressionStatus(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoPriority`.
    pub struct MetalIoPriority(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoStatus`.
    pub struct MetalIoStatus(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalLanguageVersion`.
    pub struct MetalLanguageVersion(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalLibraryError`.
    pub struct MetalLibraryError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalLibraryOptimizationLevel`.
    pub struct MetalLibraryOptimizationLevel(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalLibraryType`.
    pub struct MetalLibraryType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalLogStateError`.
    pub struct MetalLogStateError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMathFloatingPointFunctions`.
    pub struct MetalMathFloatingPointFunctions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMathMode`.
    pub struct MetalMathMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMatrixLayout`.
    pub struct MetalMatrixLayout(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMotionBorderMode`.
    pub struct MetalMotionBorderMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMultisampleDepthResolveFilter`.
    pub struct MetalMultisampleDepthResolveFilter(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMultisampleStencilResolveFilter`.
    pub struct MetalMultisampleStencilResolveFilter(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalMutability`.
    pub struct MetalMutability(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalPatchType`.
    pub struct MetalPatchType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalPipelineOption`.
    pub struct MetalPipelineOption(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalPrimitiveTopologyClass`.
    pub struct MetalPrimitiveTopologyClass(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalReadWriteTextureTier`.
    pub struct MetalReadWriteTextureTier(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalRenderStages`.
    pub struct MetalRenderStages(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalResourceUsage`.
    pub struct MetalResourceUsage(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalShaderValidation`.
    pub struct MetalShaderValidation(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalSparsePageSize`.
    pub struct MetalSparsePageSize(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalSparseTextureRegionAlignmentMode`.
    pub struct MetalSparseTextureRegionAlignmentMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalStages`.
    pub struct MetalStages(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalStepFunction`.
    pub struct MetalStepFunction(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalStitchedLibraryOptions`.
    pub struct MetalStitchedLibraryOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalStoreActionOptions`.
    pub struct MetalStoreActionOptions(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTensorDataType`.
    pub struct MetalTensorDataType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTensorError`.
    pub struct MetalTensorError(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTensorUsage`.
    pub struct MetalTensorUsage(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTessellationControlPointIndexType`.
    pub struct MetalTessellationControlPointIndexType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTessellationFactorFormat`.
    pub struct MetalTessellationFactorFormat(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTessellationFactorStepFunction`.
    pub struct MetalTessellationFactorStepFunction(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTessellationPartitionMode`.
    pub struct MetalTessellationPartitionMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTextureCompressionType`.
    pub struct MetalTextureCompressionType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTextureSparseTier`.
    pub struct MetalTextureSparseTier(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTextureSwizzle`.
    pub struct MetalTextureSwizzle(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTransformType`.
    pub struct MetalTransformType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalTriangleFillMode`.
    pub struct MetalTriangleFillMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalVertexFormat`.
    pub struct MetalVertexFormat(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalVertexStepFunction`.
    pub struct MetalVertexStepFunction(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalVisibilityResultMode`.
    pub struct MetalVisibilityResultMode(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalVisibilityResultType`.
    pub struct MetalVisibilityResultType(usize);
);
raw_value_type!(
    /// Mirrors the `Metal` framework counterpart for `MetalWinding`.
    pub struct MetalWinding(usize);
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4Archive`.
    pub struct Metal4Archive;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4ArgumentTable`.
    pub struct Metal4ArgumentTable;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4BinaryFunction`.
    pub struct Metal4BinaryFunction;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommandAllocator`.
    pub struct Metal4CommandAllocator;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommandBuffer`.
    pub struct Metal4CommandBuffer;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommandEncoder`.
    pub struct Metal4CommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommandQueue`.
    pub struct Metal4CommandQueue;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CommitFeedback`.
    pub struct Metal4CommitFeedback;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4Compiler`.
    pub struct Metal4Compiler;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CompilerTask`.
    pub struct Metal4CompilerTask;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4ComputeCommandEncoder`.
    pub struct Metal4ComputeCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4CounterHeap`.
    pub struct Metal4CounterHeap;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4FxFrameInterpolator`.
    pub struct Metal4FxFrameInterpolator;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4FxSpatialScaler`.
    pub struct Metal4FxSpatialScaler;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4FxTemporalDenoisedScaler`.
    pub struct Metal4FxTemporalDenoisedScaler;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4FxTemporalScaler`.
    pub struct Metal4FxTemporalScaler;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4MachineLearningCommandEncoder`.
    pub struct Metal4MachineLearningCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4MachineLearningPipelineState`.
    pub struct Metal4MachineLearningPipelineState;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4PipelineDataSetSerializer`.
    pub struct Metal4PipelineDataSetSerializer;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `Metal4RenderCommandEncoder`.
    pub struct Metal4RenderCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalAccelerationStructureCommandEncoder`.
    pub struct MetalAccelerationStructureCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalAllocation`.
    pub struct MetalAllocation;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalBinding`.
    pub struct MetalBinding;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalBufferBinding`.
    pub struct MetalBufferBinding;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalCommandBufferEncoderInfo`.
    pub struct MetalCommandBufferEncoderInfo;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalCommandEncoder`.
    pub struct MetalCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalCounter`.
    pub struct MetalCounter;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalDrawable`.
    pub struct MetalDrawable;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionHandle`.
    pub struct MetalFunctionHandle;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionLog`.
    pub struct MetalFunctionLog;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionLogDebugLocation`.
    pub struct MetalFunctionLogDebugLocation;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionStitchingAttribute`.
    pub struct MetalFunctionStitchingAttribute;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFunctionStitchingNode`.
    pub struct MetalFunctionStitchingNode;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxFrameInterpolator`.
    pub struct MetalFxFrameInterpolator;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxFrameInterpolatorBase`.
    pub struct MetalFxFrameInterpolatorBase;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxSpatialScalerBase`.
    pub struct MetalFxSpatialScalerBase;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxTemporalDenoisedScaler`.
    pub struct MetalFxTemporalDenoisedScaler;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxTemporalDenoisedScalerBase`.
    pub struct MetalFxTemporalDenoisedScalerBase;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalFxTemporalScalerBase`.
    pub struct MetalFxTemporalScalerBase;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIndirectComputeCommand`.
    pub struct MetalIndirectComputeCommand;
);
opaque_symbol_handle!(
    /// `id<MTLIndirectComputeCommandEncoder>` — encodes indirect compute dispatches.
    pub struct MetalIndirectComputeCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIndirectRenderCommand`.
    pub struct MetalIndirectRenderCommand;
);
opaque_symbol_handle!(
    /// `id<MTLIndirectRenderCommandEncoder>` — encodes indirect render commands.
    pub struct MetalIndirectRenderCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoCommandBuffer`.
    pub struct MetalIoCommandBuffer;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoCommandQueue`.
    pub struct MetalIoCommandQueue;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoFileHandle`.
    pub struct MetalIoFileHandle;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoScratchBuffer`.
    pub struct MetalIoScratchBuffer;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalIoScratchBufferAllocator`.
    pub struct MetalIoScratchBufferAllocator;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalLogContainer`.
    pub struct MetalLogContainer;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalObjectPayloadBinding`.
    pub struct MetalObjectPayloadBinding;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalParallelRenderCommandEncoder`.
    pub struct MetalParallelRenderCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalRasterizationRateMap`.
    pub struct MetalRasterizationRateMap;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalResource`.
    pub struct MetalResource;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalResourceStateCommandEncoder`.
    pub struct MetalResourceStateCommandEncoder;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalResourceViewPool`.
    pub struct MetalResourceViewPool;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalTensor`.
    pub struct MetalTensor;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalTensorBinding`.
    pub struct MetalTensorBinding;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalTextureBinding`.
    pub struct MetalTextureBinding;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalTextureViewPool`.
    pub struct MetalTextureViewPool;
);
opaque_symbol_handle!(
    /// Mirrors the `Metal` framework counterpart for `MetalThreadgroupBinding`.
    pub struct MetalThreadgroupBinding;
);
opaque_symbol_class!(pub struct Metal4AccelerationStructureBoundingBoxGeometryDescriptor => "MTL4AccelerationStructureBoundingBoxGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureCurveGeometryDescriptor => "MTL4AccelerationStructureCurveGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureDescriptor => "MTL4AccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureGeometryDescriptor => "MTL4AccelerationStructureGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureMotionBoundingBoxGeometryDescriptor => "MTL4AccelerationStructureMotionBoundingBoxGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureMotionCurveGeometryDescriptor => "MTL4AccelerationStructureMotionCurveGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureMotionTriangleGeometryDescriptor => "MTL4AccelerationStructureMotionTriangleGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4AccelerationStructureTriangleGeometryDescriptor => "MTL4AccelerationStructureTriangleGeometryDescriptor";);
opaque_symbol_class!(pub struct Metal4ArgumentTableDescriptor => "MTL4ArgumentTableDescriptor";);
opaque_symbol_class!(pub struct Metal4BinaryFunctionDescriptor => "MTL4BinaryFunctionDescriptor";);
opaque_symbol_class!(pub struct Metal4CommandAllocatorDescriptor => "MTL4CommandAllocatorDescriptor";);
opaque_symbol_class!(pub struct Metal4CommandBufferOptions => "MTL4CommandBufferOptions";);
opaque_symbol_class!(pub struct Metal4CommandQueueDescriptor => "MTL4CommandQueueDescriptor";);
opaque_symbol_class!(pub struct Metal4CommitOptions => "MTL4CommitOptions";);
opaque_symbol_class!(pub struct Metal4CompilerDescriptor => "MTL4CompilerDescriptor";);
opaque_symbol_class!(pub struct Metal4CompilerTaskOptions => "MTL4CompilerTaskOptions";);
opaque_symbol_class!(pub struct Metal4ComputePipelineDescriptor => "MTL4ComputePipelineDescriptor";);
opaque_symbol_class!(pub struct Metal4CounterHeapDescriptor => "MTL4CounterHeapDescriptor";);
opaque_symbol_class!(pub struct Metal4FunctionDescriptor => "MTL4FunctionDescriptor";);
opaque_symbol_class!(pub struct Metal4IndirectInstanceAccelerationStructureDescriptor => "MTL4IndirectInstanceAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct Metal4InstanceAccelerationStructureDescriptor => "MTL4InstanceAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct Metal4LibraryDescriptor => "MTL4LibraryDescriptor";);
opaque_symbol_class!(pub struct Metal4LibraryFunctionDescriptor => "MTL4LibraryFunctionDescriptor";);
opaque_symbol_class!(pub struct Metal4MachineLearningPipelineDescriptor => "MTL4MachineLearningPipelineDescriptor";);
opaque_symbol_class!(pub struct Metal4MachineLearningPipelineReflection => "MTL4MachineLearningPipelineReflection";);
opaque_symbol_class!(pub struct Metal4MeshRenderPipelineDescriptor => "MTL4MeshRenderPipelineDescriptor";);
opaque_symbol_class!(pub struct Metal4PipelineDataSetSerializerDescriptor => "MTL4PipelineDataSetSerializerDescriptor";);
opaque_symbol_class!(pub struct Metal4PipelineDescriptor => "MTL4PipelineDescriptor";);
opaque_symbol_class!(pub struct Metal4PipelineOptions => "MTL4PipelineOptions";);
opaque_symbol_class!(pub struct Metal4PipelineStageDynamicLinkingDescriptor => "MTL4PipelineStageDynamicLinkingDescriptor";);
opaque_symbol_class!(pub struct Metal4PrimitiveAccelerationStructureDescriptor => "MTL4PrimitiveAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct Metal4RenderPassDescriptor => "MTL4RenderPassDescriptor";);
opaque_symbol_class!(pub struct Metal4RenderPipelineBinaryFunctionsDescriptor => "MTL4RenderPipelineBinaryFunctionsDescriptor";);
opaque_symbol_class!(pub struct Metal4RenderPipelineColorAttachmentDescriptor => "MTL4RenderPipelineColorAttachmentDescriptor";);
opaque_symbol_class!(pub struct Metal4RenderPipelineColorAttachmentDescriptorArray => "MTL4RenderPipelineColorAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct Metal4RenderPipelineDescriptor => "MTL4RenderPipelineDescriptor";);
opaque_symbol_class!(pub struct Metal4RenderPipelineDynamicLinkingDescriptor => "MTL4RenderPipelineDynamicLinkingDescriptor";);
opaque_symbol_class!(pub struct Metal4SpecializedFunctionDescriptor => "MTL4SpecializedFunctionDescriptor";);
opaque_symbol_class!(pub struct Metal4StaticLinkingDescriptor => "MTL4StaticLinkingDescriptor";);
opaque_symbol_class!(pub struct Metal4StitchedFunctionDescriptor => "MTL4StitchedFunctionDescriptor";);
opaque_symbol_class!(pub struct Metal4TileRenderPipelineDescriptor => "MTL4TileRenderPipelineDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureBoundingBoxGeometryDescriptor => "MTLAccelerationStructureBoundingBoxGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureCurveGeometryDescriptor => "MTLAccelerationStructureCurveGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureDescriptor => "MTLAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureGeometryDescriptor => "MTLAccelerationStructureGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureMotionBoundingBoxGeometryDescriptor => "MTLAccelerationStructureMotionBoundingBoxGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureMotionCurveGeometryDescriptor => "MTLAccelerationStructureMotionCurveGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructureMotionTriangleGeometryDescriptor => "MTLAccelerationStructureMotionTriangleGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructurePassDescriptor => "MTLAccelerationStructurePassDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructurePassSampleBufferAttachmentDescriptor => "MTLAccelerationStructurePassSampleBufferAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalAccelerationStructurePassSampleBufferAttachmentDescriptorArray => "MTLAccelerationStructurePassSampleBufferAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalAccelerationStructureTriangleGeometryDescriptor => "MTLAccelerationStructureTriangleGeometryDescriptor";);
opaque_symbol_class!(pub struct MetalArchitecture => "MTLArchitecture";);
opaque_symbol_class!(pub struct MetalArgument => "MTLArgument";);
opaque_symbol_class!(pub struct MetalArrayType => "MTLArrayType";);
opaque_symbol_class!(pub struct MetalAttribute => "MTLAttribute";);
opaque_symbol_class!(pub struct MetalAttributeDescriptor => "MTLAttributeDescriptor";);
opaque_symbol_class!(pub struct MetalAttributeDescriptorArray => "MTLAttributeDescriptorArray";);
opaque_symbol_class!(pub struct MetalBinaryArchiveDescriptor => "MTLBinaryArchiveDescriptor";);
opaque_symbol_class!(pub struct MetalBlitPassDescriptor => "MTLBlitPassDescriptor";);
opaque_symbol_class!(pub struct MetalBlitPassSampleBufferAttachmentDescriptor => "MTLBlitPassSampleBufferAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalBlitPassSampleBufferAttachmentDescriptorArray => "MTLBlitPassSampleBufferAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalBufferLayoutDescriptor => "MTLBufferLayoutDescriptor";);
opaque_symbol_class!(pub struct MetalBufferLayoutDescriptorArray => "MTLBufferLayoutDescriptorArray";);
opaque_symbol_class!(
    /// `MTLCaptureDescriptor` — configures a GPU capture session.
    pub struct MetalCaptureDescriptor => "MTLCaptureDescriptor";
);
opaque_symbol_class!(pub struct MetalCommandBufferDescriptor => "MTLCommandBufferDescriptor";);
opaque_symbol_class!(pub struct MetalCommandQueueDescriptor => "MTLCommandQueueDescriptor";);
opaque_symbol_class!(pub struct MetalCompileOptions => "MTLCompileOptions";);
opaque_symbol_class!(pub struct MetalComputePassDescriptor => "MTLComputePassDescriptor";);
opaque_symbol_class!(pub struct MetalComputePassSampleBufferAttachmentDescriptor => "MTLComputePassSampleBufferAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalComputePassSampleBufferAttachmentDescriptorArray => "MTLComputePassSampleBufferAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalComputePipelineReflection => "MTLComputePipelineReflection";);
opaque_symbol_class!(pub struct MetalCounterSampleBufferDescriptor => "MTLCounterSampleBufferDescriptor";);
opaque_symbol_class!(pub struct MetalFunctionConstant => "MTLFunctionConstant";);
opaque_symbol_class!(pub struct MetalFunctionConstantValues => "MTLFunctionConstantValues";);
opaque_symbol_class!(pub struct MetalFunctionDescriptor => "MTLFunctionDescriptor";);
opaque_symbol_class!(pub struct MetalFunctionReflection => "MTLFunctionReflection";);
opaque_symbol_class!(pub struct MetalFunctionStitchingAttributeAlwaysInline => "MTLFunctionStitchingAttributeAlwaysInline";);
opaque_symbol_class!(pub struct MetalFunctionStitchingFunctionNode => "MTLFunctionStitchingFunctionNode";);
opaque_symbol_class!(pub struct MetalFunctionStitchingGraph => "MTLFunctionStitchingGraph";);
opaque_symbol_class!(pub struct MetalFunctionStitchingInputNode => "MTLFunctionStitchingInputNode";);
opaque_symbol_class!(pub struct MetalFxFrameInterpolatorDescriptor => "MTLFXFrameInterpolatorDescriptor";);
opaque_symbol_class!(pub struct MetalFxTemporalDenoisedScalerDescriptor => "MTLFXTemporalDenoisedScalerDescriptor";);
opaque_symbol_class!(pub struct MetalHeapDescriptor => "MTLHeapDescriptor";);
opaque_symbol_class!(pub struct MetalIndirectCommandBufferDescriptor => "MTLIndirectCommandBufferDescriptor";);
opaque_symbol_class!(pub struct MetalIndirectInstanceAccelerationStructureDescriptor => "MTLIndirectInstanceAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct MetalInstanceAccelerationStructureDescriptor => "MTLInstanceAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct MetalIntersectionFunctionDescriptor => "MTLIntersectionFunctionDescriptor";);
opaque_symbol_class!(pub struct MetalIntersectionFunctionTableDescriptor => "MTLIntersectionFunctionTableDescriptor";);
opaque_symbol_class!(pub struct MetalIoCommandQueueDescriptor => "MTLIOCommandQueueDescriptor";);
opaque_symbol_class!(pub struct MetalLinkedFunctions => "MTLLinkedFunctions";);
opaque_symbol_class!(pub struct MetalLogStateDescriptor => "MTLLogStateDescriptor";);
opaque_symbol_class!(pub struct MetalLogicalToPhysicalColorAttachmentMap => "MTLLogicalToPhysicalColorAttachmentMap";);
opaque_symbol_class!(pub struct MetalMeshRenderPipelineDescriptor => "MTLMeshRenderPipelineDescriptor";);
opaque_symbol_class!(pub struct MetalMotionKeyframeData => "MTLMotionKeyframeData";);
opaque_symbol_class!(pub struct MetalPipelineBufferDescriptor => "MTLPipelineBufferDescriptor";);
opaque_symbol_class!(pub struct MetalPipelineBufferDescriptorArray => "MTLPipelineBufferDescriptorArray";);
opaque_symbol_class!(pub struct MetalPointerType => "MTLPointerType";);
opaque_symbol_class!(pub struct MetalPrimitiveAccelerationStructureDescriptor => "MTLPrimitiveAccelerationStructureDescriptor";);
opaque_symbol_class!(pub struct MetalRasterizationRateLayerArray => "MTLRasterizationRateLayerArray";);
opaque_symbol_class!(pub struct MetalRasterizationRateLayerDescriptor => "MTLRasterizationRateLayerDescriptor";);
opaque_symbol_class!(pub struct MetalRasterizationRateMapDescriptor => "MTLRasterizationRateMapDescriptor";);
opaque_symbol_class!(pub struct MetalRasterizationRateSampleArray => "MTLRasterizationRateSampleArray";);
opaque_symbol_class!(pub struct MetalRenderPassAttachmentDescriptor => "MTLRenderPassAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPassColorAttachmentDescriptor => "MTLRenderPassColorAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPassColorAttachmentDescriptorArray => "MTLRenderPassColorAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalRenderPassDepthAttachmentDescriptor => "MTLRenderPassDepthAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPassDescriptor => "MTLRenderPassDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPassSampleBufferAttachmentDescriptor => "MTLRenderPassSampleBufferAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPassSampleBufferAttachmentDescriptorArray => "MTLRenderPassSampleBufferAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalRenderPassStencilAttachmentDescriptor => "MTLRenderPassStencilAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPipelineColorAttachmentDescriptorArray => "MTLRenderPipelineColorAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalRenderPipelineFunctionsDescriptor => "MTLRenderPipelineFunctionsDescriptor";);
opaque_symbol_class!(pub struct MetalRenderPipelineReflection => "MTLRenderPipelineReflection";);
opaque_symbol_class!(pub struct MetalResidencySetDescriptor => "MTLResidencySetDescriptor";);
opaque_symbol_class!(pub struct MetalResourceStatePassDescriptor => "MTLResourceStatePassDescriptor";);
opaque_symbol_class!(pub struct MetalResourceStatePassSampleBufferAttachmentDescriptor => "MTLResourceStatePassSampleBufferAttachmentDescriptor";);
opaque_symbol_class!(pub struct MetalResourceStatePassSampleBufferAttachmentDescriptorArray => "MTLResourceStatePassSampleBufferAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalResourceViewPoolDescriptor => "MTLResourceViewPoolDescriptor";);
opaque_symbol_class!(pub struct MetalSharedEventHandle => "MTLSharedEventHandle";);
opaque_symbol_class!(pub struct MetalSharedEventListener => "MTLSharedEventListener";);
opaque_symbol_class!(pub struct MetalSharedTextureHandle => "MTLSharedTextureHandle";);
opaque_symbol_class!(pub struct MetalStageInputOutputDescriptor => "MTLStageInputOutputDescriptor";);
opaque_symbol_class!(pub struct MetalStitchedLibraryDescriptor => "MTLStitchedLibraryDescriptor";);
opaque_symbol_class!(pub struct MetalStructMember => "MTLStructMember";);
opaque_symbol_class!(pub struct MetalStructType => "MTLStructType";);
opaque_symbol_class!(pub struct MetalTensorDescriptor => "MTLTensorDescriptor";);
opaque_symbol_class!(pub struct MetalTensorExtents => "MTLTensorExtents";);
opaque_symbol_class!(pub struct MetalTensorReferenceType => "MTLTensorReferenceType";);
opaque_symbol_class!(pub struct MetalTextureReferenceType => "MTLTextureReferenceType";);
opaque_symbol_class!(pub struct MetalTextureViewDescriptor => "MTLTextureViewDescriptor";);
opaque_symbol_class!(pub struct MetalTileRenderPipelineColorAttachmentDescriptorArray => "MTLTileRenderPipelineColorAttachmentDescriptorArray";);
opaque_symbol_class!(pub struct MetalType => "MTLType";);
opaque_symbol_class!(pub struct MetalVertexAttribute => "MTLVertexAttribute";);
opaque_symbol_class!(pub struct MetalVertexAttributeDescriptor => "MTLVertexAttributeDescriptor";);
opaque_symbol_class!(pub struct MetalVertexAttributeDescriptorArray => "MTLVertexAttributeDescriptorArray";);
opaque_symbol_class!(pub struct MetalVertexBufferLayoutDescriptor => "MTLVertexBufferLayoutDescriptor";);
opaque_symbol_class!(pub struct MetalVertexBufferLayoutDescriptorArray => "MTLVertexBufferLayoutDescriptorArray";);
opaque_symbol_class!(pub struct MetalVertexDescriptor => "MTLVertexDescriptor";);
opaque_symbol_class!(pub struct MetalVisibleFunctionTableDescriptor => "MTLVisibleFunctionTableDescriptor";);
