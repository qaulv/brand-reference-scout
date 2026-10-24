import importlib.util
import pathlib
import shutil
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_scout', ROOT / 'scripts/package.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def test_unlisted_private_files_never_enter_plugin_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / 'repo'
            shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns('.git', '.cache', 'trials', '__pycache__'))
            contamination = [root / 'skills/brand-reference-scout/.env',
                             root / 'skills/brand-reference-scout/examples/customer-brand.md',
                             root / 'skills/brand-reference-scout/assets/private-campaign.jpg',
                             root / 'skills/brand-reference-scout/review-decisions.json',
                             root / 'skills/brand-reference-scout/unedited-footage.mkv']
            for path in contamination:
                path.write_text('private fixture: must not be published')
            previous_root = packager.ROOT
            try:
                packager.ROOT = root.resolve()
                output = packager.package(pathlib.Path(tmp) / 'plugin.zip')
            finally:
                packager.ROOT = previous_root
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
            for path in contamination:
                self.assertNotIn(path.relative_to(root).as_posix(), names)
            self.assertIn('skills/brand-reference-scout/SKILL.md', names)
            self.assertIn('skills/brand-reference-scout/assets/review.js', names)
            self.assertIn('skills/brand-reference-scout/examples/context.json', names)


if __name__ == '__main__':
    unittest.main()
