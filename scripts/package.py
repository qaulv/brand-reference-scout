#!/usr/bin/env python3
"""Build a plugin ZIP from an explicit public-file allowlist."""
import argparse
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def package(destination):
    paths = [ROOT / p for p in ('plugin.json', '.codex-plugin/plugin.json',
                                '.agents/plugins/marketplace.json', 'LICENSE', 'README.md', 'scripts/scout.py')]
    public_skill_files = (
        'SKILL.md', 'LICENSE', 'agents/openai.yaml',
        'assets/review.html', 'assets/review.js', 'assets/style.css', 'assets/plugin-icon.svg',
        'examples/BRAND.md', 'examples/analysis.md', 'examples/campaign.svg',
        'examples/campaigns.json', 'examples/catalog.json', 'examples/context.json',
        'references/session-contract.md', 'references/sources.md', 'scripts/scout.py',
    )
    paths.extend(ROOT / 'skills/brand-reference-scout' / p for p in public_skill_files)
    destination = pathlib.Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
                raise ValueError(f'Package file must be inside repository: {path.name}')
            archive.write(path, path.relative_to(ROOT).as_posix())
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    print(package(args.out))
