mod common;

use apple_metal::resource_options;

#[test]
fn fences_can_synchronize_blit_work_between_command_buffers() {
    let device = common::device();
    let Some(fence) = device.new_fence() else {
        return;
    };

    let queue = device.new_command_queue().expect("command queue");
    let src = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("source buffer");
    let dst = device
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("destination buffer");

    common::committed_blit_copy(&queue, &src, &dst, Some(&fence));

    let copied = unsafe {
        core::slice::from_raw_parts(
            dst.contents().expect("destination contents").cast::<u8>(),
            64,
        )
    };
    assert!(copied.iter().take(8).all(|byte| *byte == b'A'));
}
