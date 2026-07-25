#![allow(clippy::too_many_lines)]

#[path = "common/mod.rs"]
mod common;

use apple_metal::{
    capture_destination, counter_sampling_point, indirect_command_type,
    intersection_function_signature, resource_options, storage_mode, CaptureManager, MetalDevice,
};

fn main() {
    let device = MetalDevice::system_default().expect("Metal device available");
    let queue = device.new_command_queue().expect("command queue");
    let counter_sets = device.counter_set_names();
    println!("counter sets: {counter_sets:?}");

    if let Some(event) = device.new_shared_event() {
        event.set_signaled_value(1);
        println!("event signaled value={}", event.signaled_value());
        let signal = queue
            .new_command_buffer()
            .expect("event signal command buffer");
        signal.encode_signal_event(&event, 2);
        signal.commit();
        signal.wait_until_completed();
        println!(
            "event reached value 2: {}",
            event.wait_until_signaled_value(2, 1_000),
        );

        let wait = queue
            .new_command_buffer()
            .expect("event wait command buffer");
        wait.encode_wait_for_event(&event, 2);
        wait.commit();
        wait.wait_until_completed();
    }

    let fence_a = device.new_fence();
    let fence_b = device.new_fence();
    let sample_buffer = counter_sets.first().and_then(|name| {
        if device.supports_counter_sampling(counter_sampling_point::AT_BLIT_BOUNDARY) {
            device
                .new_counter_sample_buffer(name, 2, storage_mode::SHARED, Some("example-samples"))
                .ok()
        } else {
            None
        }
    });

    let src = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("source buffer");
    let dst = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("destination buffer");
    let blit = queue.new_command_buffer().expect("blit command buffer");
    let encoder = blit.new_blit_command_encoder().expect("blit encoder");
    let _ = encoder.fill_buffer(&src, 0..64, b'Q');
    if let Some(fence) = fence_a.as_ref() {
        encoder.update_fence(fence);
    }
    encoder.end_encoding();
    blit.commit();
    blit.wait_until_completed();

    let blit = queue
        .new_command_buffer()
        .expect("second blit command buffer");
    let encoder = blit
        .new_blit_command_encoder()
        .expect("second blit encoder");
    if let Some(fence) = fence_a.as_ref() {
        encoder.wait_for_fence(fence);
    }
    if let Some(sample_buffer) = sample_buffer.as_ref() {
        let _ = encoder.sample_counters(sample_buffer, 0, false);
    }
    let _ = encoder.copy_buffer(&src, 0, &dst, 0, 64);
    encoder.end_encoding();
    blit.commit();
    blit.wait_until_completed();
    if let Some(sample_buffer) = sample_buffer.as_ref() {
        println!(
            "resolved counter bytes={}",
            sample_buffer
                .resolve_range(0..1)
                .map_or(0, |bytes| bytes.len())
        );
    }

    let library = device
        .new_library_with_source(common::COMPUTE_SRC)
        .expect("compile compute library");
    let increment = library
        .new_function("increment")
        .expect("increment function");
    let pipeline = device
        .new_compute_pipeline_state(&increment)
        .expect("compute pipeline");
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

    let buffer = device
        .new_buffer(16, resource_options::STORAGE_MODE_SHARED)
        .expect("compute buffer");
    common::write_u32_words(&buffer, &[1, 2, 3, 4]);
    let texture = device
        .new_texture(apple_metal::TextureDescriptor::new_2d(
            4,
            4,
            apple_metal::pixel_format::BGRA8UNORM,
        ))
        .expect("compute texture");
    let compute = queue.new_command_buffer().expect("compute command buffer");
    let encoder = compute
        .new_compute_command_encoder()
        .expect("compute command encoder");
    encoder.set_compute_pipeline_state(&pipeline);
    encoder.set_buffer(&buffer, 0, 0);
    encoder.set_texture(&texture, 1);
    if let Some(fence) = fence_a.as_ref() {
        encoder.wait_for_fence(fence);
    }
    if let Some(table) = visible_table.as_ref() {
        encoder.set_visible_function_table(table, 2);
    }
    if let Some(table) = intersection_table.as_ref() {
        encoder.set_intersection_function_table(table, 3);
    }
    if let Some(acceleration_structure) = acceleration_structure.as_ref() {
        encoder.set_acceleration_structure(acceleration_structure, 4);
    }
    encoder.dispatch_threadgroups((1, 1, 1), (4, 1, 1));
    if let Some(fence) = fence_b.as_ref() {
        encoder.update_fence(fence);
    }
    encoder.end_encoding();
    compute.commit();
    compute.wait_until_completed();
    println!(
        "compute buffer after dispatch: {:?}",
        common::read_u32_words(&buffer, 4)
    );

    if let Some(indirect) = device.new_indirect_command_buffer(
        indirect_command_type::CONCURRENT_DISPATCH,
        1,
        0,
        0,
        4,
        resource_options::STORAGE_MODE_PRIVATE,
    ) {
        indirect.reset_range(0..1);
        println!("indirect command buffer size={}", indirect.size());
    }

    if let Some(heap) = device.new_heap(1 << 20, storage_mode::SHARED) {
        if let Ok(residency_set) = device.new_residency_set(Some("example-residency"), 4) {
            let heap_buffer = heap
                .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
                .expect("heap buffer");
            residency_set.add_buffer(&heap_buffer);
            residency_set.add_heap(&heap);
            residency_set.commit();
            residency_set.request_residency();
            queue.add_residency_set(&residency_set);
            queue.remove_residency_set(&residency_set);
            residency_set.end_residency();
            residency_set.remove_all_allocations();
            residency_set.commit();
            println!(
                "residency allocation count={}",
                residency_set.allocation_count()
            );
        } else {
            println!("residency sets unavailable on this OS");
        }
    }

    if let Some(capture_manager) = CaptureManager::shared() {
        println!(
            "capture supported for developer tools={} active={}",
            capture_manager.supports_destination(capture_destination::DEVELOPER_TOOLS),
            capture_manager.is_capturing(),
        );
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
