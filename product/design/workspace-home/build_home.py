"""Generate the chosen workspace home (Direction C, "Ask first", tightened pass).

Owner pick, #general 2026-09-30: "the 'what should the team build next' looks
pretty sweet". Tightened with Product Development Lead's brief
(agent_notes/2026-09-30_workspace-landing-product-brief.md): shorter hero,
followed threads with real previews, "Waiting on you" for actual owner requests
only, a compact "Working now" row, phone and no-Buddies states.

Data read 2026-09-30 ~12:00 UTC through the owner's GET endpoints:
/api/buddies/workspaces/:id/threads, /inbox (filtered to this workspace's
Buddies) and /runs?liveInWorkspace. The grey line under a thread title is a
designer summary: the threads endpoint does not return the latest reply text.

Writes home-desktop.html, home-empty.html, home-phone.html. Run from this folder:
    python3 build_home.py
"""

ARROW = '&rarr;'

# (face asset, chip label)
TEAM = [
    ('product-lead', 'Product Dev Lead'),
    ('ui-engineer', 'UI Engineer'),
    ('dev-lead', 'Buddies Lead'),
    ('release-engineer', 'Release Engineer'),
    ('delivery-pm', 'Delivery PM'),
    ('marketing', 'Marketing Designer'),
    ('upstream', 'Upstream'),
]

# (preview or None, channel, root text, participants, replies, latest, is video, summary)
THREADS = [
    ('assets/prev-general.png', '#general',
     'Can we think of a better landing page for a workspace, this is so uninspiring',
     ['you', 'marketing', 'product-lead'], 7, 'now', False, 'Four directions; you picked C'),
    ('assets/prev-clips.jpg', '#unleashd-2',
     'What is all the clips we have and what is left to publish this?',
     ['you', 'marketing'], 20, '7h', True, 'Launch video clips and what is left'),
    ('assets/prev-thread-ui.png', '#bugfixes',
     'Replying here in the threads does not have balanced or aligned UI, we need to fix that',
     ['you', 'ui-engineer'], 1, '2h', False, 'Buddies UI Engineer replied'),
    (None, '#channels-feature',
     'Unify the DM header. It should have one model picker and not grey out harness change',
     ['you', 'product-lead'], 4, '3h', False, 'Product Development Lead replied'),
]

# The open owner requests from this workspace's Buddies (excerpts).
REQUESTS = [
    ('product-lead', 'Product Development Lead',
     'Approve enabling a disabled automation and grant schedule.manage plus background execution? '
     'Daily at 09:00, 20 min / 50k tokens / $2 ceiling.', '15d'),
    ('dev-lead', 'Buddies Development Lead',
     'Manual owner review requested before any implementation. Task 95592e35 is blocked on '
     'inactive-grantee discoverability.', '14d'),
]

# Live runs grouped by Buddy: (face, name, detail)
WORKING = [
    ('product-lead', 'Product Development Lead', '2 chats'),
    ('marketing', 'Marketing Designer', '1 chat'),
]

CHANNELS = [('general', 6), ('bugfixes', 43), ('channels-feature', 33), ('buddies-dev', 12),
            ('triage', 5), ('buddy-repairs', 4), ('case-studies', 3), ('releases', 3),
            ('unleashd-2', 1), ('upstream', 0)]


def people(ps):
    return ''.join(
        '<span class="you-av">N</span>' if p == 'you' else f'<img class="pf" src="assets/face-{p}.png" alt="">'
        for p in ps
    )


def thread_card(t):
    img, ch, text, ps, n, when, video, summary = t
    word = 'reply' if n == 1 else 'replies'
    # A text-only thread gets its opening words as the preview, set large, so the
    # card still has a face instead of an empty image box.
    if img is None:
        preview = f'<div class="pv pv-text"><span>&ldquo;{text}&rdquo;</span></div>'
    else:
        play = '<span class="play">&#9654;</span>' if video else ''
        preview = f'<div class="pv" style="background-image:url({img})">{play}</div>'
    return (
        f'<article class="t">{preview}<div class="t-body">'
        f'<div class="t-meta"><span class="hash">{ch}</span><span class="when">{when}</span></div>'
        f'<div class="t-title">{text}</div><div class="t-sum">{summary}</div>'
        f'<div class="t-foot"><span class="ps">{people(ps)}</span><span class="when">{n} {word}</span></div>'
        f'</div></article>'
    )


