import Foundation
import Metal

private func am_string(from value: UnsafePointer<CChar>?) -> String? {
    guard let value else { return nil }
    return String(cString: value)
}

private func am_make_stencil_descriptor(
    compareFunction: UInt,
    stencilFailureOperation: UInt,
    depthFailureOperation: UInt,
    depthStencilPassOperation: UInt,
    readMask: UInt32,
    writeMask: UInt32
) -> MTLStencilDescriptor {
    let descriptor = MTLStencilDescriptor()
    descriptor.stencilCompareFunction = MTLCompareFunction(rawValue: compareFunction) ?? MTLCompareFunction(rawValue: 7)!
    descriptor.stencilFailureOperation = MTLStencilOperation(rawValue: stencilFailureOperation) ?? MTLStencilOperation(rawValue: 0)!
    descriptor.depthFailureOperation = MTLStencilOperation(rawValue: depthFailureOperation) ?? MTLStencilOperation(rawValue: 0)!
    descriptor.depthStencilPassOperation = MTLStencilOperation(rawValue: depthStencilPassOperation) ?? MTLStencilOperation(rawValue: 0)!
    descriptor.readMask = readMask
    descriptor.writeMask = writeMask
    return descriptor
}

@_cdecl("am_device_new_depth_stencil_state")
public func am_device_new_depth_stencil_state(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ depthCompareFunction: UInt,
    _ depthWriteEnabled: Bool,
    _ hasFrontFaceStencil: Bool,
    _ frontStencilCompareFunction: UInt,
    _ frontStencilFailureOperation: UInt,
    _ frontDepthFailureOperation: UInt,
    _ frontDepthStencilPassOperation: UInt,
    _ frontReadMask: UInt32,
    _ frontWriteMask: UInt32,
    _ hasBackFaceStencil: Bool,
    _ backStencilCompareFunction: UInt,
    _ backStencilFailureOperation: UInt,
    _ backDepthFailureOperation: UInt,
    _ backDepthStencilPassOperation: UInt,
    _ backReadMask: UInt32,
    _ backWriteMask: UInt32,
    _ label: UnsafePointer<CChar>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle) else { return nil }

    let descriptor = MTLDepthStencilDescriptor()
    descriptor.depthCompareFunction = MTLCompareFunction(rawValue: depthCompareFunction) ?? MTLCompareFunction(rawValue: 7)!
    descriptor.isDepthWriteEnabled = depthWriteEnabled
    if let label = am_string(from: label) {
        descriptor.label = label
    }

    if hasFrontFaceStencil {
        descriptor.frontFaceStencil = am_make_stencil_descriptor(
            compareFunction: frontStencilCompareFunction,
            stencilFailureOperation: frontStencilFailureOperation,
            depthFailureOperation: frontDepthFailureOperation,
            depthStencilPassOperation: frontDepthStencilPassOperation,
            readMask: frontReadMask,
            writeMask: frontWriteMask
        )
    }

    if hasBackFaceStencil {
        descriptor.backFaceStencil = am_make_stencil_descriptor(
            compareFunction: backStencilCompareFunction,
            stencilFailureOperation: backStencilFailureOperation,
            depthFailureOperation: backDepthFailureOperation,
            depthStencilPassOperation: backDepthStencilPassOperation,
            readMask: backReadMask,
            writeMask: backWriteMask
        )
    }

    guard let state = device.makeDepthStencilState(descriptor: descriptor) else {
        return nil
    }
    return am_retain(state as AnyObject)
}

