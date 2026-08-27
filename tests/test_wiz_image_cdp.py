import base64
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from plugins.wiz.backend.export_wiz import ResourceSaver, WizDoc, WIZ_HELPER_JS


class FakeCdp:
    def __init__(self, events):
        self.events = list(events)
        self.sent = []

    def evaluate(self, expression, timeout=60):
        if "beginImageLoad" in expression:
            return "image-load-token"
        raise AssertionError(f"unexpected evaluate: {expression}")

    def wait_for_event(self, method, *, timeout=30, predicate=None):
        for index, event in enumerate(self.events):
            if event.get("method") != method:
                continue
            if predicate and not predicate(event):
                continue
            return self.events.pop(index)
        raise AssertionError(f"missing event {method}")

    def send(self, method, params=None, timeout=30):
        self.sent.append((method, params))
        if method == "Network.getResponseBody":
            return {"result": {"body": base64.b64encode(b"png").decode(), "base64Encoded": True}}
        return {"result": {}}


def make_saver(cdp):
    doc = WizDoc("kb", "doc", "测试", "/", "note", "", 0, 0, {})
    args = SimpleNamespace()
    return ResourceSaver(cdp, doc, __import__("pathlib").Path("out/test.md"), "https://example.com", args)


class WizImageCdpTests(unittest.TestCase):
    def test_external_image_uses_http_fallback_after_browser_rejection(self):
        saver = make_saver(FakeCdp([]))
        saver.fetch_base64 = lambda _url: (_ for _ in ()).throw(RuntimeError("cors"))
        saver.fetch_base64_via_browser = lambda _url: (_ for _ in ()).throw(RuntimeError("HTTP 405"))

        class Response:
            headers = {"Content-Type": "image/png"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"png"

        with patch("plugins.wiz.backend.export_wiz.urllib.request.urlopen", return_value=Response()) as opened:
            result = saver.save_normal_image("https://gips1.baidu.com/image.png", "image")
        self.assertTrue(result)
        opened.assert_called_once()

    def test_browser_helper_version_is_bumped_for_new_image_loader(self):
        self.assertIn("version === 2", WIZ_HELPER_JS)
        self.assertIn("version: 2", WIZ_HELPER_JS)

    def test_browser_fallback_reads_body_only_after_loading_finished(self):
        request_id = "request-1"
        cdp = FakeCdp(
            [
                {"method": "Network.responseReceived", "params": {"requestId": "preflight-1", "type": "Preflight", "response": {"url": "https://img.example/a.png", "status": 405, "mimeType": "text/plain"}}},
                {"method": "Network.responseReceived", "params": {"requestId": request_id, "type": "Image", "response": {"url": "https://img.example/a.png", "status": 200, "mimeType": "image/png"}}},
                {"method": "Network.loadingFinished", "params": {"requestId": request_id}},
            ]
        )
        payload = make_saver(cdp).fetch_base64_via_browser("https://img.example/a.png")
        self.assertEqual(payload["contentType"], "image/png")
        self.assertEqual(cdp.sent[-1][0], "Network.getResponseBody")
        self.assertIn(("Network.setCacheDisabled", {"cacheDisabled": True}), cdp.sent)

    def test_browser_fallback_does_not_read_body_after_loading_failed(self):
        request_id = "request-2"
        cdp = FakeCdp(
            [
                {"method": "Network.responseReceived", "params": {"requestId": request_id, "response": {"url": "https://img.example/a.png", "status": 200, "mimeType": "image/png"}}},
                {"method": "Network.loadingFailed", "params": {"requestId": request_id, "params": {"errorText": "blocked"}}},
            ]
        )
        with self.assertRaises(Exception):
            make_saver(cdp).fetch_base64_via_browser("https://img.example/a.png")
        self.assertNotIn("Network.getResponseBody", [method for method, _params in cdp.sent])

    def test_collab_failure_keeps_browser_fallback_stage(self):
        saver = make_saver(FakeCdp([]))
        saver.fetch_base64 = lambda _url: (_ for _ in ()).throw(RuntimeError("cors"))
        saver.fetch_base64_via_browser = lambda _url: (_ for _ in ()).throw(RuntimeError("response timeout"))
        saver.fetch_cache_base64 = lambda _name: None
        self.assertEqual(saver.save_collab_image("image.png"), "")
        self.assertIn("浏览器兜底失败", saver.failures[0]["error"])


if __name__ == "__main__":
    unittest.main()
