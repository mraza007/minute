#![allow(dead_code)]

use apple_metal::{
    pixel_format, resource_options, storage_mode, texture_usage, CommandQueue,
    ComputePipelineState, Fence, MetalBuffer, MetalDevice, MetalFunction, MetalLibrary,
    RenderPipelineState, TextureDescriptor,
};

pub const COMPUTE_SRC: &str = r"
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

pub const RENDER_SRC: &str = r"
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

pub fn device() -> MetalDevice {
    MetalDevice::system_default().expect("Metal device available")
}

pub fn write_u32_words(buffer: &MetalBuffer, data: &[u32]) {
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

pub fn read_u32_words(buffer: &MetalBuffer, len: usize) -> Vec<u32> {
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

pub const fn shared_render_target(width: usize, height: usize) -> TextureDescriptor {
    let mut descriptor =
        TextureDescriptor::render_target_2d(width, height, pixel_format::BGRA8UNORM);
    descriptor.storage_mode = storage_mode::SHARED;
    descriptor.usage = texture_usage::RENDER_TARGET | texture_usage::SHADER_READ;
    descriptor
}

pub fn compile_compute(
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

pub fn compile_render(
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

pub fn committed_blit_copy(
    queue: &CommandQueue,
    src: &MetalBuffer,
    dst: &MetalBuffer,
    fence: Option<&Fence>,
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
    assert!(encoder.copy_buffer(src, 0, dst, 0, 64));
    encoder.end_encoding();
    command_buffer.commit();
    command_buffer.wait_until_completed();
}

pub fn render_and_readback(
    device: &MetalDevice,
    pipeline: &RenderPipelineState,
    configure: impl FnOnce(&apple_metal::RenderCommandEncoder),
) -> Vec<u8> {
    let queue = device.new_command_queue().expect("command queue");
    let render_target = device
        .new_texture(shared_render_target(4, 4))
        .expect("render target");
    let vertex_buffer = device
        .new_buffer(16, resource_options::STORAGE_MODE_SHARED)
        .expect("vertex buffer");
    let command_buffer = queue.new_command_buffer().expect("render command buffer");
    let encoder = command_buffer
        .new_render_command_encoder(
            &render_target,
            apple_metal::load_action::CLEAR,
            apple_metal::store_action::STORE,
            [0.0, 0.0, 0.0, 1.0],
        )
        .expect("render encoder");
    encoder.set_render_pipeline_state(pipeline);
    configure(&encoder);
    encoder.set_vertex_buffer(&vertex_buffer, 0, 0);
    encoder.draw_primitives(apple_metal::primitive_type::TRIANGLE, 0, 3);
    encoder.end_encoding();
    command_buffer.commit();
    command_buffer.wait_until_completed();

    let mut rendered = vec![0_u8; 4 * 4 * 4];
    assert!(render_target.read_bytes_2d(&mut rendered, 16, (0, 0), (4, 4), 0));
    rendered
}
