import Foundation
import Metal
import MetalFX

@_cdecl("am_spatial_scaler_supports_device")
public func am_spatial_scaler_supports_device(_ deviceHandle: UnsafeMutableRawPointer?) -> Bool {
    guard #available(macOS 13.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return false
    }
    return MTLFXSpatialScalerDescriptor.supportsDevice(device)
}

@_cdecl("am_device_new_spatial_scaler")
public func am_device_new_spatial_scaler(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ colorTextureFormat: Int,
    _ outputTextureFormat: Int,
    _ inputWidth: Int,
    _ inputHeight: Int,
    _ outputWidth: Int,
    _ outputHeight: Int,
    _ colorProcessingMode: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 13.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return nil
    }

    let descriptor = MTLFXSpatialScalerDescriptor()
    descriptor.colorTextureFormat = MTLPixelFormat(rawValue: UInt(colorTextureFormat)) ?? .invalid
    descriptor.outputTextureFormat = MTLPixelFormat(rawValue: UInt(outputTextureFormat)) ?? .invalid
    descriptor.inputWidth = inputWidth
    descriptor.inputHeight = inputHeight
    descriptor.outputWidth = outputWidth
    descriptor.outputHeight = outputHeight
    descriptor.colorProcessingMode = MTLFXSpatialScalerColorProcessingMode(rawValue: colorProcessingMode) ?? MTLFXSpatialScalerColorProcessingMode(rawValue: 0)!

    guard let scaler = descriptor.makeSpatialScaler(device: device) else {
        return nil
    }
    return am_retain(scaler as AnyObject)
}

@_cdecl("am_spatial_scaler_texture_usage")
public func am_spatial_scaler_texture_usage(
    _ handle: UnsafeMutableRawPointer?,
    _ kind: Int
) -> Int {
    guard #available(macOS 13.0, *), let scaler: MTLFXSpatialScaler = am_borrow(handle) else {
        return 0
    }

    switch kind {
    case 0:
        return Int(scaler.colorTextureUsage.rawValue)
    case 1:
        return Int(scaler.outputTextureUsage.rawValue)
    default:
        return 0
    }
}

@_cdecl("am_spatial_scaler_configure")
public func am_spatial_scaler_configure(
    _ handle: UnsafeMutableRawPointer?,
    _ inputContentWidth: Int,
    _ inputContentHeight: Int,
    _ colorTextureHandle: UnsafeMutableRawPointer?,
    _ outputTextureHandle: UnsafeMutableRawPointer?,
    _ fenceHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 13.0, *),
          let scaler: MTLFXSpatialScaler = am_borrow(handle),
          let colorTexture: MTLTexture = am_borrow(colorTextureHandle),
          let outputTexture: MTLTexture = am_borrow(outputTextureHandle)
    else { return }

    scaler.inputContentWidth = inputContentWidth
    scaler.inputContentHeight = inputContentHeight
    scaler.colorTexture = colorTexture
    scaler.outputTexture = outputTexture
    scaler.fence = am_borrow(fenceHandle)
}

@_cdecl("am_spatial_scaler_encode")
public func am_spatial_scaler_encode(
    _ handle: UnsafeMutableRawPointer?,
    _ commandBufferHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 13.0, *),
          let scaler: MTLFXSpatialScaler = am_borrow(handle),
          let commandBuffer: MTLCommandBuffer = am_borrow(commandBufferHandle)
    else { return }
    scaler.encode(commandBuffer: commandBuffer)
}

@_cdecl("am_temporal_scaler_supports_device")
public func am_temporal_scaler_supports_device(_ deviceHandle: UnsafeMutableRawPointer?) -> Bool {
    guard #available(macOS 13.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return false
    }
    return MTLFXTemporalScalerDescriptor.supportsDevice(device)
}

@_cdecl("am_temporal_scaler_supported_input_content_min_scale")
public func am_temporal_scaler_supported_input_content_min_scale(
    _ deviceHandle: UnsafeMutableRawPointer?
) -> Float {
    guard #available(macOS 14.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return 0
    }
    return MTLFXTemporalScalerDescriptor.supportedInputContentMinScale(device: device)
}

@_cdecl("am_temporal_scaler_supported_input_content_max_scale")
public func am_temporal_scaler_supported_input_content_max_scale(
    _ deviceHandle: UnsafeMutableRawPointer?
) -> Float {
    guard #available(macOS 14.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return 0
    }
    return MTLFXTemporalScalerDescriptor.supportedInputContentMaxScale(device: device)
}

