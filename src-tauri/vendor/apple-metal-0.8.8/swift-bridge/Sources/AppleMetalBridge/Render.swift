import Foundation
import Metal

@_cdecl("am_device_new_render_pipeline_state")
public func am_device_new_render_pipeline_state(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ vertexHandle: UnsafeMutableRawPointer?,
    _ fragmentHandle: UnsafeMutableRawPointer?,
    _ colorPixelFormat: Int,
    _ sampleCount: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle),
          let vertex: MTLFunction = am_borrow(vertexHandle),
          let fragment: MTLFunction = am_borrow(fragmentHandle)
    else { return nil }

    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = vertex
    descriptor.fragmentFunction = fragment
    descriptor.colorAttachments[0].pixelFormat = MTLPixelFormat(rawValue: UInt(colorPixelFormat)) ?? .invalid
    descriptor.sampleCount = sampleCount

    do {
        let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        return am_retain(pipeline as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}
