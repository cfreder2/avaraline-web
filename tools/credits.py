#!/usr/bin/env python3
"""Write CREDITS.md and web/site/credits.html from their sources.

  tools/credits.py            (run from the repository root)

Sources:
  CONTRIBUTORS.md                  Avaraline's own list of contributors and their roles
  tools/credits-contributors.json  commits per GitHub account on avaraline/Avara, saved with
                                   gh api --paginate 'repos/avaraline/Avara/contributors?per_page=100&anon=1'
  levels/*/alf/*.alf               the designer each level credits (<set designer="...">),
                                   with e-mail addresses and links removed
"""
import collections, datetime, html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT = os.path.join(ROOT, 'tools', 'credits-contributors.json')


def designers():
    def clean(v):
        v = html.unescape(html.unescape(v)).replace('\n', '')   # breaks fall inside addresses
        v = re.sub(r'<[^>]*>', ' ', v)
        v = re.sub(r'\S+@\S+', ' ', v)
        v = re.sub(r'(https?://|www\.)\S+', ' ', v)
        v = re.sub(r'(?i)\b(designed by|design\s*-|e-mail:?|email:?)\s*', ' ', v)
        v = v.replace('""', '"')
        v = re.sub(r'\(\s*\)|\[\s*\]', '', v)
        v = re.sub(r'\s+', ' ', v).strip()
        return re.sub(r'^[-\s|:]+|[-\s|:,>]+$', '', v)
    count, spelling, levels = collections.Counter(), {}, 0
    base = os.path.join(ROOT, 'levels')
    for s in sorted(os.listdir(base)):
        d = os.path.join(base, s, 'alf')
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith('.alf'):
                continue
            levels += 1
            m = re.search(r'<set\b[^>]*?\bdesigner\s*=\s*"([^"]*)"', open(os.path.join(d, f), errors='replace').read())
            name = clean(m.group(1)) if m else ''
            if not name:
                continue
            key = re.sub(r'[^a-z0-9]', '', name.lower())
            count[key] += 1
            spelling.setdefault(key, collections.Counter())[name] += 1
    names = sorted(((spelling[k].most_common(1)[0][0], n) for k, n in count.items()), key=lambda x: (-x[1], x[0].lower()))
    return names, levels, sum(count.values())


def contributors():
    """Avaraline's CONTRIBUTORS.md entries in their order: (name, GitHub handle or '', role);
    and commits per GitHub account from the saved snapshot."""
    roles = []
    for line in open(os.path.join(ROOT, 'CONTRIBUTORS.md')):
        line = line.strip()
        if not line.startswith('* '):
            continue
        m = re.match(r'\*\s*(.+?)\s*<@([^>]+)>\s*-\s*(.+)', line)
        if m:
            roles.append((m.group(1), m.group(2), m.group(3)))
        else:
            name, _, role = line[2:].partition(' - ')
            roles.append((name.strip(), '', role.strip()))
    people = [{'login': c.get('login'), 'name': c.get('name', ''), 'commits': c['contributions']} for c in json.load(open(SNAPSHOT))]
    return roles, people


