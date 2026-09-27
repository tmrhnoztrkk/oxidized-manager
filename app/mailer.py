"""Outgoing e-mail over SMTP (password reset links, test messages).

The SMTP settings are stored in the ``app_settings`` table under ``smtp``; the password is encrypted.
"""
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from . import db
from .i18n import _

KEY = "smtp"
SECURITY = ("starttls", "ssl", "none")
DEFAULTS = {"host": "", "port": 587, "security": "starttls", "username": "", "password": "",
            "from_email": "", "from_name": "Oxidized Manager", "verify_tls": True, "public_url": ""}


class MailError(Exception):
    pass


def load(reveal=False):
    cfg = {**DEFAULTS, **(db.get_setting(KEY) or {})}
    if reveal:
        cfg["password"] = db.decrypt(cfg["password"])
    else:
        cfg["has_password"] = bool(cfg["password"])
        cfg["password"] = ""
    return cfg


def save(cfg):
    """Stores the settings; an empty password keeps the stored one."""
    old = db.get_setting(KEY) or {}
    new = {k: cfg.get(k, v) for k, v in DEFAULTS.items()}
    new["password"] = db.encrypt(cfg["password"]) if cfg.get("password") else old.get("password", "")
    if cfg.get("clear_password"):
        new["password"] = ""
    db.set_setting(KEY, new)


def enabled():
    cfg = db.get_setting(KEY) or {}
    return bool(cfg.get("host") and cfg.get("from_email"))


def send(to, subject, text, cfg=None):
    """Sends a plain-text message. ``cfg`` (revealed) overrides the stored settings, e.g. for a test."""
    cfg = cfg or load(reveal=True)
    if not (cfg.get("host") and cfg.get("from_email")):
        raise MailError(_("E-mail (SMTP) is not configured"))
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((cfg.get("from_name") or "", cfg["from_email"]))
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain=cfg["from_email"].rpartition("@")[2] or None)
    msg.set_content(text)

    ctx = ssl.create_default_context()
    if not cfg.get("verify_tls", True):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    host, port, security = cfg["host"], int(cfg.get("port") or 0), cfg.get("security", "starttls")
    try:
        if security == "ssl":
            smtp = smtplib.SMTP_SSL(host, port or 465, timeout=20, context=ctx)
        else:
            smtp = smtplib.SMTP(host, port or 587, timeout=20)
        with smtp:
            smtp.ehlo()
            if security == "starttls":
                smtp.starttls(context=ctx)
                smtp.ehlo()
            if cfg.get("username"):
                smtp.login(cfg["username"], cfg.get("password") or "")
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise MailError(_("The SMTP server rejected the username or password")) from e
    except smtplib.SMTPNotSupportedError as e:
        raise MailError(_("The SMTP server does not support STARTTLS — choose SSL/TLS or no encryption")) from e
    except smtplib.SMTPRecipientsRefused as e:
        raise MailError(_("The SMTP server refused the recipient {to}", to=to)) from e
    except smtplib.SMTPSenderRefused as e:
        raise MailError(_("The SMTP server refused the sender address {sender}", sender=cfg["from_email"])) from e
    except ssl.SSLCertVerificationError as e:
        raise MailError(_("The SMTP server's TLS certificate is not trusted — install a valid certificate or disable TLS verification")) from e
    except ssl.SSLError as e:
        raise MailError(_("TLS error: {err} — check the port and the encryption setting", err=e.reason or e)) from e
    except socket.gaierror as e:
        raise MailError(_("The SMTP server name could not be resolved (DNS)")) from e
    except (TimeoutError, socket.timeout) as e:
        raise MailError(_("The SMTP server did not answer in time (firewall / port?)")) from e
    except (ConnectionError, OSError, smtplib.SMTPException) as e:
        raise MailError(_("Sending the e-mail failed: {err}", err=e)) from e
