import Foundation
import Metal

private let am_argument_descriptor_stride = 6

@_cdecl("am_device_argument_buffers_support")
public func am_device_argument_buffers_support(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let device: MTLDevice = am_borrow(handle) else { return 0 }
    return Int(device.argumentBuffersSupport.rawValue)
}

@_cdecl("am_device_new_argument_encoder_with_descriptors")
public func am_device_new_argument_encoder_with_descriptors(
    _ handle: UnsafeMutableRawPointer?,
    _ descriptors: UnsafePointer<UInt>?,
    _ descriptorCount: Int
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(handle) else { return nil }

    var arguments = [MTLArgumentDescriptor]()
    arguments.reserveCapacity(max(0, descriptorCount))

    if let descriptors {
        for descriptorIndex in 0..<descriptorCount {
            let base = descriptorIndex * am_argument_descriptor_stride
            let descriptor = MTLArgumentDescriptor()
            descriptor.dataType = MTLDataType(rawValue: descriptors[base]) ?? MTLDataType(rawValue: 0)!
            descriptor.index = Int(descriptors[base + 1])
            descriptor.arrayLength = Int(descriptors[base + 2])
            descriptor.access = MTLBindingAccess(rawValue: descriptors[base + 3]) ?? MTLBindingAccess(rawValue: 0)!
            descriptor.textureType = MTLTextureType(rawValue: descriptors[base + 4]) ?? MTLTextureType(rawValue: 2)!
            descriptor.constantBlockAlignment = Int(descriptors[base + 5])
            arguments.append(descriptor)
        }
    }

    guard let encoder = device.makeArgumentEncoder(arguments: arguments) else {
        return nil
    }
    return am_retain(encoder as AnyObject)
}

@_cdecl("am_argument_encoder_set_sampler_state")
public func am_argument_encoder_set_sampler_state(
    _ handle: UnsafeMutableRawPointer?,
    _ samplerHandle: UnsafeMutableRawPointer?,
    _ index: Int
) {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle),
          let sampler: MTLSamplerState = am_borrow(samplerHandle)
    else { return }
    encoder.setSamplerState(sampler, index: index)
}