def request_card(r):
    face, name, text, when = r
    return (
        f'<div class="rq"><div class="rq-h"><img src="assets/face-{face}.png" alt=""><b>{name}</b>'
        f'<span class="when">{when}</span></div><div class="rq-t">{text}</div>'
        f'<div class="rq-a">Answer {ARROW}</div></div>'
    )


def chips(team):
    return ''.join(f'<span class="chip"><img src="assets/face-{f}.png" alt="">{n}</span>' for f, n in team)


def working_row():
    items = ''.join(
        f'<span class="w"><img src="assets/face-{f}.png" alt=""><span class="live">{n}</span>'
        f'<span class="when">{d}</span></span>'
        for f, n, d in WORKING
    )
    return f'<div class="working"><span class="label">Working now</span>{items}<a class="more">Team view {ARROW}</a></div>'


BASE_CSS = """
.aura { position: absolute; left: 50%; top: -300px; width: 1200px; height: 780px; transform: translateX(-50%);
  background: url(assets/emblem-unleashd.png) center / contain no-repeat; filter: blur(90px) saturate(1.6); opacity: .38; }
.fade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(30,32,41,.05) 0, rgba(30,32,41,.6) 260px, var(--bg) 460px); }
.wrap { position: relative; z-index: 1; }
.id { display: flex; align-items: center; gap: 14px; justify-content: center; }
.id img { border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.id span { font-family: var(--mono); color: var(--muted); }
h1 { text-align: center; font-weight: 800; color: var(--text); letter-spacing: -.025em; }
.lede { text-align: center; color: var(--body); }
.composer { background: rgba(36,39,51,.94); border: 1px solid #3d4260; box-shadow: 0 30px 80px rgba(0,0,0,.45), 0 0 0 6px rgba(196,155,255,.07); }
.ph { color: var(--muted); }
.ph b { color: var(--accent); font-weight: 500; }
.bar { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); }
.sel { border: 1px solid var(--line); border-radius: 9px; color: var(--body); }
.send { margin-left: auto; background: var(--accent); color: #1b1530; font-weight: 700; border-radius: 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.chip { display: inline-flex; align-items: center; gap: 8px; background: rgba(36,39,51,.8); border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px 5px 5px; font-size: 14px; color: var(--body); }
.chip img { width: 26px; height: 26px; border-radius: 8px; }
.chip.hire { border-style: dashed; color: var(--accent); padding-left: 14px; }
.sec-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.sec-head .more, .working .more { margin-left: auto; color: var(--accent); font-size: 14px; }
.t { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; }
.pv { background: #111 center top / cover no-repeat; position: relative; border-bottom: 1px solid var(--line); }
.pv-text { background: linear-gradient(135deg, #2b2742, #232634); display: flex; align-items: center; padding: 0 18px; }
.pv-text span { color: #d9ccff; font-weight: 700; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.play { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; display: grid; place-items: center; font-size: 18px; border: 1px solid rgba(255,255,255,.3); }
.t-body { padding: 12px 14px 14px; }
.t-meta { display: flex; justify-content: space-between; font-size: 13px; }
.t-title { color: var(--text); font-weight: 600; margin-top: 5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.t-sum { font-size: 13px; color: var(--muted); margin-top: 4px; }
.t-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.ps { display: flex; }
.pf, .you-av { width: 22px; height: 22px; border-radius: 6px; margin-right: -4px; box-shadow: 0 0 0 2px var(--card); }
.you-av { background: #3a3f55; color: var(--text); font-size: 10px; font-weight: 700; display: inline-grid; place-items: center; }
.t-foot .when { margin-left: 8px; }
.rq { border: 1px solid #5a4a2a; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; background: linear-gradient(180deg, rgba(251,191,36,.08), var(--card) 70%); }
.rq-h { display: flex; gap: 8px; align-items: center; font-size: 14px; color: var(--text); }
.rq-h img { width: 22px; height: 22px; border-radius: 6px; }
.rq-h .when { margin-left: auto; }
.rq-t { font-size: 13px; line-height: 1.45; margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.rq-a { color: var(--amber); font-size: 13px; margin-top: 8px; }
.cnt { background: var(--amber); color: #2a1d00; font-weight: 700; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.working { display: flex; align-items: center; gap: 22px; border-top: 1px solid var(--line); font-size: 14px; }
.working .w { display: flex; gap: 8px; align-items: center; }
.working img { width: 22px; height: 22px; border-radius: 6px; }
.helper { color: var(--muted); text-align: center; line-height: 1.5; }
.tag { position: absolute; right: 18px; bottom: 12px; font-family: var(--mono); font-size: 11px; color: #59627f; z-index: 2; }
"""

