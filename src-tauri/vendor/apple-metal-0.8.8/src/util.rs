use std::ffi::{CStr, CString};

/// Calls the `Metal` framework counterpart for `c_string`.
pub fn c_string(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|error| error.to_string())
}

/// Calls the `Metal` framework counterpart for `take_optional_string`.
pub unsafe fn take_optional_string(ptr: *mut core::ffi::c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }

    let value = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    libc::free(ptr.cast());
    Some(value)
}

/// Calls the `Metal` framework counterpart for `take_string`.
pub unsafe fn take_string(ptr: *mut core::ffi::c_char) -> String {
    doom_fish_utils::ffi_string::take_owned_cstring_c(ptr, |p| libc::free(p.cast()))
        .unwrap_or_default()
}
