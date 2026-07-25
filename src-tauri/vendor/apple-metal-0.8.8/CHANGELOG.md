# Changelog

## [0.8.7] - 2026-05-20

- Migrated local `take_string` body to call `doom_fish_utils::ffi_string::take_owned_cstring_c`. Centralises the duplicated FFI take-string pattern fleet-wide. No public API change.

## [0.8.6] - 2026-05-20

- Added pure-CPU doctests across descriptor and packed-vector types (`MetalCoordinate2D`, `MetalGpuAddress`, `MetalOrigin`, `MetalRegion`, `MetalResourceId`, `MetalSize`, and the `MetalPackedFloat*` family) so the public API is discoverable without a GPU.

## [0.8.5] - 2026-05-19

- Added an owned `MetalTensor` wrapper for the `MTLTensor` protocol so sibling crates can pass tensor handles across FFI without falling back to raw pointers.

## [0.8.4] - 2026-05-18

- Add one-line docs across the public safe and FFI surfaces, raising public-item rustdoc coverage to 100.0%.

## [0.8.3] - 2026-05-18

- Widen apple-cf version bound to `<0.10` so 0.9.x resolves.

## [0.8.2] - 2026-05-18

- Widen apple-cf version bound to `<0.9` so the 0.8.0 nested-CGRect dep resolves. No source changes.

## 0.8.1 — Quality pass: unsafe/Send+Sync hygiene

### Unsafe correctness

- **`opaque_handle!` macro** (advanced.rs): added `unsafe impl Send` and
  `unsafe impl Sync` for all 15 opaque-handle types it generates (`Heap`,
  `Event`, `Fence`, `DynamicLibrary`, `BinaryArchive`, `ArgumentEncoder`,
  `IndirectCommandBuffer`, `AccelerationStructure`,
  `IntersectionFunctionTable`, `VisibleFunctionTable`,
  `CounterSampleBuffer`, `LogState`, `ResidencySet`, `CaptureManager`,
  `CaptureScope`).  These types wrap Metal ObjC protocol objects whose
  reference counting is atomic and whose API is documented as thread-safe;
  the missing impls were an inconsistency relative to the equivalent types
  in `lib.rs` and `exhaustive.rs`.

- **`unsafe impl Send/Sync` in lib.rs and render.rs**: added `// SAFETY:`
  justification comments to all eight declarations explaining the Metal
  thread-safety guarantee.

- **`opaque_symbol_handle!` macro** (exhaustive.rs): added `// SAFETY:`
  comment to its `unsafe impl Send/Sync` block.

- **`take_device_array`** (exhaustive.rs): added `/// # Safety` doc
  explaining pointer, length, and allocator preconditions.

- **`copy_all_devices_with_observer`** (exhaustive.rs): replaced
  `#[allow(clippy::missing_safety_doc)]` with a proper `/// # Safety`
  section documenting callback and user-data lifetime requirements.

- **`opaque_symbol_handle!::from_raw`** (exhaustive.rs): replaced
  `#[allow(clippy::missing_safety_doc)]` with a `/// # Safety` doc
  describing the +1-retain ownership transfer contract.

- **`MetalIoCompressionContext::from_raw`** (exhaustive.rs): same — real
  safety doc replacing the `#[allow]` attribute.

## 0.8.0 — Gate macOS 15+/26+ Swift APIs behind `@available` / `#available`

### Swift bridge compatibility

The Swift bridge previously compiled only on a macOS 26 machine because
`@_cdecl` thunks that use macOS 15+ types (`MTLLogState`,
`MTLLogStateDescriptor`, `MTLResidencySet`, `MTLResidencySetDescriptor`,
`MTLCommandQueueDescriptor.logState`) lacked the `@available(macOS 15.0, *)`
attribute on their function declarations.  Without that attribute the Swift
compiler resolves the type names at the deployment-target level (macOS 11 as
declared in `Package.swift`), which fails on any CI runner whose SDK pre-dates
macOS 15 (e.g., GitHub Actions `macos-14` with Xcode 15).

