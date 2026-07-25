// MTLBuffer — generic GPU memory.

import Foundation
import Metal

@_cdecl("am_device_new_buffer")
public func am_device_new_buffer(
    _ device_handle: UnsafeMutableRawPointer?,
    _ length: Int,
    _ options: UInt
) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle),
          let buf = dev.makeBuffer(length: length, options: MTLResourceOptions(rawValue: options))
    else { return nil }
    return am_retain(buf as AnyObject)
}

@_cdecl("am_buffer_release")
public func am_buffer_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_buffer_length")
public func am_buffer_length(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let buf: MTLBuffer = am_borrow(handle) else { return 0 }
    return buf.length
}

@_cdecl("am_buffer_contents")
public func am_buffer_contents(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
    guard let buf: MTLBuffer = am_borrow(handle) else { return nil }
    return buf.contents()
}
