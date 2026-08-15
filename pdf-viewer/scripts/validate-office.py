#!/usr/bin/env python3
"""Validate generated Office files with the real zipfile module — the smoke's
ground truth that Word/Excel/PowerPoint/LibreOffice/Google can open what
Volt produces.

Usage: validate-office.py <file1> <needle1> [<file2> <needle2> ...]
Each file must be a valid zip whose CRC passes, contain an OOXML/SpreadsheetML
document part (word/document.xml, xl/worksheets/sheet1.xml, or
ppt/presentation.xml), and include the given needle somewhere in its XML parts.
For presentations, the number of ppt/slides/slideN.xml parts is printed as
"OFFICE_VALIDATE SLIDES N <path>" (once per distinct deck) so the smoke can
assert each deck has the expected slide count.
Exits 0 (prints OFFICE_VALIDATE OK) or 1 (FAIL) with the reason.
"""
import re
import sys
import zipfile

pairs = [(sys.argv[i], sys.argv[i + 1]) for i in range(1, len(sys.argv), 2)]
ok = True
slides = None
seen_decks = set()
for path, needle in pairs:
    try:
        z = zipfile.ZipFile(path)
        if not zipfile.is_zipfile(path):
            print("OFFICE_VALIDATE FAIL: not a zip:", path)
            ok = False
            continue
        bad = z.testzip()
        if bad is not None:
            print("OFFICE_VALIDATE FAIL: corrupt member", bad, "in", path)
            ok = False
            continue
        names = z.namelist()
        has_doc = ("word/document.xml" in names or "xl/worksheets/sheet1.xml" in names
                   or "ppt/presentation.xml" in names)
        if not has_doc:
            print("OFFICE_VALIDATE FAIL: no document part in", path)
            ok = False
            continue
        s = [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)]
        if s and path not in seen_decks:
            seen_decks.add(path)
            slides = len(s)
            print("OFFICE_VALIDATE SLIDES", slides, path)
        content = ""
        for n in names:
            if n.endswith(".xml"):
                content += z.read(n).decode("utf-8", "ignore")
        if needle not in content:
            print("OFFICE_VALIDATE FAIL: needle missing in", path, "->", needle)
            ok = False
            continue
    except Exception as e:  # noqa: BLE001
        print("OFFICE_VALIDATE FAIL:", path, "->", e)
        ok = False

print("OFFICE_VALIDATE", "OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