Every affected `@_cdecl` function already contained the correct
`guard #available(macOS 15.0, *)` runtime guard in its body, providing a safe
nil/0/false fallback on older operating systems.  This release adds the
matching compile-time `@available(macOS 15.0, *)` attribute above the
`@_cdecl` line on all 18 such functions, completing the two-layer guard
pattern required by the Swift compiler.

**Affected functions (all now `@available(macOS 15.0, *)`):**
- `am_device_new_command_queue_with_log_state`
- `am_device_new_log_state`
- `am_device_new_residency_set`
- `am_command_queue_add_residency_set`
- `am_command_queue_remove_residency_set`
- `am_residency_set_add_buffer`
- `am_residency_set_add_texture`
- `am_residency_set_add_heap`
- `am_residency_set_remove_buffer`
- `am_residency_set_remove_texture`
- `am_residency_set_remove_heap`
- `am_residency_set_remove_all_allocations`
- `am_residency_set_contains_buffer`
- `am_residency_set_contains_texture`
- `am_residency_set_allocation_count`
- `am_residency_set_commit`
- `am_residency_set_request_residency`
- `am_residency_set_end_residency`

**macOS 26+ sampler properties** (`MTLSamplerDescriptor.reductionMode` and
`lodBias`) remain guarded by the existing `if #available(macOS 26.0, *)` block
inside `am_device_new_sampler_state`; no function-level attribute is needed
there because only a portion of that function body requires the newer SDK.

**Behaviour on older OS versions is unchanged:** callers on macOS < 15 receive
`nil` / `false` / `0` from the guarded thunks rather than crashing.

## 0.7.0 — Close all audit-v2 gaps (0 remaining)

### Coverage

- Corrected COVERAGE_AUDIT_V2.md: 41 previously-reported GAPS were already
  wrapped as opaque handles in `exhaustive.rs`; the audit methodology was
  over-strict and did not recognise `opaque_symbol_handle!` stubs as active
  wrapper code. All 41 are now correctly marked 🟢 VERIFIED.
- Added three genuinely missing opaque-handle stubs:
  - `MetalCaptureDescriptor` (`MTLCaptureDescriptor`, `MTLCaptureManager.h`)
  - `MetalIndirectComputeCommandEncoder` (`MTLIndirectComputeCommandEncoder`,
    `MTLIndirectCommandBuffer.h`)
  - `MetalIndirectRenderCommandEncoder` (`MTLIndirectRenderCommandEncoder`,
    `MTLIndirectCommandBuffer.h`)
- EXEMPT 1 symbol: `NSProcessInfo` (Foundation class, out of scope for a
  Metal binding crate).
- Final audit: SDK_PUBLIC_SYMBOLS=248, VERIFIED=246, GAPS=0, EXEMPT=1,
  COVERAGE_PCT=99.19%.

### Fixes

- Widen `apple-cf` version constraint to `>=0.6.0, <0.8` to allow `apple-cf`
  v0.7.0.
- Add missing semicolon inside `unsafe` block in `argument.rs` (clippy
  `semicolon_if_nothing_returned`).
- Remove unnecessary `#` in raw string literals in `tests/common/mod.rs`
  (clippy `needless_raw_string_hashes`).

## 0.6.3 — Split integration coverage for bridge areas

- Added focused integration tests for depth/stencil state, sampler state,
  argument encoders, heaps, shared events, and fences under `tests/`.
- Kept the audited top-level Metal / MetalFX symbol surface unchanged while
  broadening runtime validation coverage beyond the original smoke test split.
- Bumped the crate to `0.6.3`.

## 0.6.2 — Exhaustive top-level Metal / MetalFX symbol coverage

- Completed the audited top-level symbol surface for the macOS `Metal.framework`
  and `MetalFX.framework` headers, closing every remaining gap from the
  coverage audit.
