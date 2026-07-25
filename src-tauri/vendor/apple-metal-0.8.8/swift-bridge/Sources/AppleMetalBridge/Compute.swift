// MTLLibrary + MTLFunction + MTLComputePipelineState + 1-D compute dispatch.

import Foundation
import Metal

@_cdecl("am_device_new_library_with_source")
public func am_device_new_library_with_source(
    _ device_handle: UnsafeMutableRawPointer?,
    _ source: UnsafePointer<CChar>?,
    _ out_error_message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle), let source = source else { return nil }
    let src = String(cString: source)
    do {
        let lib = try dev.makeLibrary(source: src, options: nil)
        return am_retain(lib as AnyObject)
    } catch {
        if let outE = out_error_message {
            outE.pointee = strdup(error.localizedDescription)
        }
        return nil
    }
}

@_cdecl("am_library_release")
public func am_library_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_library_new_function")
public func am_library_new_function(
    _ lib_handle: UnsafeMutableRawPointer?,
    _ name: UnsafePointer<CChar>?
) -> UnsafeMutableRawPointer? {
    guard let lib: MTLLibrary = am_borrow(lib_handle), let name = name else { return nil }
    let n = String(cString: name)
    guard let fn = lib.makeFunction(name: n) else { return nil }
    return am_retain(fn as AnyObject)
}

@_cdecl("am_function_release")
public func am_function_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_device_new_compute_pipeline_state")
public func am_device_new_compute_pipeline_state(
    _ device_handle: UnsafeMutableRawPointer?,
    _ fn_handle: UnsafeMutableRawPointer?,
    _ out_error_message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let dev: MTLDevice = am_borrow(device_handle),
          let fn: MTLFunction = am_borrow(fn_handle)
    else { return nil }
    do {
        let pso = try dev.makeComputePipelineState(function: fn)
        return am_retain(pso as AnyObject)
    } catch {
        if let outE = out_error_message {
            outE.pointee = strdup(error.localizedDescription)
        }
        return nil
    }
}

@_cdecl("am_compute_pipeline_state_release")
public func am_compute_pipeline_state_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

/// Dispatch a 1-D compute kernel: bind `pso`, set up to N buffers,
/// dispatch `threadgroups`x1x1 of `threads_per_group`x1x1 threads.
@_cdecl("am_command_buffer_dispatch_compute_1d")
public func am_command_buffer_dispatch_compute_1d(
    _ cb_handle: UnsafeMutableRawPointer?,
    _ pso_handle: UnsafeMutableRawPointer?,
    _ buffers: UnsafePointer<UnsafeMutableRawPointer?>?,
    _ buffer_count: Int,
    _ threadgroups: Int,
    _ threads_per_group: Int
) -> Bool {
    guard let cb: MTLCommandBuffer = am_borrow(cb_handle),
          let pso: MTLComputePipelineState = am_borrow(pso_handle),
          let enc = cb.makeComputeCommandEncoder()
    else { return false }
    enc.setComputePipelineState(pso)
    if let bp = buffers {
        for i in 0..<buffer_count {
            if let bh = bp[i],
               let buf: MTLBuffer = am_borrow(bh) {
                enc.setBuffer(buf, offset: 0, index: i)
            }
        }
    }
    enc.dispatchThreadgroups(
        MTLSize(width: threadgroups, height: 1, depth: 1),
        threadsPerThreadgroup: MTLSize(width: threads_per_group, height: 1, depth: 1)
    )
    enc.endEncoding()
    return true
}
