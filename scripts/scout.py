#!/usr/bin/env python3
"""Repository convenience entrypoint. The self-contained skill owns implementation."""
import pathlib
import runpy

if __name__ == "__main__":
    runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "skills/brand-reference-scout/scripts/scout.py"), run_name="__main__")