DESKTOP_CSS = """
main { display: flex; justify-content: center; }
.wrap { width: 1200px; padding-top: 48px; }
.id img { width: 52px; height: 52px; }
.id span { font-size: 14px; }
h1 { font-size: 56px; margin-top: 18px; }
.lede { font-size: 17px; margin-top: 10px; }
.composer { margin: 26px auto 0; width: 1000px; border-radius: 20px; padding: 20px 22px 14px; }
.ph { font-size: 19px; height: 50px; }
.bar { padding-top: 12px; }
.sel { padding: 7px 12px; font-size: 14px; }
.send { padding: 9px 18px; font-size: 15px; }
.chips { margin-top: 16px; }
.cols { display: grid; grid-template-columns: 1fr 340px; gap: 24px; margin-top: 40px; }
.threads { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.pv { height: 200px; }
.pv-text span { font-size: 17px; }
.t-title { font-size: 15px; }
.working { margin-top: 26px; padding-top: 14px; }
"""

PHONE_CSS = """
html, body { width: 375px; height: 812px; }
body { display: block; }
main { width: 375px; height: 812px; }
.aura { width: 700px; height: 520px; top: -240px; }
.wrap { padding: 22px 16px 0; height: 755px; overflow: hidden; }
.top { display: flex; align-items: center; gap: 10px; }
.top img { width: 34px; height: 34px; border-radius: 9px; }
.top b { color: var(--text); font-size: 20px; font-weight: 800; }
.top .sw { margin-left: auto; font-size: 13px; color: var(--accent); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; }
h1 { font-size: 30px; margin-top: 18px; line-height: 1.1; }
.lede { font-size: 13px; margin-top: 8px; }
.composer { margin-top: 16px; border-radius: 16px; padding: 14px 14px 10px; }
.ph { font-size: 15px; height: 38px; }
.bar { padding-top: 10px; }
.sel { padding: 5px 9px; font-size: 13px; }
.send { padding: 7px 13px; font-size: 13px; }
.chips { margin-top: 12px; flex-wrap: nowrap; overflow: hidden; justify-content: flex-start; }
.chip { flex: none; font-size: 13px; }
.sec { margin-top: 20px; }
.rq { margin-bottom: 8px; }
.rail-row { display: flex; gap: 12px; overflow: hidden; }
.rail-row .t { width: 240px; flex: none; }
.pv { height: 110px; }
.pv-text span { font-size: 15px; }
.t-title { font-size: 14px; }
.working { margin-top: 18px; padding-top: 12px; gap: 12px; font-size: 13px; flex-wrap: wrap; }
.tabs { position: absolute; left: 0; bottom: 0; width: 375px; }
.tabs img { width: 375px; display: block; }
"""


def page(css, body):
    return (
        '<!doctype html>\n<!-- Generated by build_home.py. Do not edit by hand. -->\n'
        f'<html><head><meta charset="utf-8"><link rel="stylesheet" href="shared.css">'
        f'<style>{BASE_CSS}{css}</style></head><body>{body}</body></html>\n'
    )


def desktop():
    threads = ''.join(thread_card(t) for t in THREADS)
    reqs = ''.join(request_card(r) for r in REQUESTS)
    body = f"""
<aside class="rail"><img src="assets/rail.png" alt=""></aside>
<main><div class="aura"></div><div class="fade"></div><div class="wrap">
<div class="id"><img src="assets/emblem-unleashd.png" alt=""><span>unleashd &middot; ~/git/unleashd</span></div>
<h1>What should the team build next?</h1>
<p class="lede">7 Buddies &middot; <span class="live">2 working now</span> &middot; {len(REQUESTS)} waiting on you</p>
<div class="composer"><div class="ph">Describe the work, or <b>@mention</b> a Buddy&hellip;</div>
<div class="bar"><span class="sel"># general &#9662;</span><span class="sel">Attach</span><span class="send">Start thread &#8629;</span></div></div>
<div class="chips">{chips(TEAM)}</div>
<div class="cols">
<section><div class="sec-head"><span class="label">Pick up where you left off</span><a class="more">All threads {ARROW}</a></div>
<div class="threads">{threads}</div></section>
<aside><div class="sec-head"><span class="label">Waiting on you</span><span class="cnt">{len(REQUESTS)}</span></div>{reqs}</aside>
</div>
{working_row()}
</div><span class="tag">MOCK &middot; live data read 2026-09-30 12:00 UTC</span></main>"""
    return page(DESKTOP_CSS, body)