def write():
    names, levels, credited = designers()
    roles, people = contributors()
    total = sum(p['commits'] for p in people)
    when = datetime.date.fromtimestamp(os.path.getmtime(SNAPSHOT)).isoformat()

    md = ['# Credits', '',
          'Avara was created by **Juri Munkki** and published by **Ambrosia Software** in 1996. '
          'Juri released the source code in 2016.', '',
          '## Avaraline', '',
          'The Avaraline community ported Avara to current systems and maintains it at '
          '[github.com/avaraline/Avara](https://github.com/avaraline/Avara). Everything here is built on their work. '
          'For the desktop app, see [its releases](https://github.com/avaraline/Avara/releases).', '',
          'From Avaraline\'s CONTRIBUTORS.md:', '']
    for name, handle, role in roles:
        md.append(f'- {name}' + (f' (@{handle})' if handle else '') + f': {role}')
    md += ['', f'Commits to avaraline/Avara on GitHub, as of {when} ({total} in all):', '', '| Contributor | Commits |', '| --- | --- |']
    for p in people:
        who = f"[@{p['login']}](https://github.com/{p['login']})" if p['login'] else p['name']
        md.append(f"| {who} | {p['commits']} |")
    md += ['', '## Level designers', '',
           f'{credited} of the {levels} levels name a designer. As credited in the level files, contact details removed, '
           'with the number of levels:', '',
           ', '.join(f'{n} ({c})' for n, c in names) + '.', '',
           '## Logo', '', 'The Avara logo is Avaraline\'s (rsrc/img/avara-logo-only-transparent.png in avaraline/Avara).', '',
           '## This fork', '',
           'The browser build and this site are by cfreder2, made with AI assistance: see [AI.md](AI.md). '
           'This fork is not made, run or endorsed by the Avaraline project.', '',
           '## License', '', 'MIT: see [LICENSE.txt](LICENSE.txt).', '',
           '<!-- Written by tools/credits.py -->', '']
    open(os.path.join(ROOT, 'CREDITS.md'), 'w').write('\n'.join(md))

    e = html.escape
    roles_html = ''.join(f'<li>{e(name)}' + (f' (@{e(handle)})' if handle else '') + f': {e(role)}</li>' for name, handle, role in roles)
    commits_html = ''.join(
        f"<tr><td>{('<a href=%s>@%s</a>' % (e('https://github.com/' + p['login'], quote=True), e(p['login']))) if p['login'] else e(p['name'])}</td><td>{p['commits']}</td></tr>"
        for p in people)
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avara credits</title>
<style>
  :root {{ --bg:#0b0e14; --text:#d8e2ea; --dim:#9aa7b3; --faint:#6b7783; --link:#7c9cd6; --line:#243140; }}
  html, body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }}
  main {{ max-width:760px; margin:0 auto; padding:32px 16px 64px; }}
  h1 {{ font-size:28px; margin:0 0 12px; }} h2 {{ font-size:19px; margin:32px 0 8px; }}
  a {{ color:var(--link); text-decoration:none; }} a:hover {{ text-decoration:underline; }}
  p, li {{ color:var(--dim); }} ul {{ padding-left:20px; }}
  table {{ border-collapse:collapse; font-size:14px; }} td {{ padding:3px 16px 3px 0; border-bottom:1px solid var(--line); color:var(--dim); }}
  td:last-child {{ text-align:right; font-variant-numeric:tabular-nums; }}
  .names {{ font-size:14px; }} .back {{ font-size:14px; }} .small {{ font-size:13px; color:var(--faint); }}
</style>
</head>
<body><main>
<p class="back"><a href="./">&larr; Back to the game</a></p>
<h1>Credits</h1>
<p>Avara was created by <b>Juri Munkki</b> and published by <b>Ambrosia Software</b> in 1996. Juri released the source code in 2016.</p>
<h2>Avaraline</h2>
<p>The Avaraline community ported Avara to current systems and maintains it at <a href="https://github.com/avaraline/Avara">github.com/avaraline/Avara</a>. This browser version is built on their work. For the desktop app, see <a href="https://github.com/avaraline/Avara/releases">its releases</a>.</p>
<p>From Avaraline's CONTRIBUTORS.md:</p>
<ul>{roles_html}</ul>
<p>Commits to avaraline/Avara on GitHub, as of {when} ({total} in all):</p>
<table>{commits_html}</table>
<h2>Level designers</h2>
<p>{credited} of the {levels} levels name a designer. As credited in the level files, contact details removed, with the number of levels:</p>
<p class="names">{e(', '.join(f'{n} ({c})' for n, c in names))}.</p>
<h2>Logo</h2>
<p>The Avara logo is Avaraline's.</p>
<h2>This browser version</h2>
<p>An unofficial browser build by cfreder2, made with AI assistance (Anthropic's Claude). It is not made, run or endorsed by the Avaraline project. How AI was used: <a href="https://github.com/cfreder2/avaraline-web/blob/site/AI.md">AI.md</a>. Source: <a href="https://github.com/cfreder2/avaraline-web">github.com/cfreder2/avaraline-web</a>.</p>
<h2>License</h2>
<p>MIT: <a href="LICENSE.txt">LICENSE.txt</a>.</p>
<p class="small">Written by tools/credits.py.</p>
</main></body>
</html>
'''
    open(os.path.join(ROOT, 'web', 'site', 'credits.html'), 'w').write(page)
    print(f'CREDITS.md and web/site/credits.html: {len(people)} GitHub contributors ({total} commits), {len(names)} level designers')


if __name__ == '__main__':
    write()
