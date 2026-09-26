#!/usr/bin/env python3
"""Checks that every translatable string has a translation in each catalog.

  python tools/i18n_check.py              # report missing / unused keys, exit 1 if something is missing
  python tools/i18n_check.py --missing    # print the missing keys as a JSON object (handy for new languages)

Sources
  web UI  : t('…'), tn('…', '…', n), N_('…') in static/js/**/*.js  → static/js/locales/<lang>.js
  backend : _("…"), N_("…") in app/**/*.py                                 → app/locales/<lang>.py (MESSAGES)
"""
import ast
import json
import re
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LANGS = ["tr"]

_LIT = r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\""
_CALL = re.compile(rf"(?<![\w.$])(t|N_)\(\s*({_LIT})")
_PLURAL = re.compile(rf"(?<![\w.$])tn\(\s*({_LIT})\s*,\s*({_LIT})")
_TEMPLATE = re.compile(r"(?<![\w.$])(t|N_|tn)\(\s*`")


def _unquote(lit):
    body = lit[1:-1]
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), body)


def js_keys():
    keys, problems = {}, []
    for path in sorted((ROOT / "static/js").rglob("*.js")):
        if "locales" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for m in _CALL.finditer(text):
            keys.setdefault(_unquote(m.group(2)), f"{rel}:{text.count(chr(10), 0, m.start()) + 1}")
        for m in _PLURAL.finditer(text):
            # languages without plural forms translate the "other" form only
            keys.setdefault(_unquote(m.group(2)), f"{rel}:{text.count(chr(10), 0, m.start()) + 1}")
        for m in _TEMPLATE.finditer(text):
            problems.append(f"{rel}:{text.count(chr(10), 0, m.start()) + 1}: template literal passed to {m.group(1)}()")
    return keys, problems


def py_keys():
    keys = {}
    for path in sorted((ROOT / "app").rglob("*.py")):
        if "locales" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("_", "N_")
                    and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                keys.setdefault(node.args[0].value, f"{path.relative_to(ROOT)}:{node.lineno}")
    return keys


def load_js_catalog(lang):
    text = (ROOT / f"static/js/locales/{lang}.js").read_text(encoding="utf-8")
    body = text[text.index("{"): text.rindex("}") + 1]
    body = re.sub(r",(\s*})", r"\1", body)                 # trailing comma
    body = "\n".join(ln for ln in body.splitlines() if not ln.strip().startswith("//"))
    return json.loads(body)


def load_py_catalog(lang):
    return runpy.run_path(str(ROOT / f"app/locales/{lang}.py"))["MESSAGES"]


def placeholders(s):
    return sorted(set(re.findall(r"\{(\w+)\}", s)))


def main():
    dump = "--missing" in sys.argv
    failed = False
    jk, problems = js_keys()
    pk = py_keys()
    for p in problems:
        print("!!", p)
        failed = True
    for lang in LANGS:
        for label, keys, catalog in (("web", jk, load_js_catalog(lang)), ("api", pk, load_py_catalog(lang))):
            missing = {k: v for k, v in keys.items() if k not in catalog}
            unused = [k for k in catalog if k not in keys]
            bad = [k for k in keys if k in catalog and placeholders(k) != placeholders(catalog[k])]
            print(f"[{lang}/{label}] {len(keys)} strings, {len(missing)} missing, {len(unused)} unused, {len(bad)} placeholder mismatches")
            if dump and missing:
                print(json.dumps({k: "" for k in missing}, ensure_ascii=False, indent=2))
            else:
                for k, where in missing.items():
                    print(f"   missing: {where}: {k!r}")
            for k in bad:
                print(f"   placeholders differ: {k!r}")
            for k in unused:
                print(f"   unused: {k!r}")
            failed = failed or bool(missing) or bool(bad)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
