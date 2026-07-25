import Foundation
import Metal

@_cdecl("am_device_name")
public func am_device_name(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>? {
    guard let device: MTLDevice = am_borrow(handle) else { return nil }
    return am_copy_string(device.name)
}

@_cdecl("am_device_registry_id")
public func am_device_registry_id(_ handle: UnsafeMutableRawPointer?) -> UInt64 {
    guard let device: MTLDevice = am_borrow(handle) else { return 0 }
    return device.registryID
}

@_cdecl("am_device_supports_dynamic_libraries")
public func am_device_supports_dynamic_libraries(_ handle: UnsafeMutableRawPointer?) -> Bool {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return false }
    return device.supportsDynamicLibraries
}

@_cdecl("am_device_supports_render_dynamic_libraries")
public func am_device_supports_render_dynamic_libraries(_ handle: UnsafeMutableRawPointer?) -> Bool {
    guard #available(macOS 12.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return false }
    return device.supportsRenderDynamicLibraries
}

@_cdecl("am_device_supports_raytracing")
public func am_device_supports_raytracing(_ handle: UnsafeMutableRawPointer?) -> Bool {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return false }
    return device.supportsRaytracing
}

@_cdecl("am_device_supports_counter_sampling")
public func am_device_supports_counter_sampling(
    _ handle: UnsafeMutableRawPointer?,
    _ samplingPoint: Int
) -> Bool {
    guard #available(macOS 10.15, *),
          let device: MTLDevice = am_borrow(handle),
          let point = MTLCounterSamplingPoint(rawValue: UInt(samplingPoint))
    else { return false }
    return device.supportsCounterSampling(point)
}

@_cdecl("am_device_counter_set_count")
public func am_device_counter_set_count(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard #available(macOS 10.15, *),
          let device: MTLDevice = am_borrow(handle),
          let counterSets = device.counterSets
    else { return 0 }
    return counterSets.count
}

@_cdecl("am_device_counter_set_name_at")
public func am_device_counter_set_name_at(
    _ handle: UnsafeMutableRawPointer?,
    _ index: Int
) -> UnsafeMutablePointer<CChar>? {
    guard #available(macOS 10.15, *),
          let device: MTLDevice = am_borrow(handle),
          let counterSets = device.counterSets,
          index >= 0,
          index < counterSets.count
    else { return nil }
    return am_copy_string(counterSets[index].name)
}

@_cdecl("am_device_new_command_queue_with_max_command_buffer_count")
public func am_device_new_command_queue_with_max_command_buffer_count(
    _ handle: UnsafeMutableRawPointer?,
    _ maxCommandBufferCount: Int
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(handle),
          let queue = device.makeCommandQueue(maxCommandBufferCount: maxCommandBufferCount)
    else { return nil }
    return am_retain(queue as AnyObject)
}

@available(macOS 15.0, *)
@_cdecl("am_device_new_command_queue_with_log_state")
public func am_device_new_command_queue_with_log_state(
    _ handle: UnsafeMutableRawPointer?,
    _ maxCommandBufferCount: Int,
    _ logStateHandle: UnsafeMutableRawPointer?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 15.0, *),
          let device: MTLDevice = am_borrow(handle),
          let logState: MTLLogState = am_borrow(logStateHandle)
    else { return nil }

    let descriptor = MTLCommandQueueDescriptor()
    descriptor.maxCommandBufferCount = maxCommandBufferCount
    descriptor.logState = logState
    guard let queue = device.makeCommandQueue(descriptor: descriptor) else {
        return nil
    }
    return am_retain(queue as AnyObject)
}

@_cdecl("am_device_new_heap")
public func am_device_new_heap(
    _ handle: UnsafeMutableRawPointer?,
    _ size: Int,
    _ storageMode: Int
) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(handle) else { return nil }
    let descriptor = MTLHeapDescriptor()
    descriptor.size = size
    descriptor.storageMode = MTLStorageMode(rawValue: UInt(storageMode)) ?? .shared
    guard let heap = device.makeHeap(descriptor: descriptor) else { return nil }
    return am_retain(heap as AnyObject)
}

