//! Issue #59: can the updater replace this app bundle in place?
//!
//! The updater renames the running `.app` aside and moves the new one into
//! its place. On a read-only volume that rename fails with
//! "Read-only file system (os error 30)". Two common ways to get there:
//! running Minute straight from the mounted DMG, and macOS App
//! Translocation, which runs a quarantined app that was never moved with
//! Finder from a random read-only mount.

use std::path::{Path, PathBuf};

/// The `.app` bundle that contains `exe`, or `None` when `exe` is not
/// inside one (for example a `tauri dev` build in `target/`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// Whether `path` sits on a volume mounted read-only. An error from
/// `statvfs` counts as writable, so the updater still gets its own try.
pub fn is_on_read_only_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is a valid NUL-terminated string and `stats` points to
    // writable memory the size of `statvfs`. We read `stats` only on success.
    if unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return false;
    }
    let stats = unsafe { stats.assume_init() };
    stats.f_flag & libc::ST_RDONLY != 0
}

/// Whether the running app's bundle is on a read-only volume, so an
/// in-app update cannot install.
pub fn app_bundle_is_read_only() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_of(&exe))
        .is_some_and(|bundle| is_on_read_only_volume(&bundle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_enclosing_app_bundle() {
        let exe = Path::new("/Volumes/Minute/Minute.app/Contents/MacOS/minute");
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from("/Volumes/Minute/Minute.app"))
        );
    }

    #[test]
    fn a_binary_outside_a_bundle_has_none() {
        assert_eq!(bundle_of(Path::new("/repo/target/debug/minute")), None);
    }

    #[test]
    fn a_temp_dir_is_writable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_on_read_only_volume(dir.path()));
    }

    #[test]
    fn a_missing_path_counts_as_writable() {
        assert!(!is_on_read_only_volume(Path::new("/no/such/path/Minute.app")));
    }

    // macOS mounts the signed system volume read-only, so `/System` is a
    // real read-only volume on every supported Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_volume_is_read_only() {
        assert!(is_on_read_only_volume(Path::new("/System")));
    }
}
