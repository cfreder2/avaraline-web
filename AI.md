# How AI was used in this fork

This fork (cfreder2/avaraline-web) adds a browser build of Avara. Its changes were
written with AI assistance: Anthropic's Claude, used through Claude Code, directed and
reviewed by cfreder2.

## What AI assistance produced

- The browser build: the C++ changes behind `#ifdef __EMSCRIPTEN__`, `Makefile.emscripten`,
  `src/net/AvaraTCP_web.cpp` and the other new files under `src/`.
- The changes on the `port-fixes`, `actor-smoothing` and `small-fixes` branches.
- The web pages and scripts under `web/`, the signaling relay in `web/serve.py`, and the
  scripts under `tools/`.
- The site in `web/site/`: lobby, accounts, game list, telemetry. Its Supabase schema and
  functions are kept in a separate private repository.
- The testing: automated browser checks and measurements (multiplayer rounds, simulated
  network latency), desktop builds, and `tools/check_web_gating.py`. Results are in the
  commit messages.

Commits made this way end with `Co-Authored-By: Claude`.

## What it did not produce

- Avara: Juri Munkki's game, and its graphics, sounds and levels.
- The Avaraline desktop app and everything in
  [avaraline/Avara](https://github.com/avaraline/Avara). The upstream code in this fork is
  the community's, unchanged except where this fork's commits say otherwise. None of this
  fork's AI-assisted work is part of the Avaraline app. Changes offered upstream go as pull
  requests, marked as AI-assisted, for the maintainers to accept or decline.
- The levels: made by their designers (see [CREDITS.md](CREDITS.md)).
- The logo: Avaraline's.

## Outside this repository

- A promotional trailer: footage captured from the game. Its music was composed by an AI
  agent, using the GeneralUser GS soundfont.
