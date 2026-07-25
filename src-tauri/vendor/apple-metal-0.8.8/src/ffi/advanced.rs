use core::ffi::c_void;

extern "C" {
    /// Calls the `Metal` framework counterpart for `am_object_release`.
    pub fn am_object_release(handle: *mut c_void);

    /// Calls the `Metal` framework counterpart for `am_device_name`.
    pub fn am_device_name(handle: *mut c_void) -> *mut core::ffi::c_char;
    /// Calls the `Metal` framework counterpart for `am_device_registry_id`.
    pub fn am_device_registry_id(handle: *mut c_void) -> u64;
    /// Calls the `Metal` framework counterpart for `am_device_supports_dynamic_libraries`.
    pub fn am_device_supports_dynamic_libraries(handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_device_supports_render_dynamic_libraries`.
    pub fn am_device_supports_render_dynamic_libraries(handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_device_supports_raytracing`.
    pub fn am_device_supports_raytracing(handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_device_supports_counter_sampling`.
    pub fn am_device_supports_counter_sampling(handle: *mut c_void, sampling_point: usize) -> bool;
    /// Calls the `Metal` framework counterpart for `am_device_counter_set_count`.
    pub fn am_device_counter_set_count(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_device_counter_set_name_at`.
    pub fn am_device_counter_set_name_at(
        handle: *mut c_void,
        index: usize,
    ) -> *mut core::ffi::c_char;
    /// Calls the `Metal` framework counterpart for `am_device_new_command_queue_with_max_command_buffer_count`.
    pub fn am_device_new_command_queue_with_max_command_buffer_count(
        handle: *mut c_void,
        max_command_buffer_count: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_command_queue_with_log_state`.
    pub fn am_device_new_command_queue_with_log_state(
        handle: *mut c_void,
        max_command_buffer_count: usize,
        log_state_handle: *mut c_void,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_heap`.
    pub fn am_device_new_heap(handle: *mut c_void, size: usize, storage_mode: usize)
        -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_fence`.
    pub fn am_device_new_fence(handle: *mut c_void) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_shared_event`.
    pub fn am_device_new_shared_event(handle: *mut c_void) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_dynamic_library_with_source`.
    pub fn am_device_new_dynamic_library_with_source(
        handle: *mut c_void,
        source: *const core::ffi::c_char,
        install_name: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_dynamic_library_with_url`.
    pub fn am_device_new_dynamic_library_with_url(
        handle: *mut c_void,
        path: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_binary_archive`.
    pub fn am_device_new_binary_archive(
        handle: *mut c_void,
        path: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_indirect_command_buffer`.
    pub fn am_device_new_indirect_command_buffer(
        handle: *mut c_void,
        command_types: usize,
        max_command_count: usize,
        max_vertex_buffer_bind_count: usize,
        max_fragment_buffer_bind_count: usize,
        max_kernel_buffer_bind_count: usize,
        options: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_acceleration_structure_with_size`.
    pub fn am_device_new_acceleration_structure_with_size(
        handle: *mut c_void,
        size: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_counter_sample_buffer`.
    pub fn am_device_new_counter_sample_buffer(
        handle: *mut c_void,
        counter_set_name: *const core::ffi::c_char,
        sample_count: usize,
        storage_mode: usize,
        label: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_log_state`.
    pub fn am_device_new_log_state(
        handle: *mut c_void,
        level: usize,
        buffer_size: isize,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_device_new_residency_set`.
    pub fn am_device_new_residency_set(
        handle: *mut c_void,
        label: *const core::ffi::c_char,
        initial_capacity: usize,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_command_queue_add_residency_set`.
    pub fn am_command_queue_add_residency_set(
        handle: *mut c_void,
        residency_set_handle: *mut c_void,
    );
    /// Calls the `Metal` framework counterpart for `am_command_queue_remove_residency_set`.
    pub fn am_command_queue_remove_residency_set(
        handle: *mut c_void,
        residency_set_handle: *mut c_void,
    );

    /// Calls the `Metal` framework counterpart for `am_buffer_did_modify_range`.
    pub fn am_buffer_did_modify_range(handle: *mut c_void, location: usize, length: usize);
    /// Calls the `Metal` framework counterpart for `am_buffer_new_texture_view_2d`.
    pub fn am_buffer_new_texture_view_2d(
        handle: *mut c_void,
        pixel_format: usize,
        width: usize,
        height: usize,
        bytes_per_row: usize,
        offset: usize,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_texture_depth`.
    pub fn am_texture_depth(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_texture_mipmap_level_count`.
    pub fn am_texture_mipmap_level_count(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_texture_array_length`.
    pub fn am_texture_array_length(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_texture_usage`.
    pub fn am_texture_usage(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_texture_storage_mode`.
    pub fn am_texture_storage_mode(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_texture_replace_region_2d`.
    pub fn am_texture_replace_region_2d(
        handle: *mut c_void,
        x: usize,
        y: usize,
        width: usize,
        height: usize,
        mipmap_level: usize,
        bytes: *const u8,
        bytes_per_row: usize,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_texture_get_bytes_2d`.
    pub fn am_texture_get_bytes_2d(
        handle: *mut c_void,
        out_bytes: *mut u8,
        out_len: usize,
        bytes_per_row: usize,
        x: usize,
        y: usize,
        width: usize,
        height: usize,
        mipmap_level: usize,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_texture_new_view`.
    pub fn am_texture_new_view(handle: *mut c_void, pixel_format: usize) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_compute_pipeline_state_thread_execution_width`.
    pub fn am_compute_pipeline_state_thread_execution_width(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_compute_pipeline_state_max_total_threads_per_threadgroup`.
    pub fn am_compute_pipeline_state_max_total_threads_per_threadgroup(
        handle: *mut c_void,
    ) -> usize;
    /// Calls the `Metal` framework counterpart for `am_compute_pipeline_state_new_visible_function_table`.
    pub fn am_compute_pipeline_state_new_visible_function_table(
        handle: *mut c_void,
        function_count: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_compute_pipeline_state_new_intersection_function_table`.
    pub fn am_compute_pipeline_state_new_intersection_function_table(
        handle: *mut c_void,
        function_count: usize,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_function_new_argument_encoder`.
    pub fn am_function_new_argument_encoder(
        handle: *mut c_void,
        buffer_index: usize,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_heap_size`.
    pub fn am_heap_size(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_heap_used_size`.
    pub fn am_heap_used_size(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_heap_current_allocated_size`.
    pub fn am_heap_current_allocated_size(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_heap_max_available_size`.
    pub fn am_heap_max_available_size(handle: *mut c_void, alignment: usize) -> usize;
    /// Calls the `Metal` framework counterpart for `am_heap_new_buffer`.
    pub fn am_heap_new_buffer(handle: *mut c_void, length: usize, options: usize) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_heap_new_texture_2d`.
    pub fn am_heap_new_texture_2d(
        handle: *mut c_void,
        pixel_format: usize,
        width: usize,
        height: usize,
        mipmapped: bool,
        usage: usize,
        storage_mode: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_heap_new_acceleration_structure_with_size`.
    pub fn am_heap_new_acceleration_structure_with_size(
        handle: *mut c_void,
        size: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_heap_set_purgeable_state`.
    pub fn am_heap_set_purgeable_state(handle: *mut c_void, state: usize) -> usize;

    /// Calls the `Metal` framework counterpart for `am_event_signaled_value`.
    pub fn am_event_signaled_value(handle: *mut c_void) -> u64;
    /// Calls the `Metal` framework counterpart for `am_event_set_signaled_value`.
    pub fn am_event_set_signaled_value(handle: *mut c_void, value: u64);
    /// Calls the `Metal` framework counterpart for `am_event_wait_until_signaled_value`.
    pub fn am_event_wait_until_signaled_value(
        handle: *mut c_void,
        value: u64,
        timeout_ms: u64,
    ) -> bool;

    /// Calls the `Metal` framework counterpart for `am_dynamic_library_install_name`.
    pub fn am_dynamic_library_install_name(handle: *mut c_void) -> *mut core::ffi::c_char;
    /// Calls the `Metal` framework counterpart for `am_dynamic_library_serialize_to_url`.
    pub fn am_dynamic_library_serialize_to_url(
        handle: *mut c_void,
        path: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> bool;

    /// Calls the `Metal` framework counterpart for `am_binary_archive_add_compute_function`.
    pub fn am_binary_archive_add_compute_function(
        handle: *mut c_void,
        function_handle: *mut c_void,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_binary_archive_add_render_functions`.
    pub fn am_binary_archive_add_render_functions(
        handle: *mut c_void,
        vertex_handle: *mut c_void,
        fragment_handle: *mut c_void,
        color_pixel_format: usize,
        sample_count: usize,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_binary_archive_serialize_to_url`.
    pub fn am_binary_archive_serialize_to_url(
        handle: *mut c_void,
        path: *const core::ffi::c_char,
        out_error_message: *mut *mut core::ffi::c_char,
    ) -> bool;

    /// Calls the `Metal` framework counterpart for `am_argument_encoder_encoded_length`.
    pub fn am_argument_encoder_encoded_length(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_argument_encoder_alignment`.
    pub fn am_argument_encoder_alignment(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_argument_encoder_set_argument_buffer`.
    pub fn am_argument_encoder_set_argument_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
        offset: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_argument_encoder_set_buffer`.
    pub fn am_argument_encoder_set_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
        offset: usize,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_argument_encoder_set_texture`.
    pub fn am_argument_encoder_set_texture(
        handle: *mut c_void,
        texture_handle: *mut c_void,
        index: usize,
    );

    /// Calls the `Metal` framework counterpart for `am_indirect_command_buffer_size`.
    pub fn am_indirect_command_buffer_size(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_indirect_command_buffer_reset_range`.
    pub fn am_indirect_command_buffer_reset_range(
        handle: *mut c_void,
        location: usize,
        length: usize,
    );

    /// Calls the `Metal` framework counterpart for `am_acceleration_structure_size`.
    pub fn am_acceleration_structure_size(handle: *mut c_void) -> usize;

    /// Calls the `Metal` framework counterpart for `am_intersection_function_table_set_opaque_triangle`.
    pub fn am_intersection_function_table_set_opaque_triangle(
        handle: *mut c_void,
        signature: usize,
        index: usize,
    );

    /// Calls the `Metal` framework counterpart for `am_counter_sample_buffer_sample_count`.
    pub fn am_counter_sample_buffer_sample_count(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_counter_sample_buffer_resolve_range`.
    pub fn am_counter_sample_buffer_resolve_range(
        handle: *mut c_void,
        location: usize,
        length: usize,
        out_len: *mut usize,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_residency_set_add_buffer`.
    pub fn am_residency_set_add_buffer(handle: *mut c_void, buffer_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_add_texture`.
    pub fn am_residency_set_add_texture(handle: *mut c_void, texture_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_add_heap`.
    pub fn am_residency_set_add_heap(handle: *mut c_void, heap_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_remove_buffer`.
    pub fn am_residency_set_remove_buffer(handle: *mut c_void, buffer_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_remove_texture`.
    pub fn am_residency_set_remove_texture(handle: *mut c_void, texture_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_remove_heap`.
    pub fn am_residency_set_remove_heap(handle: *mut c_void, heap_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_remove_all_allocations`.
    pub fn am_residency_set_remove_all_allocations(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_contains_buffer`.
    pub fn am_residency_set_contains_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_residency_set_contains_texture`.
    pub fn am_residency_set_contains_texture(
        handle: *mut c_void,
        texture_handle: *mut c_void,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_residency_set_allocation_count`.
    pub fn am_residency_set_allocation_count(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_residency_set_commit`.
    pub fn am_residency_set_commit(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_request_residency`.
    pub fn am_residency_set_request_residency(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_residency_set_end_residency`.
    pub fn am_residency_set_end_residency(handle: *mut c_void);

    /// Calls the `Metal` framework counterpart for `am_capture_manager_shared`.
    pub fn am_capture_manager_shared() -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_capture_manager_supports_destination`.
    pub fn am_capture_manager_supports_destination(handle: *mut c_void, destination: usize)
        -> bool;
    /// Calls the `Metal` framework counterpart for `am_capture_manager_is_capturing`.
    pub fn am_capture_manager_is_capturing(handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_capture_manager_new_scope_with_device`.
    pub fn am_capture_manager_new_scope_with_device(
        handle: *mut c_void,
        device_handle: *mut c_void,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_capture_manager_new_scope_with_command_queue`.
    pub fn am_capture_manager_new_scope_with_command_queue(
        handle: *mut c_void,
        queue_handle: *mut c_void,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_capture_scope_begin`.
    pub fn am_capture_scope_begin(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_capture_scope_end`.
    pub fn am_capture_scope_end(handle: *mut c_void);
}
