#![allow(
    clippy::cognitive_complexity,
    clippy::too_many_arguments,
    clippy::too_many_lines
)]

use apple_metal::{
    argument_buffers_tier, binding_access, blend_factor, blend_operation, capture_destination,
    color_write_mask, command_buffer_status, compare_function, copy_all_devices,
    counter_sampling_point, indirect_command_type, intersection_function_signature, load_action,
    log_level, metal_library_error_domain, pixel_format, primitive_type, purgeable_state,
    resource_options, sampler_address_mode, sampler_border_color, sampler_min_mag_filter,
    sampler_mip_filter, sampler_reduction_mode, spatial_scaler_color_processing_mode,
    stencil_operation, storage_mode, store_action, texture_type, texture_usage, ArgumentDescriptor,
    ArgumentEncoder, BinaryArchive, BlitCommandEncoder, CaptureManager, CommandBuffer,
    CommandQueue, ComputeCommandEncoder, ComputePipelineDescriptor, ComputePipelineState,
    DepthStencilDescriptor, DynamicLibrary, Event, Fence, IndirectCommandBuffer, MetalBuffer,
    MetalCommandQueueDescriptor, MetalDevice, MetalFunction, MetalHeapDescriptor, MetalLibrary,
    MetalTexture, RenderCommandEncoder, RenderPipelineColorAttachmentDescriptor,
    RenderPipelineDescriptor, RenderPipelineState, ResidencySet, SamplerDescriptor,
    SpatialScalerDescriptor, StencilDescriptor, TemporalScalerDescriptor, TemporalScalerFrameState,
    TemporalScalerTextures, TextureDescriptor, TileRenderPipelineColorAttachmentDescriptor,
    TileRenderPipelineDescriptor,
};
use std::fs;
use std::path::PathBuf;

const COMPUTE_SRC: &str = r"
#include <metal_stdlib>
using namespace metal;

struct Args {
    device uint *buffer;
    texture2d<float> texture;
};

kernel void increment(device uint *data [[buffer(0)]],
                      uint gid [[thread_position_in_grid]]) {
    if (gid < 4) {
        data[gid] += 1;
    }
}

kernel void use_args(constant Args &args [[buffer(0)]],
                     uint gid [[thread_position_in_grid]]) {
    if (gid == 0) {
        args.buffer[0] = 7;
    }
}
";

const RENDER_SRC: &str = r"
#include <metal_stdlib>
using namespace metal;

struct VertexOut {
    float4 position [[position]];
};

vertex VertexOut fullscreen_vertex(uint vertex_id [[vertex_id]]) {
    float2 positions[3] = {
        float2(-1.0, -1.0),
        float2( 3.0, -1.0),
        float2(-1.0,  3.0)
    };

    VertexOut out;
    out.position = float4(positions[vertex_id], 0.0, 1.0);
    return out;
}

fragment float4 solid_fragment() {
    return float4(0.2, 0.4, 0.8, 1.0);
}
";

const DYNAMIC_LIB_SRC: &str = r"
#include <metal_stdlib>
using namespace metal;

kernel void dynamic_noop(device uint *data [[buffer(0)]],
                         uint gid [[thread_position_in_grid]]) {
    if (gid == 0) {
        data[gid] += 1;
    }
}
";

fn artifact_path(name: &str) -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.push("target");
    dir.push("apple-metal-test-artifacts");
    fs::create_dir_all(&dir).expect("create artifact dir");
    let mut path = dir;
    path.push(name);
    let _ = fs::remove_file(&path);
    path
}

fn write_u32_words(buffer: &MetalBuffer, data: &[u32]) {
    let words = unsafe {
        core::slice::from_raw_parts_mut(
            buffer
                .contents()
                .expect("shared buffer contents")
                .cast::<u32>(),
            data.len(),
        )
    };
    words.copy_from_slice(data);
}

