mod common;

use apple_metal::{pixel_format, resource_options, storage_mode, TextureDescriptor};

#[test]
fn heap_can_allocate_buffers_and_textures() {
    let device = common::device();
    let Some(heap) = device.new_heap(1 << 20, storage_mode::SHARED) else {
        return;
    };

    assert!(heap.size() >= (1 << 20));
    assert!(heap.max_available_size(256) > 0);
    assert!(heap.used_size() <= heap.size());
    assert!(heap.current_allocated_size() <= heap.size());

    let buffer = heap
        .new_buffer(256, resource_options::STORAGE_MODE_SHARED)
        .expect("heap buffer");
    assert_eq!(buffer.length(), 256);

    let texture = heap
        .new_texture(TextureDescriptor::new_2d(4, 4, pixel_format::BGRA8UNORM))
        .expect("heap texture");
    let upload = vec![0x22_u8; 4 * 4 * 4];
    assert!(texture.replace_region_2d(&upload, 16, (0, 0), (4, 4), 0));
    let mut download = vec![0_u8; upload.len()];
    assert!(texture.read_bytes_2d(&mut download, 16, (0, 0), (4, 4), 0));
    assert_eq!(download, upload);
    assert_eq!(texture.width(), 4);
    assert_eq!(texture.height(), 4);
    assert_eq!(texture.pixel_format(), pixel_format::BGRA8UNORM);
    assert_eq!(texture.storage_mode(), storage_mode::SHARED);
}
