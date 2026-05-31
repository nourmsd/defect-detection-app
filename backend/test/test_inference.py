import pytest

# Import the real function from your AI module
# from inference import run_inference, classify_confidence
# For now we mock them to show structure:

def classify_confidence(score, threshold=0.75):
    return 'ok' if score >= threshold else 'defective'

class TestClassifyConfidence:

    # TEST 1 — above threshold → ok
    def test_above_threshold_returns_ok(self):
        result = classify_confidence(0.90)
        assert result == 'ok'

    # TEST 2 — below threshold → defective
    def test_below_threshold_returns_defective(self):
        result = classify_confidence(0.50)
        assert result == 'defective'


def run_inference(frame):
    # Replace with: from inference import run_inference
    return {
        'label': 'ok',
        'confidence': 0.92,
        'defect_type': None,
        'processing_time': 120,
    }

class TestRunInference:

    # TEST 1 — payload has required keys
    def test_payload_has_required_keys(self):
        dummy_frame = None  # replace with a real numpy frame
        result = run_inference(dummy_frame)
        assert 'label' in result
        assert 'confidence' in result
        assert 'defect_type' in result
        assert 'processing_time' in result

    # TEST 2 — processing time is under 500ms
    def test_latency_under_500ms(self):
        result = run_inference(None)
        assert result['processing_time'] < 500