EMPTY_RAIL = """
<aside class="rail erail">
<div class="er-top"><span class="er-back">&larr; Workspaces</span></div>
<div class="er-name">my-new-app <span>&#9662;</span></div>
<div class="er-sep"></div>
<div class="er-item">&equiv; Threads</div>
<div class="er-h">CHANNELS <span>+</span></div>
<div class="er-item"># general</div>
<div class="er-h">BUDDIES <span>+</span></div>
</aside>"""

EMPTY_CSS = DESKTOP_CSS + """
.erail { background: var(--bg-deep); padding: 34px 26px; font-size: 20px; }
.er-back { font-family: var(--mono); font-size: 14px; color: var(--muted); }
.er-name { color: var(--text); font-weight: 700; font-size: 26px; margin-top: 22px; }
.er-name span { font-size: 12px; color: var(--muted); }
.er-sep { border-top: 1px solid var(--line); margin: 26px -26px 22px; }
.er-item { color: #9aa6d0; margin: 14px 0; }
.er-h { font-family: var(--mono); font-size: 13px; letter-spacing: .08em; color: var(--muted); margin-top: 34px; display: flex; justify-content: space-between; }
.aura { background-image: url(assets/emblem-new.png); }
.helper { margin-top: 18px; font-size: 15px; }
.starters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; width: 1000px; margin: 40px auto 0; }
.starter { border: 1px dashed var(--line); border-radius: 14px; padding: 16px 18px; background: rgba(36,39,51,.5); }
.starter b { color: var(--text); font-size: 15px; display: block; }
.starter span { color: var(--muted); font-size: 14px; display: block; margin-top: 6px; line-height: 1.45; }
"""


def empty():
    body = f"""
{EMPTY_RAIL}
<main><div class="aura"></div><div class="fade"></div><div class="wrap">
<div class="id"><img src="assets/emblem-new.png" alt=""><span>my-new-app &middot; ~/git/my-new-app</span></div>
<h1>What should the team build next?</h1>
<p class="lede">No Buddies here yet.</p>
<div class="composer"><div class="ph">Describe the work&hellip;</div>
<div class="bar"><span class="sel"># general &#9662;</span><span class="sel">Attach</span><span class="send">Start thread &#8629;</span></div></div>
<div class="chips"><span class="chip hire">+ Hire your first Buddy</span></div>
<p class="helper">Post here and @mention a Buddy to hand it the work.<br>Hire one first: describe the role, and the Builder drafts it.</p>
<div class="starters">
<div class="starter"><b>An engineer for this repo</b><span>Reads the code, fixes bugs, opens a branch per change.</span></div>
<div class="starter"><b>A product lead</b><span>Turns your asks into Tasks and keeps the team on them.</span></div>
<div class="starter"><b>A designer</b><span>Mocks screens and visuals before anything gets built.</span></div>
</div>
</div><span class="tag">MOCK &middot; empty state, illustrative workspace</span></main>"""
    return page(EMPTY_CSS, body)


def phone():
    threads = ''.join(thread_card(t) for t in THREADS)
    reqs = ''.join(request_card(r) for r in REQUESTS)
    body = f"""
<main><div class="aura"></div><div class="fade"></div><div class="wrap">
<div class="top"><img src="assets/emblem-unleashd.png" alt=""><b>unleashd</b><span class="sw">Switch</span></div>
<h1>What should the team build next?</h1>
<p class="lede">7 Buddies &middot; <span class="live" style="font-size:13px">2 working</span> &middot; {len(REQUESTS)} waiting on you</p>
<div class="composer"><div class="ph">Describe the work, or <b>@mention</b>&hellip;</div>
<div class="bar"><span class="sel"># general &#9662;</span><span class="send">Start &#8629;</span></div></div>
<div class="chips">{chips(TEAM)}</div>
<section class="sec"><div class="sec-head"><span class="label">Waiting on you</span><span class="cnt">{len(REQUESTS)}</span></div>{reqs}</section>
<section class="sec"><div class="sec-head"><span class="label">Pick up where you left off</span></div>
<div class="rail-row">{threads}</div></section>
</div><div class="tabs"><img src="assets/phone-tabbar.png" alt=""></div></main>"""
    return page(PHONE_CSS, body)


for name, html in [('home-desktop.html', desktop()), ('home-empty.html', empty()), ('home-phone.html', phone())]:
    with open(name, 'w') as f:
        f.write(html)