@_cdecl("am_device_new_sampler_state")
public func am_device_new_sampler_state(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ minFilter: UInt,
    _ magFilter: UInt,
    _ mipFilter: UInt,
    _ maxAnisotropy: Int,
    _ sAddressMode: UInt,
    _ tAddressMode: UInt,
    _ rAddressMode: UInt,
    _ borderColor: UInt,
    _ reductionMode: UInt,
    _ normalizedCoordinates: Bool,
    _ lodMinClamp: Float,
    _ lodMaxClamp: Float,
    _ lodAverage: Bool,
    _ lodBias: Float,
    _ compareFunction: UInt,
    _ supportArgumentBuffers: Bool,
    _ label: UnsafePointer<CChar>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle) else { return nil }

    let descriptor = MTLSamplerDescriptor()
    descriptor.minFilter = MTLSamplerMinMagFilter(rawValue: minFilter) ?? MTLSamplerMinMagFilter(rawValue: 0)!
    descriptor.magFilter = MTLSamplerMinMagFilter(rawValue: magFilter) ?? MTLSamplerMinMagFilter(rawValue: 0)!
    descriptor.mipFilter = MTLSamplerMipFilter(rawValue: mipFilter) ?? MTLSamplerMipFilter(rawValue: 0)!
    descriptor.maxAnisotropy = maxAnisotropy
    descriptor.sAddressMode = MTLSamplerAddressMode(rawValue: sAddressMode) ?? MTLSamplerAddressMode(rawValue: 0)!
    descriptor.tAddressMode = MTLSamplerAddressMode(rawValue: tAddressMode) ?? MTLSamplerAddressMode(rawValue: 0)!
    descriptor.rAddressMode = MTLSamplerAddressMode(rawValue: rAddressMode) ?? MTLSamplerAddressMode(rawValue: 0)!
    descriptor.borderColor = MTLSamplerBorderColor(rawValue: borderColor) ?? MTLSamplerBorderColor(rawValue: 0)!
    descriptor.normalizedCoordinates = normalizedCoordinates
    descriptor.lodMinClamp = lodMinClamp
    descriptor.lodMaxClamp = lodMaxClamp
    descriptor.lodAverage = lodAverage
    descriptor.compareFunction = MTLCompareFunction(rawValue: compareFunction) ?? MTLCompareFunction(rawValue: 0)!
    descriptor.supportArgumentBuffers = supportArgumentBuffers
    if let label = am_string(from: label) {
        descriptor.label = label
    }

    if #available(macOS 26.0, *) {
        descriptor.reductionMode = MTLSamplerReductionMode(rawValue: reductionMode) ?? MTLSamplerReductionMode(rawValue: 0)!
        descriptor.lodBias = lodBias
    }

    guard let sampler = device.makeSamplerState(descriptor: descriptor) else {
        return nil
    }
    return am_retain(sampler as AnyObject)
}

@_cdecl("am_compute_command_encoder_set_sampler_state")
public func am_compute_command_encoder_set_sampler_state(
    _ handle: UnsafeMutableRawPointer?,
    _ samplerHandle: UnsafeMutableRawPointer?,
    _ index: Int
) {
    guard let encoder: MTLComputeCommandEncoder = am_borrow(handle),
          let sampler: MTLSamplerState = am_borrow(samplerHandle)
    else { return }
    encoder.setSamplerState(sampler, index: index)
}

@_cdecl("am_render_command_encoder_set_fragment_sampler_state")
public func am_render_command_encoder_set_fragment_sampler_state(
    _ handle: UnsafeMutableRawPointer?,
    _ samplerHandle: UnsafeMutableRawPointer?,
    _ index: Int
) {
    guard let encoder: MTLRenderCommandEncoder = am_borrow(handle),
          let sampler: MTLSamplerState = am_borrow(samplerHandle)
    else { return }
    encoder.setFragmentSamplerState(sampler, index: index)
}

@_cdecl("am_render_command_encoder_set_depth_stencil_state")
public func am_render_command_encoder_set_depth_stencil_state(
    _ handle: UnsafeMutableRawPointer?,
    _ depthStencilStateHandle: UnsafeMutableRawPointer?
) {
    guard let encoder: MTLRenderCommandEncoder = am_borrow(handle),
          let depthStencilState: MTLDepthStencilState = am_borrow(depthStencilStateHandle)
    else { return }
    encoder.setDepthStencilState(depthStencilState)
}
