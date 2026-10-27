#!/usr/bin/env python3
"""Check that this branch changes nothing a desktop build compiles.

  tools/check_web_gating.py [BASE]      (default: upstream/main)

For each C/C++ file changed since BASE:
  - an existing file, with __EMSCRIPTEN__ undefined (unifdef -U), must equal BASE's;
  - a new source file must have no code outside #ifdef __EMSCRIPTEN__;
  - a new header must only be included from code inside #ifdef __EMSCRIPTEN__.
Requires git and unifdef.
"""
import re, subprocess, sys, tempfile, os

SRC = ('.c', '.cpp', '.h', '.hpp')

def run(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout

def desktop(text):
    with tempfile.NamedTemporaryFile('w', suffix='.c', delete=False) as t:
        t.write(text)
    r = subprocess.run(['unifdef', '-U__EMSCRIPTEN__', t.name], capture_output=True, text=True)
    os.unlink(t.name)
    return r.stdout

def code_only(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'//[^\n]*', '', text)
    return text.strip()

base = sys.argv[1] if len(sys.argv) > 1 else 'upstream/main'
rows = run('git', 'diff', '--name-status', base).split('\n')
changes = [r.split('\t') for r in rows if r and r.split('\t')[-1].endswith(SRC)]
bad = 0
new_headers = [p for s, p in changes if s == 'A' and p.endswith(('.h', '.hpp'))]
for status, path in changes:
    text = open(path).read()
    if status == 'M':
        if desktop(text) != run('git', 'show', f'{base}:{path}'):
            print(f'FAIL {path}: differs from {base} with __EMSCRIPTEN__ undefined'); bad += 1
    elif status == 'A' and path.endswith(('.c', '.cpp')):
        if code_only(desktop(text)):
            print(f'FAIL {path}: new file has code outside #ifdef __EMSCRIPTEN__'); bad += 1
# new headers: no desktop-visible include of them anywhere in the tree
tracked = [p for p in run('git', 'ls-files').split('\n') if p.endswith(SRC)]
for h in new_headers:
    name = os.path.basename(h)
    for p in tracked:
        if re.search(r'#\s*include\s*[<"]' + re.escape(name) + r'[>"]', desktop(open(p).read())):
            print(f'FAIL {h}: included by {p} outside #ifdef __EMSCRIPTEN__'); bad += 1
print(f'{len(changes)} C/C++ files changed since {base}: {"desktop builds unchanged" if not bad else f"{bad} problems"}')
sys.exit(1 if bad else 0)
