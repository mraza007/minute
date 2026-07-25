// MTLTexture — 2D GPU image + IOSurface-backed textures.

import Foundation
import Metal
#if canImport(IOSurface)
import IOSurface
#endif

@_cdecl("am_device_new_texture_2d")
public func am_device_new_texture_2d(
    _ device_handle: UnsafeMutableRawPointer?,
    _ pixel_format: Int,
    _ width: Int,
    _ height: Int,
    _ mipmapped: Bool,
    _ usage: Int,
    _ storage_mode: Int
) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle) else { return nil }
    let desc = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: MTLPixelFormat(rawValue: UInt(pixel_format)) ?? .invalid,
        width: width,
        height: height,
        mipmapped: mipmapped
    )
    desc.usage = MTLTextureUsage(rawValue: UInt(usage))
    desc.storageMode = MTLStorageMode(rawValue: UInt(storage_mode)) ?? .shared
    guard let tex = dev.makeTexture(descriptor: desc) else { return nil }
    return am_retain(tex as AnyObject)
}

@_cdecl("am_texture_release")
public func am_texture_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_texture_width")
public func am_texture_width(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let t: MTLTexture = am_borrow(handle) else { return 0 }
    return t.width
}

@_cdecl("am_texture_height")
public func am_texture_height(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let t: MTLTexture = am_borrow(handle) else { return 0 }
    return t.height
}

@_cdecl("am_texture_pixel_format")
public func am_texture_pixel_format(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let t: MTLTexture = am_borrow(handle) else { return 0 }
    return Int(t.pixelFormat.rawValue)
}

#if canImport(IOSurface)
@_cdecl("am_device_new_texture_from_iosurface")
public func am_device_new_texture_from_iosurface(
    _ device_handle: UnsafeMutableRawPointer?,
    _ iosurface_ptr: UnsafeMutableRawPointer?,
    _ plane_index: Int,
    _ pixel_format: Int,
    _ width: Int,
    _ height: Int
) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle),
          let iosurface_ptr = iosurface_ptr
    else { return nil }
    let surface = Unmanaged<IOSurfaceRef>.fromOpaque(iosurface_ptr).takeUnretainedValue()
    let desc = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: MTLPixelFormat(rawValue: UInt(pixel_format)) ?? .invalid,
        width: width,
        height: height,
        mipmapped: false
    )
    desc.usage = [.shaderRead, .shaderWrite]
    desc.storageMode = .shared
    guard let tex = dev.makeTexture(descriptor: desc, iosurface: surface, plane: plane_index) else {
        return nil
    }
    return am_retain(tex as AnyObject)
}
#endif
