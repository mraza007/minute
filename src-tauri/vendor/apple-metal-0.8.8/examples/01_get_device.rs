use apple_metal::MetalDevice;

fn main() {
    let device = MetalDevice::system_default().expect("no Metal device found");
    println!("got Metal device at {:p}", device.as_ptr());
    assert!(!device.as_ptr().is_null());
}
