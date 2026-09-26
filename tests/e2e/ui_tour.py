"""Browser tour over a running e2e environment (KEEP=1 tests/e2e/run.sh), with Playwright.

Visits every page as admin in English and Turkish, as restricted users, opens the main dialogs,
and fails on JavaScript errors. Screenshots go to $SHOTS (default /tmp/oxmgr-shots).

  python tests/e2e/ui_tour.py [http://localhost:18080]
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18080"
SHOTS = os.environ.get("SHOTS", "/tmp/oxmgr-shots")
os.makedirs(SHOTS, exist_ok=True)
errors = []


def new_page(browser, lang="en", theme="light"):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US")
    ctx.add_init_script(f"localStorage.setItem('oxmgr-lang', '{lang}'); localStorage.setItem('oxmgr-theme', '{theme}');")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"[{lang}] pageerror {page.url}: {e}"))
    page.on("console", lambda m: m.type == "error" and "favicon" not in m.text and errors.append(f"[{lang}] console {page.url}: {m.text}"))
    return page


def login(page, user, pw):
    page.goto(BASE + "/")
    page.fill("input[name=username]", user)
    page.fill("input[name=password]", pw)
    page.click("button[type=submit]")
    page.wait_for_selector("#nav a", timeout=15000)


def visit(page, hash_, shot=None, wait="#view .page-head, #view .empty, #view .card"):
    page.goto(BASE + "/" + hash_)
    page.wait_for_selector(wait, timeout=20000)
    page.wait_for_timeout(700)
    if page.locator("#view .alert.danger b").filter(has_text="could not be loaded").count():
        errors.append(f"page failed: {hash_}")
    if shot:
        page.screenshot(path=f"{SHOTS}/{shot}.png", full_page=False)


def close_modal(page):
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)


def nav_labels(page):
    return [x.strip() for x in page.locator("#nav a span:first-of-type").all_inner_texts()]


def admin_tour(browser, lang, theme):
    p = new_page(browser, lang, theme)
    login(p, "admin", "Hq-pass-123")
    sfx = f"{lang}-{theme}"
    # workspace 1 (embedded)
    p.evaluate("localStorage.setItem('oxmgr-ws', 'local')")
    visit(p, "#/", f"dashboard-{sfx}")
    visit(p, "#/devices", f"devices-{sfx}", "#dv-table table")
    p.click("#dv-add")
    p.wait_for_selector(".modal #df-name")
    p.screenshot(path=f"{SHOTS}/device-form-{sfx}.png")
    close_modal(p)
    for tab in ("", "/config", "/versions", "/debug"):
        visit(p, f"#/devices/R1{tab}", f"device{tab.replace('/', '-') or '-overview'}-{sfx}" if lang == "en" else None)
    visit(p, "#/groups")
    visit(p, "#/search")
    p.fill("#s-q", "hostname")
    p.click("#s-form button[type=submit]")
    p.wait_for_selector("#s-results [data-n]", timeout=15000)
    visit(p, "#/logs", None, "#lg-term")
    p.wait_for_timeout(1500)
    for tab in ("general", "schema", "raw", "routerdb", "backups"):
        visit(p, f"#/settings/{tab}")
    # destinations: list, add form with every provider, every how-to guide
    visit(p, "#/destinations", f"destinations-{sfx}", "#ds-list .card")
    p.click("#ds-add")
    p.wait_for_selector(".modal #df-types")
    for prov in ("gitlab", "gitea", "git", "git_ssh", "github"):
        p.click(f".modal label.choice.mini:has(input[value={prov}])")
        p.wait_for_timeout(150)
        if prov == "git_ssh":
            p.click("#df-keygen")
            p.wait_for_selector("#df-pubkey", state="visible")
            p.screenshot(path=f"{SHOTS}/dest-form-ssh-{sfx}.png")
    p.screenshot(path=f"{SHOTS}/dest-form-github-{sfx}.png")
    p.click(".modal [data-howto-current]")
    p.wait_for_selector(".modal .steps-list")
    p.screenshot(path=f"{SHOTS}/howto-github-{sfx}.png")
    close_modal(p)
    close_modal(p)
    visit(p, "#/destinations", None, "#ds-list .card")
    p.locator("#ds-list [data-hist]").first.click()
    p.wait_for_selector(".modal table")
    p.screenshot(path=f"{SHOTS}/dest-history-{sfx}.png")
    close_modal(p)
    # administration
    visit(p, "#/workspaces", f"workspaces-{sfx}", "#ws-list .card")
    p.locator("#ws-list [data-a=share]").nth(1).click()
    p.wait_for_selector(".modal #sh-user")
    p.screenshot(path=f"{SHOTS}/share-{sfx}.png")
    close_modal(p)
    visit(p, "#/users", f"users-{sfx}", "#view table")
    p.locator("#view [data-edit]").first.click()
    p.wait_for_selector(".modal #uf-role")
    p.screenshot(path=f"{SHOTS}/user-edit-{sfx}.png")
    close_modal(p)
    visit(p, "#/access")
    visit(p, "#/audit", None, "#au-body")
    # workspace 2 (remote, through the proxy)
    p.click("#inst-switch")
    p.locator(".dropdown-menu.floating button").filter(has_text="Branch").click()
    p.wait_for_timeout(800)
    visit(p, "#/", f"remote-dashboard-{sfx}")
    visit(p, "#/devices", None, "#dv-table table")
    visit(p, "#/destinations", None, "#ds-list .card")
    visit(p, "#/logs", None, "#lg-term")
    p.wait_for_timeout(1500)
    # user menu
    p.click("#user-menu")
    p.wait_for_selector(".dropdown-menu.floating")
    p.screenshot(path=f"{SHOTS}/user-menu-{sfx}.png")
    p.context.close()


def restricted_tour(browser):
    ali = new_page(browser)
    login(ali, "ali", "ali-pass-123")
    labels = nav_labels(ali)
    ok = "Users & access" not in labels and "Oxidized settings" not in labels and "Devices" in labels
    print("  ali nav:", labels, "OK" if ok else "UNEXPECTED")
    if not ok:
        errors.append(f"ali nav: {labels}")
    visit(ali, "#/devices", "ali-devices", "#dv-table table")
    visit(ali, "#/users")  # admin page → redirected to the dashboard
    if "#/users" in ali.url:
        errors.append("ali could open #/users")
    ali.context.close()

    veli = new_page(browser, "tr")
    login(veli, "veli", "veli-pass-123")
    labels = nav_labels(veli)
    print("  veli nav (tr):", labels)
    if any(x in labels for x in ("Kullanıcılar & erişim", "Workspace'ler")):
        errors.append(f"veli nav: {labels}")
    visit(veli, "#/", "veli-dashboard-tr")
    visit(veli, "#/destinations", "veli-destinations-tr", "#ds-list .card")
    if veli.locator("#ds-add").count():
        errors.append("veli (operator) sees 'Add destination'")
    veli.context.close()


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for lang, theme in (("en", "light"), ("tr", "dark")):
        print(f"== admin tour {lang}/{theme}")
        admin_tour(browser, lang, theme)
    print("== restricted users")
    restricted_tour(browser)
    browser.close()

print(f"\nscreenshots: {SHOTS}")
if errors:
    print("ERRORS:")
    for e in errors:
        print("  ", e)
    sys.exit(1)
print("UI tour OK — no JavaScript errors")
