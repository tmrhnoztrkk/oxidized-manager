# Changelog

## 3.0.1

- **Data survives updates:** data now lives in the named Docker volume `oxidized-manager-data` instead of `./data`, so updating, `docker compose down` or cloning into another folder no longer starts an empty installation. An existing `./data` is copied into the volume on the first start.
- `.env` is optional: `docker compose up` works without it.
- The sidebar menu button now collapses the sidebar on wide screens (remembered per browser); on narrow screens tapping the page closes the open sidebar.

## 3.0.0 — first public release

- **Workspaces**
  - One container runs the manager.
  - It can optionally run one embedded Oxidized, and manage up to 10 remote Oxidized installations (configurable).
  - Remote installations are reached over HTTPS with API keys: either another Oxidized Manager or a plain Oxidized REST API.
- **Users**
  - Administrators and users.
  - Workspaces are shared per user with a viewer, operator or manager role.
  - Workspace managers can share their workspace.
  - Audit log per workspace.
- **Backup destinations**
  - Scheduled or on-demand git pushes to GitHub, GitLab, Gitea/Forgejo, any HTTPS git server, or any SSH git server with a generated deploy key.
  - Connection test and step-by-step setup guides in the UI.
  - Run history with links to the commits.
- **Languages:** English and Turkish, for both the UI and API messages.
- **Setup wizard:** run Oxidized here, manage a remote one, or skip.
- **Tests:** unit/API tests (pytest) and a Docker-based end-to-end suite with fake IOS devices and Gitea.
