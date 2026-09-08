import unittest

from wandao_core.document_links import direct_document_reference
from wandao_report import finalize_report


class DocumentLinkTests(unittest.TestCase):
    def test_direct_reference_keeps_a_verified_https_document_page(self) -> None:
        reference = direct_document_reference(
            "https://www.yuque.com/team/handbook/intro",
            document_id="doc-123",
        )

        self.assertEqual(reference["documentUrl"], "https://www.yuque.com/team/handbook/intro")
        self.assertEqual(reference["documentUrlKind"], "direct_page")
        self.assertEqual(reference["documentUrlLabel"], "定位到原文")
        self.assertEqual(reference["documentId"], "doc-123")

    def test_direct_reference_rejects_non_browser_urls(self) -> None:
        self.assertEqual(direct_document_reference("http://example.test/page"), {})
        self.assertEqual(direct_document_reference("https://example.test/a b"), {})
        self.assertEqual(direct_document_reference("not a url"), {})

    def test_resource_failure_preserves_the_document_reference(self) -> None:
        report = finalize_report(
            {
                "resourceFailures": [{
                    "document": "语雀笔记",
                    **direct_document_reference("https://www.yuque.com/team/book/note", document_id="doc-123"),
                    "failures": [{"kind": "image", "url": "https://cdn.example.test/image.png", "error": "HTTP 404"}],
                }]
            }
        )

        item = report["resourceFailures"][0]
        self.assertEqual(item["documentUrl"], "https://www.yuque.com/team/book/note")
        self.assertEqual(item["documentId"], "doc-123")
