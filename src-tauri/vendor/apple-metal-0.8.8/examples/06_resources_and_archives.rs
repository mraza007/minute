#![allow(clippy::too_many_lines)]

#[path = "common/mod.rs"]
mod common;

use apple_metal::{
    log_level, pixel_format, resource_options, storage_mode, MetalDevice, TextureDescriptor,
};

fn main() {
    let device = MetalDevice::system_default().expect("Metal device available");
    println!("device: {}", device.name());

    let queue = device
        .new_command_queue_with_max_command_buffer_count(4)
        .expect("bounded command queue");
    let scratch = queue
        .new_command_buffer_with_unretained_references()
        .expect("bounded scratch command buffer");
    println!("bounded queue scratch status={}", scratch.status());

    let library = device
        .new_library_with_source(common::COMPUTE_SRC)
        .expect("compile compute library");
    let args = library.new_function("use_args").expect("use_args function");
    let argument_encoder = args.new_argument_encoder(0).expect("argument encoder");
    let argument_buffer = device
        .new_buffer(
            argument_encoder.encoded_length(),
            resource_options::STORAGE_MODE_SHARED,
        )
        .expect("argument buffer");
    let payload = device
        .new_buffer(16, resource_options::STORAGE_MODE_SHARED)
        .expect("payload buffer");
    let texture = device
        .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
        .expect("argument texture");
    argument_encoder.set_argument_buffer(&argument_buffer, 0);
    argument_encoder.set_buffer(&payload, 0, 0);
    argument_encoder.set_texture(&texture, 1);
    println!(
        "argument encoder length={} alignment={}",
        argument_encoder.encoded_length(),
        argument_encoder.alignment(),
    );

    let backing = device
        .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
        .expect("backing buffer");
    let buffer_texture = backing
        .new_texture_view_2d(pixel_format::BGRA8UNORM, 16, 4, 64, 0)
        .expect("buffer-backed texture");
    println!(
        "buffer-backed texture {}x{} fmt={}",
        buffer_texture.width(),
        buffer_texture.height(),
        buffer_texture.pixel_format(),
    );

    if let Some(heap) = device.new_heap(1 << 20, storage_mode::SHARED) {
        let heap_buffer = heap
            .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
            .expect("heap buffer");
        let heap_texture = heap
            .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
            .expect("heap texture");
        println!(
            "heap size={} used={} current={} max_available={}",
            heap.size(),
            heap.used_size(),
            heap.current_allocated_size(),
            heap.max_available_size(256),
        );
        println!(
            "heap buffer len={} heap texture {}x{} purgeable={}",
            heap_buffer.length(),
            heap_texture.width(),
            heap_texture.height(),
            heap.set_purgeable_state(apple_metal::purgeable_state::KEEP_CURRENT),
        );
    } else {
        println!("heaps are unavailable on this device");
    }

    match device.new_log_state(log_level::INFO, 1_024) {
        Ok(log_state) => {
            let _ = device
                .new_command_queue_with_log_state(4, &log_state)
                .expect("log-state queue");
            println!("created queue with log state");
        }
        Err(error) => println!("log state unavailable on this OS: {error}"),
    }

    if device.supports_dynamic_libraries() {
        let dynamic_path = common::artifact_path("example-dylib.metallib");
        let dynamic_library = device
            .new_dynamic_library_with_source(
                common::DYNAMIC_LIB_SRC,
                dynamic_path.to_string_lossy().as_ref(),
            )
            .expect("dynamic library from source");
        dynamic_library
            .serialize_to_file(&dynamic_path)
            .expect("serialize dynamic library");
        let reloaded = device
            .load_dynamic_library(&dynamic_path)
            .expect("reload dynamic library");
        println!("dynamic library install name: {}", reloaded.install_name());

        let render_library = device
            .new_library_with_source(common::RENDER_SRC)
            .expect("compile render library");
        let vertex = render_library
            .new_function("fullscreen_vertex")
            .expect("vertex function");
        let fragment = render_library
            .new_function("solid_fragment")
            .expect("fragment function");
        let increment = library
            .new_function("increment")
            .expect("increment function");

        let archive_path = common::artifact_path("example-archive.metalarc");
        let archive = device.new_binary_archive(None).expect("binary archive");
        archive
            .add_compute_function(&increment)
            .expect("archive compute pipeline");
        archive
            .add_render_functions(&vertex, &fragment, pixel_format::BGRA8UNORM, 1)
            .expect("archive render pipeline");
        archive
            .serialize_to_file(&archive_path)
            .expect("serialize binary archive");
        let _ = device
            .new_binary_archive(Some(&archive_path))
            .expect("reload binary archive");
        println!("binary archive written to {}", archive_path.display());
    } else {
        println!("dynamic libraries unsupported; skipping archive serialization");
    }
}
