import Darwin
import Foundation
import Metal

@_cdecl("am_new_class_instance")
public func am_new_class_instance(_ className: UnsafePointer<CChar>?) -> UnsafeMutableRawPointer? {
    guard let className else { return nil }
    guard let cls = NSClassFromString(String(cString: className)) as? NSObject.Type else {
        return nil
    }
    return am_retain(cls.init())
}

@_cdecl("am_copy_metal_string_constant")
public func am_copy_metal_string_constant(
    _ symbolName: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let symbolName else { return nil }
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), symbolName) else {
        return nil
    }

    let value = symbol.assumingMemoryBound(to: Optional<NSString>.self).pointee
    return am_copy_string(value as String?)
}

@_cdecl("am_copy_all_devices")
public func am_copy_all_devices(
    _ outCount: UnsafeMutablePointer<Int>?
) -> UnsafeMutablePointer<UnsafeMutableRawPointer?>? {
    let devices = MTLCopyAllDevices()
    outCount?.pointee = devices.count
    guard devices.count > 0 else { return nil }
    let bytes = devices.count * MemoryLayout<UnsafeMutableRawPointer?>.stride
    guard let buffer = malloc(bytes)?.assumingMemoryBound(to: UnsafeMutableRawPointer?.self) else {
        outCount?.pointee = 0
        return nil
    }
    for (index, device) in devices.enumerated() {
        buffer[index] = am_retain(device)
    }
    return buffer
}

@_cdecl("am_copy_all_devices_with_observer")
public func am_copy_all_devices_with_observer(
    _ outCount: UnsafeMutablePointer<Int>?,
    _ outObserver: UnsafeMutablePointer<UnsafeMutableRawPointer?>?,
    _ callback: (@convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void)?,
    _ userData: UnsafeMutableRawPointer?
) -> UnsafeMutablePointer<UnsafeMutableRawPointer?>? {
    guard #available(macOS 11.0, *) else {
        outCount?.pointee = 0
        outObserver?.pointee = nil
        return nil
    }

    let result = MTLCopyAllDevicesWithObserver { device, notification in
        guard let callback else { return }
        let deviceHandle = am_retain(device)
        let notificationName = strdup(notification.rawValue)
        callback(deviceHandle, notificationName, userData)
        am_release(deviceHandle)
        free(notificationName)
    }
    outObserver?.pointee = am_retain(result.observer)
    outCount?.pointee = result.devices.count
    guard result.devices.count > 0 else { return nil }
    let bytes = result.devices.count * MemoryLayout<UnsafeMutableRawPointer?>.stride
    guard let buffer = malloc(bytes)?.assumingMemoryBound(to: UnsafeMutableRawPointer?.self) else {
        outCount?.pointee = 0
        return nil
    }
    for (index, device) in result.devices.enumerated() {
        buffer[index] = am_retain(device)
    }
    return buffer
}

@_cdecl("am_remove_device_observer")
public func am_remove_device_observer(_ observerHandle: UnsafeMutableRawPointer?) {
    guard #available(macOS 11.0, *) else { return }
    guard let observer: NSObject = am_borrow(observerHandle) else { return }
    MTLRemoveDeviceObserver(observer)
}

@_cdecl("am_io_compression_context_default_chunk_size")
public func am_io_compression_context_default_chunk_size() -> Int {
    if #available(macOS 13.0, *) {
        return MTLIOCompressionContextDefaultChunkSize()
    }
    return 0
}

@_cdecl("am_io_create_compression_context")
public func am_io_create_compression_context(
    _ path: UnsafePointer<CChar>?,
    _ method: Int,
    _ chunkSize: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 13.0, *) else { return nil }
    guard let path else { return nil }
    guard let compressionMethod = MTLIOCompressionMethod(rawValue: method) else {
        return nil
    }
    return MTLIOCreateCompressionContext(String(cString: path), compressionMethod, chunkSize)
}

@_cdecl("am_io_compression_context_append_data")
public func am_io_compression_context_append_data(
    _ handle: UnsafeMutableRawPointer?,
    _ data: UnsafePointer<UInt8>?,
    _ size: Int
) {
    guard #available(macOS 13.0, *) else { return }
    guard let handle, let data else { return }
    MTLIOCompressionContextAppendData(handle, data, size)
}

@_cdecl("am_io_flush_and_destroy_compression_context")
public func am_io_flush_and_destroy_compression_context(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard #available(macOS 13.0, *) else { return 1 }
    guard let handle else { return 1 }
    return MTLIOFlushAndDestroyCompressionContext(handle).rawValue
}
