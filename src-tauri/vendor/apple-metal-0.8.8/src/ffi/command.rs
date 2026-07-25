use core::ffi::c_void;

extern "C" {
    /// Calls the `Metal` framework counterpart for `am_command_queue_new_command_buffer_with_unretained_references`.
    pub fn am_command_queue_new_command_buffer_with_unretained_references(
        handle: *mut c_void,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_command_buffer_enqueue`.
    pub fn am_command_buffer_enqueue(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_command_buffer_wait_until_scheduled`.
    pub fn am_command_buffer_wait_until_scheduled(handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_command_buffer_status`.
    pub fn am_command_buffer_status(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_command_buffer_error_message`.
    pub fn am_command_buffer_error_message(handle: *mut c_void) -> *mut core::ffi::c_char;
    /// Calls the `Metal` framework counterpart for `am_command_buffer_new_blit_command_encoder`.
    pub fn am_command_buffer_new_blit_command_encoder(handle: *mut c_void) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_command_buffer_new_compute_command_encoder`.
    pub fn am_command_buffer_new_compute_command_encoder(handle: *mut c_void) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_command_buffer_new_render_command_encoder`.
    pub fn am_command_buffer_new_render_command_encoder(
        handle: *mut c_void,
        texture_handle: *mut c_void,
        load_action: usize,
        store_action: usize,
        clear_r: f64,
        clear_g: f64,
        clear_b: f64,
        clear_a: f64,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_command_buffer_encode_wait_for_event`.
    pub fn am_command_buffer_encode_wait_for_event(
        handle: *mut c_void,
        event_handle: *mut c_void,
        value: u64,
    );
    /// Calls the `Metal` framework counterpart for `am_command_buffer_encode_signal_event`.
    pub fn am_command_buffer_encode_signal_event(
        handle: *mut c_void,
        event_handle: *mut c_void,
        value: u64,
    );

    /// Calls the `Metal` framework counterpart for `am_command_encoder_end_encoding`.
    pub fn am_command_encoder_end_encoding(handle: *mut c_void);

    /// Calls the `Metal` framework counterpart for `am_blit_command_encoder_copy_buffer`.
    pub fn am_blit_command_encoder_copy_buffer(
        handle: *mut c_void,
        src_handle: *mut c_void,
        src_offset: usize,
        dst_handle: *mut c_void,
        dst_offset: usize,
        size: usize,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_blit_command_encoder_fill_buffer`.
    pub fn am_blit_command_encoder_fill_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
        location: usize,
        length: usize,
        value: u8,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_blit_command_encoder_sample_counters`.
    pub fn am_blit_command_encoder_sample_counters(
        handle: *mut c_void,
        sample_buffer_handle: *mut c_void,
        sample_index: usize,
        barrier: bool,
    ) -> bool;
    /// Calls the `Metal` framework counterpart for `am_blit_command_encoder_update_fence`.
    pub fn am_blit_command_encoder_update_fence(handle: *mut c_void, fence_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_blit_command_encoder_wait_for_fence`.
    pub fn am_blit_command_encoder_wait_for_fence(handle: *mut c_void, fence_handle: *mut c_void);

    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_pipeline_state`.
    pub fn am_compute_command_encoder_set_pipeline_state(
        handle: *mut c_void,
        pipeline_handle: *mut c_void,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_buffer`.
    pub fn am_compute_command_encoder_set_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
        offset: usize,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_texture`.
    pub fn am_compute_command_encoder_set_texture(
        handle: *mut c_void,
        texture_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_visible_function_table`.
    pub fn am_compute_command_encoder_set_visible_function_table(
        handle: *mut c_void,
        table_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_intersection_function_table`.
    pub fn am_compute_command_encoder_set_intersection_function_table(
        handle: *mut c_void,
        table_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_acceleration_structure`.
    pub fn am_compute_command_encoder_set_acceleration_structure(
        handle: *mut c_void,
        acceleration_structure_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_dispatch_threadgroups`.
    pub fn am_compute_command_encoder_dispatch_threadgroups(
        handle: *mut c_void,
        tg_w: usize,
        tg_h: usize,
        tg_d: usize,
        threads_w: usize,
        threads_h: usize,
        threads_d: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_dispatch_threads`.
    pub fn am_compute_command_encoder_dispatch_threads(
        handle: *mut c_void,
        grid_w: usize,
        grid_h: usize,
        grid_d: usize,
        threads_w: usize,
        threads_h: usize,
        threads_d: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_update_fence`.
    pub fn am_compute_command_encoder_update_fence(handle: *mut c_void, fence_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_wait_for_fence`.
    pub fn am_compute_command_encoder_wait_for_fence(
        handle: *mut c_void,
        fence_handle: *mut c_void,
    );

    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_set_render_pipeline_state`.
    pub fn am_render_command_encoder_set_render_pipeline_state(
        handle: *mut c_void,
        pipeline_handle: *mut c_void,
    );
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_set_vertex_buffer`.
    pub fn am_render_command_encoder_set_vertex_buffer(
        handle: *mut c_void,
        buffer_handle: *mut c_void,
        offset: usize,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_draw_primitives`.
    pub fn am_render_command_encoder_draw_primitives(
        handle: *mut c_void,
        primitive_type: usize,
        vertex_start: usize,
        vertex_count: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_update_fence`.
    pub fn am_render_command_encoder_update_fence(handle: *mut c_void, fence_handle: *mut c_void);
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_wait_for_fence`.
    pub fn am_render_command_encoder_wait_for_fence(handle: *mut c_void, fence_handle: *mut c_void);
}
