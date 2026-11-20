// Formats alerts and delivers them to ntfy (phone/tablet/desktop app), Pushover and/or a generic webhook.
// Uses the global fetch built into Node 22: no dependencies.

const LABEL = { critical: 'Critical', warning: 'Warning', routine: 'Routine' };
const NTFY_PRIORITY = { critical: 5, warning: 4, routine: 2 };
const PUSHOVER_PRIORITY = { critical: 1, warning: 0, routine: -1 };
const NTFY_TAGS = { critical: ['rotating_light'], warning: ['warning'], routine: ['wrench'], resolved: ['white_check_mark'] };

export function formatTime(ms, timezone, now = Date.now()) {
  if (!ms) return 'never';
  const d = new Date(ms);
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(t));
  const sameDay = day(ms) === day(now);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
  }).format(d);
}

function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

// Builds { title, body, severity, tag } for an alert lifecycle step.
export function formatAlert(kind, alert, device, ctx) {
  const name = device?.name || alert.device_id;
  if (kind === 'resolve') {
    return {
      severity: alert.severity,
      tag: 'resolved',
      title: `RESOLVED — ${name}: ${alert.title}`,
      body: [
        `Device: ${name}`,
        `Cleared: ${alert.title}`,
        `Duration: ${duration(ctx.now - alert.opened_at)}`,
        `Opened: ${formatTime(alert.opened_at, ctx.timezone, ctx.now)}`,
      ].join('\n'),
    };
  }
  const prefix = kind === 'remind' ? 'STILL OPEN — ' : kind === 'escalate' ? 'ESCALATED — ' : '';
  const lines = [`Device: ${name}`, `Issue: ${alert.issue}`];
  if (ctx.lastSeen !== undefined) lines.push(`Last successful check: ${formatTime(ctx.lastSeen, ctx.timezone, ctx.now)}`);
  lines.push(`Priority: ${LABEL[alert.severity]}`);
  if (alert.action) lines.push(`Action: ${alert.action}`);
  if (kind === 'remind') lines.push(`Open since: ${formatTime(alert.opened_at, ctx.timezone, ctx.now)} (${duration(ctx.now - alert.opened_at)})`);
  return { severity: alert.severity, tag: alert.severity, title: `${prefix}IT ALERT — ${name}: ${alert.title}`, body: lines.join('\n') };
}

async function post(url, init) {
  const res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function createNotifier(cfg, log = console) {
  const channels = [];

  if (cfg.ntfy?.topic) {
    const server = (cfg.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '');
    channels.push({
      name: 'ntfy',
      // JSON publishing avoids HTTP-header encoding limits on titles with non-ASCII characters.
      send: (m, extra) =>
        post(server, {
          headers: { 'Content-Type': 'application/json', ...(cfg.ntfy.token ? { Authorization: `Bearer ${cfg.ntfy.token}` } : {}) },
          body: JSON.stringify({
            topic: cfg.ntfy.topic,
            title: m.title,
            message: m.body,
            priority: m.tag === 'resolved' ? 3 : NTFY_PRIORITY[m.severity] || 3,
            tags: NTFY_TAGS[m.tag] || [],
            ...(cfg.ntfy.clickUrl ? { click: cfg.ntfy.clickUrl } : {}),
            ...extra,
          }),
        }),
    });
  }

  if (cfg.pushover?.token && cfg.pushover?.user) {
    channels.push({
      name: 'pushover',
      send: (m) =>
        post('https://api.pushover.net/1/messages.json', {
          body: new URLSearchParams({
            token: cfg.pushover.token,
            user: cfg.pushover.user,
            title: m.title.slice(0, 250),
            message: m.body.slice(0, 1024),
            priority: String(m.tag === 'resolved' ? -1 : PUSHOVER_PRIORITY[m.severity] ?? 0),
          }),
        }),
    });
  }

  if (cfg.webhook?.url) {
    channels.push({
      name: 'webhook',
      send: (m, extra) =>
        post(cfg.webhook.url, {
          headers: { 'Content-Type': 'application/json', ...(cfg.webhook.headers || {}) },
          body: JSON.stringify({ title: m.title, text: m.body, severity: m.severity, status: m.tag === 'resolved' ? 'resolved' : 'open', ...extra }),
        }),
    });
  }

  return {
    configured: channels.map((c) => c.name),
    // Never throws: a broken notification channel must not break monitoring.
    async send(message, extra = {}) {
      const results = await Promise.allSettled(channels.map((c) => c.send(message, extra)));
      const ok = [];
      const errors = [];
      results.forEach((r, i) => (r.status === 'fulfilled' ? ok.push(channels[i].name) : errors.push(`${channels[i].name}: ${r.reason?.message || r.reason}`)));
      if (errors.length) log.error(`Notification "${message.title}" failed: ${errors.join('; ')}`);
      if (!channels.length) log.warn(`No notification channel configured; not sent: ${message.title}`);
      return { ok, errors };
    },
  };
}
