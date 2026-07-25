mod common;

use apple_metal::{
    argument_buffers_tier, binding_access, pixel_format, resource_options, texture_type,
    ArgumentDescriptor, SamplerDescriptor, TextureDescriptor,
};

#[test]
fn argument_encoders_can_encode_function_and_descriptor_layouts() {
    let device = common::device();
    let (_library, _increment_fn, args_fn, _increment_pipeline) = common::compile_compute(&device);
    let args_pipeline = device
        .new_compute_pipeline_state(&args_fn)
        .expect("argument-buffer compute pipeline");

    let function_encoder = args_fn
        .new_argument_encoder(0)
        .expect("function argument encoder");
    assert!(function_encoder.encoded_length() > 0);
    assert!(function_encoder.alignment() > 0);

    let storage_buffer = device
        .new_buffer(
            4 * core::mem::size_of::<u32>(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("storage buffer");
    common::write_u32_words(&storage_buffer, &[0, 0, 0, 0]);

    let texture = device
        .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
        .expect("argument texture");
    let upload = vec![0x33_u8; 4 * 4 * 4];
    assert!(texture.replace_region_2d(&upload, 16, (0, 0), (4, 4), 0));

    let function_argument_buffer = device
        .new_buffer(
            function_encoder.encoded_length(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("function argument buffer");
    function_encoder.set_argument_buffer(&function_argument_buffer, 0);
    function_encoder.set_buffer(&storage_buffer, 0, 0);
    function_encoder.set_texture(&texture, 1);

    let queue = device.new_command_queue().expect("command queue");
    let compute_command_buffer = queue.new_command_buffer().expect("compute command buffer");
    let compute_encoder = compute_command_buffer
        .new_compute_command_encoder()
        .expect("compute encoder");
    compute_encoder.set_compute_pipeline_state(&args_pipeline);
    compute_encoder.set_buffer(&function_argument_buffer, 0, 0);
    compute_encoder.dispatch_threads((1, 1, 1), (1, 1, 1));
    compute_encoder.end_encoding();
    compute_command_buffer.commit();
    compute_command_buffer.wait_until_completed();
    assert_eq!(common::read_u32_words(&storage_buffer, 1), vec![7]);

    let descriptor_encoder = device
        .new_argument_encoder_with_descriptors(&[
            ArgumentDescriptor::buffer(0, binding_access::READ_WRITE),
            ArgumentDescriptor::texture(1, texture_type::TYPE_2D, binding_access::READ_ONLY),
            ArgumentDescriptor::sampler(2),
        ])
        .expect("descriptor argument encoder");
    assert!(descriptor_encoder.encoded_length() > 0);
    assert!(descriptor_encoder.alignment() > 0);

    let descriptor_argument_buffer = device
        .new_buffer(
            descriptor_encoder.encoded_length(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("descriptor argument buffer");
    descriptor_encoder.set_argument_buffer(&descriptor_argument_buffer, 0);
    descriptor_encoder.set_buffer(&storage_buffer, 0, 0);
    descriptor_encoder.set_texture(&texture, 1);
    let sampler = device
        .new_sampler_state(&SamplerDescriptor::new())
        .expect("descriptor sampler state");
    descriptor_encoder.set_sampler_state(&sampler, 2);

    assert!(device.argument_buffers_support() <= argument_buffers_tier::TIER2);
}
