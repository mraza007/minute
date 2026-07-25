use apple_metal::{gpu_family, pixel_format, resource_options, MetalDevice, TextureDescriptor};

fn main() {
    let d = MetalDevice::system_default().expect("no Metal");
    println!("unified memory: {}", d.has_unified_memory());
    println!(
        "recommended max working set: {} MB",
        d.recommended_max_working_set_size() / (1024 * 1024)
    );
    println!("supports Metal3: {}", d.supports_family(gpu_family::METAL3));
    println!("supports Apple7: {}", d.supports_family(gpu_family::APPLE7));

    let buf = d
        .new_buffer(4096, resource_options::STORAGE_MODE_SHARED)
        .expect("buffer create failed");
    println!(
        "buffer {} bytes, contents={:?}",
        buf.length(),
        buf.contents().is_some()
    );
    let n = buf.write_bytes(b"hello metal");
    println!("wrote {n} bytes");

    let tx = d
        .new_texture(TextureDescriptor::new_2d(
            256,
            256,
            pixel_format::BGRA8UNORM,
        ))
        .expect("texture create failed");
    println!(
        "texture {}x{} fmt={}",
        tx.width(),
        tx.height(),
        tx.pixel_format()
    );
}
