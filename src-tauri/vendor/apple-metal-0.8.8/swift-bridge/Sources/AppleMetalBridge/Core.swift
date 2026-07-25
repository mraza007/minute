// Core memory-management + FFI utility helpers for the Apple Metal
// Swift bridge. Mirrors the pattern used by screencapturekit-rs.

import Foundation
import Metal

/// Take a Swift reference and hand a +1 retained, opaque `void*` to Rust.
@inline(__always)
public func am_retain<T: AnyObject>(_ object: T) -> UnsafeMutableRawPointer {
    Unmanaged.passRetained(object as AnyObject).toOpaque()
}

/// Drop a +1 retained Swift reference that Rust no longer owns.
@inline(__always)
public func am_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle = handle else { return }
    Unmanaged<AnyObject>.fromOpaque(handle).release()
}

/// Borrow a Metal protocol-typed reference from an opaque pointer
/// without changing the retain count. Returns `nil` if the cast
/// fails.
@inline(__always)
public func am_borrow<T>(_ handle: UnsafeMutableRawPointer?) -> T? {
    guard let handle = handle else { return nil }
    return Unmanaged<AnyObject>.fromOpaque(handle).takeUnretainedValue() as? T
}
