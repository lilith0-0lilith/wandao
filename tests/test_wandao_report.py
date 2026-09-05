import unittest
from unittest.mock import patch

from wandao_report import derive_outcome, finalize_report


class WandaoReportTests(unittest.TestCase):
    def test_finalize_export_report_adds_common_fields(self) -> None:
        report = finalize_report(
            {
                "platform": "wiz",
                "total": 3,
                "exported": 2,
                "failures": [{"title": "broken", "error": "timeout"}],
            },
            mode="export",
            report_file="00-导出报告.json",
            output="exports/wiz",
        )

        self.assertEqual(report["reportSchemaVersion"], 1)
        self.assertEqual(report["provider"], "wiz")
        self.assertEqual(report["mode"], "export")
        self.assertEqual(report["totalDocs"], 3)
        self.assertEqual(report["successCount"], 2)
        self.assertEqual(report["failureCount"], 1)
        self.assertEqual(report["outcome"], "partial")
        self.assertEqual(report["reportFile"], "00-导出报告.json")
        self.assertEqual(report["output"], "exports/wiz")

    def test_finalize_import_report_combines_created_and_updated(self) -> None:
        report = finalize_report(
            {
                "provider": "yuque-import",
                "totalDocs": 5,
                "createdDocs": 2,
                "updatedDocs": 1,
                "skippedDocs": 1,
                "imageFailures": [{"document": "a", "failures": [{"url": "x"}]}],
            },
            mode="import",
        )

        self.assertEqual(report["successCount"], 3)
        self.assertEqual(report["failureCount"], 0)
        self.assertEqual(report["resourceFailures"][0]["type"], "image")
        self.assertEqual(report["resourceFailures"][0]["document"], "a")
        self.assertEqual(report["resourceFailures"][0]["url"], "x")
        self.assertEqual(report["outcome"], "partial")

    def test_finalize_legacy_import_count_fields(self) -> None:
        report = finalize_report(
            {
                "provider": "yinxiang-import",
                "sourceDocCount": 4,
                "importedCount": 3,
                "failures": [{"path": "broken.md", "error": "timeout"}],
            },
            mode="import",
        )

        self.assertEqual(report["totalDocs"], 4)
        self.assertEqual(report["successCount"], 3)
        self.assertEqual(report["failureCount"], 1)
        self.assertEqual(report["outcome"], "partial")

    def test_finalize_report_emits_task_result_v1_with_run_lineage(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "WANDAO_RUN_ID": "run-123",
                "WANDAO_JOB_ID": "job-456",
                "WANDAO_PARENT_RUN_ID": "run-122",
            },
            clear=False,
        ):
            report = finalize_report({"totalDocs": 0}, provider="wiz", mode="export")

        self.assertEqual(report["kind"], "wandao.result")
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["runId"], "run-123")
        self.assertEqual(report["jobId"], "job-456")
        self.assertEqual(report["parentRunId"], "run-122")
        self.assertEqual(report["outcome"], "completed")
        for field in ("provider", "mode", "totalDocs", "successCount", "failureCount", "failures", "resourceFailures", "outcome"):
            self.assertIn(field, report)

    def test_report_outcome_corrects_contradictory_failure_count(self) -> None:
        report = finalize_report(
            {
                "totalDocs": 2,
                "successCount": 1,
                "failureCount": 0,
                "failures": [{"title": "missing", "error": "timeout"}],
            }
        )

        self.assertEqual(report["failureCount"], 1)
        self.assertEqual(report["outcome"], "partial")
        self.assertEqual(derive_outcome({"stopped": True}), "stopped")
        self.assertEqual(derive_outcome({"rateLimitedPaused": True}), "paused")

    def test_resource_failure_count_adds_images_and_attachments(self) -> None:
        report = finalize_report(
            {
                "imageFailureCount": 2,
                "attachmentFailureCount": 3,
            }
        )

        self.assertEqual(report["imageFailureCount"], 2)
        self.assertEqual(report["attachmentFailureCount"], 3)
        self.assertEqual(report["resourceFailureCount"], 5)
        self.assertEqual(report["failureCount"], 0)
        self.assertEqual(report["outcome"], "partial")

    def test_legacy_resource_duplicate_does_not_count_as_document_failure(self) -> None:
        report = finalize_report(
            {
                "failureCount": 0,
                "failures": [{"url": "https://cdn.example.test/a.png", "error": "HTTP 500"}],
                "imageFailures": [{"url": "https://cdn.example.test/a.png", "error": "HTTP 500"}],
                "imageFailureCount": 1,
            }
        )

        self.assertEqual(report["failureCount"], 0)
        self.assertEqual(report["resourceFailureCount"], 1)
        self.assertEqual(report["imageFailureCount"], 1)
        self.assertEqual(report["outcome"], "partial")

    def test_root_resource_warning_list_becomes_resource_details(self) -> None:
        report = finalize_report(
            {
                "resourceWarnings": [
                    {"url": "https://cdn.example.test/a.bin", "error": "HTTP 403"},
                    "资源被跳过",
                ]
            }
        )

        self.assertEqual(report["failureCount"], 0)
        self.assertEqual(report["resourceFailureCount"], 2)
        self.assertEqual(len(report["resourceFailures"]), 2)
        self.assertTrue(any(item.get("url") for item in report["resourceFailures"]))
        self.assertTrue(any(item.get("warning") == "资源被跳过" for item in report["resourceFailures"]))

    def test_nested_image_and_attachment_warnings_inherit_document_context(self) -> None:
        report = finalize_report(
            {
                "documents": [
                    {
                        "relativePath": "目录/图片.md",
                        "imageWarnings": [{"url": "https://cdn.example.test/image.png", "error": "404"}],
                    },
                    {
                        "document": "目录/附件.md",
                        "attachmentWarnings": [{"name": "guide.pdf", "error": "403"}],
                    },
                ]
            }
        )

        self.assertEqual(report["imageFailureCount"], 1)
        self.assertEqual(report["attachmentFailureCount"], 1)
        self.assertEqual(report["resourceFailureCount"], 2)
        image = next(item for item in report["resourceFailures"] if item["type"] == "image")
        attachment = next(item for item in report["resourceFailures"] if item["type"] == "attachment")
        self.assertEqual(image["relativePath"], "目录/图片.md")
        self.assertEqual(attachment["document"], "目录/附件.md")

    def test_nested_resource_failure_inherits_page_link_semantics(self) -> None:
        report = finalize_report(
            {
                "resourceFailures": [
                    {
                        "title": "资料札记-728｜城市公共绿道",
                        "documentUrl": "https://www.wiz.cn/xapp",
                        "documentUrlKind": "platform_entry",
                        "documentUrlLabel": "打开为知笔记",
                        "documentId": "doc-123",
                        "knowledgeBaseId": "kb-456",
                        "failures": [
                            {"kind": "image", "url": "https://cdn.example.test/progress", "error": "图片响应 HTTP 404"}
                        ],
                    }
                ]
            }
        )

        item = report["resourceFailures"][0]
        self.assertEqual(item["title"], "资料札记-728｜城市公共绿道")
        self.assertEqual(item["documentUrl"], "https://www.wiz.cn/xapp")
        self.assertEqual(item["documentUrlKind"], "platform_entry")
        self.assertEqual(item["documentUrlLabel"], "打开为知笔记")
        self.assertEqual(item["documentId"], "doc-123")
        self.assertEqual(item["knowledgeBaseId"], "kb-456")

    def test_local_image_alias_is_deduplicated_against_generic_resource_failure(self) -> None:
        report = finalize_report(
            {
                "resourceFailures": [
                    {
                        "document": "a.md",
                        "reason": "本地图片引用未修复：assets/a.png（找不到本地文件）",
                    }
                ],
                "localImageReferenceFailures": [
                    {"document": "a.md", "reference": "assets/a.png", "warning": "缺少本地图片"}
                ],
            }
        )

        self.assertEqual(report["resourceFailureCount"], 1)
        self.assertEqual(report["imageFailureCount"], 1)
        self.assertEqual(len(report["resourceFailures"]), 1)
        self.assertEqual(report["resourceFailures"][0]["type"], "image")

    def test_document_failure_with_url_and_image_word_is_not_a_resource(self) -> None:
        report = finalize_report(
            {
                "failureCount": 1,
                "failures": [
                    {
                        "relativePath": "正文.md",
                        "url": "https://example.test/document",
                        "error": "正文图片说明解析失败",
                    }
                ],
            }
        )

        self.assertEqual(report["failureCount"], 1)
        self.assertEqual(report.get("resourceFailureCount", 0), 0)
        self.assertEqual(report["resourceFailures"], [])

    def test_warning_count_only_and_warning_list_only_have_stable_counts(self) -> None:
        count_only = finalize_report(
            {"imageWarnings": 3, "attachmentWarnings": 0, "resourceWarnings": 4}
        )
        list_only = finalize_report(
            {"imageWarnings": ["a", "b"], "attachmentWarnings": ["c"]}
        )

        self.assertEqual(count_only["imageFailureCount"], 3)
        self.assertEqual(count_only["attachmentFailureCount"], 0)
        self.assertEqual(count_only["resourceFailureCount"], 4)
        self.assertEqual(count_only["resourceFailures"], [])
        self.assertEqual(list_only["imageFailureCount"], 2)
        self.assertEqual(list_only["attachmentFailureCount"], 1)
        self.assertEqual(list_only["resourceFailureCount"], 3)
        self.assertEqual(len(list_only["resourceFailures"]), 3)

    def test_same_reference_is_counted_separately_for_image_and_attachment(self) -> None:
        report = finalize_report(
            {
                "imageFailures": [{"url": "https://cdn.example.test/shared", "error": "image failed"}],
                "attachmentFailures": [{"url": "https://cdn.example.test/shared", "error": "attachment failed"}],
            }
        )

        self.assertEqual(report["imageFailureCount"], 1)
        self.assertEqual(report["attachmentFailureCount"], 1)
        self.assertEqual(report["resourceFailureCount"], 2)
        self.assertEqual(len(report["resourceFailures"]), 2)

    def test_generic_resource_is_upgraded_by_matching_concrete_failure(self) -> None:
        report = finalize_report(
            {
                "resourceFailures": [{"url": "https://cdn.example.test/a.png", "error": "failed"}],
                "imageFailures": [{"url": "https://cdn.example.test/a.png", "error": "failed", "kind": "image"}],
            }
        )

        self.assertEqual(report["resourceFailureCount"], 1)
        self.assertEqual(report["imageFailureCount"], 1)
        self.assertEqual(len(report["resourceFailures"]), 1)
        self.assertEqual(report["resourceFailures"][0]["type"], "image")

    def test_explicit_counts_use_maximum_when_the_list_is_shorter_or_longer(self) -> None:
        report = finalize_report(
            {
                "imageFailureCount": 5,
                "attachmentFailureCount": 1,
                "resourceFailureCount": 2,
                "imageFailures": [{"url": "https://cdn.example.test/a.png"}],
                "attachmentFailures": [
                    {"url": "https://files.example.test/a.pdf"},
                    {"url": "https://files.example.test/b.pdf"},
                ],
            }
        )

        self.assertEqual(report["imageFailureCount"], 5)
        self.assertEqual(report["attachmentFailureCount"], 2)
        self.assertEqual(report["resourceFailureCount"], 7)

    def test_warning_wrapper_count_and_alias_list_use_the_larger_value(self) -> None:
        report = finalize_report(
            {
                "imageWarnings": {
                    "count": 5,
                    "items": ["a", "b"],
                }
            }
        )

        self.assertEqual(report["imageFailureCount"], 5)
        self.assertEqual(report["resourceFailureCount"], 5)


if __name__ == "__main__":
    unittest.main()
