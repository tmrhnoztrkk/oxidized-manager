// Administration › E-mail (SMTP): outgoing mail for password reset links
import { api } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { $, esc, icon, modal, pwField, setBusy, toast, toastError } from '../ui.js';

const PORTS = { starttls: 587, ssl: 465, none: 25 };

export async function render(view) {
  const cfg = await api.get('/api/settings/smtp');
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(t('E-mail (SMTP)'))}</h1>
      <div class="sub">${esc(t('The mail server used to send password reset links. Users need an e-mail address in their profile to receive one.'))}</div></div>
      <div class="actions"><span id="ml-state"></span></div></div>
    <form class="card" autocomplete="off"><div class="card-body stack">
      <div class="section-title">${icon('server')} ${esc(t('Server'))}</div>
      <div class="grid c3">
        <div class="field span2"><label>${esc(t('SMTP server'))}</label><input class="input" name="host" value="${esc(cfg.host)}" placeholder="smtp.example.com"></div>
        <div class="field"><label>${esc(t('Port'))}</label><input class="input" type="number" name="port" min="1" max="65535" value="${esc(cfg.port)}"></div>
      </div>
      <div class="grid c2">
        <div class="field"><label>${esc(t('Encryption'))}</label><select class="select" name="security">
          <option value="starttls">${esc(t('STARTTLS (usually port 587)'))}</option>
          <option value="ssl">${esc(t('SSL/TLS (usually port 465)'))}</option>
          <option value="none">${esc(t('None (port 25, internal relays only)'))}</option></select></div>
        <div class="field"><label>${esc(t('TLS certificate'))}</label><label class="switch" style="margin-top:6px"><input type="checkbox" name="verify_tls" ${cfg.verify_tls ? 'checked' : ''}><span class="track"></span><span>${esc(t('Verify the server certificate'))}</span></label></div>
      </div>
      <div class="grid c2">
        <div class="field"><label>${esc(t('Username'))} <span class="muted small">(${esc(t('empty = no authentication'))})</span></label><input class="input" name="username" value="${esc(cfg.username)}" autocomplete="off"></div>
        <div class="field"><label>${esc(t('Password'))} ${cfg.has_password ? `<span class="muted small">(${esc(t('leave empty to keep'))})</span>` : ''}</label>${pwField('ml-pass', { has: cfg.has_password })}</div>
      </div>
      <div class="section-title">${icon('mail')} ${esc(t('Sender'))}</div>
      <div class="grid c2">
        <div class="field"><label>${esc(t('Sender address'))}</label><input class="input" type="email" name="from_email" value="${esc(cfg.from_email)}" placeholder="noreply@example.com"></div>
        <div class="field"><label>${esc(t('Sender name'))}</label><input class="input" name="from_name" value="${esc(cfg.from_name)}"></div>
      </div>
      <div class="field"><label>${esc(t('Panel address'))}</label><input class="input" name="public_url" value="${esc(cfg.public_url || location.origin)}" placeholder="https://oxidized.example.com">
        <div class="small muted">${esc(t('Reset links in the e-mails point here. Use the address users open the panel with.'))}</div></div>
    </div>
    <div class="card-foot row between">
      <button type="button" class="btn" id="ml-test">${icon('send')} ${esc(t('Send test e-mail'))}</button>
      <button type="submit" class="btn primary">${icon('save')} ${esc(t('Save'))}</button></div></form>`;

  const f = view.querySelector('form');
  f.security.value = cfg.security;
  const showState = (c) => {
    $('#ml-state', view).innerHTML = c.host && c.from_email
      ? `<span class="badge success">${icon('checkCircle')} ${esc(t('Password reset by e-mail is on'))}</span>`
      : `<span class="badge">${icon('info')} ${esc(t('Not configured'))}</span>`;
  };
  showState(cfg);
  // follow the usual port when the encryption changes and the port was still the default of the old one
  let lastSec = cfg.security;
  f.security.onchange = () => {
    if (+f.port.value === PORTS[lastSec]) f.port.value = PORTS[f.security.value];
    lastSec = f.security.value;
  };
  const values = () => ({
    host: f.host.value.trim(), port: +f.port.value, security: f.security.value, verify_tls: f.verify_tls.checked,
    username: f.username.value.trim(), password: $('#ml-pass', f).value,
    from_email: f.from_email.value.trim(), from_name: f.from_name.value.trim(), public_url: f.public_url.value.trim(),
  });

  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    try {
      const saved = await api.put('/api/settings/smtp', values());
      state.me.reset_enabled = !!(saved.host && saved.from_email);
      $('#ml-pass', f).value = '';
      showState(saved);
      toast(t('E-mail settings saved'), 'success');
    } catch (err) { toastError(err); }
    setBusy(btn, false);
  };

  $('#ml-test', view).onclick = () => {
    const m = modal({
      title: `${icon('send')} ${esc(t('Send test e-mail'))}`, size: 'sm',
      body: `<div class="stack"><div class="field"><label>${esc(t('Recipient'))}</label><input class="input" type="email" id="ml-to" value="${esc(state.me.profile?.email || '')}" placeholder="name@example.com"></div>
        <div class="small muted">${esc(t('Uses the values in the form, including unsaved changes.'))}</div></div>`,
      footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${icon('send')} ${esc(t('Send'))}</button>`,
    });
    m.foot.querySelector('[data-a=no]').onclick = m.close;
    m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
      setBusy(e.currentTarget, true, t('Sending'));
      try {
        await api.post('/api/settings/smtp/test', { ...values(), to: $('#ml-to', m.body).value.trim() });
        m.close();
        toast(t('Test e-mail sent. Check the inbox (and the spam folder).'), 'success');
      } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
    };
  };
  return null;
}
