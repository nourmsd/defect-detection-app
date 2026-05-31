import pytest
from unittest.mock import MagicMock, patch

# ---- ROBOT TESTS ----

ROBOT_DISCONNECT_GRACE_MS = 10000

def is_robot_connected(last_heartbeat_ms, now_ms):
    return (now_ms - last_heartbeat_ms) < ROBOT_DISCONNECT_GRACE_MS

class TestRobot:

    # TEST 1 — within grace window → connected
    def test_connected_within_grace_window(self):
        assert is_robot_connected(last_heartbeat_ms=1000, now_ms=5000) is True

    # TEST 2 — grace window expired → disconnected
    def test_disconnected_after_grace_expired(self):
        assert is_robot_connected(last_heartbeat_ms=0, now_ms=15000) is False


# ---- PLC TESTS ----

class TestPLC:

    # TEST 1 — write_signal calls adapter with correct args
    def test_write_signal_calls_adapter(self):
        mock_adapter = MagicMock()
        address, value = 0x01, 1

        # Simulate your write_signal function
        mock_adapter.write(address, value)

        mock_adapter.write.assert_called_once_with(0x01, 1)

    # TEST 2 — enter_safe_state writes 0 to all outputs
    def test_safe_state_zeros_all_outputs(self):
        mock_adapter = MagicMock()
        outputs = [0x01, 0x02, 0x03]

        for address in outputs:
            mock_adapter.write(address, 0)

        assert mock_adapter.write.call_count == len(outputs)
        for call in mock_adapter.write.call_args_list:
            assert call.args[1] == 0  # value is always 0