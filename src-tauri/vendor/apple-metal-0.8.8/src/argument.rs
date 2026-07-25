use crate::{ffi, ArgumentEncoder, MetalDevice, SamplerState};

const DATA_TYPE_TEXTURE: usize = 58;
const DATA_TYPE_SAMPLER: usize = 59;
const DATA_TYPE_POINTER: usize = 60;

/// `MTLArgumentBuffersTier` enum values.
pub mod argument_buffers_tier {
    /// Mirrors the `Metal` framework constant `TIER1`.
    pub const TIER1: usize = 0;
    /// Mirrors the `Metal` framework constant `TIER2`.
    pub const TIER2: usize = 1;
}

/// `MTLBindingAccess` enum values.
pub mod binding_access {
    /// Mirrors the `Metal` framework constant `READ_ONLY`.
    pub const READ_ONLY: usize = 0;
    /// Mirrors the `Metal` framework constant `READ_WRITE`.
    pub const READ_WRITE: usize = 1;
    /// Mirrors the `Metal` framework constant `WRITE_ONLY`.
    pub const WRITE_ONLY: usize = 2;
}

/// `MTLTextureType` enum values.
pub mod texture_type {
    /// Mirrors the `Metal` framework constant `TYPE_1D`.
    pub const TYPE_1D: usize = 0;
    /// Mirrors the `Metal` framework constant `TYPE_1D_ARRAY`.
    pub const TYPE_1D_ARRAY: usize = 1;
    /// Mirrors the `Metal` framework constant `TYPE_2D`.
    pub const TYPE_2D: usize = 2;
    /// Mirrors the `Metal` framework constant `TYPE_2D_ARRAY`.
    pub const TYPE_2D_ARRAY: usize = 3;
    /// Mirrors the `Metal` framework constant `TYPE_2D_MULTISAMPLE`.
    pub const TYPE_2D_MULTISAMPLE: usize = 4;
    /// Mirrors the `Metal` framework constant `CUBE`.
    pub const CUBE: usize = 5;
    /// Mirrors the `Metal` framework constant `CUBE_ARRAY`.
    pub const CUBE_ARRAY: usize = 6;
    /// Mirrors the `Metal` framework constant `TYPE_3D`.
    pub const TYPE_3D: usize = 7;
    /// Mirrors the `Metal` framework constant `TYPE_2D_MULTISAMPLE_ARRAY`.
    pub const TYPE_2D_MULTISAMPLE_ARRAY: usize = 8;
    /// Mirrors the `Metal` framework constant `TEXTURE_BUFFER`.
    pub const TEXTURE_BUFFER: usize = 9;
}

/// Safe Rust description of `MTLArgumentDescriptor`.
#[derive(Debug, Clone, Copy)]
pub struct ArgumentDescriptor {
    data_type: usize,
    index: usize,
    array_length: usize,
    access: usize,
    texture_type: usize,
    constant_block_alignment: usize,
}

impl ArgumentDescriptor {
    /// Describe a buffer pointer argument at `index`.
    #[must_use]
    pub const fn buffer(index: usize, access: usize) -> Self {
        Self {
            data_type: DATA_TYPE_POINTER,
            index,
            array_length: 0,
            access,
            texture_type: texture_type::TYPE_2D,
            constant_block_alignment: 0,
        }
    }

    /// Describe a texture argument at `index`.
    #[must_use]
    pub const fn texture(index: usize, texture_type: usize, access: usize) -> Self {
        Self {
            data_type: DATA_TYPE_TEXTURE,
            index,
            array_length: 0,
            access,
            texture_type,
            constant_block_alignment: 0,
        }
    }

    /// Describe a sampler argument at `index`.
    #[must_use]
    pub const fn sampler(index: usize) -> Self {
        Self {
            data_type: DATA_TYPE_SAMPLER,
            index,
            array_length: 0,
            access: binding_access::READ_ONLY,
            texture_type: texture_type::TYPE_2D,
            constant_block_alignment: 0,
        }
    }

    /// Describe a constant block argument using a raw `MTLDataType` value.
    #[must_use]
    pub const fn constant(data_type: usize, index: usize, array_length: usize) -> Self {
        Self {
            data_type,
            index,
            array_length,
            access: binding_access::READ_ONLY,
            texture_type: texture_type::TYPE_2D,
            constant_block_alignment: 0,
        }
    }

    /// Override the descriptor's array length.
    #[must_use]
    pub fn with_array_length(mut self, array_length: usize) -> Self {
        self.array_length = array_length;
        self
    }

    /// Override the descriptor's constant-block alignment.
    #[must_use]
    pub fn with_constant_block_alignment(mut self, alignment: usize) -> Self {
        self.constant_block_alignment = alignment;
        self
    }

    const fn as_words(self) -> [usize; 6] {
        [
            self.data_type,
            self.index,
            self.array_length,
            self.access,
            self.texture_type,
            self.constant_block_alignment,
        ]
    }
}

impl MetalDevice {
    /// Create an argument encoder from a slice of `MTLArgumentDescriptor` values.
    #[must_use]
    pub fn new_argument_encoder_with_descriptors(
        &self,
        descriptors: &[ArgumentDescriptor],
    ) -> Option<ArgumentEncoder> {
        let mut words = Vec::with_capacity(descriptors.len().saturating_mul(6));
        for descriptor in descriptors {
            words.extend_from_slice(&descriptor.as_words());
        }
        let ptr = unsafe {
            ffi::am_device_new_argument_encoder_with_descriptors(
                self.as_ptr(),
                words.as_ptr(),
                descriptors.len(),
            )
        };
        if ptr.is_null() {
            None
        } else {
            Some(unsafe { ArgumentEncoder::from_retained_ptr(ptr) })
        }
    }
}

impl ArgumentEncoder {
    /// Encode a sampler binding at `index`.
    pub fn set_sampler_state(&self, sampler: &SamplerState, index: usize) {
        unsafe {
            ffi::am_argument_encoder_set_sampler_state(self.as_ptr(), sampler.as_ptr(), index);
        };
    }
}