fn read_u32_words(buffer: &MetalBuffer, len: usize) -> Vec<u32> {
    unsafe {
        core::slice::from_raw_parts(
            buffer
                .contents()
                .expect("shared buffer contents")
                .cast::<u32>(),
            len,
        )
        .to_vec()
    }
}

const fn shared_render_target(width: usize, height: usize) -> TextureDescriptor {
    let mut descriptor =
        TextureDescriptor::render_target_2d(width, height, pixel_format::BGRA8UNORM);
    descriptor.storage_mode = storage_mode::SHARED;
    descriptor.usage = texture_usage::RENDER_TARGET | texture_usage::SHADER_READ;
    descriptor
}

fn compile_compute(
    device: &MetalDevice,
) -> (
    MetalLibrary,
    MetalFunction,
    MetalFunction,
    ComputePipelineState,
) {
    let library = device
        .new_library_with_source(COMPUTE_SRC)
        .expect("compile compute MSL");
    let increment = library
        .new_function("increment")
        .expect("increment function");
    let args = library.new_function("use_args").expect("use_args function");
    let pipeline = device
        .new_compute_pipeline_state(&increment)
        .expect("compute pipeline");
    (library, increment, args, pipeline)
}

fn compile_render(
    device: &MetalDevice,
) -> (
    MetalLibrary,
    MetalFunction,
    MetalFunction,
    RenderPipelineState,
) {
    let library = device
        .new_library_with_source(RENDER_SRC)
        .expect("compile render MSL");
    let vertex = library
        .new_function("fullscreen_vertex")
        .expect("vertex function");
    let fragment = library
        .new_function("solid_fragment")
        .expect("fragment function");
    let pipeline = device
        .new_render_pipeline_state(&vertex, &fragment, pixel_format::BGRA8UNORM, 1)
        .expect("render pipeline");
    (library, vertex, fragment, pipeline)
}

fn committed_blit_copy(
    queue: &CommandQueue,
    src: &MetalBuffer,
    dst: &MetalBuffer,
    fence: Option<&Fence>,
    sample_buffer: Option<&apple_metal::CounterSampleBuffer>,
) {
    let command_buffer = queue.new_command_buffer().expect("blit command buffer");
    let encoder = command_buffer
        .new_blit_command_encoder()
        .expect("first blit encoder");
    assert!(encoder.fill_buffer(src, 0..64, b'A'));
    if let Some(fence) = fence {
        encoder.update_fence(fence);
    }
    encoder.end_encoding();
    command_buffer.commit();
    command_buffer.wait_until_completed();

    let command_buffer = queue
        .new_command_buffer()
        .expect("second blit command buffer");
    let encoder = command_buffer
        .new_blit_command_encoder()
        .expect("second blit encoder");
    if let Some(fence) = fence {
        encoder.wait_for_fence(fence);
    }
    if let Some(sample_buffer) = sample_buffer {
        let _ = encoder.sample_counters(sample_buffer, 0, false);
    }
    assert!(encoder.copy_buffer(src, 0, dst, 0, 64));
    encoder.end_encoding();
    command_buffer.commit();
    command_buffer.wait_until_completed();
}

fn scratch_compute_bindings(
    queue: &CommandQueue,
    pipeline: &ComputePipelineState,
    buffer: &MetalBuffer,
    texture: &MetalTexture,
    fence: Option<&Fence>,
    visible_table: Option<&apple_metal::VisibleFunctionTable>,
    intersection_table: Option<&apple_metal::IntersectionFunctionTable>,
    acceleration_structure: Option<&apple_metal::AccelerationStructure>,
) {
    let command_buffer = queue
        .new_command_buffer()
        .expect("scratch compute command buffer");
    let encoder = command_buffer
        .new_compute_command_encoder()
        .expect("scratch compute encoder");
    encoder.set_compute_pipeline_state(pipeline);
    encoder.set_buffer(buffer, 0, 0);
    encoder.set_texture(texture, 1);
    if let Some(fence) = fence {
        encoder.wait_for_fence(fence);
    }
    if let Some(table) = visible_table {
        encoder.set_visible_function_table(table, 2);
    }
    if let Some(table) = intersection_table {
        encoder.set_intersection_function_table(table, 3);
    }
    if let Some(acceleration_structure) = acceleration_structure {
        encoder.set_acceleration_structure(acceleration_structure, 4);
    }
    encoder.dispatch_threadgroups((1, 1, 1), (1, 1, 1));
    encoder.end_encoding();
}

