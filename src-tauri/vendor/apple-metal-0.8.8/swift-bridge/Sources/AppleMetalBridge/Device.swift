// MTLDevice — handle to a GPU.

import Foundation
import Metal

@_cdecl("am_device_system_default")
public func am_device_system_default() -> UnsafeMutableRawPointer? {
    guard let device = MTLCreateSystemDefaultDevice() else { return nil }
    return am_retain(device as AnyObject)
}

@_cdecl("am_device_release")
public func am_device_release(_ handle: UnsafeMutableRawPointer?) { am_release(handle) }

@_cdecl("am_device_has_unified_memory")
public func am_device_has_unified_memory(_ handle: UnsafeMutableRawPointer?) -> Bool {
    guard let dev: MTLDevice = am_borrow(handle) else { return false }
    return dev.hasUnifiedMemory
}

@_cdecl("am_device_recommended_max_working_set_size")
public func am_device_recommended_max_working_set_size(_ handle: UnsafeMutableRawPointer?) -> UInt64 {
    guard let dev: MTLDevice = am_borrow(handle) else { return 0 }
    return dev.recommendedMaxWorkingSetSize
}

@_cdecl("am_device_supports_family")
public func am_device_supports_family(_ handle: UnsafeMutableRawPointer?, _ family: Int64) -> Bool {
    guard let dev: MTLDevice = am_borrow(handle),
          let fam = MTLGPUFamily(rawValue: Int(family))
    else { return false }
    return dev.supportsFamily(fam)
}
