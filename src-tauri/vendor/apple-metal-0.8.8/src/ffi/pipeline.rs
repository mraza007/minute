use core::ffi::c_void;

extern "C" {
    /// Calls the `Metal` framework counterpart for `am_device_new_compute_pipeline_state_with_descriptor`.
    pub fn am_device_new_compute_pipeline_state_with_descriptor(
        device_handle: *mut c_void,
        function_handle: *mut c_void,
        label: *const core::ffi::c_char,
        thread_group_size_is_multiple_of_thread_execution_width: bool,
        max_total_threads_per_threadgroup: usize,
        support_indirect_command_buffers: bool,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_device_new_render_pipeline_state_with_descriptor`.
    pub fn am_device_new_render_pipeline_state_with_descriptor(
        device_handle: *mut c_void,
        vertex_handle: *mut c_void,
        fragment_handle: *mut c_void,
        label: *const core::ffi::c_char,
        raster_sample_count: usize,
        alpha_to_coverage_enabled: bool,
        alpha_to_one_enabled: bool,
        rasterization_enabled: bool,
        support_indirect_command_buffers: bool,
        depth_attachment_pixel_format: usize,
        stencil_attachment_pixel_format: usize,
        color_attachments: *const usize,
        color_attachment_count: usize,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_device_new_tile_render_pipeline_state`.
    pub fn am_device_new_tile_render_pipeline_state(
        device_handle: *mut c_void,
        tile_function_handle: *mut c_void,
        label: *const core::ffi::c_char,
        raster_sample_count: usize,
        threadgroup_size_matches_tile_size: bool,
        max_total_threads_per_threadgroup: usize,
        color_attachments: *const usize,
        color_attachment_count: usize,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
}
