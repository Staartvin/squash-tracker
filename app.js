// Squash tracker: dashboard, leaderboard, history and data entry.
// Plain JavaScript, no build step. Data lives in Supabase (or in demo mode,
// in this browser's localStorage).
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const userCfg = window.SQUASH_CONFIG || {};
  const CFG = {
    title: userCfg.title || 'Squash Crew',
    supabaseUrl: (userCfg.supabaseUrl || '').replace(/\/+$/, ''),
    supabaseKey: userCfg.supabaseKey || '',
    seasonStart: userCfg.seasonStart || '2026-09-01',
    subscriptionPrice: Number(userCfg.subscriptionPrice) || 312,
    slotValues: Object.assign({ offpeak: 10, fri_peak: 14, fri_offpeak: 10 }, userCfg.slotValues),
  };

  const SLOTS = {
    offpeak: { label: 'Off-peak', hint: 'Weekend daytime, or Mon–Thu 14–18', order: 0 },
    fri_peak: { label: 'Friday peak', hint: 'Friday 18–22', order: 1 },
    fri_offpeak: { label: 'Friday off-peak', hint: 'Subscribers only', order: 2 },
  };

  // Rating: Elo where a game's result blends the win (50%) with the share of
  // points scored (50%). Close losses still count, so improving shows up
  // before the wins do.
  const ELO_START = 1000;
  const ELO_K = 32;
  const PROVISIONAL_GAMES = 5;
  const SERIES_SLOTS = 8;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    append(el, children);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    setAttrs(el, attrs);
    append(el, children);
    return el;
  }

  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.setAttribute('class', v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  function groupBy(list, key) {
    const m = new Map();
    for (const item of list) {
      const k = key(item);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    }
    return m;
  }

  const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
  };

  // Dates are 'YYYY-MM-DD' strings, handled in UTC so they never shift.
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const toTime = (iso) => Date.parse(iso + 'T00:00:00Z');
  const fromTime = (t) => new Date(t).toISOString().slice(0, 10);
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function addYears(iso, n) {
    const d = new Date(toTime(iso));
    d.setUTCFullYear(d.getUTCFullYear() + n);
    return fromTime(d.getTime());
  }
  const weekday = (iso) => new Date(toTime(iso)).getUTCDay(); // 0 = Sunday
  function fmtDate(iso, opts) {
    return new Date(toTime(iso)).toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }, opts));
  }
  const fmtDay = (iso) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short', year: undefined });
  function fmtEuro(n) {
    const whole = Math.abs(n - Math.round(n)) < 0.005;
    return '€' + n.toLocaleString('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  const fmtPct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const fmt1 = (x) => (x == null ? '–' : x.toFixed(1));
  const fmtSigned = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(Math.round(x));

  function guessSlot(iso) {
    const wd = weekday(iso);
    return wd === 5 ? 'fri_peak' : 'offpeak';
  }

  // Each subscriber's year runs from their own start date. Players marked as
  // subscriber without a date fall back to the configured default.
  function subStart(p) {
    return p.subscription_start || (p.is_subscriber ? CFG.seasonStart : null);
  }

  // How many full subscription years have started before today (0 = first year).
  function subYearsDone(p) {
    const start = subStart(p);
    if (!start) return null;
    const today = todayIso();
    let n = 0;
    while (addYears(start, n + 1) <= today) n++;
    return n;
  }

  // ago = 0 is the current subscription year, 1 the one before, and so on.
  function subYear(p, ago) {
    const n = subYearsDone(p);
    if (n == null || n - ago < 0) return null;
    const start = addYears(subStart(p), n - ago);
    return { start, end: addYears(subStart(p), n - ago + 1) };
  }

  const lastDay = (end) => fromTime(toTime(end) - DAY);

  // ---------------------------------------------------------------------------
  // Backends
  // ---------------------------------------------------------------------------

  function supabaseBackend(url, key) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    // Legacy anon keys are JWTs and also go in Authorization; new publishable keys don't.
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;

    async function fail(res) {
      let msg = res.statusText || 'Request failed';
      try {
        const body = await res.json();
        msg = body.message || body.error || msg;
      } catch { /* not JSON */ }
      if (/players_name_key/.test(msg)) msg = 'There is already a player with that name.';
      return new Error(msg);
    }

    async function getAll(table, query) {
      const rows = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const res = await fetch(`${url}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`, { headers });
        if (!res.ok) throw await fail(res);
        const page = await res.json();
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    }

    async function rpc(fn, args) {
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
      if (!res.ok) throw await fail(res);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    return {
      demo: false,
      async load() {
        const [players, sessions, attendance, games] = await Promise.all([
          getAll('players', 'select=*&order=created_at'),
          getAll('sessions', 'select=*&order=played_on'),
          getAll('attendance', 'select=*&order=session_id,player_id'),
          getAll('games', 'select=*&order=id'),
        ]);
        return { players, sessions, attendance, games };
      },
      verify: (code) => rpc('verify_code', { p_code: code }),
      logSession: (code, x) => rpc('log_session', {
        p_code: code, p_played_on: x.date, p_slot: x.slot, p_player_ids: x.playerIds, p_games: x.games, p_note: x.note || null,
      }),
      deleteGame: (code, id) => rpc('delete_game', { p_code: code, p_id: id }),
      deleteSession: (code, id) => rpc('delete_session', { p_code: code, p_id: id }),
      removeAttendance: (code, sessionId, playerId) => rpc('remove_attendance', { p_code: code, p_session_id: sessionId, p_player_id: playerId }),
      savePlayer: (code, p) => rpc('save_player', {
        p_code: code, p_id: p.id || null, p_name: p.name, p_subscription_start: p.subscription_start || null, p_active: p.active !== false,
      }),
    };
  }

  // Demo mode: same interface, sample data kept in this browser only.
  function demoBackend() {
    const KEY = 'squash-tracker-demo-v2';
    const CODE = 'demo';
    let db = read() || seedDemo();
    write();

    function read() {
      try { return JSON.parse(store.get(KEY)); } catch { return null; }
    }
    function write() { store.set(KEY, JSON.stringify(db)); }
    function check(code) { if (code !== CODE) throw new Error('Wrong group code'); }
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

    return {
      demo: true,
      async load() { return clone(db); },
      async verify(code) { return code === CODE; },
      async logSession(code, x) {
        check(code);
        let sess = db.sessions.find((r) => r.played_on === x.date && r.slot === x.slot);
        if (!sess) {
          sess = { id: uuid(), played_on: x.date, slot: x.slot, note: x.note || null, created_at: new Date().toISOString() };
          db.sessions.push(sess);
        } else if (x.note) {
          sess.note = x.note;
        }
        const ids = new Set(x.playerIds);
        for (const g of x.games) {
          db.games.push({ id: ++db.seq, session_id: sess.id, player_a: g.a, player_b: g.b, score_a: g.sa, score_b: g.sb, created_at: new Date().toISOString() });
          ids.add(g.a);
          ids.add(g.b);
        }
        for (const pid of ids) {
          if (!db.attendance.some((a) => a.session_id === sess.id && a.player_id === pid)) db.attendance.push({ session_id: sess.id, player_id: pid });
        }
        write();
        return sess.id;
      },
      async deleteGame(code, id) {
        check(code);
        db.games = db.games.filter((g) => g.id !== id);
        write();
      },
      async deleteSession(code, id) {
        check(code);
        db.sessions = db.sessions.filter((r) => r.id !== id);
        db.games = db.games.filter((g) => g.session_id !== id);
        db.attendance = db.attendance.filter((a) => a.session_id !== id);
        write();
      },
      async removeAttendance(code, sessionId, playerId) {
        check(code);
        if (db.games.some((g) => g.session_id === sessionId && (g.player_a === playerId || g.player_b === playerId))) {
          throw new Error('This player has games in this session. Delete those games first.');
        }
        db.attendance = db.attendance.filter((a) => !(a.session_id === sessionId && a.player_id === playerId));
        write();
      },
      async savePlayer(code, p) {
        check(code);
        const name = (p.name || '').trim();
        if (!name || name.length > 40) throw new Error('Names need 1 to 40 characters.');
        if (db.players.some((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== p.id)) throw new Error('There is already a player with that name.');
        if (p.id) {
          Object.assign(db.players.find((r) => r.id === p.id), { name, is_subscriber: !!p.subscription_start, subscription_start: p.subscription_start || null, active: p.active !== false });
          write();
          return p.id;
        }
        const id = uuid();
        db.players.push({ id, name, is_subscriber: !!p.subscription_start, subscription_start: p.subscription_start || null, active: true, created_at: new Date().toISOString() });
        write();
        return id;
      },
      reset() {
        db = seedDemo();
        write();
      },
    };
  }

  function seedDemo() {
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const people = [
      { name: 'Vincent', since: CFG.seasonStart, skill: (f) => 0.40 + 0.14 * f, show: 0.9 },
      { name: 'Sam', since: CFG.seasonStart, skill: () => 0.62, show: 0.85 },
      { name: 'Joris', since: fromTime(toTime(todayIso()) - 2 * DAY), skill: () => 0.57, show: 0.8 },
      { name: 'Mila', since: null, skill: () => 0.55, show: 0.45 },
      { name: 'Thijs', since: null, skill: () => 0.50, show: 0.35 },
    ];
    const t0 = Date.now() - 400 * DAY;
    const players = people.map((p, i) => ({ id: 'demo-p' + i, name: p.name, is_subscriber: !!p.since, subscription_start: p.since, active: true, created_at: new Date(t0 + i * 1000).toISOString() }));
    const db = { players, sessions: [], attendance: [], games: [], seq: 0 };

    const end = toTime(todayIso()) - DAY;
    const start = end - 210 * DAY;
    for (let t = start; t <= end; t += DAY) {
      const iso = fromTime(t);
      const wd = weekday(iso);
      let slot = null;
      if (wd === 6 && rand() < 0.75) slot = 'offpeak';
      else if (wd === 5 && rand() < 0.3) slot = rand() < 0.8 ? 'fri_peak' : 'fri_offpeak';
      if (!slot) continue;
      const here = people.map((p, i) => ({ p, i })).filter(({ p }) => rand() < p.show && (slot !== 'fri_offpeak' || p.since));
      if (here.length < 2) continue;
      const id = 'demo-s' + db.sessions.length;
      db.sessions.push({ id, played_on: iso, slot, note: null, created_at: new Date(t).toISOString() });
      for (const { i } of here) db.attendance.push({ session_id: id, player_id: players[i].id });
      const progress = (t - start) / (end - start);
      const nGames = 4 + Math.floor(rand() * 5);
      for (let g = 0; g < nGames; g++) {
        const a = here[Math.floor(rand() * here.length)];
        let b = here[Math.floor(rand() * here.length)];
        while (b === a) b = here[Math.floor(rand() * here.length)];
        const sa0 = a.p.skill(progress);
        const sb0 = b.p.skill(progress);
        const pRally = 0.5 + (sa0 - sb0) * 1.1;
        let sa = 0;
        let sb = 0;
        while (!((sa >= 11 || sb >= 11) && Math.abs(sa - sb) >= 2)) {
          if (rand() < pRally) sa++;
          else sb++;
        }
        db.games.push({ id: ++db.seq, session_id: id, player_a: players[a.i].id, player_b: players[b.i].id, score_a: sa, score_b: sb, created_at: new Date(t).toISOString() });
      }
    }
    return db;
  }

  // ---------------------------------------------------------------------------
  // Derived numbers
  // ---------------------------------------------------------------------------

  function derive(raw) {
    const players = raw.players
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((p, i) => Object.assign({}, p, { color: i < SERIES_SLOTS ? `var(--s${i + 1})` : 'var(--muted)' }));
    const pById = new Map(players.map((p) => [p.id, p]));
    const sessions = raw.sessions
      .slice()
      .sort((a, b) => a.played_on.localeCompare(b.played_on) || SLOTS[a.slot].order - SLOTS[b.slot].order);
    const games = raw.games.slice().sort((a, b) => Number(a.id) - Number(b.id));
    const gamesBySession = groupBy(games, (g) => g.session_id);
    const attBySession = new Map(sessions.map((x) => [x.id, new Set()]));
    for (const a of raw.attendance) attBySession.get(a.session_id)?.add(a.player_id);

    const stats = new Map(players.map((p) => [p.id, {
      rating: ELO_START, games: 0, wins: 0, pf: 0, pa: 0, lastDelta: null,
      history: [], perSession: [], opp: new Map(), recent: [],
    }]));

    for (const sess of sessions) {
      const before = new Map();
      const tally = new Map();
      for (const g of gamesBySession.get(sess.id) || []) {
        const A = stats.get(g.player_a);
        const B = stats.get(g.player_b);
        if (!A || !B) continue;
        if (!before.has(g.player_a)) before.set(g.player_a, A.rating);
        if (!before.has(g.player_b)) before.set(g.player_b, B.rating);
        const expected = 1 / (1 + Math.pow(10, (B.rating - A.rating) / 400));
        const share = g.score_a / (g.score_a + g.score_b);
        const actual = 0.5 * (g.score_a > g.score_b ? 1 : 0) + 0.5 * share;
        const delta = ELO_K * (actual - expected);
        A.rating += delta;
        B.rating -= delta;
        record(A, g.player_a, g.player_b, g.score_a, g.score_b);
        record(B, g.player_b, g.player_a, g.score_b, g.score_a);
      }
      for (const [pid, r0] of before) {
        const P = stats.get(pid);
        P.lastDelta = P.rating - r0;
        P.history.push({ x: sess.played_on, y: P.rating });
        const t = tally.get(pid);
        P.perSession.push({ x: sess.played_on, y: t.pf / t.games, games: t.games, wins: t.wins, pf: t.pf, pa: t.pa });
      }

      function record(P, pid, oppId, pf, pa) {
        const won = pf > pa;
        P.games++;
        P.wins += won ? 1 : 0;
        P.pf += pf;
        P.pa += pa;
        if (!P.opp.has(oppId)) P.opp.set(oppId, { games: 0, wins: 0, pf: 0, pa: 0, results: [] });
        const o = P.opp.get(oppId);
        o.games++;
        o.wins += won ? 1 : 0;
        o.pf += pf;
        o.pa += pa;
        o.results.push(won ? 'W' : 'L');
        P.recent.push({ date: sess.played_on, oppId, pf, pa });
        if (!tally.has(pid)) tally.set(pid, { games: 0, wins: 0, pf: 0, pa: 0 });
        const t = tally.get(pid);
        t.games++;
        t.wins += won ? 1 : 0;
        t.pf += pf;
        t.pa += pa;
      }
    }

    const ranked = players
      .filter((p) => stats.get(p.id).games > 0)
      .sort((a, b) => stats.get(b.id).rating - stats.get(a.id).rating);
    const rankOf = new Map(ranked.map((p, i) => [p.id, i + 1]));

    return { players, pById, sessions, games, gamesBySession, attBySession, stats, ranked, rankOf };
  }

  function visitValue(d, playerId, from, to) {
    let total = 0;
    let visits = 0;
    for (const sess of d.sessions) {
      if (sess.played_on < from || sess.played_on >= to) continue;
      if (!d.attBySession.get(sess.id)?.has(playerId)) continue;
      total += CFG.slotValues[sess.slot] || 0;
      visits++;
    }
    return { total, visits };
  }

  function breakEven(d, ago) {
    const price = CFG.subscriptionPrice;
    const today = todayIso();
    return d.players
      .map((p) => ({ p, season: subYear(p, ago) }))
      .filter((x) => x.season)
      .map(({ p, season }) => {
        const seasonDays = (toTime(season.end) - toTime(season.start)) / DAY;
        const elapsedDays = Math.max(0, Math.min(seasonDays, (toTime(today) - toTime(season.start)) / DAY + 1));
        let total = 0;
        let visits = 0;
        let crossed = null;
        const points = [{ x: season.start, y: 0 }];
        for (const sess of d.sessions) {
          if (sess.played_on < season.start || sess.played_on >= season.end) continue;
          if (!d.attBySession.get(sess.id)?.has(p.id)) continue;
          total += CFG.slotValues[sess.slot] || 0;
          visits++;
          points.push({ x: sess.played_on, y: total });
          if (!crossed && total >= price) crossed = sess.played_on;
        }
        let projected = null;
        let projectedDate = null;
        if (!crossed && total > 0 && elapsedDays >= 21 && today < season.end) {
          const perDay = total / elapsedDays;
          projected = perDay * seasonDays;
          const t = toTime(season.start) + (price / perDay) * DAY;
          if (t < toTime(season.end)) projectedDate = fromTime(t);
        }
        return { player: p, season, total, visits, crossed, points, projected, projectedDate };
      });
  }

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
  }

  function timeTicks(t0, t1, maxTicks) {
    const months = [];
    const d = new Date(t0);
    d.setUTCDate(1);
    if (d.getTime() < t0) d.setUTCMonth(d.getUTCMonth() + 1);
    while (d.getTime() <= t1) {
      months.push(d.getTime());
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    if (months.length >= 2) {
      const every = Math.ceil(months.length / maxTicks);
      return months.filter((_, i) => i % every === 0).map((t, i) => {
        const dt = new Date(t);
        const showYear = i === 0 || dt.getUTCMonth() === 0;
        return { t, label: dt.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: showYear ? 'numeric' : undefined }) };
      });
    }
    const weeks = [];
    const every = Math.max(1, Math.ceil((t1 - t0) / DAY / 7 / maxTicks)) * 7;
    for (let t = t0; t <= t1; t += every * DAY) weeks.push({ t, label: fmtDate(fromTime(t), { year: undefined }) });
    return weeks;
  }

  function valueAt(points, x) {
    let v = null;
    for (const p of points) {
      if (p.x <= x) v = p;
      else break;
    }
    return v;
  }

  const tooltipEl = () => document.getElementById('tooltip');

  function showTooltip(title, rows, clientX, clientY) {
    const tt = tooltipEl();
    tt.replaceChildren(
      h('div', { class: 'tt-title' }, title),
      ...rows.map((r) => h('div', { class: 'tt-row' },
        r.color ? h('span', { class: 'key-line', style: `background:${r.color}` }) : null,
        h('strong', null, r.value),
        h('span', null, r.name || ''))),
    );
    tt.hidden = false;
    const rect = tt.getBoundingClientRect();
    let left = clientX + 14;
    if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - 14;
    let top = clientY - rect.height - 12;
    if (top < 8) top = clientY + 16;
    tt.style.left = Math.max(8, left) + 'px';
    tt.style.top = top + 'px';
  }
  const hideTooltip = () => { tooltipEl().hidden = true; };

  // series: [{ id, name, color, points: [{x: iso, y}] }]
  function lineChart(opts) {
    const {
      series, xDomain, target, yFmt = (v) => String(Math.round(v)), height = 240,
      curve = 'step', label, tableX = 'Date', yMin, yMax, dots = false,
    } = opts;
    const root = h('div', { class: 'chart' });
    const usable = series.filter((x) => x.points.length);
    if (!usable.length) return h('p', { class: 'empty' }, 'Nothing to chart yet.');

    if (usable.length >= 2) {
      root.append(h('div', { class: 'legend', 'aria-hidden': 'true' },
        usable.map((x) => h('span', { class: 'legend-item' }, h('span', { class: 'key-line', style: `background:${x.color}` }), x.name))));
    }
    const holder = h('div');
    root.append(holder);

    const allX = [...new Set(usable.flatMap((x) => x.points.map((p) => p.x)))].sort();

    function draw() {
      const W = Math.max(280, holder.clientWidth || root.clientWidth || 600);
      const labelSpace = usable.length <= 4 ? Math.min(90, Math.max(56, ...usable.map((x) => x.name.length * 7 + 12))) : 12;
      const M = { l: 40, r: labelSpace, t: target ? 22 : 10, b: 26 };
      const iw = W - M.l - M.r;
      const ih = height - M.t - M.b;

      let t0 = toTime(xDomain ? xDomain[0] : allX[0]);
      let t1 = toTime(xDomain ? xDomain[1] : allX[allX.length - 1]);
      if (t1 - t0 < 7 * DAY) { t0 -= 3 * DAY; t1 += 3 * DAY; }
      const ys = usable.flatMap((x) => x.points.map((p) => p.y));
      if (target) ys.push(target.y);
      const yScale = niceTicks(yMin ?? Math.min(...ys), yMax ?? Math.max(...ys), 4);
      const X = (iso) => M.l + ((toTime(iso) - t0) / (t1 - t0)) * iw;
      const Y = (v) => M.t + ih - ((v - yScale.lo) / (yScale.hi - yScale.lo)) * ih;

      const svg = s('svg', {
        viewBox: `0 0 ${W} ${height}`, height, role: 'img', tabindex: 0,
        'aria-label': label + '. Use the arrow keys to read values, or open the table below.',
      });

      const grid = s('g');
      for (const v of yScale.ticks) {
        grid.append(s('line', { x1: M.l, x2: M.l + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
        grid.append(s('text', { x: M.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, yFmt(v)));
      }
      grid.append(s('line', { x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
      for (const tk of timeTicks(t0, t1, Math.max(2, Math.floor(iw / 70)))) {
        const x = M.l + ((tk.t - t0) / (t1 - t0)) * iw;
        grid.append(s('text', { x, y: height - 6, 'text-anchor': 'middle' }, tk.label));
      }
      svg.append(grid);

      if (target) {
        svg.append(s('line', { x1: M.l, x2: M.l + iw, y1: Y(target.y), y2: Y(target.y), stroke: 'var(--ink-2)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
        svg.append(s('text', { class: 'target-label', x: M.l + iw, y: Y(target.y) - 6, 'text-anchor': 'end' }, target.label));
      }

      const ends = [];
      for (const ser of usable) {
        const pts = ser.points;
        let d = '';
        pts.forEach((p, i) => {
          const x = X(p.x);
          const y = Y(p.y);
          if (i === 0) d += `M${x},${y}`;
          else if (curve === 'step') d += `H${x}V${y}`;
          else d += `L${x},${y}`;
        });
        const last = pts[pts.length - 1];
        const extendTo = ser.extendTo || opts.extendTo;
        if (extendTo && curve === 'step') {
          const xe = Math.min(X(extendTo), M.l + iw);
          if (xe > X(last.x)) d += `H${xe}`;
        }
        svg.append(s('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        if (dots) {
          for (const p of pts) svg.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: 4, fill: ser.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
        } else {
          svg.append(s('circle', { cx: X(last.x), cy: Y(last.y), r: 4, fill: ser.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
        }
        ends.push({ ser, x: X(last.x), y: Y(last.y), v: last.y });
      }

      // Direct end labels, only when there are few series and they don't collide.
      if (usable.length <= 4) {
        const sorted = ends.slice().sort((a, b) => a.y - b.y);
        const clear = sorted.every((e, i) => i === 0 || e.y - sorted[i - 1].y >= 14);
        if (clear) {
          for (const e of ends) {
            const lx = Math.max(e.x, M.l + iw) + 8;
            svg.append(s('text', { class: 'end-label', x: lx, y: e.y + 4 }, usable.length > 1 ? e.ser.name : yFmt(e.v)));
          }
        }
      }

      // Hover / keyboard layer.
      const cross = s('line', { y1: M.t, y2: M.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
      const marks = s('g', { visibility: 'hidden' });
      svg.append(cross, marks);
      const hit = s('rect', { x: M.l, y: 0, width: iw + 8, height, fill: 'transparent' });
      svg.append(hit);

      let idx = -1;
      function focusAt(i, clientX, clientY) {
        idx = Math.max(0, Math.min(allX.length - 1, i));
        const xIso = allX[idx];
        const x = X(xIso);
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);
        cross.setAttribute('visibility', 'visible');
        marks.replaceChildren();
        const rows = [];
        for (const ser of usable) {
          const p = valueAt(ser.points, xIso);
          if (!p) continue;
          marks.append(s('circle', { cx: x, cy: Y(p.y), r: 5, fill: ser.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
          rows.push({ color: ser.color, value: yFmt(p.y), name: usable.length > 1 ? ser.name : (ser.detail ? ser.detail(p) : ''), sort: p.y });
        }
        marks.setAttribute('visibility', 'visible');
        rows.sort((a, b) => b.sort - a.sort);
        if (clientX == null) {
          const r = svg.getBoundingClientRect();
          clientX = r.left + (x / W) * r.width;
          clientY = r.top + M.t;
        }
        showTooltip(fmtDay(xIso), rows, clientX, clientY);
      }
      function clear() {
        cross.setAttribute('visibility', 'hidden');
        marks.setAttribute('visibility', 'hidden');
        hideTooltip();
      }
      function nearest(clientX) {
        const r = svg.getBoundingClientRect();
        const px = ((clientX - r.left) / r.width) * W;
        let best = 0;
        let bestD = Infinity;
        allX.forEach((xi, i) => {
          const dd = Math.abs(X(xi) - px);
          if (dd < bestD) { bestD = dd; best = i; }
        });
        return best;
      }
      hit.addEventListener('pointermove', (e) => focusAt(nearest(e.clientX), e.clientX, e.clientY));
      hit.addEventListener('pointerdown', (e) => focusAt(nearest(e.clientX), e.clientX, e.clientY));
      hit.addEventListener('pointerleave', clear);
      svg.addEventListener('blur', clear);
      svg.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          focusAt(idx < 0 ? (e.key === 'ArrowRight' ? 0 : allX.length - 1) : idx + (e.key === 'ArrowRight' ? 1 : -1));
        } else if (e.key === 'Escape') {
          clear();
        }
      });

      holder.replaceChildren(svg);
    }

    let lastW = 0;
    const ro = new ResizeObserver(() => {
      const w = holder.clientWidth;
      if (w && Math.abs(w - lastW) > 4) { lastW = w; draw(); }
    });
    ro.observe(holder);
    setTimeout(() => { if (!lastW) { lastW = holder.clientWidth; draw(); } }, 0);

    // Table twin: every value is reachable without hovering.
    const tbl = h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, tableX), usable.map((x) => h('th', { class: 'num' }, x.name)))),
      h('tbody', null, allX.slice().reverse().map((xi) => h('tr', null,
        h('td', null, fmtDay(xi)),
        usable.map((ser) => {
          const p = ser.points.find((q) => q.x === xi) || (curve === 'step' ? valueAt(ser.points, xi) : null);
          return h('td', { class: 'num' }, p ? yFmt(p.y) : '–');
        })))));
    root.append(h('details', { class: 'table-view' }, h('summary', null, 'Show as table'), h('div', { class: 'table-wrap' }, tbl)));
    return root;
  }

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------

  const api = CFG.supabaseUrl && CFG.supabaseKey ? supabaseBackend(CFG.supabaseUrl, CFG.supabaseKey) : demoBackend();
  const CODE_KEY = 'squash-tracker-code' + (api.demo ? '-demo' : '');
  const DRAFT_KEY = 'squash-tracker-draft';

  const state = {
    raw: null,
    d: null,
    error: null,
    code: store.get(CODE_KEY),
    unlocked: false,
    seasonK: null,
    draft: loadDraft(),
  };

  function loadDraft() {
    try {
      const d = JSON.parse(store.get(DRAFT_KEY));
      if (d && d.date && d.slot && Array.isArray(d.games)) return d;
    } catch { /* ignore */ }
    return freshDraft();
  }
  function freshDraft() {
    const date = todayIso();
    return { date, slot: guessSlot(date), playerIds: [], games: [], note: '' };
  }
  const saveDraft = () => store.set(DRAFT_KEY, JSON.stringify(state.draft));

  async function reload() {
    try {
      state.raw = await api.load();
      state.d = derive(state.raw);
      state.error = null;
    } catch (e) {
      state.error = e;
    }
    render();
  }

  async function unlock(code) {
    const ok = await api.verify(code);
    if (ok) {
      state.code = code;
      state.unlocked = true;
      store.set(CODE_KEY, code);
    }
    return ok;
  }

  function lock() {
    state.code = null;
    state.unlocked = false;
    store.del(CODE_KEY);
    render();
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function act(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await reload();
      return true;
    } catch (e) {
      if (/group code/i.test(e.message)) { state.unlocked = false; store.del(CODE_KEY); }
      alert(e.message);
      render();
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  function route() {
    const [view, arg] = (location.hash.replace(/^#/, '') || 'dashboard').split('/');
    return { view: ['dashboard', 'players', 'history', 'log'].includes(view) ? view : 'dashboard', arg: arg ? decodeURIComponent(arg) : null };
  }

  function render() {
    hideTooltip();
    const { view, arg } = route();
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    renderBanner();
    const app = document.getElementById('app');
    if (state.error) {
      app.replaceChildren(h('div', { class: 'card' },
        h('h2', null, 'Could not load the data'),
        h('p', { class: 'sub' }, state.error.message),
        h('button', { class: 'btn', onclick: reload }, 'Try again')));
      return;
    }
    if (!state.d) {
      app.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
      return;
    }
    const scrollY = window.scrollY;
    const views = { dashboard: viewDashboard, players: () => viewPlayers(arg), history: viewHistory, log: viewLog };
    app.replaceChildren(views[view]());
    if (view === 'log') window.scrollTo(0, scrollY);
  }

  function renderBanner() {
    const el = document.getElementById('banner');
    if (!api.demo) { el.replaceChildren(); return; }
    el.className = 'banner';
    el.replaceChildren(h('div', { class: 'banner-inner' },
      h('span', null, h('strong', null, 'Demo mode. '), 'Sample data, saved only in this browser. The group code is ', h('strong', null, 'demo'), '. Add your Supabase details to config.js to share real data.'),
      h('button', {
        class: 'btn btn-small', onclick: () => {
          if (!confirm('Replace everything in demo mode with fresh sample data?')) return;
          api.reset();
          reload();
        },
      }, 'Reset demo data')));
  }

  function nameOf(id) { return state.d.pById.get(id)?.name || 'Unknown'; }
  function dotFor(id) { return h('span', { class: 'dot', style: `background:${state.d.pById.get(id)?.color || 'var(--muted)'}`, 'aria-hidden': 'true' }); }

  // ----- Dashboard

  function viewDashboard() {
    const d = state.d;
    const maxAgo = Math.max(0, ...d.players.map(subYearsDone).filter((n) => n != null));
    if (state.seasonK == null || state.seasonK > maxAgo) state.seasonK = 0;
    const yearLabel = (ago) => (ago === 0 ? 'Current year' : ago === 1 ? 'Previous year' : `${ago} years ago`);

    const frag = h('div');
    frag.append(h('div', { class: 'view-head' },
      h('h1', null, CFG.title),
      maxAgo > 0 ? h('label', { class: 'muted small' }, 'Subscription ',
        h('select', {
          style: 'width:auto;min-height:32px;padding:4px 8px',
          onchange: (e) => { state.seasonK = Number(e.target.value); render(); },
        }, Array.from({ length: maxAgo + 1 }, (_, ago) => h('option', { value: ago, selected: ago === state.seasonK }, yearLabel(ago))))) : null));

    if (!d.players.length) {
      frag.append(h('div', { class: 'card' },
        h('h2', null, 'Welcome'),
        h('p', { class: 'sub' }, 'Start by adding the players, then log your first session.'),
        h('a', { class: 'btn btn-primary', href: '#log', style: 'display:inline-block;text-decoration:none' }, 'Add players')));
      return frag;
    }

    frag.append(breakEvenCard(state.seasonK));
    frag.append(leaderboardCard());
    if (d.ranked.length) frag.append(ratingChartCard());
    if (d.ranked.length >= 2) frag.append(headToHeadCard());
    return frag;
  }

  function breakEvenCard(ago) {
    const d = state.d;
    const price = CFG.subscriptionPrice;
    const rows = breakEven(d, ago);
    const today = todayIso();
    const card = h('section', { class: 'card' },
      h('h2', null, 'Subscription break-even'),
      h('p', { class: 'sub' },
        `${fmtEuro(price)} per person per year, counted from each person's own start date. Each visit counts what you'd otherwise pay: ${fmtEuro(CFG.slotValues.offpeak)} off-peak, ${fmtEuro(CFG.slotValues.fri_peak)} Friday peak.`));

    if (!rows.length) {
      card.append(h('p', { class: 'empty' }, 'No subscribers yet. Fill in "Subscriber since" for a player on the Log page.'));
    }

    card.append(h('div', { class: 'meters' }, rows.map((r) => {
      const pct = Math.min(1, r.total / price);
      const done = r.total >= price;
      const toGo = Math.max(0, price - r.total);
      const running = today >= r.season.start && today < r.season.end;
      const daysLeft = Math.round((toTime(r.season.end) - toTime(today)) / DAY);
      const notes = [];
      notes.push(h('span', null, `${r.visits} visit${r.visits === 1 ? '' : 's'}`));
      if (done) {
        notes.push(h('span', { class: 'badge-good' }, '✓ Broke even on ' + fmtDate(r.crossed, { year: undefined })));
        notes.push(h('span', null, `${fmtEuro(r.total - price)} ahead`));
      } else if (!running && today >= r.season.end) {
        notes.push(h('span', null, `Ended ${fmtEuro(toGo)} short`));
      } else {
        notes.push(h('span', null, `${Math.ceil(toGo / CFG.slotValues.offpeak)} more off-peak visits to go (or ${Math.ceil(toGo / CFG.slotValues.fri_peak)} Friday peak)`));
        if (r.projectedDate) notes.push(h('span', null, 'At this pace: break-even around ' + fmtDate(r.projectedDate)));
        else if (r.projected != null) notes.push(h('span', null, `At this pace: ${fmtEuro(Math.round(r.projected))} by the end of the year, ${fmtEuro(Math.round(price - r.projected))} short`));
      }
      return h('div', { class: 'meter' + (done ? ' done' : '') },
        h('div', { class: 'meter-top' },
          h('span', { class: 'meter-name' }, dotFor(r.player.id), r.player.name,
            h('span', { class: 'muted small', style: 'font-weight:400' },
              `${fmtDate(r.season.start)} – ${fmtDate(lastDay(r.season.end))}`,
              running ? ` · ${daysLeft} days left` : today < r.season.start ? ' · not started yet' : '')),
          h('span', { class: 'meter-amount' }, h('strong', null, fmtEuro(r.total)), h('span', { class: 'muted' }, ` of ${fmtEuro(price)}`))),
        h('div', {
          class: 'meter-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': price, 'aria-valuenow': Math.round(r.total),
          'aria-label': `${r.player.name}: ${fmtEuro(r.total)} of ${fmtEuro(price)}`,
        }, h('div', { class: 'meter-fill', style: `width:${(pct * 100).toFixed(1)}%` })),
        h('div', { class: 'meter-note' }, notes));
    })));

    if (rows.some((r) => r.visits > 0)) {
      const from = rows.map((r) => r.season.start).sort()[0];
      const to = rows.map((r) => lastDay(r.season.end)).sort().pop();
      card.append(lineChart({
        label: 'Value of visits so far this subscription year per subscriber, against the subscription price',
        series: rows.map((r) => ({
          id: r.player.id, name: r.player.name, color: r.player.color, points: r.points,
          extendTo: today < lastDay(r.season.end) ? today : lastDay(r.season.end),
        })),
        xDomain: [from, to],
        target: { y: price, label: `${fmtEuro(price)} subscription` },
        yMin: 0,
        yFmt: (v) => fmtEuro(Math.round(v)),
        curve: 'step',
        height: 220,
      }));
    }

    // What a subscription would be worth to the people who don't have one.
    if (ago === 0) {
      const yearAgo = addYears(today, -1);
      const tomorrow = fromTime(toTime(today) + DAY);
      const others = d.players.filter((p) => !subStart(p) && p.active !== false);
      if (others.length) {
        card.append(h('div', { class: 'what-if' },
          h('h3', null, 'Without a subscription'),
          h('ul', null, others.map((p) => {
            const v = visitValue(d, p.id, yearAgo, tomorrow);
            return h('li', null, dotFor(p.id), h('strong', null, p.name), ' ',
              v.visits
                ? `${v.visits} visit${v.visits === 1 ? '' : 's'} in the last 12 months, about ${fmtEuro(v.total)} paid. ` +
                  (v.total >= price ? 'A subscription would have paid off.' : `A subscription pays off after ${fmtEuro(price - v.total)} more.`)
                : 'no visits logged in the last 12 months.');
          }))));
      }
    }
    return card;
  }

  function leaderboardCard() {
    const d = state.d;
    const card = h('section', { class: 'card' },
      h('h2', null, 'Leaderboard'),
      h('p', { class: 'sub' }, 'All games, all time. Ranked by rating; tap a player for their progress.'));
    if (!d.ranked.length) {
      card.append(h('p', { class: 'empty' }, 'No games yet. Log a session to get the leaderboard going.'));
      return card;
    }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null,
        h('th', null, '#'), h('th', null, 'Player'), h('th', { class: 'num' }, 'Rating'), h('th', { class: 'num' }, 'Last'),
        h('th', { class: 'num' }, 'Games'), h('th', { class: 'num' }, 'W–L'), h('th', { class: 'num' }, 'Win %'), h('th', { class: 'num', title: 'Average points scored per game' }, 'Pts/game'))),
      h('tbody', null, d.ranked.map((p, i) => {
        const st = d.stats.get(p.id);
        const delta = st.lastDelta;
        return h('tr', { class: 'clickable', tabindex: 0, onclick: () => { location.hash = '#players/' + encodeURIComponent(p.id); }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = '#players/' + encodeURIComponent(p.id); } },
          h('td', { class: 'rank num' }, i + 1),
          h('td', null, h('span', { class: 'player-cell' }, dotFor(p.id), p.name, st.games < PROVISIONAL_GAMES ? h('span', { class: 'tag', title: `Fewer than ${PROVISIONAL_GAMES} games` }, 'new') : null)),
          h('td', { class: 'num' }, h('strong', null, Math.round(st.rating))),
          h('td', { class: 'num ' + (delta > 0.5 ? 'delta-up' : delta < -0.5 ? 'delta-down' : 'muted') }, delta == null ? '–' : (delta > 0.5 ? '▲ ' : delta < -0.5 ? '▼ ' : '') + fmtSigned(delta)),
          h('td', { class: 'num' }, st.games),
          h('td', { class: 'num' }, `${st.wins}–${st.games - st.wins}`),
          h('td', { class: 'num' }, fmtPct(st.wins / st.games)),
          h('td', { class: 'num' }, fmt1(st.pf / st.games)));
      })))));
    card.append(h('details', { class: 'explain' },
      h('summary', null, 'How the rating works'),
      h('p', null, `Everyone starts at ${ELO_START}. After each game, points move from one player to the other based on how the result compares with what the ratings predicted. Beating a higher-rated player earns more than beating a lower-rated one.`),
      h('p', null, 'The result of a game is half the win and half the share of points you scored. So losing 9–11 to someone much stronger can still raise your rating, and improving shows up before the wins do.'),
      h('p', null, `"Last" is the change in your most recent session. Players marked "new" have fewer than ${PROVISIONAL_GAMES} games, so their rating is still settling.`)));
    return card;
  }

  function ratingChartCard() {
    const d = state.d;
    return h('section', { class: 'card' },
      h('h2', null, 'Rating over time'),
      h('p', { class: 'sub' }, 'Each step is a session.'),
      lineChart({
        label: 'Rating over time per player',
        series: d.ranked.map((p) => ({ id: p.id, name: p.name, color: p.color, points: d.stats.get(p.id).history })),
        extendTo: d.sessions.length ? d.sessions[d.sessions.length - 1].played_on : null,
        curve: 'step',
        yFmt: (v) => String(Math.round(v)),
      }));
  }

  function headToHeadCard() {
    const d = state.d;
    const ps = d.ranked;
    return h('section', { class: 'card' },
      h('h2', null, 'Head to head'),
      h('p', { class: 'sub' }, 'Row player\'s record against the column player: wins–losses, then average score per game.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, ''), ps.map((p) => h('th', { class: 'num' }, h('span', { class: 'player-cell' }, dotFor(p.id), p.name))))),
        h('tbody', null, ps.map((row) => h('tr', null,
          h('th', { scope: 'row' }, h('span', { class: 'player-cell' }, dotFor(row.id), row.name)),
          ps.map((col) => {
            if (row.id === col.id) return h('td', { class: 'num muted' }, '');
            const o = d.stats.get(row.id).opp.get(col.id);
            if (!o) return h('td', { class: 'num muted' }, '–');
            return h('td', { class: 'num' },
              h('div', null, h('strong', null, `${o.wins}–${o.games - o.wins}`)),
              h('div', { class: 'muted small' }, `${fmt1(o.pf / o.games)}–${fmt1(o.pa / o.games)}`));
          })))))));
  }

  // ----- Players

  function viewPlayers(arg) {
    const d = state.d;
    const frag = h('div');
    const withGames = d.players.filter((p) => d.stats.get(p.id).games > 0);
    const pid = arg && d.pById.has(arg) ? arg : (withGames[0] || d.players[0])?.id;
    if (!pid) {
      frag.append(h('div', { class: 'view-head' }, h('h1', null, 'Players')), h('p', { class: 'empty' }, 'No players yet. Add them on the Log page.'));
      return frag;
    }
    const p = d.pById.get(pid);
    const st = d.stats.get(pid);
    frag.append(h('div', { class: 'view-head' },
      h('h1', null, p.name),
      h('select', {
        'aria-label': 'Choose a player', style: 'width:auto',
        onchange: (e) => { location.hash = '#players/' + encodeURIComponent(e.target.value); },
      }, d.players.map((x) => h('option', { value: x.id, selected: x.id === pid }, x.name)))));

    if (!st.games) {
      frag.append(h('p', { class: 'empty' }, `${p.name} hasn't played any logged games yet.`));
      return frag;
    }

    const today = todayIso();
    const subYr = subYear(p, 0);
    const visitWindow = subYr
      ? { ...visitValue(d, pid, subYr.start, subYr.end), label: `since ${fmtDate(subYr.start)}` }
      : { ...visitValue(d, pid, addYears(today, -1), fromTime(toTime(today) + DAY)), label: 'last 12 months' };
    const first = st.perSession.slice(0, 3);
    const last = st.perSession.slice(-3);
    const avg = (xs) => xs.reduce((a, x) => a + x.pf, 0) / xs.reduce((a, x) => a + x.games, 0);
    const trend = st.perSession.length >= 6 ? avg(last) - avg(first) : null;

    frag.append(h('div', { class: 'tiles' },
      tile('Rating', Math.round(st.rating), d.rankOf.has(pid) ? `#${d.rankOf.get(pid)} of ${d.ranked.length}` : ''),
      tile('Games', st.games, `${st.wins} won, ${st.games - st.wins} lost`),
      tile('Win rate', fmtPct(st.wins / st.games), ''),
      tile('Points per game', fmt1(st.pf / st.games),
        trend == null ? `conceded ${fmt1(st.pa / st.games)}` : h('span', { class: trend > 0.05 ? 'delta-up' : trend < -0.05 ? 'delta-down' : '' }, `${trend >= 0 ? '+' : '−'}${Math.abs(trend).toFixed(1)} vs first 3 sessions`)),
      tile('Visits', visitWindow.visits, `${visitWindow.label} · worth ${fmtEuro(visitWindow.total)}`)));

    frag.append(h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('h2', null, 'Points per game'),
        h('p', { class: 'sub' }, 'Average points scored per game, per session. Rising means you are taking more points off the others.'),
        lineChart({
          label: `${p.name}: average points per game per session`,
          series: [{ id: pid, name: p.name, color: p.color, points: st.perSession, detail: (pt) => `${pt.games} game${pt.games === 1 ? '' : 's'}, ${pt.wins} won` }],
          curve: 'linear', dots: st.perSession.length <= 40, yMin: 0, yMax: Math.max(11, ...st.perSession.map((x) => x.y)),
          yFmt: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)), height: 200,
        })),
      h('section', { class: 'card' },
        h('h2', null, 'Rating'),
        h('p', { class: 'sub' }, 'After each session.'),
        lineChart({
          label: `${p.name}: rating after each session`,
          series: [{ id: pid, name: p.name, color: p.color, points: st.history }],
          curve: 'linear', dots: st.history.length <= 40, height: 200,
        }))));

    const opps = [...st.opp.entries()].sort((a, b) => b[1].games - a[1].games);
    frag.append(h('section', { class: 'card' },
      h('h2', null, 'Against each opponent'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Opponent'), h('th', { class: 'num' }, 'Games'), h('th', { class: 'num' }, 'W–L'), h('th', { class: 'num' }, 'Avg score'), h('th', { class: 'num' }, 'Last 5'))),
        h('tbody', null, opps.map(([oid, o]) => h('tr', null,
          h('td', null, h('span', { class: 'player-cell' }, dotFor(oid), nameOf(oid))),
          h('td', { class: 'num' }, o.games),
          h('td', { class: 'num' }, `${o.wins}–${o.games - o.wins}`),
          h('td', { class: 'num' }, `${fmt1(o.pf / o.games)}–${fmt1(o.pa / o.games)}`),
          h('td', { class: 'num' }, o.results.slice(-5).join(' ')))))))));

    frag.append(h('section', { class: 'card' },
      h('h2', null, 'Recent games'),
      h('ul', { class: 'game-list' }, st.recent.slice(-10).reverse().map((g) => h('li', null,
        h('span', { class: 'muted small', style: 'min-width:92px' }, fmtDay(g.date)),
        h('span', { class: 'score' }, `${g.pf}–${g.pa}`),
        h('span', { class: 'muted' }, g.pf > g.pa ? 'beat' : 'lost to'),
        h('span', { class: 'side' }, dotFor(g.oppId), h('span', null, nameOf(g.oppId))))))));
    return frag;
  }

  function tile(label, value, delta) {
    return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), delta ? h('div', { class: 'delta' }, delta) : null);
  }

  // ----- History

  function viewHistory() {
    const d = state.d;
    const frag = h('div');
    frag.append(h('div', { class: 'view-head' }, h('h1', null, 'History'),
      state.unlocked ? h('span', { class: 'muted small' }, 'Editing is on') : h('a', { class: 'small', href: '#log' }, 'Enter the group code to edit')));
    if (!d.sessions.length) {
      frag.append(h('p', { class: 'empty' }, 'No sessions logged yet.'));
      return frag;
    }
    let month = null;
    for (const sess of d.sessions.slice().reverse()) {
      const m = fmtDate(sess.played_on, { day: undefined, month: 'long', year: 'numeric' });
      if (m !== month) {
        month = m;
        frag.append(h('h2', { class: 'month-head' }, m));
      }
      frag.append(sessionCard(sess));
    }
    return frag;
  }

  function sessionCard(sess) {
    const d = state.d;
    const games = d.gamesBySession.get(sess.id) || [];
    const att = [...(d.attBySession.get(sess.id) || [])].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const edit = state.unlocked;
    return h('article', { class: 'card' },
      h('div', { class: 'session-head' },
        h('h3', null, fmtDay(sess.played_on)),
        h('span', { class: 'pill' }, SLOTS[sess.slot].label),
        h('span', { class: 'muted small' }, `${fmtEuro(CFG.slotValues[sess.slot] || 0)} per subscriber`),
        edit ? h('button', {
          class: 'btn btn-small btn-ghost',
          onclick: () => {
            if (!confirm(`Delete the whole session on ${fmtDay(sess.played_on)}, including ${games.length} game(s)?`)) return;
            act(() => api.deleteSession(state.code, sess.id), 'Session deleted');
          },
        }, 'Delete session') : null),
      sess.note ? h('p', { class: 'muted small', style: 'margin:6px 0 0' }, sess.note) : null,
      h('div', { class: 'people' }, att.map((pid) => h('span', { class: 'person' }, dotFor(pid), nameOf(pid),
        edit ? h('button', {
          class: 'btn-icon', 'aria-label': `Remove ${nameOf(pid)} from this session`, title: 'Remove',
          onclick: () => act(() => api.removeAttendance(state.code, sess.id, pid), 'Removed'),
        }, '×') : null))),
      games.length ? h('ul', { class: 'game-list' }, games.map((g) => {
        const aWin = g.score_a > g.score_b;
        return h('li', null,
          h('span', { class: 'side' + (aWin ? ' win' : ''), style: 'justify-content:flex-end' }, h('span', null, nameOf(g.player_a)), dotFor(g.player_a)),
          h('span', { class: 'score' }, `${g.score_a}–${g.score_b}`),
          h('span', { class: 'side right' + (aWin ? '' : ' win') }, dotFor(g.player_b), h('span', null, nameOf(g.player_b))),
          edit ? h('button', {
            class: 'btn-icon', 'aria-label': 'Delete this game', title: 'Delete game',
            onclick: () => {
              if (!confirm(`Delete ${nameOf(g.player_a)} ${g.score_a}–${g.score_b} ${nameOf(g.player_b)}?`)) return;
              act(() => api.deleteGame(state.code, g.id), 'Game deleted');
            },
          }, '×') : null);
      })) : h('p', { class: 'muted small', style: 'margin:0' }, 'No games logged.'));
  }

  // ----- Log

  function viewLog() {
    const frag = h('div');
    frag.append(h('div', { class: 'view-head' }, h('h1', null, 'Log'),
      state.unlocked ? h('button', { class: 'btn btn-small btn-ghost', onclick: lock }, 'Lock editing') : null));
    if (!state.unlocked) {
      frag.append(unlockCard());
      return frag;
    }
    frag.append(sessionForm());
    frag.append(playersCard());
    return frag;
  }

  function unlockCard() {
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Group code', 'aria-label': 'Group code', value: '' });
    const err = h('p', { class: 'form-error', hidden: true });
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock');
    const form = h('form', {
      class: 'unlock',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.hidden = true;
        try {
          if (await unlock(input.value.trim())) { render(); return; }
          err.textContent = 'That code is not right.';
        } catch (ex) {
          err.textContent = ex.message;
        }
        err.hidden = false;
        btn.disabled = false;
      },
    }, input, btn);
    return h('section', { class: 'card' },
      h('h2', null, 'Enter the group code'),
      h('p', { class: 'sub' }, 'Anyone can look; only people with the code can add or change games. This browser remembers it.'),
      err, form);
  }

  function sessionForm() {
    const d = state.d;
    const dr = state.draft;
    const active = d.players.filter((p) => p.active !== false);
    const err = h('p', { class: 'form-error', hidden: true });

    if (!active.length) {
      return h('section', { class: 'card' }, h('h2', null, 'Log a session'), h('p', { class: 'empty' }, 'Add players below first.'));
    }

    const existing = d.sessions.find((x) => x.played_on === dr.date && x.slot === dr.slot);
    const update = (fn) => { fn(); saveDraft(); render(); };

    const dateInput = h('input', {
      type: 'date', id: 'f-date', value: dr.date, max: todayIso(), required: true,
      onchange: (e) => update(() => { dr.date = e.target.value || todayIso(); dr.slot = guessSlot(dr.date); }),
    });

    const slotChoices = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Time slot' },
      Object.entries(SLOTS).map(([key, sl]) => h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'slot', value: key, checked: dr.slot === key, onchange: () => update(() => { dr.slot = key; }) }),
        h('span', null, h('span', { class: 'choice-label' }, sl.label), h('small', null, `${sl.hint} · ${fmtEuro(CFG.slotValues[key])}`)))));

    const inGames = new Set(dr.games.flatMap((g) => [g.a, g.b]).filter(Boolean));
    const peopleChoices = h('div', { class: 'choices' }, active.map((p) => h('label', { class: 'choice' },
      h('input', {
        type: 'checkbox', checked: dr.playerIds.includes(p.id) || inGames.has(p.id), disabled: inGames.has(p.id),
        onchange: (e) => update(() => {
          dr.playerIds = e.target.checked ? [...new Set([...dr.playerIds, p.id])] : dr.playerIds.filter((x) => x !== p.id);
        }),
      }),
      h('span', null, dotFor(p.id), p.name, subStart(p) ? h('small', null, 'sub') : null))));

    const here = new Set([...dr.playerIds, ...inGames]);
    const options = active.slice().sort((a, b) => (here.has(b.id) ? 1 : 0) - (here.has(a.id) ? 1 : 0));
    const playerSelect = (value, onchange, cls, labelText) => h('select', { class: cls, 'aria-label': labelText, onchange },
      h('option', { value: '' }, 'Player…'),
      options.map((p) => h('option', { value: p.id, selected: p.id === value }, p.name)));

    const rows = h('div', { class: 'game-rows' }, dr.games.map((g, i) => {
      const scoreInput = (key, cls, labelText) => h('input', {
        type: 'number', inputmode: 'numeric', min: 0, max: 99, class: cls, 'aria-label': labelText, placeholder: '0',
        value: g[key] ?? '',
        oninput: (e) => { g[key] = e.target.value === '' ? null : Number(e.target.value); saveDraft(); },
      });
      return h('div', { class: 'game-row' },
        playerSelect(g.a, (e) => update(() => { g.a = e.target.value || null; }), 'pa', `Game ${i + 1}, first player`),
        scoreInput('sa', 'sa', `Game ${i + 1}, first player's score`),
        h('span', { class: 'vs' }, '–'),
        scoreInput('sb', 'sb', `Game ${i + 1}, second player's score`),
        playerSelect(g.b, (e) => update(() => { g.b = e.target.value || null; }), 'pb', `Game ${i + 1}, second player`),
        h('button', { type: 'button', class: 'btn-icon del', 'aria-label': `Remove game ${i + 1}`, onclick: () => update(() => { dr.games.splice(i, 1); }) }, '×'));
    }));

    const addGame = () => update(() => {
      const prev = dr.games[dr.games.length - 1];
      const ids = [...here];
      dr.games.push({ a: prev ? prev.a : ids[0] || null, b: prev ? prev.b : ids[1] || null, sa: null, sb: null });
    });

    const note = h('input', { type: 'text', maxlength: 200, value: dr.note || '', placeholder: 'Optional', oninput: (e) => { dr.note = e.target.value; saveDraft(); } });

    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Add to this session' : dr.games.length ? 'Save session' : 'Save visit');

    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const problem = validateDraft(dr);
        if (problem) {
          err.textContent = problem;
          err.hidden = false;
          err.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        saveBtn.disabled = true;
        const payload = {
          date: dr.date, slot: dr.slot, note: (dr.note || '').trim(),
          playerIds: [...new Set([...dr.playerIds, ...dr.games.flatMap((g) => [g.a, g.b])])],
          games: dr.games.map((g) => ({ a: g.a, b: g.b, sa: g.sa, sb: g.sb })),
        };
        const n = payload.games.length;
        const ok = await act(() => api.logSession(state.code, payload), n ? `Saved ${n} game${n === 1 ? '' : 's'}` : 'Visit saved');
        if (ok) {
          // Keep date, slot and who's there so the next batch of games is quick to add.
          state.draft = { date: dr.date, slot: dr.slot, playerIds: payload.playerIds, games: [], note: '' };
          saveDraft();
          render();
        } else {
          saveBtn.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'f-date' }, 'Date'), dateInput),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Time slot'), slotChoices),
    existing ? h('p', { class: 'notice' }, `There is already a session on this date and slot (${(d.gamesBySession.get(existing.id) || []).length} games). Saving adds to it, so the visit isn't counted twice.`) : null,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who was there? ', h('span', { class: 'hint' }, 'Counts towards break-even for subscribers.')), peopleChoices),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Games ', h('span', { class: 'hint' }, 'Optional. One row per game, e.g. 11–7. Don\'t remember the scores? Just save the visit.')),
      rows,
      h('div', null, h('button', { type: 'button', class: 'btn', onclick: addGame }, dr.games.length ? '+ Another game' : '+ Add a game'))),
    h('div', { class: 'field' }, h('label', null, 'Note'), note),
    err,
    h('div', { class: 'actions' }, saveBtn,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { if (confirm('Clear this form?')) update(() => { state.draft = freshDraft(); }); } }, 'Clear')));

    return h('section', { class: 'card' }, h('h2', null, 'Log a session'), h('p', { class: 'sub' }, 'Log the visit and any games. You can come back and add more games to the same session later.'), form);
  }

  function validateDraft(dr) {
    if (!dr.date) return 'Pick a date.';
    if (!SLOTS[dr.slot]) return 'Pick a time slot.';
    if (!dr.playerIds.length && !dr.games.length) return 'Tick who was there, or add a game.';
    for (let i = 0; i < dr.games.length; i++) {
      const g = dr.games[i];
      const n = `Game ${i + 1}: `;
      if (!g.a || !g.b) return n + 'choose both players.';
      if (g.a === g.b) return n + 'the two players must be different.';
      if (!Number.isInteger(g.sa) || !Number.isInteger(g.sb)) return n + 'fill in both scores.';
      if (g.sa < 0 || g.sb < 0 || g.sa > 99 || g.sb > 99) return n + 'scores must be between 0 and 99.';
      if (g.sa === g.sb) return n + 'a game cannot end in a draw.';
    }
    return null;
  }

  function playersCard() {
    const d = state.d;
    const subDate = (value, labelText) => h('input', { type: 'date', value: value || '', 'aria-label': labelText, class: 'sub-date' });
    const list = h('div', { class: 'player-rows' }, d.players.map((p) => {
      const name = h('input', { type: 'text', value: p.name, maxlength: 40, 'aria-label': 'Name' });
      const since = subDate(subStart(p), `${p.name}: subscriber since`);
      const activeBox = h('input', { type: 'checkbox', checked: p.active !== false });
      const btn = h('button', {
        type: 'button', class: 'btn btn-small', disabled: true,
        onclick: () => act(() => api.savePlayer(state.code, { id: p.id, name: name.value, subscription_start: since.value || null, active: activeBox.checked }), 'Player saved'),
      }, 'Save');
      const dirty = () => { btn.disabled = name.value.trim() === p.name && since.value === (subStart(p) || '') && activeBox.checked === (p.active !== false); };
      name.addEventListener('input', dirty);
      since.addEventListener('input', dirty);
      since.addEventListener('change', dirty);
      activeBox.addEventListener('change', dirty);
      return h('div', { class: 'player-row' },
        dotFor(p.id), name,
        h('label', { class: 'check' }, 'Subscriber since', since),
        h('label', { class: 'check', title: 'Inactive players are hidden from the log form' }, activeBox, 'Active'),
        btn);
    }));

    const newName = h('input', { type: 'text', maxlength: 40, placeholder: 'New player name', 'aria-label': 'New player name' });
    const newSince = subDate('', 'New player: subscriber since');
    const addForm = h('form', {
      class: 'add-player',
      onsubmit: (e) => {
        e.preventDefault();
        if (!newName.value.trim()) return;
        act(() => api.savePlayer(state.code, { name: newName.value, subscription_start: newSince.value || null }), 'Player added');
      },
    }, newName, h('label', { class: 'check' }, 'Subscriber since', newSince), h('button', { class: 'btn', type: 'submit' }, 'Add player'));

    return h('section', { class: 'card' },
      h('h2', null, 'Players'),
      h('p', { class: 'sub' }, 'Fill in "Subscriber since" with the date someone\'s yearly subscription started; their break-even year runs from that date. Leave it empty for people without one.'),
      d.players.length ? list : null,
      addForm);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  document.title = CFG.title;
  document.getElementById('site-title').textContent = CFG.title;
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  window.addEventListener('scroll', hideTooltip, { passive: true });

  render();
  reload();
  if (state.code) {
    api.verify(state.code)
      .then((ok) => {
        state.unlocked = !!ok;
        if (!ok) store.del(CODE_KEY);
        render();
      })
      .catch(() => {});
  }
})();
