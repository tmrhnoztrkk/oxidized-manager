# Contributing

Thanks for helping! Bug reports, translations and pull requests are welcome.

## Before you open a pull request

```bash
pip install -r requirements-dev.txt
python -m pyflakes app tests tools
pytest -q
python tools/i18n_check.py
tests/e2e/run.sh          # needs Docker; runs the full scenario in ~2 minutes
```

The CI workflow runs all of these.

- **Backend** (`app/`): FastAPI, no ORM (SQLite via `db.py`).
  - Every workspace endpoint lives under `/api/w/<id>/…` and is permission-checked by the rule table in `app/perms.py`.
  - When you add an endpoint, add or adjust a rule and a test in `tests/test_perms.py`.
- **Frontend** (`static/`): plain ES modules, no build step and no framework.
  - Keep it that way, so the UI works offline and the image stays small.
- **Texts:** write every user-facing string in English and wrap it:
  - `t('…')` / `tn('…', '…', n)` in JS
  - `_("…")` in Python
  - `N_('…')` for strings that are translated later through a variable

  Then add the Turkish translation to `static/js/locales/tr.js` or `app/locales/tr.py`. `tools/i18n_check.py` lists anything that is missing.
- **Commits:** keep them focused, and describe the *why* in the message.

## New languages

1. Copy the two `tr` catalogs.
2. Translate the values.
3. Register the language in `static/js/i18n.js`, `app/i18n.py` and `tools/i18n_check.py`.

## Reporting bugs

Please include:

- Oxidized Manager version (sidebar) and Oxidized version (`docker compose exec oxidized-manager oxidized --version`).
- What you did, what you expected and what happened.
- Relevant lines from `docker compose logs oxidized-manager`. **Remove passwords, tokens and IP addresses** first.

Security issues: see [SECURITY.md](SECURITY.md).