@_cdecl("am_device_new_temporal_scaler")
public func am_device_new_temporal_scaler(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ colorTextureFormat: Int,
    _ depthTextureFormat: Int,
    _ motionTextureFormat: Int,
    _ outputTextureFormat: Int,
    _ inputWidth: Int,
    _ inputHeight: Int,
    _ outputWidth: Int,
    _ outputHeight: Int,
    _ autoExposureEnabled: Bool,
    _ requiresSynchronousInitialization: Bool,
    _ inputContentPropertiesEnabled: Bool,
    _ inputContentMinScale: Float,
    _ inputContentMaxScale: Float,
    _ reactiveMaskTextureEnabled: Bool,
    _ reactiveMaskTextureFormat: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 13.0, *), let device: MTLDevice = am_borrow(deviceHandle) else {
        return nil
    }

    let descriptor = MTLFXTemporalScalerDescriptor()
    descriptor.colorTextureFormat = MTLPixelFormat(rawValue: UInt(colorTextureFormat)) ?? .invalid
    descriptor.depthTextureFormat = MTLPixelFormat(rawValue: UInt(depthTextureFormat)) ?? .invalid
    descriptor.motionTextureFormat = MTLPixelFormat(rawValue: UInt(motionTextureFormat)) ?? .invalid
    descriptor.outputTextureFormat = MTLPixelFormat(rawValue: UInt(outputTextureFormat)) ?? .invalid
    descriptor.inputWidth = inputWidth
    descriptor.inputHeight = inputHeight
    descriptor.outputWidth = outputWidth
    descriptor.outputHeight = outputHeight
    descriptor.isAutoExposureEnabled = autoExposureEnabled
    descriptor.requiresSynchronousInitialization = requiresSynchronousInitialization
    descriptor.isInputContentPropertiesEnabled = inputContentPropertiesEnabled
    descriptor.inputContentMinScale = inputContentMinScale
    descriptor.inputContentMaxScale = inputContentMaxScale
    if #available(macOS 14.4, *) {
        descriptor.isReactiveMaskTextureEnabled = reactiveMaskTextureEnabled
        descriptor.reactiveMaskTextureFormat = MTLPixelFormat(rawValue: UInt(reactiveMaskTextureFormat)) ?? .invalid
    }

    guard let scaler = descriptor.makeTemporalScaler(device: device) else {
        return nil
    }
    return am_retain(scaler as AnyObject)
}

@_cdecl("am_temporal_scaler_texture_usage")
public func am_temporal_scaler_texture_usage(
    _ handle: UnsafeMutableRawPointer?,
    _ kind: Int
) -> Int {
    guard #available(macOS 13.0, *), let scaler: MTLFXTemporalScaler = am_borrow(handle) else {
        return 0
    }

    switch kind {
    case 0:
        return Int(scaler.colorTextureUsage.rawValue)
    case 1:
        return Int(scaler.depthTextureUsage.rawValue)
    case 2:
        return Int(scaler.motionTextureUsage.rawValue)
    case 3:
        if #available(macOS 14.4, *) {
            return Int(scaler.reactiveTextureUsage.rawValue)
        }
        return 0
    case 4:
        return Int(scaler.outputTextureUsage.rawValue)
    default:
        return 0
    }
}

@_cdecl("am_temporal_scaler_set_textures")
public func am_temporal_scaler_set_textures(
    _ handle: UnsafeMutableRawPointer?,
    _ colorTextureHandle: UnsafeMutableRawPointer?,
    _ depthTextureHandle: UnsafeMutableRawPointer?,
    _ motionTextureHandle: UnsafeMutableRawPointer?,
    _ outputTextureHandle: UnsafeMutableRawPointer?,
    _ exposureTextureHandle: UnsafeMutableRawPointer?,
    _ reactiveMaskTextureHandle: UnsafeMutableRawPointer?,
    _ fenceHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 13.0, *),
          let scaler: MTLFXTemporalScaler = am_borrow(handle),
          let colorTexture: MTLTexture = am_borrow(colorTextureHandle),
          let depthTexture: MTLTexture = am_borrow(depthTextureHandle),
          let motionTexture: MTLTexture = am_borrow(motionTextureHandle),
          let outputTexture: MTLTexture = am_borrow(outputTextureHandle)
    else { return }

    scaler.colorTexture = colorTexture
    scaler.depthTexture = depthTexture
    scaler.motionTexture = motionTexture
    scaler.outputTexture = outputTexture
    scaler.exposureTexture = am_borrow(exposureTextureHandle)
    if #available(macOS 14.4, *) {
        scaler.reactiveMaskTexture = am_borrow(reactiveMaskTextureHandle)
    }
    scaler.fence = am_borrow(fenceHandle)
}

@_cdecl("am_temporal_scaler_set_frame_state")
public func am_temporal_scaler_set_frame_state(
    _ handle: UnsafeMutableRawPointer?,
    _ inputContentWidth: Int,
    _ inputContentHeight: Int,
    _ preExposure: Float,
    _ jitterOffsetX: Float,
    _ jitterOffsetY: Float,
    _ motionVectorScaleX: Float,
    _ motionVectorScaleY: Float,
    _ reset: Bool,
    _ depthReversed: Bool
) {
    guard #available(macOS 13.0, *), let scaler: MTLFXTemporalScaler = am_borrow(handle) else {
        return
    }

    scaler.inputContentWidth = inputContentWidth
    scaler.inputContentHeight = inputContentHeight
    scaler.preExposure = preExposure
    scaler.jitterOffsetX = jitterOffsetX
    scaler.jitterOffsetY = jitterOffsetY
    scaler.motionVectorScaleX = motionVectorScaleX
    scaler.motionVectorScaleY = motionVectorScaleY
    scaler.reset = reset
    scaler.isDepthReversed = depthReversed
}

@_cdecl("am_temporal_scaler_encode")
public func am_temporal_scaler_encode(
    _ handle: UnsafeMutableRawPointer?,
    _ commandBufferHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 13.0, *),
          let scaler: MTLFXTemporalScaler = am_borrow(handle),
          let commandBuffer: MTLCommandBuffer = am_borrow(commandBufferHandle)
    else { return }
    scaler.encode(commandBuffer: commandBuffer)
}
