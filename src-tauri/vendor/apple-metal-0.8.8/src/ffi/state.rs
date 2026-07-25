use core::ffi::c_void;

extern "C" {
    /// Calls the `Metal` framework counterpart for `am_device_argument_buffers_support`.
    pub fn am_device_argument_buffers_support(handle: *mut c_void) -> usize;
    /// Calls the `Metal` framework counterpart for `am_device_new_argument_encoder_with_descriptors`.
    pub fn am_device_new_argument_encoder_with_descriptors(
        handle: *mut c_void,
        descriptors: *const usize,
        descriptor_count: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_argument_encoder_set_sampler_state`.
    pub fn am_argument_encoder_set_sampler_state(
        handle: *mut c_void,
        sampler_handle: *mut c_void,
        index: usize,
    );

    /// Calls the `Metal` framework counterpart for `am_device_new_depth_stencil_state`.
    pub fn am_device_new_depth_stencil_state(
        device_handle: *mut c_void,
        depth_compare_function: usize,
        depth_write_enabled: bool,
        has_front_face_stencil: bool,
        front_stencil_compare_function: usize,
        front_stencil_failure_operation: usize,
        front_depth_failure_operation: usize,
        front_depth_stencil_pass_operation: usize,
        front_read_mask: u32,
        front_write_mask: u32,
        has_back_face_stencil: bool,
        back_stencil_compare_function: usize,
        back_stencil_failure_operation: usize,
        back_depth_failure_operation: usize,
        back_depth_stencil_pass_operation: usize,
        back_read_mask: u32,
        back_write_mask: u32,
        label: *const core::ffi::c_char,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_device_new_sampler_state`.
    pub fn am_device_new_sampler_state(
        device_handle: *mut c_void,
        min_filter: usize,
        mag_filter: usize,
        mip_filter: usize,
        max_anisotropy: usize,
        s_address_mode: usize,
        t_address_mode: usize,
        r_address_mode: usize,
        border_color: usize,
        reduction_mode: usize,
        normalized_coordinates: bool,
        lod_min_clamp: f32,
        lod_max_clamp: f32,
        lod_average: bool,
        lod_bias: f32,
        compare_function: usize,
        support_argument_buffers: bool,
        label: *const core::ffi::c_char,
    ) -> *mut c_void;

    /// Calls the `Metal` framework counterpart for `am_compute_command_encoder_set_sampler_state`.
    pub fn am_compute_command_encoder_set_sampler_state(
        handle: *mut c_void,
        sampler_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_set_fragment_sampler_state`.
    pub fn am_render_command_encoder_set_fragment_sampler_state(
        handle: *mut c_void,
        sampler_handle: *mut c_void,
        index: usize,
    );
    /// Calls the `Metal` framework counterpart for `am_render_command_encoder_set_depth_stencil_state`.
    pub fn am_render_command_encoder_set_depth_stencil_state(
        handle: *mut c_void,
        depth_stencil_state_handle: *mut c_void,
    );
}
