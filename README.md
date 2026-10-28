<p align="center">
  <a href="https://cfreder2.github.io/avaraline-web/"><img src="web/site/img/preview.jpg" width="720" alt="Avara: unofficial browser build"></a>
</p>

# Avara in a browser (unofficial)

This fork of [avaraline/Avara](https://github.com/avaraline/Avara) builds Avara for the web,
with Emscripten, WebGL2 and WebRTC.

**Play: <https://cfreder2.github.io/avaraline-web/>**

It is not made, run or endorsed by the Avaraline project. Avara is Juri Munkki's game, ported
to current systems and maintained by the Avaraline community; for the desktop app, see
[their releases](https://github.com/avaraline/Avara/releases). This fork was made with AI
assistance: [AI.md](AI.md) says how, and what is not AI-made. Problems with the browser build
go in [this repository's issues](https://github.com/cfreder2/avaraline-web/issues), not
Avaraline's.

<!-- Trailer: put the github.com/user-attachments/assets/... link that GitHub gives for
     Avara-trailer-10MB.mp4 on its own line here, with a blank line above and below. -->

<table>
  <tr>
    <td><img src=".github/readme/01-origins.jpg" alt="Origins"><br><sub>Origins, by Sphinx</sub></td>
    <td><img src=".github/readme/02-decagon-battle.jpg" alt="Decagon"><br><sub>Decagon, by Sphinx</sub></td>
    <td><img src=".github/readme/03-messiah.jpg" alt="Messiah"><br><sub>Messiah, by Sphinx</sub></td>
  </tr>
  <tr>
    <td><img src=".github/readme/04-battle-disco.jpg" alt="Disco"><br><sub>Disco, by Apollo (2000)</sub></td>
    <td><img src=".github/readme/09-fort-of-bob-hud.jpg" alt="Fort of Bob"><br><sub>Fort of Bob, by Juri Munkki (1996)</sub></td>
    <td><img src=".github/readme/07-platforms.jpg" alt="Platforms"><br><sub>Platforms, by Carlos Castillo-Garsow (1996)</sub></td>
  </tr>
</table>

## What the browser build does

- Solo, or host and join online games of up to 8 players. The Online screen lists browser
  games, and the desktop games on Avaraline's tracker beside them.
- Over 1,100 levels, downloaded when a game needs them.
- Optional accounts, with an Elo rating and a friends list. Without one you play as a guest.
- Keyboard and mouse, or a gamepad.
- Not yet: browser and desktop players in the same game.

## How it relates to Avaraline's code

The changes are kept in separate branches, so that any of them could be offered upstream.

| Branch | What it changes | C++ |
| --- | --- | --- |
| `port-fixes` | Bugs the port found that affect desktop builds too: the locator table, the skybox draw count, `--basepath`, GLSL ES literals | 5 files, +19 −15 |
| `web-build` | The Emscripten build, on top of `port-fixes`. Every change to an existing file is inside `#ifdef __EMSCRIPTEN__` | 15 files edited, 5 added |
| `netplay-pacing` | Lockstep over WebRTC: catch up after network waits, a latency floor from the round trip. On top of `web-build` | 1 file, +143 −12 |
| `actor-smoothing` | Draw actors that update at 15 Hz between their updates | 7 files, +58 −11 |
| `small-fixes` | Say why Start/Ready does nothing when no level is loaded | 2 files, +11 −3 |
| `site` (this branch) | All of the above, plus the page at github.io: lobby, accounts, game list, statistics. Not meant for upstream | 7 files, +131 −1, all inside `#ifdef __EMSCRIPTEN__` |

To check that `web-build` or `netplay-pacing` changes nothing a desktop build compiles, check
out the branch and run `python3 tools/check_web_gating.py port-fixes`. It removes the
`__EMSCRIPTEN__` blocks with `unifdef` and compares each file with `port-fixes`.

Measured on the live site with four headless Chrome players in one game on one Mac: 60.0 game
ticks a second and 60 frames drawn; with 70 ms of simulated network delay, 60.0 ticks and 59.5
to 59.8 frames.

## Privacy

The page at github.io records play statistics in a Supabase database, to find bugs and to see
whether the build keeps 60 frames a second:

- for each visit: a random ID for the visit and one for the browser (Supabase's anonymous
  sign-in), the build, the callsign you play under, the kind of device, screen size, graphics
  renderer, time played, rounds, kills, deaths, wins and frame rate;
- for each round: the level, mode, number of players, outcome, score, frame rate, tick rate and
  network round trip;
- events: whether joining a game worked and how the connection got through, and level
  downloads.

It stores no IP addresses, e-mail addresses or chat. Visits are kept for 400 days, events for
90. **Settings > Send play statistics** turns it off.

A game you host is listed on the Online screen with its name, your callsign, the level and the
players. Accounts are optional: a username and a password, stored as a bcrypt hash, with no
e-mail address. In an online game players connect to each other directly, so each can see the
others' IP addresses; **Settings > Connect only through the host** limits that to the host.

## Building

    source ../emsdk/emsdk_env.sh          # Emscripten on PATH
    make -f Makefile.emscripten           # build_web/avara.{html,js,wasm,data}
    make -f Makefile.emscripten serve     # the plain page, at http://localhost:8000
    node tools/build.mjs                  # the site's page, staged in dist/

Desktop builds are unchanged: `make`, as in Avaraline's instructions below.

## Credits

Avara was created by Juri Munkki and published by Ambrosia Software in 1996. The Avaraline
community ported it to current systems: 14 people have made 1,815 commits to
avaraline/Avara on GitHub. The level files name 116 designers. [CREDITS.md](CREDITS.md) lists them all.

---

*The rest of this file is Avaraline's README.*


# Avara

![avara](https://img.avara.gg/uploads/original/30/fe/42a79ba9b5843fc858a824ae8231.gif)

[Avara Discord](https://discord.gg/yw5qnBtJd5) | IRC: avaraline.net:6667 #avaraline

A port of the [1996 game by Juri Munkki](https://en.wikipedia.org/wiki/Avara), published by Ambrosia Software, [released under MIT license](https://github.com/jmunkki/Avara).

Avara is a cult-classic three-dimensional networked action FPS with remote-controlled bipedal tanks. 

The game was originally developed in the early 1990s for Apple Macintosh. This port uses SDL2 and OpenGL to replace legacy system APIs, and is intended to run *at 60fps* on Windows, macOS, and Linux.

#### [💾 Download the alpha version!](https://github.com/avaraline/Avara/releases/tag/0.7.0-nightly.20201230)

Otherwise, see [build instructions](https://github.com/avaraline/Avara/wiki/Build-instructions).

#### [🔍 Game server tracker](http://tracker.avara.gg/)
[Check the tracker](http://tracker.avara.gg/) to get a list of currently active Avara servers. There's also a JSON feed available [here](http://tracker.avara.gg/api/v1/games/)!

_Please note that this tracker is **not** compatible with the Mac OS 9 version of Avara._

## Media
* [Downloads](https://github.com/avaraline/Avara/releases/tag/0.7.0-nightly.20201230)
* [Youtube: Long play multiplayer](https://www.youtube.com/watch?v=AqDRN6srt5M)
* [YouTube: The first successful 3-player alpha test](https://www.youtube.com/watch?v=aOW6lSC0kQI)
* [YouTube: Testing Grimoire (and UI preview)](https://www.youtube.com/watch?v=OX4I18PXXOI&)

## Resources 
- [Game server tracker](http://tracker.avara.gg/) and [API](http://tracker.avara.gg/api/v1/games/)
- [👷 Build Instructions](https://github.com/avaraline/Avara/wiki/Build-instructions) (tl;dr run `make`)
- **[How to play](https://github.com/avaraline/Avara/wiki/How-to-Play)**
- **[⌨️ Configuring your Controls](https://github.com/avaraline/Avara/wiki/Configuring-your-Controls)**
- **[📡 Configuring your Network](https://github.com/avaraline/Avara/wiki/Configuring-your-Network)** - ⚠️ Read this if you have trouble connecting online.
- [Known issues](https://github.com/avaraline/Avara/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
- [Read more about the porting process](https://github.com/avaraline/Avara/wiki/Porting-challenges) and how specific [obstacles](https://en.wikipedia.org/wiki/Macintosh_Toolbox) were overcome
- Join us on the [Avara Discord](https://discord.gg/yw5qnBtJd5)
- Join us on IRC: `irc://avaraline.net:6667/avaraline`


