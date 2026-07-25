use apple_metal::{resource_options, MetalDevice};

fn main() {
    let dev = MetalDevice::system_default().expect("no Metal");
    let queue = dev.new_command_queue().expect("queue");
    let src = dev
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("src");
    let dst = dev
        .new_buffer(64, resource_options::STORAGE_MODE_SHARED)
        .expect("dst");
    let _ = src.write_bytes(b"hello GPU blit from apple-metal-rs!!!!!");

    let cb = queue.new_command_buffer().expect("cb");
    assert!(cb.blit_copy_buffer(&src, 0, &dst, 0, 64));
    cb.commit();
    cb.wait_until_completed();

    let p = dst.contents().unwrap().cast::<u8>();
    let bytes = unsafe { core::slice::from_raw_parts(p, 40) };
    let s = String::from_utf8_lossy(bytes);
    println!("GPU blit result: {s:?}");
    assert!(s.starts_with("hello GPU blit"));
}
