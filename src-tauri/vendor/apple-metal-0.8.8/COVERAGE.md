# COVERAGE

Audit target: `MacOSX26.2.sdk/System/Library/Frameworks/Metal.framework/Headers`
plus the wrapped `MetalFX.framework` headers from the active Xcode
toolchain (`xcrun --sdk macosx --show-sdk-path`).

Current audit status:

- **430 / 430** audited top-level macOS `Metal.framework` + `MetalFX.framework`
  public symbols are wrapped.
- **0 gaps** remain in the audited matrix.
- `MetalPerformanceShaders.framework` is still out of scope for this crate.

## Coverage summary

`apple-metal` `0.6.3` keeps the smoke-tested, fully exercised core runtime
workflows from `0.6.0` through `0.6.2` — device discovery, buffers, textures,
command queues/buffers, explicit blit/compute/render encoders, public
pipeline descriptors, depth/stencil state, sampler state, argument encoders,
heaps, events, dynamic libraries, binary archives, indirect command buffers,
acceleration-structure handles, capture scopes, residency sets, and the
spatial / temporal scaler path.

On top of that, `0.6.3` adds focused integration coverage for the split bridge
areas while retaining the completed *top-level symbol* audit from `0.6.2`,
including the descriptor, reflection, render-pass, resource-state,
rasterization-rate, function-stitching, tensor, IO, MetalFX base / denoised /
frame-interpolator, and `MTL4*` / `MTL4FX*` families as safe public Rust
surface:

- opaque handle wrappers for protocol/object families;
- constructible `Type::new()` wrappers for descriptor / Objective-C class
  families via the Swift bridge's Objective-C runtime path;
- raw-value wrapper types for enums, options, and newer Metal 4 state enums;
- Rust value types for audited C structs / typedefs such as `MetalOrigin`,
  `MetalRegion`, `MetalCoordinate2D`, `MetalResourceId`,
  `MetalPackedFloat3`, `MetalPackedFloatQuaternion`, `MetalPackedFloat4x3`,
  and `MetalGpuAddress`;
- bridge-backed helpers for exported Metal string constants, device
  enumeration / observation, and IO compression contexts.

The result is complete audited top-level symbol coverage without dropping down
to raw Objective-C messaging from Rust.

## Validation hooks

The wrapped surface is validated by:

- examples `01_get_device` through `07_advanced_objects`
- `tests/public_api_smoke.rs`
- `tests/exhaustive_symbols.rs`
- `tests/depth_stencil_bridge.rs`
- `tests/sampler_bridge.rs`
- `tests/argument_buffer_bridge.rs`
- `tests/heap_bridge.rs`
- `tests/event_bridge.rs`
- `tests/fence_bridge.rs`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- `for ex in examples/*.rs; do cargo run --example "$(basename "$ex" .rs)"; done`
