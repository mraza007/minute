use crate::{
    ffi, util::take_optional_string, CommandBuffer, CommandQueue, ComputePipelineState,
    CounterSampleBuffer, DepthStencilState, Event, Fence, MetalBuffer, MetalTexture,
    RenderPipelineState, SamplerState,
};
use core::ffi::c_void;
use core::ops::Range;

macro_rules! opaque_encoder {
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

/// `MTLCommandBufferStatus` enum values.
pub mod command_buffer_status {
    /// Mirrors the `Metal` framework constant `NOT_ENQUEUED`.
    pub const NOT_ENQUEUED: usize = 0;
    /// Mirrors the `Metal` framework constant `ENQUEUED`.
    pub const ENQUEUED: usize = 1;
    /// Mirrors the `Metal` framework constant `COMMITTED`.
    pub const COMMITTED: usize = 2;
    /// Mirrors the `Metal` framework constant `SCHEDULED`.
    pub const SCHEDULED: usize = 3;
    /// Mirrors the `Metal` framework constant `COMPLETED`.
    pub const COMPLETED: usize = 4;
    /// Mirrors the `Metal` framework constant `ERROR`.
    pub const ERROR: usize = 5;
}

opaque_encoder!(
    /// Apple's `id<MTLBlitCommandEncoder>` — encodes buffer and texture copy work.
    pub struct BlitCommandEncoder;
);
opaque_encoder!(
    /// Apple's `id<MTLComputeCommandEncoder>` — encodes compute dispatches.
    pub struct ComputeCommandEncoder;
);
opaque_encoder!(
    /// Apple's `id<MTLRenderCommandEncoder>` — encodes render passes.
    pub struct RenderCommandEncoder;
);

impl CommandQueue {
    /// Create a new command buffer that does not retain resources it references.
    #[must_use]
    pub fn new_command_buffer_with_unretained_references(&self) -> Option<CommandBuffer> {
        let ptr = unsafe {
            ffi::am_command_queue_new_command_buffer_with_unretained_references(self.as_ptr())
        };
        if ptr.is_null() {
            None
        } else {
            Some(unsafe { CommandBuffer::from_retained_ptr(ptr) })
        }
    }
}

impl CommandBuffer {
    /// Enqueue the command buffer on its queue without immediately committing it.
    pub fn enqueue(&self) {
        unsafe { ffi::am_command_buffer_enqueue(self.as_ptr()) };
    }

    /// Block the current thread until Metal schedules the command buffer.
    pub fn wait_until_scheduled(&self) {
        unsafe { ffi::am_command_buffer_wait_until_scheduled(self.as_ptr()) };
    }

    /// Current `MTLCommandBufferStatus` value — see [`command_buffer_status`].
    #[must_use]
    pub fn status(&self) -> usize {
        unsafe { ffi::am_command_buffer_status(self.as_ptr()) }
    }

    /// Localized Metal error string for a failed command buffer.
    #[must_use]
    pub fn error(&self) -> Option<String> {
        unsafe { take_optional_string(ffi::am_command_buffer_error_message(self.as_ptr())) }
    }

    /// Create a standalone blit command encoder for this command buffer.
    #[must_use]
    pub fn new_blit_command_encoder(&self) -> Option<BlitCommandEncoder> {
        BlitCommandEncoder::wrap(unsafe {
            ffi::am_command_buffer_new_blit_command_encoder(self.as_ptr())
        })
    }

    /// Create a standalone compute command encoder for this command buffer.
    #[must_use]
    pub fn new_compute_command_encoder(&self) -> Option<ComputeCommandEncoder> {
        ComputeCommandEncoder::wrap(unsafe {
            ffi::am_command_buffer_new_compute_command_encoder(self.as_ptr())
        })
    }

    /// Create a render command encoder that renders into `texture`.
    #[must_use]
    pub fn new_render_command_encoder(
        &self,
        texture: &MetalTexture,
        load_action: usize,
        store_action: usize,
        clear_color: [f64; 4],
    ) -> Option<RenderCommandEncoder> {
        RenderCommandEncoder::wrap(unsafe {
            ffi::am_command_buffer_new_render_command_encoder(
                self.as_ptr(),
                texture.as_ptr(),
                load_action,
                store_action,
                clear_color[0],
                clear_color[1],
                clear_color[2],
                clear_color[3],
            )
        })
    }

    /// Encode a wait until `event` reaches at least `value`.
    pub fn encode_wait_for_event(&self, event: &Event, value: u64) {
        unsafe {
            ffi::am_command_buffer_encode_wait_for_event(self.as_ptr(), event.as_ptr(), value);
        };
    }

    /// Encode a signal that updates `event` to `value`.
    pub fn encode_signal_event(&self, event: &Event, value: u64) {
        unsafe { ffi::am_command_buffer_encode_signal_event(self.as_ptr(), event.as_ptr(), value) };
    }
}

impl BlitCommandEncoder {
    /// Copy `size` bytes from `src` into `dst`.
    #[must_use]
    pub fn copy_buffer(
        &self,
        src: &MetalBuffer,
        src_offset: usize,
        dst: &MetalBuffer,
        dst_offset: usize,
        size: usize,
    ) -> bool {
        unsafe {
            ffi::am_blit_command_encoder_copy_buffer(
                self.as_ptr(),
                src.as_ptr(),
                src_offset,
                dst.as_ptr(),
                dst_offset,
                size,
            )
        }
    }

    /// Fill a byte range of `buffer` with `value`.
    #[must_use]
    pub fn fill_buffer(&self, buffer: &MetalBuffer, range: Range<usize>, value: u8) -> bool {
        let length = range.end.saturating_sub(range.start);
        unsafe {
            ffi::am_blit_command_encoder_fill_buffer(
                self.as_ptr(),
                buffer.as_ptr(),
                range.start,
                length,
                value,
            )
        }
    }

    /// Sample hardware counters into `sample_buffer`.
    #[must_use]
    pub fn sample_counters(
        &self,
        sample_buffer: &CounterSampleBuffer,
        sample_index: usize,
        barrier: bool,
    ) -> bool {
        unsafe {
            ffi::am_blit_command_encoder_sample_counters(
                self.as_ptr(),
                sample_buffer.as_ptr(),
                sample_index,
                barrier,
            )
        }
    }

    /// Update `fence` with work encoded so far.
    pub fn update_fence(&self, fence: &Fence) {
        unsafe { ffi::am_blit_command_encoder_update_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Wait for `fence` before executing subsequent work.
    pub fn wait_for_fence(&self, fence: &Fence) {
        unsafe { ffi::am_blit_command_encoder_wait_for_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Finish encoding commands.
    pub fn end_encoding(&self) {
        unsafe { ffi::am_command_encoder_end_encoding(self.as_ptr()) };
    }
}

impl ComputeCommandEncoder {
    /// Bind a compute pipeline state.
    pub fn set_compute_pipeline_state(&self, pipeline: &ComputePipelineState) {
        unsafe {
            ffi::am_compute_command_encoder_set_pipeline_state(self.as_ptr(), pipeline.as_ptr());
        };
    }

    /// Bind a buffer at `index`.
    pub fn set_buffer(&self, buffer: &MetalBuffer, offset: usize, index: usize) {
        unsafe {
            ffi::am_compute_command_encoder_set_buffer(
                self.as_ptr(),
                buffer.as_ptr(),
                offset,
                index,
            );
        };
    }

    /// Bind a texture at `index`.
    pub fn set_texture(&self, texture: &MetalTexture, index: usize) {
        unsafe {
            ffi::am_compute_command_encoder_set_texture(self.as_ptr(), texture.as_ptr(), index);
        };
    }

    /// Bind a sampler state at `index`.
    pub fn set_sampler_state(&self, sampler: &SamplerState, index: usize) {
        unsafe {
            ffi::am_compute_command_encoder_set_sampler_state(
                self.as_ptr(),
                sampler.as_ptr(),
                index,
            );
        };
    }

    /// Bind a visible function table at `index`.
    pub fn set_visible_function_table(&self, table: &crate::VisibleFunctionTable, index: usize) {
        unsafe {
            ffi::am_compute_command_encoder_set_visible_function_table(
                self.as_ptr(),
                table.as_ptr(),
                index,
            );
        };
    }

    /// Bind an intersection function table at `index`.
    pub fn set_intersection_function_table(
        &self,
        table: &crate::IntersectionFunctionTable,
        index: usize,
    ) {
        unsafe {
            ffi::am_compute_command_encoder_set_intersection_function_table(
                self.as_ptr(),
                table.as_ptr(),
                index,
            );
        };
    }

    /// Bind an acceleration structure at `index`.
    pub fn set_acceleration_structure(
        &self,
        acceleration_structure: &crate::AccelerationStructure,
        index: usize,
    ) {
        unsafe {
            ffi::am_compute_command_encoder_set_acceleration_structure(
                self.as_ptr(),
                acceleration_structure.as_ptr(),
                index,
            );
        };
    }

    /// Dispatch threadgroups of fixed size.
    pub fn dispatch_threadgroups(
        &self,
        threadgroups: (usize, usize, usize),
        threads_per_threadgroup: (usize, usize, usize),
    ) {
        unsafe {
            ffi::am_compute_command_encoder_dispatch_threadgroups(
                self.as_ptr(),
                threadgroups.0,
                threadgroups.1,
                threadgroups.2,
                threads_per_threadgroup.0,
                threads_per_threadgroup.1,
                threads_per_threadgroup.2,
            );
        };
    }

    /// Dispatch an arbitrary thread grid.
    pub fn dispatch_threads(
        &self,
        threads: (usize, usize, usize),
        threads_per_threadgroup: (usize, usize, usize),
    ) {
        unsafe {
            ffi::am_compute_command_encoder_dispatch_threads(
                self.as_ptr(),
                threads.0,
                threads.1,
                threads.2,
                threads_per_threadgroup.0,
                threads_per_threadgroup.1,
                threads_per_threadgroup.2,
            );
        };
    }

    /// Update `fence` with work encoded so far.
    pub fn update_fence(&self, fence: &Fence) {
        unsafe { ffi::am_compute_command_encoder_update_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Wait for `fence` before executing subsequent work.
    pub fn wait_for_fence(&self, fence: &Fence) {
        unsafe { ffi::am_compute_command_encoder_wait_for_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Finish encoding commands.
    pub fn end_encoding(&self) {
        unsafe { ffi::am_command_encoder_end_encoding(self.as_ptr()) };
    }
}

impl RenderCommandEncoder {
    /// Bind a render pipeline state.
    pub fn set_render_pipeline_state(&self, pipeline: &RenderPipelineState) {
        unsafe {
            ffi::am_render_command_encoder_set_render_pipeline_state(
                self.as_ptr(),
                pipeline.as_ptr(),
            );
        };
    }

    /// Bind a vertex buffer at `index`.
    pub fn set_vertex_buffer(&self, buffer: &MetalBuffer, offset: usize, index: usize) {
        unsafe {
            ffi::am_render_command_encoder_set_vertex_buffer(
                self.as_ptr(),
                buffer.as_ptr(),
                offset,
                index,
            );
        };
    }

    /// Bind a fragment sampler state at `index`.
    pub fn set_fragment_sampler_state(&self, sampler: &SamplerState, index: usize) {
        unsafe {
            ffi::am_render_command_encoder_set_fragment_sampler_state(
                self.as_ptr(),
                sampler.as_ptr(),
                index,
            );
        };
    }

    /// Bind a depth/stencil state object.
    pub fn set_depth_stencil_state(&self, state: &DepthStencilState) {
        unsafe {
            ffi::am_render_command_encoder_set_depth_stencil_state(self.as_ptr(), state.as_ptr());
        };
    }

    /// Draw a non-indexed primitive range.
    pub fn draw_primitives(&self, primitive_type: usize, vertex_start: usize, vertex_count: usize) {
        unsafe {
            ffi::am_render_command_encoder_draw_primitives(
                self.as_ptr(),
                primitive_type,
                vertex_start,
                vertex_count,
            );
        };
    }

    /// Update `fence` with work encoded so far.
    pub fn update_fence(&self, fence: &Fence) {
        unsafe { ffi::am_render_command_encoder_update_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Wait for `fence` before executing subsequent work.
    pub fn wait_for_fence(&self, fence: &Fence) {
        unsafe { ffi::am_render_command_encoder_wait_for_fence(self.as_ptr(), fence.as_ptr()) };
    }

    /// Finish encoding commands.
    pub fn end_encoding(&self) {
        unsafe { ffi::am_command_encoder_end_encoding(self.as_ptr()) };
    }
}