@_cdecl("am_device_new_fence")
public func am_device_new_fence(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(handle),
          let fence = device.makeFence()
    else { return nil }
    return am_retain(fence as AnyObject)
}

@_cdecl("am_device_new_shared_event")
public func am_device_new_shared_event(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
    guard let device: MTLDevice = am_borrow(handle),
          let event = device.makeSharedEvent()
    else { return nil }
    return am_retain(event as AnyObject)
}

@_cdecl("am_device_new_dynamic_library_with_source")
public func am_device_new_dynamic_library_with_source(
    _ handle: UnsafeMutableRawPointer?,
    _ source: UnsafePointer<CChar>?,
    _ installName: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle),
          let source,
          let installName
    else { return nil }

    let options = MTLCompileOptions()
    options.libraryType = .dynamic
    options.installName = String(cString: installName)

    do {
        let library = try device.makeLibrary(source: String(cString: source), options: options)
        let dynamicLibrary = try device.makeDynamicLibrary(library: library)
        return am_retain(dynamicLibrary as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@_cdecl("am_device_new_dynamic_library_with_url")
public func am_device_new_dynamic_library_with_url(
    _ handle: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle),
          let url = am_url(from: path)
    else { return nil }

    do {
        let dynamicLibrary = try device.makeDynamicLibrary(url: url)
        return am_retain(dynamicLibrary as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@_cdecl("am_device_new_binary_archive")
public func am_device_new_binary_archive(
    _ handle: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return nil }

    let descriptor = MTLBinaryArchiveDescriptor()
    descriptor.url = am_url(from: path)

    do {
        let archive = try device.makeBinaryArchive(descriptor: descriptor)
        return am_retain(archive as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@_cdecl("am_device_new_indirect_command_buffer")
public func am_device_new_indirect_command_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ commandTypes: UInt,
    _ maxCommandCount: Int,
    _ maxVertexBufferBindCount: Int,
    _ maxFragmentBufferBindCount: Int,
    _ maxKernelBufferBindCount: Int,
    _ options: UInt
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 10.14, *),
          let device: MTLDevice = am_borrow(handle)
    else { return nil }

    let descriptor = MTLIndirectCommandBufferDescriptor()
    descriptor.commandTypes = MTLIndirectCommandType(rawValue: commandTypes)
    descriptor.inheritBuffers = false
    descriptor.inheritPipelineState = false
    descriptor.maxVertexBufferBindCount = maxVertexBufferBindCount
    descriptor.maxFragmentBufferBindCount = maxFragmentBufferBindCount
    if #available(macOS 11.0, *) {
        descriptor.maxKernelBufferBindCount = maxKernelBufferBindCount
    }

    guard let buffer = device.makeIndirectCommandBuffer(
        descriptor: descriptor,
        maxCommandCount: maxCommandCount,
        options: MTLResourceOptions(rawValue: options)
    ) else {
        return nil
    }
    return am_retain(buffer as AnyObject)
}

@_cdecl("am_device_new_acceleration_structure_with_size")
public func am_device_new_acceleration_structure_with_size(
    _ handle: UnsafeMutableRawPointer?,
    _ size: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let device: MTLDevice = am_borrow(handle),
          let accelerationStructure = device.makeAccelerationStructure(size: size)
    else { return nil }
    return am_retain(accelerationStructure as AnyObject)
}

@_cdecl("am_device_new_counter_sample_buffer")
public func am_device_new_counter_sample_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ counterSetName: UnsafePointer<CChar>?,
    _ sampleCount: Int,
    _ storageMode: Int,
    _ label: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 10.15, *),
          let device: MTLDevice = am_borrow(handle),
          let counterSetName
    else { return nil }

    let name = String(cString: counterSetName)
    let counterSets = device.counterSets ?? []
    guard let counterSet = counterSets.first(where: { $0.name == name }) else {
        am_store_error_message(outErrorMessage, "Unknown MTLCounterSet '\(name)'")
        return nil
    }

    let descriptor = MTLCounterSampleBufferDescriptor()
    descriptor.counterSet = counterSet
    descriptor.sampleCount = sampleCount
    descriptor.storageMode = MTLStorageMode(rawValue: UInt(storageMode)) ?? .shared
    if let label {
        descriptor.label = String(cString: label)
    }

    do {
        let sampleBuffer = try device.makeCounterSampleBuffer(descriptor: descriptor)
        return am_retain(sampleBuffer as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@available(macOS 15.0, *)
@_cdecl("am_device_new_log_state")
public func am_device_new_log_state(
    _ handle: UnsafeMutableRawPointer?,
    _ level: UInt,
    _ bufferSize: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 15.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return nil }

    let descriptor = MTLLogStateDescriptor()
    descriptor.level = MTLLogLevel(rawValue: Int(level)) ?? .undefined
    descriptor.bufferSize = bufferSize

    do {
        let logState = try device.makeLogState(descriptor: descriptor)
        return am_retain(logState as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@available(macOS 15.0, *)
@_cdecl("am_device_new_residency_set")
public func am_device_new_residency_set(
    _ handle: UnsafeMutableRawPointer?,
    _ label: UnsafePointer<CChar>?,
    _ initialCapacity: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 15.0, *),
          let device: MTLDevice = am_borrow(handle)
    else { return nil }

    let descriptor = MTLResidencySetDescriptor()
    descriptor.initialCapacity = initialCapacity
    if let label {
        descriptor.label = String(cString: label)
    }

    do {
        let residencySet = try device.makeResidencySet(descriptor: descriptor)
        return am_retain(residencySet as AnyObject)
    } catch {
        am_store_error(outErrorMessage, error)
        return nil
    }
}

@available(macOS 15.0, *)
@_cdecl("am_command_queue_add_residency_set")
public func am_command_queue_add_residency_set(
    _ handle: UnsafeMutableRawPointer?,
    _ residencySetHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let queue: MTLCommandQueue = am_borrow(handle),
          let residencySet: MTLResidencySet = am_borrow(residencySetHandle)
    else { return }
    queue.addResidencySet(residencySet)
}

@available(macOS 15.0, *)
@_cdecl("am_command_queue_remove_residency_set")
public func am_command_queue_remove_residency_set(
    _ handle: UnsafeMutableRawPointer?,
    _ residencySetHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let queue: MTLCommandQueue = am_borrow(handle),
          let residencySet: MTLResidencySet = am_borrow(residencySetHandle)
    else { return }
    queue.removeResidencySet(residencySet)
}

@_cdecl("am_buffer_did_modify_range")
public func am_buffer_did_modify_range(
    _ handle: UnsafeMutableRawPointer?,
    _ location: Int,
    _ length: Int
) {
    guard let buffer: MTLBuffer = am_borrow(handle) else { return }
    buffer.didModifyRange(location..<(location + length))
}

@_cdecl("am_buffer_new_texture_view_2d")
public func am_buffer_new_texture_view_2d(
    _ handle: UnsafeMutableRawPointer?,
    _ pixelFormat: Int,
    _ width: Int,
    _ height: Int,
    _ bytesPerRow: Int,
    _ offset: Int
) -> UnsafeMutableRawPointer? {
    guard let buffer: MTLBuffer = am_borrow(handle) else { return nil }
    let descriptor = am_make_texture_descriptor(
        pixelFormat: pixelFormat,
        width: width,
        height: height,
        mipmapped: false,
        usage: Int(MTLTextureUsage.shaderRead.rawValue | MTLTextureUsage.shaderWrite.rawValue),
        storageMode: Int(MTLStorageMode.shared.rawValue)
    )
    guard let texture = buffer.makeTexture(descriptor: descriptor, offset: offset, bytesPerRow: bytesPerRow) else {
        return nil
    }
    return am_retain(texture as AnyObject)
}

@_cdecl("am_texture_depth")
public func am_texture_depth(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let texture: MTLTexture = am_borrow(handle) else { return 0 }
    return texture.depth
}

@_cdecl("am_texture_mipmap_level_count")
public func am_texture_mipmap_level_count(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let texture: MTLTexture = am_borrow(handle) else { return 0 }
    return texture.mipmapLevelCount
}

@_cdecl("am_texture_array_length")
public func am_texture_array_length(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let texture: MTLTexture = am_borrow(handle) else { return 0 }
    return texture.arrayLength
}

@_cdecl("am_texture_usage")
public func am_texture_usage(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let texture: MTLTexture = am_borrow(handle) else { return 0 }
    return Int(texture.usage.rawValue)
}

@_cdecl("am_texture_storage_mode")
public func am_texture_storage_mode(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let texture: MTLTexture = am_borrow(handle) else { return 0 }
    return Int(texture.storageMode.rawValue)
}

@_cdecl("am_texture_replace_region_2d")
public func am_texture_replace_region_2d(
    _ handle: UnsafeMutableRawPointer?,
    _ x: Int,
    _ y: Int,
    _ width: Int,
    _ height: Int,
    _ mipmapLevel: Int,
    _ bytes: UnsafePointer<UInt8>?,
    _ bytesPerRow: Int
) -> Bool {
    guard let texture: MTLTexture = am_borrow(handle),
          let bytes
    else { return false }
    let region = MTLRegionMake2D(x, y, width, height)
    texture.replace(region: region, mipmapLevel: mipmapLevel, withBytes: bytes, bytesPerRow: bytesPerRow)
    return true
}

@_cdecl("am_texture_get_bytes_2d")
public func am_texture_get_bytes_2d(
    _ handle: UnsafeMutableRawPointer?,
    _ outBytes: UnsafeMutablePointer<UInt8>?,
    _ outLen: Int,
    _ bytesPerRow: Int,
    _ x: Int,
    _ y: Int,
    _ width: Int,
    _ height: Int,
    _ mipmapLevel: Int
) -> Bool {
    guard let texture: MTLTexture = am_borrow(handle),
          let outBytes
    else { return false }
    let required = bytesPerRow * height
    guard outLen >= required else { return false }
    let region = MTLRegionMake2D(x, y, width, height)
    texture.getBytes(outBytes, bytesPerRow: bytesPerRow, from: region, mipmapLevel: mipmapLevel)
    return true
}

@_cdecl("am_texture_new_view")
public func am_texture_new_view(
    _ handle: UnsafeMutableRawPointer?,
    _ pixelFormat: Int
) -> UnsafeMutableRawPointer? {
    guard let texture: MTLTexture = am_borrow(handle),
          let view = texture.makeTextureView(pixelFormat: MTLPixelFormat(rawValue: UInt(pixelFormat)) ?? .invalid)
    else { return nil }
    return am_retain(view as AnyObject)
}

@_cdecl("am_compute_pipeline_state_thread_execution_width")
public func am_compute_pipeline_state_thread_execution_width(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let pipeline: MTLComputePipelineState = am_borrow(handle) else { return 0 }
    return pipeline.threadExecutionWidth
}

@_cdecl("am_compute_pipeline_state_max_total_threads_per_threadgroup")
public func am_compute_pipeline_state_max_total_threads_per_threadgroup(
    _ handle: UnsafeMutableRawPointer?
) -> Int {
    guard let pipeline: MTLComputePipelineState = am_borrow(handle) else { return 0 }
    return pipeline.maxTotalThreadsPerThreadgroup
}

@_cdecl("am_compute_pipeline_state_new_visible_function_table")
public func am_compute_pipeline_state_new_visible_function_table(
    _ handle: UnsafeMutableRawPointer?,
    _ functionCount: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let pipeline: MTLComputePipelineState = am_borrow(handle)
    else { return nil }
    let descriptor = MTLVisibleFunctionTableDescriptor()
    descriptor.functionCount = functionCount
    guard let table = pipeline.makeVisibleFunctionTable(descriptor: descriptor) else { return nil }
    return am_retain(table as AnyObject)
}

@_cdecl("am_compute_pipeline_state_new_intersection_function_table")
public func am_compute_pipeline_state_new_intersection_function_table(
    _ handle: UnsafeMutableRawPointer?,
    _ functionCount: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 11.0, *),
          let pipeline: MTLComputePipelineState = am_borrow(handle)
    else { return nil }
    let descriptor = MTLIntersectionFunctionTableDescriptor()
    descriptor.functionCount = functionCount
    guard let table = pipeline.makeIntersectionFunctionTable(descriptor: descriptor) else { return nil }
    return am_retain(table as AnyObject)
}

@_cdecl("am_function_new_argument_encoder")
public func am_function_new_argument_encoder(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferIndex: Int
) -> UnsafeMutableRawPointer? {
    guard let function: MTLFunction = am_borrow(handle) else { return nil }
    let encoder = function.makeArgumentEncoder(bufferIndex: bufferIndex)
    return am_retain(encoder as AnyObject)
}

@_cdecl("am_heap_size")
public func am_heap_size(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let heap: MTLHeap = am_borrow(handle) else { return 0 }
    return heap.size
}

@_cdecl("am_heap_used_size")
public func am_heap_used_size(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let heap: MTLHeap = am_borrow(handle) else { return 0 }
    return heap.usedSize
}

@_cdecl("am_heap_current_allocated_size")
public func am_heap_current_allocated_size(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let heap: MTLHeap = am_borrow(handle) else { return 0 }
    return heap.currentAllocatedSize
}

@_cdecl("am_heap_max_available_size")
public func am_heap_max_available_size(_ handle: UnsafeMutableRawPointer?, _ alignment: Int) -> Int {
    guard let heap: MTLHeap = am_borrow(handle) else { return 0 }
    return heap.maxAvailableSize(alignment: alignment)
}

@_cdecl("am_heap_new_buffer")
public func am_heap_new_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ length: Int,
    _ options: UInt
) -> UnsafeMutableRawPointer? {
    guard let heap: MTLHeap = am_borrow(handle),
          let buffer = heap.makeBuffer(length: length, options: MTLResourceOptions(rawValue: options))
    else { return nil }
    return am_retain(buffer as AnyObject)
}

@_cdecl("am_heap_new_texture_2d")
public func am_heap_new_texture_2d(
    _ handle: UnsafeMutableRawPointer?,
    _ pixelFormat: Int,
    _ width: Int,
    _ height: Int,
    _ mipmapped: Bool,
    _ usage: Int,
    _ storageMode: Int
) -> UnsafeMutableRawPointer? {
    guard let heap: MTLHeap = am_borrow(handle) else { return nil }
    let descriptor = am_make_texture_descriptor(
        pixelFormat: pixelFormat,
        width: width,
        height: height,
        mipmapped: mipmapped,
        usage: usage,
        storageMode: storageMode
    )
    guard let texture = heap.makeTexture(descriptor: descriptor) else { return nil }
    return am_retain(texture as AnyObject)
}

@_cdecl("am_heap_new_acceleration_structure_with_size")
public func am_heap_new_acceleration_structure_with_size(
    _ handle: UnsafeMutableRawPointer?,
    _ size: Int
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 13.0, *),
          let heap: MTLHeap = am_borrow(handle),
          let accelerationStructure = heap.makeAccelerationStructure(size: size)
    else { return nil }
    return am_retain(accelerationStructure as AnyObject)
}

@_cdecl("am_heap_set_purgeable_state")
public func am_heap_set_purgeable_state(_ handle: UnsafeMutableRawPointer?, _ state: UInt) -> UInt {
    guard let heap: MTLHeap = am_borrow(handle) else { return 0 }
    return heap.setPurgeableState(MTLPurgeableState(rawValue: state) ?? .keepCurrent).rawValue
}

@_cdecl("am_event_signaled_value")
public func am_event_signaled_value(_ handle: UnsafeMutableRawPointer?) -> UInt64 {
    guard let event: MTLSharedEvent = am_borrow(handle) else { return 0 }
    return event.signaledValue
}

@_cdecl("am_event_set_signaled_value")
public func am_event_set_signaled_value(_ handle: UnsafeMutableRawPointer?, _ value: UInt64) {
    guard let event: MTLSharedEvent = am_borrow(handle) else { return }
    event.signaledValue = value
}

@_cdecl("am_event_wait_until_signaled_value")
public func am_event_wait_until_signaled_value(
    _ handle: UnsafeMutableRawPointer?,
    _ value: UInt64,
    _ timeoutMs: UInt64
) -> Bool {
    guard #available(macOS 12.0, *),
          let event: MTLSharedEvent = am_borrow(handle)
    else { return false }
    return event.wait(untilSignaledValue: value, timeoutMS: timeoutMs)
}

@_cdecl("am_dynamic_library_install_name")
public func am_dynamic_library_install_name(_ handle: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>? {
    guard #available(macOS 11.0, *),
          let dynamicLibrary: MTLDynamicLibrary = am_borrow(handle)
    else { return nil }
    return am_copy_string(dynamicLibrary.installName)
}

@_cdecl("am_dynamic_library_serialize_to_url")
public func am_dynamic_library_serialize_to_url(
    _ handle: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    guard #available(macOS 11.0, *),
          let dynamicLibrary: MTLDynamicLibrary = am_borrow(handle),
          let url = am_url(from: path)
    else { return false }
    do {
        try dynamicLibrary.serialize(to: url)
        return true
    } catch {
        am_store_error(outErrorMessage, error)
        return false
    }
}

@_cdecl("am_binary_archive_add_compute_function")
public func am_binary_archive_add_compute_function(
    _ handle: UnsafeMutableRawPointer?,
    _ functionHandle: UnsafeMutableRawPointer?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    guard #available(macOS 11.0, *),
          let archive: MTLBinaryArchive = am_borrow(handle),
          let function: MTLFunction = am_borrow(functionHandle)
    else { return false }

    let descriptor = MTLComputePipelineDescriptor()
    descriptor.computeFunction = function
    do {
        try archive.addComputePipelineFunctions(descriptor: descriptor)
        return true
    } catch {
        am_store_error(outErrorMessage, error)
        return false
    }
}

@_cdecl("am_binary_archive_add_render_functions")
public func am_binary_archive_add_render_functions(
    _ handle: UnsafeMutableRawPointer?,
    _ vertexHandle: UnsafeMutableRawPointer?,
    _ fragmentHandle: UnsafeMutableRawPointer?,
    _ colorPixelFormat: Int,
    _ sampleCount: Int,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    guard #available(macOS 11.0, *),
          let archive: MTLBinaryArchive = am_borrow(handle),
          let vertex: MTLFunction = am_borrow(vertexHandle),
          let fragment: MTLFunction = am_borrow(fragmentHandle)
    else { return false }

    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = vertex
    descriptor.fragmentFunction = fragment
    descriptor.colorAttachments[0].pixelFormat = MTLPixelFormat(rawValue: UInt(colorPixelFormat)) ?? .invalid
    descriptor.sampleCount = sampleCount

    do {
        try archive.addRenderPipelineFunctions(descriptor: descriptor)
        return true
    } catch {
        am_store_error(outErrorMessage, error)
        return false
    }
}

@_cdecl("am_binary_archive_serialize_to_url")
public func am_binary_archive_serialize_to_url(
    _ handle: UnsafeMutableRawPointer?,
    _ path: UnsafePointer<CChar>?,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Bool {
    guard #available(macOS 11.0, *),
          let archive: MTLBinaryArchive = am_borrow(handle),
          let url = am_url(from: path)
    else { return false }
    do {
        try archive.serialize(to: url)
        return true
    } catch {
        am_store_error(outErrorMessage, error)
        return false
    }
}

@_cdecl("am_argument_encoder_encoded_length")
public func am_argument_encoder_encoded_length(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle) else { return 0 }
    return encoder.encodedLength
}

@_cdecl("am_argument_encoder_alignment")
public func am_argument_encoder_alignment(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle) else { return 0 }
    return encoder.alignment
}

@_cdecl("am_argument_encoder_set_argument_buffer")
public func am_argument_encoder_set_argument_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferHandle: UnsafeMutableRawPointer?,
    _ offset: Int
) {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle),
          let buffer: MTLBuffer = am_borrow(bufferHandle)
    else { return }
    encoder.setArgumentBuffer(buffer, offset: offset)
}

