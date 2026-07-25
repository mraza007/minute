mod common;

#[test]
fn shared_events_can_be_signaled_waited_and_encoded_on_command_buffers() {
    let device = common::device();
    let Some(event) = device.new_shared_event() else {
        return;
    };

    event.set_signaled_value(1);
    assert_eq!(event.signaled_value(), 1);
    assert!(event.wait_until_signaled_value(1, 1_000));

    let queue = device.new_command_queue().expect("command queue");

    let signal_buffer = queue.new_command_buffer().expect("signal command buffer");
    signal_buffer.encode_signal_event(&event, 2);
    signal_buffer.commit();
    signal_buffer.wait_until_completed();
    assert!(event.wait_until_signaled_value(2, 1_000));

    let wait_buffer = queue.new_command_buffer().expect("wait command buffer");
    wait_buffer.encode_wait_for_event(&event, 2);
    wait_buffer.commit();
    wait_buffer.wait_until_completed();
}
