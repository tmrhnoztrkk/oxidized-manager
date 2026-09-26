# Security policy

Oxidized Manager stores network device credentials, so security reports are taken seriously.

Please **do not open a public issue** for vulnerabilities. Report them privately through GitHub's
"Report a vulnerability" (Security → Advisories) on this repository, with steps to reproduce.
You will get an answer within a week; fixes are released as soon as possible and credited unless you prefer otherwise.

## Hardening checklist

- **HTTPS.** Run behind an HTTPS reverse proxy and set `SECURE_COOKIES=true` and `FORWARDED_ALLOW_IPS`.
- **Secret key.** Keep `data/.secret_key` (or `SECRET_KEY`) secret and backed up. It encrypts the stored API keys, git tokens and SSH keys.
- **Least privilege.**
  - Give users the lowest workspace role they need.
  - Give remote-access API keys the `read` scope when management is not required.
- **Git tokens.** Limit them to the single backup repository (GitHub fine-grained tokens, GitLab project tokens), or use SSH deploy keys.
- **Audit log.** Review it: password reveals and exports with passwords are recorded.
