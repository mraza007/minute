// apple-metal build.rs — builds the AppleMetalBridge Swift static
// library and links it into the Rust crate, the same way every other
// Swift-bridged doom-fish crate does.

use std::env;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

    if env::var("DOCS_RS").is_ok() {
        return;
    }

    println!("cargo:rustc-link-lib=framework=Metal");
    // Minute-specific patch (see src-tauri/Cargo.toml's `[patch.crates-io]`
    // comment): MetalFX.framework only exists since macOS 13.0 (unlike
    // Metal/Foundation/IOSurface below, all long predating Minute's 11.0
    // floor), so it's weak-linked the same way — and for the same
    // "don't break app launch on an older OS" reason — as
    // `screencapturekit`'s own patched `ScreenCaptureKit.framework` link.
    // `apple-metal` is a transitive dependency pulled in unconditionally by
    // `screencapturekit` (not something Minute calls into directly), so
    // this crate is vendored purely to apply this one link-time fix.
    println!("cargo:rustc-link-arg=-weak_framework");
    println!("cargo:rustc-link-arg=MetalFX");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=IOSurface");

    let swift_dir = "swift-bridge";
    let out_dir = env::var("OUT_DIR").unwrap();
    let swift_build_dir = format!("{out_dir}/swift-build");

    println!("cargo:rerun-if-changed={swift_dir}");

    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let swift_triple = match target_arch.as_str() {
        "x86_64" => "x86_64-apple-macosx",
        "aarch64" => "arm64-apple-macosx",
        other => panic!("apple-metal: unsupported target arch '{other}'"),
    };

    let swift_args = vec![
        "build",
        "-c",
        "release",
        "--triple",
        swift_triple,
        "--package-path",
        swift_dir,
        "--scratch-path",
        &swift_build_dir,
    ];

    let output = Command::new("swift")
        .args(&swift_args)
        .output()
        .expect("Failed to build Swift bridge");

    if !output.status.success() {
        eprintln!(
            "Swift build STDOUT:\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
        eprintln!(
            "Swift build STDERR:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        panic!(
            "Swift build failed with exit code: {:?}",
            output.status.code()
        );
    }

    println!("cargo:rustc-link-search=native={swift_build_dir}/release");
    println!("cargo:rustc-link-lib=static=AppleMetalBridge");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    if let Ok(output) = Command::new("xcode-select").arg("-p").output() {
        if output.status.success() {
            let xcode_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let swift_lib_path =
                format!("{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib_path}");
            println!("cargo:rustc-link-search=native={swift_lib_path}");
        }
    }
}
