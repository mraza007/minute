use core::ffi::c_void;

extern "C" {
    /// Calls the `Metal` framework counterpart for `am_spatial_scaler_supports_device`.
    pub fn am_spatial_scaler_supports_device(device_handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_device_new_spatial_scaler`.
    pub fn am_device_new_spatial_scaler(
        device_handle: *mut c_void,
        color_texture_format: usize,
        output_texture_format: usize,
        input_width: usize,
        input_height: usize,
        output_width: usize,
        output_height: usize,
        color_processing_mode: isize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_spatial_scaler_texture_usage`.
    pub fn am_spatial_scaler_texture_usage(handle: *mut c_void, kind: usize) -> usize;
    /// Calls the `Metal` framework counterpart for `am_spatial_scaler_configure`.
    pub fn am_spatial_scaler_configure(
        handle: *mut c_void,
        input_content_width: usize,
        input_content_height: usize,
        color_texture_handle: *mut c_void,
        output_texture_handle: *mut c_void,
        fence_handle: *mut c_void,
    );
    /// Calls the `Metal` framework counterpart for `am_spatial_scaler_encode`.
    pub fn am_spatial_scaler_encode(handle: *mut c_void, command_buffer_handle: *mut c_void);

    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_supports_device`.
    pub fn am_temporal_scaler_supports_device(device_handle: *mut c_void) -> bool;
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_supported_input_content_min_scale`.
    pub fn am_temporal_scaler_supported_input_content_min_scale(device_handle: *mut c_void) -> f32;
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_supported_input_content_max_scale`.
    pub fn am_temporal_scaler_supported_input_content_max_scale(device_handle: *mut c_void) -> f32;
    /// Calls the `Metal` framework counterpart for `am_device_new_temporal_scaler`.
    pub fn am_device_new_temporal_scaler(
        device_handle: *mut c_void,
        color_texture_format: usize,
        depth_texture_format: usize,
        motion_texture_format: usize,
        output_texture_format: usize,
        input_width: usize,
        input_height: usize,
        output_width: usize,
        output_height: usize,
        auto_exposure_enabled: bool,
        requires_synchronous_initialization: bool,
        input_content_properties_enabled: bool,
        input_content_min_scale: f32,
        input_content_max_scale: f32,
        reactive_mask_texture_enabled: bool,
        reactive_mask_texture_format: usize,
    ) -> *mut c_void;
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_texture_usage`.
    pub fn am_temporal_scaler_texture_usage(handle: *mut c_void, kind: usize) -> usize;
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_set_textures`.
    pub fn am_temporal_scaler_set_textures(
        handle: *mut c_void,
        color_texture_handle: *mut c_void,
        depth_texture_handle: *mut c_void,
        motion_texture_handle: *mut c_void,
        output_texture_handle: *mut c_void,
        exposure_texture_handle: *mut c_void,
        reactive_mask_texture_handle: *mut c_void,
        fence_handle: *mut c_void,
    );
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_set_frame_state`.
    pub fn am_temporal_scaler_set_frame_state(
        handle: *mut c_void,
        input_content_width: usize,
        input_content_height: usize,
        pre_exposure: f32,
        jitter_offset_x: f32,
        jitter_offset_y: f32,
        motion_vector_scale_x: f32,
        motion_vector_scale_y: f32,
        reset: bool,
        depth_reversed: bool,
    );
    /// Calls the `Metal` framework counterpart for `am_temporal_scaler_encode`.
    pub fn am_temporal_scaler_encode(handle: *mut c_void, command_buffer_handle: *mut c_void);
}
