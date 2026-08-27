import unittest

from plugins.wiz.backend.export_wiz import should_skip_existing_doc


class WizRetryFailedTests(unittest.TestCase):
    def test_retry_failed_does_not_skip_existing_markdown(self) -> None:
        self.assertFalse(
            should_skip_existing_doc(
                incremental=True,
                path_exists=True,
                retry_failed=True,
            )
        )

    def test_incremental_export_still_skips_existing_markdown_normally(self) -> None:
        self.assertTrue(
            should_skip_existing_doc(
                incremental=True,
                path_exists=True,
                retry_failed=False,
            )
        )


if __name__ == "__main__":
    unittest.main()
