import Foundation
import Metal

private let am_render_color_attachment_stride = 9

private func am_string(from value: UnsafePointer<CChar>?) -> String? {
    guard let value else { return nil }
    return String(cString: value)
}

private func am_apply_render_color_attachments(
    _ raw: UnsafePointer<UInt>?,
    count: Int,
    to attachments: MTLRenderPipelineColorAttachmentDescriptorArray
) {
    guard let raw else { return }

    for attachmentIndex in 0..<count {
        let base = attachmentIndex * am_render_color_attachment_stride
        let attachment = MTLRenderPipelineColorAttachmentDescriptor()
        attachment.pixelFormat = MTLPixelFormat(rawValue: raw[base]) ?? .invalid
        attachment.isBlendingEnabled = raw[base + 1] != 0
        attachment.sourceRGBBlendFactor = MTLBlendFactor(rawValue: raw[base + 2]) ?? MTLBlendFactor(rawValue: 1)!
        attachment.destinationRGBBlendFactor = MTLBlendFactor(rawValue: raw[base + 3]) ?? MTLBlendFactor(rawValue: 0)!
        attachment.rgbBlendOperation = MTLBlendOperation(rawValue: raw[base + 4]) ?? MTLBlendOperation(rawValue: 0)!
        attachment.sourceAlphaBlendFactor = MTLBlendFactor(rawValue: raw[base + 5]) ?? MTLBlendFactor(rawValue: 1)!
        attachment.destinationAlphaBlendFactor = MTLBlendFactor(rawValue: raw[base + 6]) ?? MTLBlendFactor(rawValue: 0)!
        attachment.alphaBlendOperation = MTLBlendOperation(rawValue: raw[base + 7]) ?? MTLBlendOperation(rawValue: 0)!
        attachment.writeMask = MTLColorWriteMask(rawValue: raw[base + 8])
        attachments[attachmentIndex] = attachment
    }
}

private func am_apply_tile_color_attachments(
    _ raw: UnsafePointer<UInt>?,
    count: Int,
    to attachments: MTLTileRenderPipelineColorAttachmentDescriptorArray
) {
    guard let raw else { return }

    for attachmentIndex in 0..<count {
        let attachment = MTLTileRenderPipelineColorAttachmentDescriptor()
        attachment.pixelFormat = MTLPixelFormat(rawValue: raw[attachmentIndex]) ?? .invalid
        attachments[attachmentIndex] = attachment
    }
}

@_cdecl("am_device_new_compute_pipeline_state_with_descriptor")
public func am_device_new_compute_pipeline_state_with_descriptor(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ functionHandle: UnsafeMutableRawPointer?,
    _ label: UnsafePointer<CChar>?,
    _ threadGroupSizeIsMultipleOfThreadExecutionWidth: Bool,
    _ maxTotalThreadsPerThreadgroup: Int,
    _ supportIndirectCommandBuffers: Bool,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle),
          let function: MTLFunction = am_borrow(functionHandle)
    else { return nil }

    let descriptor = MTLComputePipelineDescriptor()
    if let label = am_string(from: label) {
        descriptor.label = label
    }
    descriptor.computeFunction = function
    descriptor.threadGroupSizeIsMultipleOfThreadExecutionWidth = threadGroupSizeIsMultipleOfThreadExecutionWidth
    if maxTotalThreadsPerThreadgroup > 0 {
        descriptor.maxTotalThreadsPerThreadgroup = maxTotalThreadsPerThreadgroup
    }
    descriptor.supportIndirectCommandBuffers = supportIndirectCommandBuffers

    do {
        var reflection: MTLAutoreleasedComputePipelineReflection?
        let pipeline = try device.makeComputePipelineState(
            descriptor: descriptor,
            options: [],
            reflection: &reflection
        )
        return am_retain(pipeline as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@_cdecl("am_device_new_render_pipeline_state_with_descriptor")
public func am_device_new_render_pipeline_state_with_descriptor(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ vertexHandle: UnsafeMutableRawPointer?,
    _ fragmentHandle: UnsafeMutableRawPointer?,
    _ label: UnsafePointer<CChar>?,
    _ rasterSampleCount: Int,
    _ alphaToCoverageEnabled: Bool,
    _ alphaToOneEnabled: Bool,
    _ rasterizationEnabled: Bool,
    _ supportIndirectCommandBuffers: Bool,
    _ depthAttachmentPixelFormat: Int,
    _ stencilAttachmentPixelFormat: Int,
    _ colorAttachments: UnsafePointer<UInt>?,
    _ colorAttachmentCount: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle),
          let vertex: MTLFunction = am_borrow(vertexHandle)
    else { return nil }

    let fragment: MTLFunction? = am_borrow(fragmentHandle)
    let descriptor = MTLRenderPipelineDescriptor()
    if let label = am_string(from: label) {
        descriptor.label = label
    }
    descriptor.vertexFunction = vertex
    descriptor.fragmentFunction = fragment
    descriptor.rasterSampleCount = max(1, rasterSampleCount)
    descriptor.isAlphaToCoverageEnabled = alphaToCoverageEnabled
    descriptor.isAlphaToOneEnabled = alphaToOneEnabled
    descriptor.isRasterizationEnabled = rasterizationEnabled
    descriptor.supportIndirectCommandBuffers = supportIndirectCommandBuffers
    descriptor.depthAttachmentPixelFormat = MTLPixelFormat(rawValue: UInt(depthAttachmentPixelFormat)) ?? .invalid
    descriptor.stencilAttachmentPixelFormat = MTLPixelFormat(rawValue: UInt(stencilAttachmentPixelFormat)) ?? .invalid
    am_apply_render_color_attachments(colorAttachments, count: colorAttachmentCount, to: descriptor.colorAttachments)

    do {
        let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        return am_retain(pipeline as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@_cdecl("am_device_new_tile_render_pipeline_state")
public func am_device_new_tile_render_pipeline_state(
    _ deviceHandle: UnsafeMutableRawPointer?,
    _ tileFunctionHandle: UnsafeMutableRawPointer?,
    _ label: UnsafePointer<CChar>?,
    _ rasterSampleCount: Int,
    _ threadgroupSizeMatchesTileSize: Bool,
    _ maxTotalThreadsPerThreadgroup: Int,
    _ colorAttachments: UnsafePointer<UInt>?,
    _ colorAttachmentCount: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(deviceHandle),
          let tileFunction: MTLFunction = am_borrow(tileFunctionHandle)
    else { return nil }

    let descriptor = MTLTileRenderPipelineDescriptor()
    if let label = am_string(from: label) {
        descriptor.label = label
    }
    descriptor.tileFunction = tileFunction
    descriptor.rasterSampleCount = max(1, rasterSampleCount)
    descriptor.threadgroupSizeMatchesTileSize = threadgroupSizeMatchesTileSize
    if maxTotalThreadsPerThreadgroup > 0 {
        descriptor.maxTotalThreadsPerThreadgroup = maxTotalThreadsPerThreadgroup
    }
    am_apply_tile_color_attachments(colorAttachments, count: colorAttachmentCount, to: descriptor.colorAttachments)

    do {
        var reflection: MTLAutoreleasedRenderPipelineReflection?
        let pipeline = try device.makeRenderPipelineState(
            tileDescriptor: descriptor,
            options: [],
            reflection: &reflection
        )
        return am_retain(pipeline as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}
