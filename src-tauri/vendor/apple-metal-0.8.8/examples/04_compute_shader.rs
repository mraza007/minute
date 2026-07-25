//! Smoke test for the v0.5 compute pipeline: compiles a trivial
//! "multiply by 2" Metal kernel, dispatches it on a shared buffer
//! of 16 floats, and verifies every element doubled.

#![allow(clippy::cast_precision_loss, clippy::float_cmp)]

use apple_metal::{resource_options, MetalDevice};

const KERNEL_SRC: &str = "
#include <metal_stdlib>
using namespace metal;

kernel void mul2(device float *data [[buffer(0)]],
                 uint i [[thread_position_in_grid]]) {
    data[i] = data[i] * 2.0;
}
";

const N: usize = 16;

fn main() {
    let device = MetalDevice::system_default().expect("MTLCreateSystemDefaultDevice");
    println!("Device unified={}", device.has_unified_memory());

    let lib = device
        .new_library_with_source(KERNEL_SRC)
        .expect("compile MSL source");
    println!("✅ Compiled library {:p}", lib.as_ptr());

    let func = lib.new_function("mul2").expect("locate function 'mul2'");
    println!("✅ Found function mul2 {:p}", func.as_ptr());

    let pso = device
        .new_compute_pipeline_state(&func)
        .expect("build compute pipeline state");
    println!("✅ Compute pipeline state {:p}", pso.as_ptr());

    let byte_len = N * core::mem::size_of::<f32>();
    let buffer = device
        .new_buffer(byte_len, resource_options::STORAGE_MODE_SHARED)
        .expect("allocate buffer");

    let slice: &mut [f32] = unsafe {
        core::slice::from_raw_parts_mut(
            buffer.contents().expect("buffer.contents").cast::<f32>(),
            N,
        )
    };
    for (i, x) in slice.iter_mut().enumerate() {
        *x = i as f32;
    }
    println!("Input : {slice:?}");

    let queue = device.new_command_queue().expect("MTLCommandQueue");
    let cb = queue.new_command_buffer().expect("MTLCommandBuffer");
    let ok = cb.dispatch_compute_1d(&pso, &[&buffer], N, 1);
    assert!(ok, "dispatch_compute_1d failed");
    cb.commit();
    cb.wait_until_completed();

    let slice: &[f32] = unsafe {
        core::slice::from_raw_parts(buffer.contents().expect("buffer.contents").cast::<f32>(), N)
    };
    println!("Output: {slice:?}");

    for (i, &v) in slice.iter().enumerate() {
        let expected = (i as f32) * 2.0;
        assert_eq!(v, expected, "element {i} expected {expected} got {v}");
    }
    println!("✅ All {N} elements correctly doubled by the GPU kernel");
}
