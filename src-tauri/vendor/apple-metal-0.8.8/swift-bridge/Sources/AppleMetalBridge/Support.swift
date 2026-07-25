import Foundation
import Metal

@inline(__always)
public func am_copy_string(_ value: String?) -> UnsafeMutablePointer<CChar>? {
    guard let value else { return nil }
    return strdup(value)
}

@inline(__always)
public func am_store_error(
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ error: Error
) {
    outErrorMessage?.pointee = strdup((error as NSError).localizedDescription)
}

@inline(__always)
public func am_store_error_message(
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ message: String
) {
    outErrorMessage?.pointee = strdup(message)
}

@inline(__always)
public func am_url(from path: UnsafePointer<CChar>?) -> URL? {
    guard let path else { return nil }
    return URL(fileURLWithPath: String(cString: path))
}

@inline(__always)
public func am_copy_data(_ data: Data?) -> UnsafeMutableRawPointer? {
    guard let data, !data.isEmpty, let buffer = malloc(data.count) else { return nil }
    data.copyBytes(to: buffer.assumingMemoryBound(to: UInt8.self), count: data.count)
    return buffer
}

@inline(__always)
public func am_make_texture_descriptor(
    pixelFormat: Int,
    width: Int,
    height: Int,
    mipmapped: Bool,
    usage: Int,
    storageMode: Int
) -> MTLTextureDescriptor {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: MTLPixelFormat(rawValue: UInt(pixelFormat)) ?? .invalid,
        width: width,
        height: height,
        mipmapped: mipmapped
    )
    descriptor.usage = MTLTextureUsage(rawValue: UInt(usage))
    descriptor.storageMode = MTLStorageMode(rawValue: UInt(storageMode)) ?? .shared
    return descriptor
}

@_cdecl("am_object_release")
public func am_object_release(_ handle: UnsafeMutableRawPointer?) {
    am_release(handle)
}

@_cdecl("am_object_copy_label")
public func am_object_copy_label(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>? {
    if let value: MTLRenderPipelineState = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLComputePipelineState = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLDepthStencilState = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLSamplerState = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLCommandQueue = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLBinaryArchive = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLCaptureScope = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    if let value: MTLResource = am_borrow(handle) {
        return am_copy_string(value.label)
    }
    return nil
}