@_cdecl("am_argument_encoder_set_buffer")
public func am_argument_encoder_set_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferHandle: UnsafeMutableRawPointer?,
    _ offset: Int,
    _ index: Int
) {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle),
          let buffer: MTLBuffer = am_borrow(bufferHandle)
    else { return }
    encoder.setBuffer(buffer, offset: offset, index: index)
}

@_cdecl("am_argument_encoder_set_texture")
public func am_argument_encoder_set_texture(
    _ handle: UnsafeMutableRawPointer?,
    _ textureHandle: UnsafeMutableRawPointer?,
    _ index: Int
) {
    guard let encoder: MTLArgumentEncoder = am_borrow(handle),
          let texture: MTLTexture = am_borrow(textureHandle)
    else { return }
    encoder.setTexture(texture, index: index)
}

@_cdecl("am_indirect_command_buffer_size")
public func am_indirect_command_buffer_size(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let buffer: MTLIndirectCommandBuffer = am_borrow(handle) else { return 0 }
    return buffer.size
}

@_cdecl("am_indirect_command_buffer_reset_range")
public func am_indirect_command_buffer_reset_range(
    _ handle: UnsafeMutableRawPointer?,
    _ location: Int,
    _ length: Int
) {
    guard let buffer: MTLIndirectCommandBuffer = am_borrow(handle) else { return }
    buffer.reset(location..<(location + length))
}

