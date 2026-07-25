// MTLCommandQueue + MTLCommandBuffer + blit encoder.

import Foundation
import Metal

@_cdecl("am_device_new_command_queue")
public func am_device_new_command_queue(_ device_handle: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle),
          let queue = dev.makeCommandQueue()
    else { return nil }
    return am_retain(queue as AnyObject)
}

@_cdecl("am_command_queue_release")
public func am_command_queue_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_command_queue_new_command_buffer")
public func am_command_queue_new_command_buffer(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
    guard let q: MTLCommandQueue = am_borrow(handle),
          let cb = q.makeCommandBuffer()
    else { return nil }
    return am_retain(cb as AnyObject)
}

@_cdecl("am_command_buffer_release")
public func am_command_buffer_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_command_buffer_commit")
public func am_command_buffer_commit(_ handle: UnsafeMutableRawPointer?) {
    if let cb: MTLCommandBuffer = am_borrow(handle) { cb.commit() }
}

@_cdecl("am_command_buffer_wait_until_completed")
public func am_command_buffer_wait_until_completed(_ handle: UnsafeMutableRawPointer?) {
    if let cb: MTLCommandBuffer = am_borrow(handle) { cb.waitUntilCompleted() }
}

@_cdecl("am_command_buffer_blit_copy_buffer")
public func am_command_buffer_blit_copy_buffer(
    _ cb_handle: UnsafeMutableRawPointer?,
    _ src_handle: UnsafeMutableRawPointer?,
    _ src_offset: Int,
    _ dst_handle: UnsafeMutableRawPointer?,
    _ dst_offset: Int,
    _ size: Int
) -> Bool {
    guard let cb: MTLCommandBuffer = am_borrow(cb_handle),
          let src: MTLBuffer = am_borrow(src_handle),
          let dst: MTLBuffer = am_borrow(dst_handle),
          let blit = cb.makeBlitCommandEncoder()
    else { return false }
    blit.copy(from: src, sourceOffset: src_offset, to: dst, destinationOffset: dst_offset, size: size)
    blit.endEncoding()
    return true
}
