mod common;

use apple_metal::{compare_function, stencil_operation, DepthStencilDescriptor, StencilDescriptor};

#[test]
fn depth_stencil_state_can_be_created_and_bound_for_render() {
    let device = common::device();
    let (_library, _vertex, _fragment, pipeline) = common::compile_render(&device);

    let mut stencil = StencilDescriptor::new();
    stencil.stencil_compare_function = compare_function::ALWAYS;
    stencil.stencil_failure_operation = stencil_operation::REPLACE;
    stencil.depth_failure_operation = stencil_operation::KEEP;
    stencil.depth_stencil_pass_operation = stencil_operation::REPLACE;
    stencil.read_mask = 0xff;
    stencil.write_mask = 0xff;

    let mut descriptor = DepthStencilDescriptor::new();
    descriptor.depth_compare_function = compare_function::LESS_EQUAL;
    descriptor.depth_write_enabled = true;
    descriptor.front_face_stencil = Some(stencil);
    descriptor.back_face_stencil = Some(stencil);
    descriptor.label = Some("depth-stencil-bridge".to_string());

    let state = device
        .new_depth_stencil_state(&descriptor)
        .expect("depth stencil state");
    assert_eq!(state.label().as_deref(), Some("depth-stencil-bridge"));

    let rendered = common::render_and_readback(&device, &pipeline, |encoder| {
        encoder.set_depth_stencil_state(&state);
    });
    assert!(rendered.chunks_exact(4).any(|pixel| pixel[3] != 0));
}