@_cdecl("am_acceleration_structure_size")
public func am_acceleration_structure_size(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let accelerationStructure: MTLAccelerationStructure = am_borrow(handle) else { return 0 }
    return accelerationStructure.size
}

@_cdecl("am_intersection_function_table_set_opaque_triangle")
public func am_intersection_function_table_set_opaque_triangle(
    _ handle: UnsafeMutableRawPointer?,
    _ signature: UInt,
    _ index: Int
) {
    guard #available(macOS 11.0, *),
          let table: MTLIntersectionFunctionTable = am_borrow(handle)
    else { return }
    table.setOpaqueTriangleIntersectionFunction(
        signature: MTLIntersectionFunctionSignature(rawValue: signature),
        index: index
    )
}

@_cdecl("am_counter_sample_buffer_sample_count")
public func am_counter_sample_buffer_sample_count(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard let sampleBuffer: MTLCounterSampleBuffer = am_borrow(handle) else { return 0 }
    return sampleBuffer.sampleCount
}

@_cdecl("am_counter_sample_buffer_resolve_range")
public func am_counter_sample_buffer_resolve_range(
    _ handle: UnsafeMutableRawPointer?,
    _ location: Int,
    _ length: Int,
    _ outLen: UnsafeMutablePointer<Int>?
) -> UnsafeMutableRawPointer? {
    guard #available(macOS 10.15, *),
          let sampleBuffer: MTLCounterSampleBuffer = am_borrow(handle)
    else { return nil }
    do {
        guard let data = try sampleBuffer.resolveCounterRange(location..<(location + length)) else {
            return nil
        }
        outLen?.pointee = data.count
        return am_copy_data(data)
    } catch {
        return nil
    }
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_add_buffer")
public func am_residency_set_add_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let buffer: MTLBuffer = am_borrow(bufferHandle)
    else { return }
    residencySet.addAllocation(buffer)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_add_texture")
public func am_residency_set_add_texture(
    _ handle: UnsafeMutableRawPointer?,
    _ textureHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let texture: MTLTexture = am_borrow(textureHandle)
    else { return }
    residencySet.addAllocation(texture)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_add_heap")
public func am_residency_set_add_heap(
    _ handle: UnsafeMutableRawPointer?,
    _ heapHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let heap: MTLHeap = am_borrow(heapHandle)
    else { return }
    residencySet.addAllocation(heap)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_remove_buffer")
public func am_residency_set_remove_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let buffer: MTLBuffer = am_borrow(bufferHandle)
    else { return }
    residencySet.removeAllocation(buffer)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_remove_texture")
public func am_residency_set_remove_texture(
    _ handle: UnsafeMutableRawPointer?,
    _ textureHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let texture: MTLTexture = am_borrow(textureHandle)
    else { return }
    residencySet.removeAllocation(texture)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_remove_heap")
public func am_residency_set_remove_heap(
    _ handle: UnsafeMutableRawPointer?,
    _ heapHandle: UnsafeMutableRawPointer?
) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let heap: MTLHeap = am_borrow(heapHandle)
    else { return }
    residencySet.removeAllocation(heap)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_remove_all_allocations")
public func am_residency_set_remove_all_allocations(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle)
    else { return }
    residencySet.removeAllAllocations()
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_contains_buffer")
public func am_residency_set_contains_buffer(
    _ handle: UnsafeMutableRawPointer?,
    _ bufferHandle: UnsafeMutableRawPointer?
) -> Bool {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let buffer: MTLBuffer = am_borrow(bufferHandle)
    else { return false }
    return residencySet.containsAllocation(buffer)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_contains_texture")
public func am_residency_set_contains_texture(
    _ handle: UnsafeMutableRawPointer?,
    _ textureHandle: UnsafeMutableRawPointer?
) -> Bool {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle),
          let texture: MTLTexture = am_borrow(textureHandle)
    else { return false }
    return residencySet.containsAllocation(texture)
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_allocation_count")
public func am_residency_set_allocation_count(_ handle: UnsafeMutableRawPointer?) -> Int {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle)
    else { return 0 }
    return residencySet.allocationCount
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_commit")
public func am_residency_set_commit(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle)
    else { return }
    residencySet.commit()
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_request_residency")
public func am_residency_set_request_residency(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle)
    else { return }
    residencySet.requestResidency()
}

@available(macOS 15.0, *)
@_cdecl("am_residency_set_end_residency")
public func am_residency_set_end_residency(_ handle: UnsafeMutableRawPointer?) {
    guard #available(macOS 15.0, *),
          let residencySet: MTLResidencySet = am_borrow(handle)
    else { return }
    residencySet.endResidency()
}

@_cdecl("am_capture_manager_shared")
public func am_capture_manager_shared() -> UnsafeMutableRawPointer? {
    return am_retain(MTLCaptureManager.shared() as AnyObject)
}

@_cdecl("am_capture_manager_supports_destination")
public func am_capture_manager_supports_destination(
    _ handle: UnsafeMutableRawPointer?,
    _ destination: UInt
) -> Bool {
    guard #available(macOS 10.15, *),
          let manager: MTLCaptureManager = am_borrow(handle),
          let destination = MTLCaptureDestination(rawValue: Int(destination))
    else { return false }
    return manager.supportsDestination(destination)
}

@_cdecl("am_capture_manager_is_capturing")
public func am_capture_manager_is_capturing(_ handle: UnsafeMutableRawPointer?) -> Bool {
    guard let manager: MTLCaptureManager = am_borrow(handle) else { return false }
    return manager.isCapturing
}

@_cdecl("am_capture_manager_new_scope_with_device")
public func am_capture_manager_new_scope_with_device(
    _ handle: UnsafeMutableRawPointer?,
    _ deviceHandle: UnsafeMutableRawPointer?
) -> UnsafeMutableRawPointer? {
    guard let manager: MTLCaptureManager = am_borrow(handle),
          let device: MTLDevice = am_borrow(deviceHandle)
    else { return nil }
    return am_retain(manager.makeCaptureScope(device: device) as AnyObject)
}

@_cdecl("am_capture_manager_new_scope_with_command_queue")
public func am_capture_manager_new_scope_with_command_queue(
    _ handle: UnsafeMutableRawPointer?,
    _ queueHandle: UnsafeMutableRawPointer?
) -> UnsafeMutableRawPointer? {
    guard let manager: MTLCaptureManager = am_borrow(handle),
          let queue: MTLCommandQueue = am_borrow(queueHandle)
    else { return nil }
    return am_retain(manager.makeCaptureScope(commandQueue: queue) as AnyObject)
}

@_cdecl("am_capture_scope_begin")
public func am_capture_scope_begin(_ handle: UnsafeMutableRawPointer?) {
    guard let scope: MTLCaptureScope = am_borrow(handle) else { return }
    scope.begin()
}

@_cdecl("am_capture_scope_end")
public func am_capture_scope_end(_ handle: UnsafeMutableRawPointer?) {
    guard let scope: MTLCaptureScope = am_borrow(handle) else { return }
    scope.end()
}