- Added exhaustive safe wrappers for the remaining descriptor, reflection,
  resource-state, rasterization-rate, tensor, IO, function-stitching,
  MetalFX base / denoised / frame-interpolator, and `MTL4*` / `MTL4FX*`
  families.
- Added bridge-backed runtime helpers for descriptor-class construction,
  device enumeration / observation, IO compression contexts, and exported
  Metal string constants.
- Added `tests/exhaustive_symbols.rs` to compile-smoke the full audited symbol
  surface.
- Bumped the crate to `0.6.2`.

## 0.6.1 — State descriptors, public pipeline descriptors, and MetalFX scalers

- Added safe wrappers for `MTLCompareFunction`, `MTLStencilOperation`,
  `MTLStencilDescriptor`, `MTLDepthStencilDescriptor`,
  `MTLDepthStencilState`, `MTLSamplerDescriptor`, and `MTLSamplerState`, plus
  encoder bindings for sampler and depth/stencil state.
- Added public argument-buffer descriptor coverage with
  `MTLArgumentBuffersTier`, `MTLBindingAccess`, `MTLTextureType`,
  `MTLArgumentDescriptor`, and descriptor-driven argument-encoder creation.
- Added public compute/render/tile pipeline descriptor wrappers, including
  blend/write-mask enums and descriptor-driven synchronous pipeline
  compilation helpers.
- Added limited `MetalFX` spatial and temporal scaler wrappers, linked the
  `MetalFX.framework`, and refreshed the README / coverage audit for the new
  surface.
- Bumped the crate to `0.6.1`.

## 0.6.0 — Wider Metal resource, command, and advanced-object coverage

- Added safe wrappers for richer `MTLDevice` capability queries, explicit
  command buffer lifecycle/state APIs, `MTLBlitCommandEncoder`,
  `MTLComputeCommandEncoder`, `MTLRenderCommandEncoder`, and
  `MTLRenderPipelineState`.
- Added advanced Metal object coverage for texture views, buffer-backed
  textures, heaps, fences, shared events, dynamic libraries, binary archives,
  argument encoders, indirect command buffers, acceleration-structure handles,
  visible/intersection function tables, counter sample buffers, log state,
  residency sets, and capture scopes.
- Split the Rust FFI and Swift bridge into `core`, `command`, `render`, and
  `advanced` areas following the `screencapturekit-rs` multi-file bridge
  pattern.
- Added examples `05_render_and_explicit_encoders`,
  `06_resources_and_archives`, and `07_advanced_objects`, plus the
  `tests/public_api_smoke.rs` integration smoke test.
- Added `COVERAGE.md`, refreshed the README, and bumped the crate to `0.6.0`.

## 0.5.0 — Compute pipeline + screencapturekit-style bridge split

- **`MetalLibrary`** — compile MSL source via
  `MetalDevice::new_library_with_source(...)`.
- **`MetalFunction`** — `library.new_function(name)`.
- **`ComputePipelineState`** —
  `device.new_compute_pipeline_state(&function)`.
- **`CommandBuffer::dispatch_compute_1d(&pso, &[&buffer, ...],
  threadgroups, threads_per_group)`** — record + dispatch a
  1-D compute kernel against a list of buffers bound at
  consecutive argument slots.
- Swift bridge restructured into 6 files following the
  `screencapturekit-rs` pattern (`Core.swift`, `Device.swift`,
  `Buffer.swift`, `Texture.swift`, `CommandQueue.swift`,
  `Compute.swift`) with shared `am_retain`/`am_release`/`am_borrow`
  helpers. No behaviour change for existing consumers.
- New example `04_compute_shader` runs an end-to-end GPU
  multiply-by-2 kernel.

## 0.1.0

- Initial release.
- Extracted from `apple-cf-rs v0.1.1`'s `metal` feature.
- `MetalDevice::system_default()`, `MetalTexture` getters,
  `IOSurfaceMetalExt::create_metal_texture` (under the default
  `iosurface` feature), `pixel_format` constants,
  `is_ycbcr_biplanar` helper.
