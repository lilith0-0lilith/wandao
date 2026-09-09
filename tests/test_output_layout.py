import argparse
import json
import tempfile
import unittest
from pathlib import Path

from wandao_core.output_layout import add_output_layout_args, resolve_output_directory, sanitize_output_folder_name


class OutputLayoutTests(unittest.TestCase):
    def test_flat_mode_returns_root_without_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(resolve_output_directory(root, "语雀知识库", "book-1"), root.resolve())
            self.assertFalse((root / ".wandao" / "output-layout.json").exists())

    def test_sanitizes_windows_names(self) -> None:
        self.assertEqual(sanitize_output_folder_name('A<>:"/\\|?*  '), "A---------")
        self.assertEqual(sanitize_output_folder_name("CON"), "CON-来源")
        self.assertEqual(sanitize_output_folder_name("   "), "导出内容")

    def test_same_id_keeps_directory_when_source_is_renamed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = resolve_output_directory(root, "旧名称", "stable-id", auto_output_folder=True)
            renamed = resolve_output_directory(root, "新名称", "stable-id", auto_output_folder=True)
            self.assertEqual(first, renamed)
            layout = json.loads((root / ".wandao" / "output-layout.json").read_text(encoding="utf-8"))
            self.assertEqual(layout["sources"]["stable-id"]["sourceName"], "新名称")

    def test_same_name_different_ids_do_not_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = resolve_output_directory(root, "同名来源", "id-1", auto_output_folder=True)
            second = resolve_output_directory(root, "同名来源", "id-2", auto_output_folder=True)
            self.assertNotEqual(first, second)
            self.assertEqual(second.name, "同名来源 (2)")

    def test_preserves_existing_flat_export_for_resume(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "01-旧文档.md").write_text("# old", encoding="utf-8")
            result = resolve_output_directory(
                root, "来源", "source-id", auto_output_folder=True, preserve_legacy=True
            )
            self.assertEqual(result, root.resolve())
            self.assertFalse((root / ".wandao" / "output-layout.json").exists())

    def test_new_empty_root_creates_source_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            result = resolve_output_directory(root, "来源/测试", "source-id", auto_output_folder=True)
            self.assertEqual(result, (root / "来源-测试").resolve())
            self.assertTrue(result.is_dir())


class OutputLayoutArgumentTests(unittest.TestCase):
    def test_cli_flags_are_mutually_exclusive(self) -> None:
        parser = argparse.ArgumentParser()
        add_output_layout_args(parser)
        self.assertFalse(parser.parse_args([]).auto_output_folder)
        self.assertTrue(parser.parse_args(["--auto-output-folder"]).auto_output_folder)
        self.assertFalse(parser.parse_args(["--flat-output"]).auto_output_folder)


if __name__ == "__main__":
    unittest.main()
