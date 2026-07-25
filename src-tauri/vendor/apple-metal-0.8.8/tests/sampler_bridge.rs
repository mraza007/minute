mod common;

use apple_metal::{
    compare_function, resource_options, sampler_address_mode, sampler_border_color,
    sampler_min_mag_filter, sampler_mip_filter, sampler_reduction_mode, SamplerDescriptor,
};

#[test]
fn sampler_state_can_be_created_and_bound_to_compute_and_render_encoders() {
    let device = common::device();
    let (_compute_library, _increment_fn, _args_fn, compute_pipeline) =
        common::compile_compute(&device);
    let (_render_library, _vertex, _fragment, render_pipeline) = common::compile_render(&device);

    let mut descriptor = SamplerDescriptor::new();
    descriptor.min_filter = sampler_min_mag_filter::LINEAR;
    descriptor.mag_filter = sampler_min_mag_filter::LINEAR;
    descriptor.mip_filter = sampler_mip_filter::LINEAR;
    descriptor.s_address_mode = sampler_address_mode::CLAMP_TO_EDGE;
    descriptor.t_address_mode = sampler_address_mode::CLAMP_TO_EDGE;
    descriptor.r_address_mode = sampler_address_mode::CLAMP_TO_BORDER_COLOR;
    descriptor.border_color = sampler_border_color::OPAQUE_WHITE;
    descriptor.reduction_mode = sampler_reduction_mode::WEIGHTED_AVERAGE;
    descriptor.compare_function = compare_function::LESS_EQUAL;
    descriptor.support_argument_buffers = true;
    descriptor.label = Some("sampler-bridge".to_string());

    let sampler = device
        .new_sampler_state(&descriptor)
        .expect("sampler state");
    assert_eq!(sampler.label().as_deref(), Some("sampler-bridge"));

    let queue = device.new_command_queue().expect("command queue");
    let buffer = device
        .new_buffer(
            4 * core::mem::size_of::<u32>(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("compute buffer");
    common::write_u32_words(&buffer, &[0, 1, 2, 3]);

    let compute_command_buffer = queue.new_command_buffer().expect("compute command buffer");
    let compute_encoder = compute_command_buffer
        .new_compute_command_encoder()
        .expect("compute encoder");
    compute_encoder.set_compute_pipeline_state(&compute_pipeline);
    compute_encoder.set_buffer(&buffer, 0, 0);
    compute_encoder.set_sampler_state(&sampler, 0);
    compute_encoder.dispatch_threads((4, 1, 1), (1, 1, 1));
    compute_encoder.end_encoding();
    compute_command_buffer.commit();
    compute_command_buffer.wait_until_completed();
    assert_eq!(common::read_u32_words(&buffer, 4), vec![1, 2, 3, 4]);

    let rendered = common::render_and_readback(&device, &render_pipeline, |encoder| {
        encoder.set_fragment_sampler_state(&sampler, 0);
    });
    assert!(rendered.chunks_exact(4).any(|pixel| pixel[3] != 0));
}
