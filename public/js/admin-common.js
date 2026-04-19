'use strict';

// Shared admin nav + utilities

function adminNav(active) {
  const links = [
    { href: '/admin',          label: 'Dashboard' },
    { href: '/admin/boards',   label: 'Boards'    },
    { href: '/admin/reports',  label: 'Reports'   },
    { href: '/admin/bans',     label: 'Bans'      },
    { href: '/admin/accounts', label: 'Accounts'  },
    { href: '/admin/flairs',      label: 'Flairs'      },
    { href: '/admin/polls',       label: 'Polls'       },
    { href: '/admin/wordfilter',  label: 'Word Filter' },
    { href: '/admin/verified',      label: 'Verified'      },
    { href: '/admin/constitution',  label: 'Constitution'  },
    { href: '/admin/danger',        label: '⚠ Danger',  danger: true }
  ];

  const nav = document.getElementById('admin-nav');
  if (!nav) return;

  nav.innerHTML = `
    <span class="brand">PoliChan <span class="dim">/ admin</span></span>
    ${links.map(l => {
      const isActive  = l.href === active;
      const style     = l.danger ? 'color:#ff4444;margin-left:auto' : '';
      const cls       = isActive ? 'active' : '';
      const onClick   = l.danger && !isActive
        ? `onclick="return confirm('You are entering the Danger Zone. Actions here are permanent and cannot be undone. Continue?')"` : '';
      return `<a href="${l.href}" class="${cls}" style="${style}" ${onClick}>${l.label}</a>`;
    }).join('')}
    <a href="/" class="dim" style="${links.some(l => l.danger) ? '' : 'margin-left:auto'}">← Site</a>
  `;
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-CA', { hour12: false });
}

function toast(msg, isError) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: isError ? '#7f1d1d' : '#14532d',
    border: `1px solid ${isError ? '#ef4444' : '#22c55e'}`,
    color: '#fff', padding: '10px 20px', borderRadius: '8px',
    fontSize: '0.82rem', zIndex: 9999, pointerEvents: 'none'
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