#[test]
fn public_api_smoke() {
    let device = MetalDevice::system_default().expect("Metal device available");
    let borrowed = unsafe { MetalDevice::from_raw_borrowed(device.as_ptr()) };
    assert_eq!(borrowed.has_unified_memory(), device.has_unified_memory());
    assert!(!device.name().is_empty());
    assert!(!copy_all_devices().is_empty());
    assert!(metal_library_error_domain().is_some());
    assert!(MetalCommandQueueDescriptor::new().is_some());
    assert!(MetalHeapDescriptor::new().is_some());
    let _ = device.registry_id();
    let _ = device.supports_dynamic_libraries();
    let _ = device.supports_render_dynamic_libraries();
    let _ = device.supports_raytracing();
    let _ = device.supports_counter_sampling(counter_sampling_point::AT_BLIT_BOUNDARY);
    let counter_set_names = device.counter_set_names();
    let _ = device.recommended_max_working_set_size();

    let (_compute_library, increment_fn, args_fn, pipeline) = compile_compute(&device);
    let (_render_library, vertex_fn, fragment_fn, render_pipeline) = compile_render(&device);
    let _ = render_pipeline.label();
    assert!(pipeline.thread_execution_width() > 0);
    assert!(pipeline.max_total_threads_per_threadgroup() > 0);
    assert!(device.argument_buffers_support() <= argument_buffers_tier::TIER2);

    let mut sampler_descriptor = SamplerDescriptor::new();
    sampler_descriptor.min_filter = sampler_min_mag_filter::LINEAR;
    sampler_descriptor.mag_filter = sampler_min_mag_filter::LINEAR;
    sampler_descriptor.mip_filter = sampler_mip_filter::LINEAR;
    sampler_descriptor.s_address_mode = sampler_address_mode::CLAMP_TO_EDGE;
    sampler_descriptor.t_address_mode = sampler_address_mode::CLAMP_TO_EDGE;
    sampler_descriptor.r_address_mode = sampler_address_mode::CLAMP_TO_BORDER_COLOR;
    sampler_descriptor.border_color = sampler_border_color::OPAQUE_WHITE;
    sampler_descriptor.reduction_mode = sampler_reduction_mode::WEIGHTED_AVERAGE;
    sampler_descriptor.compare_function = compare_function::LESS_EQUAL;
    sampler_descriptor.support_argument_buffers = true;
    sampler_descriptor.label = Some("smoke-sampler".to_string());
    let sampler_state = device
        .new_sampler_state(&sampler_descriptor)
        .expect("sampler state");
    assert_eq!(sampler_state.label().as_deref(), Some("smoke-sampler"));

    let mut stencil_descriptor = StencilDescriptor::new();
    stencil_descriptor.stencil_compare_function = compare_function::ALWAYS;
    stencil_descriptor.stencil_failure_operation = stencil_operation::REPLACE;
    stencil_descriptor.depth_failure_operation = stencil_operation::KEEP;
    stencil_descriptor.depth_stencil_pass_operation = stencil_operation::REPLACE;
    stencil_descriptor.read_mask = 0xff;
    stencil_descriptor.write_mask = 0xff;

    let mut depth_stencil_descriptor = DepthStencilDescriptor::new();
    depth_stencil_descriptor.depth_compare_function = compare_function::LESS_EQUAL;
    depth_stencil_descriptor.depth_write_enabled = true;
    depth_stencil_descriptor.front_face_stencil = Some(stencil_descriptor);
    depth_stencil_descriptor.back_face_stencil = Some(stencil_descriptor);
    depth_stencil_descriptor.label = Some("smoke-depth".to_string());
    let depth_stencil_state = device
        .new_depth_stencil_state(&depth_stencil_descriptor)
        .expect("depth stencil state");
    assert_eq!(depth_stencil_state.label().as_deref(), Some("smoke-depth"));

    let mut compute_descriptor = ComputePipelineDescriptor::new(&increment_fn);
    compute_descriptor.thread_group_size_is_multiple_of_thread_execution_width = true;
    compute_descriptor.max_total_threads_per_threadgroup = 64;
    compute_descriptor.support_indirect_command_buffers = true;
    let descriptor_compute_pipeline = device
        .new_compute_pipeline_state_with_descriptor(&compute_descriptor)
        .expect("descriptor compute pipeline");
    assert!(descriptor_compute_pipeline.thread_execution_width() > 0);

    let mut color_attachment_descriptor =
        RenderPipelineColorAttachmentDescriptor::new(pixel_format::BGRA8UNORM);
    color_attachment_descriptor.blending_enabled = true;
    color_attachment_descriptor.source_rgb_blend_factor = blend_factor::SOURCE_ALPHA;
    color_attachment_descriptor.destination_rgb_blend_factor = blend_factor::ONE_MINUS_SOURCE_ALPHA;
    color_attachment_descriptor.rgb_blend_operation = blend_operation::ADD;
    color_attachment_descriptor.source_alpha_blend_factor = blend_factor::ONE;
    color_attachment_descriptor.destination_alpha_blend_factor = blend_factor::ZERO;
    color_attachment_descriptor.alpha_blend_operation = blend_operation::ADD;
    color_attachment_descriptor.write_mask = color_write_mask::ALL;
    let color_attachments = [color_attachment_descriptor];
    let mut render_descriptor =
        RenderPipelineDescriptor::new(&vertex_fn, Some(&fragment_fn), &color_attachments);
    render_descriptor.depth_attachment_pixel_format = pixel_format::DEPTH32FLOAT;
    render_descriptor.stencil_attachment_pixel_format = pixel_format::STENCIL8;
    render_descriptor.support_indirect_command_buffers = true;
    let descriptor_render_pipeline = device
        .new_render_pipeline_state_with_descriptor(&render_descriptor)
        .expect("descriptor render pipeline");
    let _ = descriptor_render_pipeline.label();

    let tile_color_attachments = [TileRenderPipelineColorAttachmentDescriptor::new(
        pixel_format::BGRA8UNORM,
    )];
    let _tile_descriptor = TileRenderPipelineDescriptor::new(&fragment_fn, &tile_color_attachments);

    let queue = device.new_command_queue().expect("command queue");
    let bounded_queue = device
        .new_command_queue_with_max_command_buffer_count(4)
        .expect("bounded command queue");

    if let Ok(log_state) = device.new_log_state(log_level::INFO, 1_024) {
        let logged_queue = device
            .new_command_queue_with_log_state(4, &log_state)
            .expect("log-state queue");
        drop(logged_queue);
    }

    let status_buffer = bounded_queue
        .new_command_buffer_with_unretained_references()
        .expect("unretained command buffer");
    assert_eq!(status_buffer.status(), command_buffer_status::NOT_ENQUEUED);
    status_buffer.enqueue();
    assert!(status_buffer.status() >= command_buffer_status::ENQUEUED);
    status_buffer.commit();
    status_buffer.wait_until_scheduled();
    status_buffer.wait_until_completed();
    assert_eq!(status_buffer.status(), command_buffer_status::COMPLETED);
    assert!(status_buffer.error().is_none());

    let shared_buffer = device
        .new_buffer(
            4 * core::mem::size_of::<u32>(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("shared buffer");
    assert_eq!(shared_buffer.length(), 16);
    write_u32_words(&shared_buffer, &[1, 2, 3, 4]);

    if let Some(managed_buffer) = device.new_buffer(64, resource_options::STORAGE_MODE_MANAGED) {
        managed_buffer.did_modify_range(0..4);
    }

    let arg_encoder: ArgumentEncoder = args_fn.new_argument_encoder(0).expect("argument encoder");
    assert!(arg_encoder.encoded_length() > 0);
    assert!(arg_encoder.alignment() > 0);
    let argument_buffer = device
        .new_buffer(
            arg_encoder.encoded_length(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("argument buffer");
    arg_encoder.set_argument_buffer(&argument_buffer, 0);
    arg_encoder.set_buffer(&shared_buffer, 0, 0);

    let texture = device
        .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
        .expect("shared texture");
    let upload = vec![0x11_u8; 4 * 4 * 4];
    assert!(texture.replace_region_2d(&upload, 16, (0, 0), (4, 4), 0));
    let mut download = vec![0_u8; upload.len()];
    assert!(texture.read_bytes_2d(&mut download, 16, (0, 0), (4, 4), 0));
    assert_eq!(download, upload);
    assert_eq!(texture.width(), 4);
    assert_eq!(texture.height(), 4);
    assert_eq!(texture.pixel_format(), pixel_format::BGRA8UNORM);
    assert_eq!(texture.depth(), 1);
    assert_eq!(texture.mipmap_level_count(), 1);
    assert_eq!(texture.array_length(), 1);
    assert_eq!(
        texture.usage(),
        texture_usage::SHADER_READ | texture_usage::SHADER_WRITE
    );
    assert_eq!(texture.storage_mode(), storage_mode::SHARED);
    let texture_view = texture
        .new_view(pixel_format::BGRA8UNORM)
        .expect("texture view");
    arg_encoder.set_texture(&texture_view, 1);

    let descriptor_argument_encoder = device
        .new_argument_encoder_with_descriptors(&[
            ArgumentDescriptor::buffer(0, binding_access::READ_WRITE),
            ArgumentDescriptor::texture(1, texture_type::TYPE_2D, binding_access::READ_ONLY),
            ArgumentDescriptor::sampler(2),
        ])
        .expect("descriptor argument encoder");
    assert!(descriptor_argument_encoder.encoded_length() > 0);
    let descriptor_argument_buffer = device
        .new_buffer(
            descriptor_argument_encoder.encoded_length(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("descriptor argument buffer");
    descriptor_argument_encoder.set_argument_buffer(&descriptor_argument_buffer, 0);
    descriptor_argument_encoder.set_buffer(&shared_buffer, 0, 0);
    descriptor_argument_encoder.set_texture(&texture_view, 1);
    descriptor_argument_encoder.set_sampler_state(&sampler_state, 2);

    let texture_backing = device
        .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
        .expect("texture backing buffer");
    let buffer_texture = texture_backing
        .new_texture_view_2d(pixel_format::BGRA8UNORM, 16, 4, 64, 0)
        .expect("buffer-backed texture");
    assert_eq!(buffer_texture.width(), 16);

    let signal_event: Option<Event> = device.new_shared_event();
    if let Some(event) = signal_event.as_ref() {
        event.set_signaled_value(1);
        assert_eq!(event.signaled_value(), 1);
        assert!(event.wait_until_signaled_value(1, 1_000));

        let command_buffer = queue.new_command_buffer().expect("event signal buffer");
        command_buffer.encode_signal_event(event, 2);
        command_buffer.commit();
        command_buffer.wait_until_completed();
        assert!(event.wait_until_signaled_value(2, 1_000));

        let command_buffer = queue.new_command_buffer().expect("event wait buffer");
        command_buffer.encode_wait_for_event(event, 2);
        command_buffer.commit();
        command_buffer.wait_until_completed();
    }

    let fence_a: Option<Fence> = device.new_fence();
    let fence_b: Option<Fence> = device.new_fence();
    let fence_c: Option<Fence> = device.new_fence();

    let sample_buffer = counter_set_names.first().and_then(|name| {
        if device.supports_counter_sampling(counter_sampling_point::AT_BLIT_BOUNDARY) {
            device
                .new_counter_sample_buffer(name, 2, storage_mode::SHARED, Some("smoke-samples"))
                .ok()
        } else {
            None
        }
    });

    let blit_src = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("blit src");
    let blit_dst = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("blit dst");
    committed_blit_copy(
        &queue,
        &blit_src,
        &blit_dst,
        fence_a.as_ref(),
        sample_buffer.as_ref(),
    );
    let copied = unsafe {
        core::slice::from_raw_parts(
            blit_dst.contents().expect("blit dst contents").cast::<u8>(),
            64,
        )
    };
    assert!(copied.iter().take(8).all(|byte| *byte == b'A'));

    if let Some(sample_buffer) = sample_buffer.as_ref() {
        assert_eq!(sample_buffer.sample_count(), 2);
        let resolved = sample_buffer
            .resolve_range(0..1)
            .expect("resolved counter data");
        assert!(!resolved.is_empty());
    }

    let explicit_buffer = device
        .new_buffer(
            4 * core::mem::size_of::<u32>(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("explicit compute buffer");
    write_u32_words(&explicit_buffer, &[0, 1, 2, 3]);
    let compute_command_buffer: CommandBuffer =
        queue.new_command_buffer().expect("compute command buffer");
    let compute_encoder: ComputeCommandEncoder = compute_command_buffer
        .new_compute_command_encoder()
        .expect("compute encoder");
    compute_encoder.set_compute_pipeline_state(&descriptor_compute_pipeline);
    compute_encoder.set_buffer(&explicit_buffer, 0, 0);
    compute_encoder.set_sampler_state(&sampler_state, 2);
    if let Some(fence) = fence_a.as_ref() {
        compute_encoder.wait_for_fence(fence);
    }
    compute_encoder.dispatch_threads((4, 1, 1), (1, 1, 1));
    if let Some(fence) = fence_b.as_ref() {
        compute_encoder.update_fence(fence);
    }
    compute_encoder.end_encoding();
    compute_command_buffer.commit();
    compute_command_buffer.wait_until_completed();
    assert_eq!(read_u32_words(&explicit_buffer, 4), vec![1, 2, 3, 4]);

    let visible_table = pipeline.new_visible_function_table(1);
    let intersection_table = if device.supports_raytracing() {
        pipeline.new_intersection_function_table(1)
    } else {
        None
    };
    if let Some(table) = intersection_table.as_ref() {
        table.set_opaque_triangle_intersection_function(intersection_function_signature::NONE, 0);
    }
    let acceleration_structure = if device.supports_raytracing() {
        device.new_acceleration_structure_with_size(256)
    } else {
        None
    };
    if let Some(acceleration_structure) = acceleration_structure.as_ref() {
        let _ = acceleration_structure.size();
    }
    scratch_compute_bindings(
        &queue,
        &pipeline,
        &explicit_buffer,
        &texture_view,
        fence_b.as_ref(),
        visible_table.as_ref(),
        intersection_table.as_ref(),
        acceleration_structure.as_ref(),
    );

    let indirect_command_buffer: Option<IndirectCommandBuffer> = device
        .new_indirect_command_buffer(
            indirect_command_type::CONCURRENT_DISPATCH,
            1,
            0,
            0,
            4,
            resource_options::STORAGE_MODE_PRIVATE,
        );
    if let Some(indirect_command_buffer) = indirect_command_buffer.as_ref() {
        assert!(indirect_command_buffer.size() > 0);
        indirect_command_buffer.reset_range(0..1);
    }

    let render_target = device
        .new_texture(shared_render_target(4, 4))
        .expect("render target");
    let vertex_buffer = device
        .new_buffer(16, resource_options::STORAGE_MODE_SHARED)
        .expect("vertex buffer");
    let render_command_buffer = queue.new_command_buffer().expect("render command buffer");
    let render_encoder: RenderCommandEncoder = render_command_buffer
        .new_render_command_encoder(
            &render_target,
            load_action::CLEAR,
            store_action::STORE,
            [0.0, 0.0, 0.0, 1.0],
        )
        .expect("render encoder");
    if let Some(fence) = fence_b.as_ref() {
        render_encoder.wait_for_fence(fence);
    }
    render_encoder.set_render_pipeline_state(&descriptor_render_pipeline);
    render_encoder.set_depth_stencil_state(&depth_stencil_state);
    render_encoder.set_fragment_sampler_state(&sampler_state, 0);
    render_encoder.set_vertex_buffer(&vertex_buffer, 0, 0);
    render_encoder.draw_primitives(primitive_type::TRIANGLE, 0, 3);
    if let Some(fence) = fence_c.as_ref() {
        render_encoder.update_fence(fence);
    }
    render_encoder.end_encoding();
    render_command_buffer.commit();
    render_command_buffer.wait_until_completed();
    let mut rendered = vec![0_u8; 4 * 4 * 4];
    assert!(render_target.read_bytes_2d(&mut rendered, 16, (0, 0), (4, 4), 0));
    assert!(rendered.chunks_exact(4).any(|pixel| pixel[3] != 0));

    if let Some(fence) = fence_c.as_ref() {
        let command_buffer = queue.new_command_buffer().expect("post-render blit buffer");
        let encoder: BlitCommandEncoder = command_buffer
            .new_blit_command_encoder()
            .expect("post-render blit encoder");
        encoder.wait_for_fence(fence);
        encoder.end_encoding();
    }

    let mut spatial_scaler_descriptor = SpatialScalerDescriptor::new(
        pixel_format::BGRA8UNORM,
        pixel_format::BGRA8UNORM,
        4,
        4,
        8,
        8,
    );
    spatial_scaler_descriptor.color_processing_mode = spatial_scaler_color_processing_mode::LINEAR;
    if SpatialScalerDescriptor::supports_device(&device) {
        let spatial_output = device
            .new_texture(TextureDescriptor::render_target_2d(
                8,
                8,
                pixel_format::BGRA8UNORM,
            ))
            .expect("spatial output texture");
        if let Some(spatial_scaler) = device.new_spatial_scaler(&spatial_scaler_descriptor) {
            let _ = spatial_scaler.color_texture_usage();
            let _ = spatial_scaler.output_texture_usage();
            spatial_scaler.configure(4, 4, &texture_view, &spatial_output, fence_a.as_ref());
        }
    }

    if TemporalScalerDescriptor::supports_device(&device) {
        let mut temporal_scaler_descriptor = TemporalScalerDescriptor::new(
            pixel_format::BGRA8UNORM,
            pixel_format::BGRA8UNORM,
            pixel_format::RG16FLOAT,
            pixel_format::BGRA8UNORM,
            (4, 4),
            (8, 8),
        );
        temporal_scaler_descriptor.auto_exposure_enabled = true;
        temporal_scaler_descriptor.input_content_properties_enabled = true;
        let min_scale = TemporalScalerDescriptor::supported_input_content_min_scale(&device);
        let max_scale = TemporalScalerDescriptor::supported_input_content_max_scale(&device);
        if min_scale > 0.0 && max_scale >= min_scale {
            temporal_scaler_descriptor.input_content_min_scale = min_scale;
            temporal_scaler_descriptor.input_content_max_scale = max_scale;
        }
        let temporal_output = device
            .new_texture(TextureDescriptor::render_target_2d(
                8,
                8,
                pixel_format::BGRA8UNORM,
            ))
            .expect("temporal output texture");
        if let Some(temporal_scaler) = device.new_temporal_scaler(&temporal_scaler_descriptor) {
            let _ = temporal_scaler.color_texture_usage();
            let _ = temporal_scaler.depth_texture_usage();
            let _ = temporal_scaler.motion_texture_usage();
            let _ = temporal_scaler.reactive_texture_usage();
            let _ = temporal_scaler.output_texture_usage();
            temporal_scaler.set_textures(TemporalScalerTextures {
                color_texture: &texture_view,
                depth_texture: &texture_view,
                motion_texture: &texture_view,
                output_texture: &temporal_output,
                exposure_texture: None,
                reactive_mask_texture: None,
                fence: fence_a.as_ref(),
            });
            temporal_scaler.set_frame_state(TemporalScalerFrameState::new(4, 4));
        }
    }

    if let Some(heap) = device.new_heap(1 << 20, storage_mode::SHARED) {
        assert!(heap.size() >= (1 << 20));
        let _ = heap.used_size();
        let _ = heap.current_allocated_size();
        let _ = heap.max_available_size(256);
        let heap_buffer = heap
            .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
            .expect("heap buffer");
        let heap_texture = heap
            .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
            .expect("heap texture");
        let _ = heap.set_purgeable_state(purgeable_state::KEEP_CURRENT);
        if device.supports_raytracing() {
            let _ = heap.new_acceleration_structure_with_size(256);
        }

        if let Ok(residency_set) = device.new_residency_set(Some("smoke-residency"), 4) {
            let residency_set: ResidencySet = residency_set;
            residency_set.add_buffer(&heap_buffer);
            assert!(residency_set.contains_buffer(&heap_buffer));
            residency_set.add_texture(&heap_texture);
            assert!(residency_set.contains_texture(&heap_texture));
            residency_set.add_heap(&heap);
            assert!(residency_set.allocation_count() >= 2);
            residency_set.commit();
            residency_set.request_residency();
            residency_set.end_residency();
            queue.add_residency_set(&residency_set);
            queue.remove_residency_set(&residency_set);
            residency_set.remove_texture(&heap_texture);
            residency_set.remove_heap(&heap);
            residency_set.remove_buffer(&heap_buffer);
            residency_set.remove_all_allocations();
            residency_set.commit();
        }
    }

    if device.supports_dynamic_libraries() {
        let dynamic_path = artifact_path("smoke-dylib.metallib");
        let dynamic_library: DynamicLibrary = device
            .new_dynamic_library_with_source(
                DYNAMIC_LIB_SRC,
                dynamic_path.to_string_lossy().as_ref(),
            )
            .expect("dynamic library from source");
        assert!(!dynamic_library.install_name().is_empty());
        dynamic_library
            .serialize_to_file(&dynamic_path)
            .expect("serialize dynamic library");
        let reloaded = device
            .load_dynamic_library(&dynamic_path)
            .expect("load dynamic library");
        assert!(!reloaded.install_name().is_empty());

        let archive_path = artifact_path("smoke-archive.metalarc");
        let binary_archive: BinaryArchive = device
            .new_binary_archive(None)
            .expect("empty binary archive");
        binary_archive
            .add_compute_function(&increment_fn)
            .expect("archive compute pipeline");
        binary_archive
            .add_render_functions(&vertex_fn, &fragment_fn, pixel_format::BGRA8UNORM, 1)
            .expect("archive render pipeline");
        binary_archive
            .serialize_to_file(&archive_path)
            .expect("serialize binary archive");
        let _ = device
            .new_binary_archive(Some(&archive_path))
            .expect("reload binary archive");
    }

    if let Some(capture_manager) = CaptureManager::shared() {
        let _: CaptureManager = capture_manager;
        let _ = capture_manager.is_capturing();
        let _ = capture_manager.supports_destination(capture_destination::DEVELOPER_TOOLS);
        if let Some(scope) = capture_manager.new_capture_scope_with_device(&device) {
            scope.begin();
            scope.end();
        }
        if let Some(scope) = capture_manager.new_capture_scope_with_command_queue(&queue) {
            scope.begin();
            scope.end();
        }
    }
}
