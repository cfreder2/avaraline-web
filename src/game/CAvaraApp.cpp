/*
    Copyright ©1994-1996, Juri Munkki
    All rights reserved.

    File: CAvaraApp.c
    Created: Wednesday, November 16, 1994, 01:26
    Modified: Friday, September 20, 1996, 02:05
*/

#define MAINAVARAAPP

#include "CAvaraApp.h"

#include "AssetManager.h"
#include "AvaraScoreInterface.h"
#include "AvaraTCP.h"
#include "Beeper.h"
#include "CAvaraGame.h"
#include "CBSPWorld.h"
#include "CNetManager.h"
#include "CNetManager.h" // version.net
#include "CRC.h"
#ifndef __EMSCRIPTEN__
#include "CRUDsqlite.h"
#endif /* __EMSCRIPTEN__ */
#include "CSoundMixer.h"
#include "CViewParameters.h"
#include "CharWordLongPointer.h"
#include "ColorManager.h"
#include "CommandList.h"
#include "Debug.h"
#include "GitVersion.h" // version.git
#include "InfoMessages.h"
#include "KeyFuncs.h"
#include "LegacyOpenGLRenderer.h"
#include "LevelLoader.h"
#include "Messages.h"
#include "ModernOpenGLRenderer.h"
#include "Parser.h"
#include "Preferences.h"
#include "System.h"
#include "Tags.h"
#ifndef __EMSCRIPTEN__
#include "httplib.h"
#endif /* __EMSCRIPTEN__ */
#include "NVGUtil.h"
#include <glm/glm.hpp>
#ifdef __EMSCRIPTEN__
#include "CAbstractPlayer.h"
#include "WebBridge.h"
#include "DrawableSize.h"
#include "CRUDnull.h"  // no-op persistence backend for the web build
#include <emscripten.h>
// One frame reached the screen; the page's FPS meter and auto render scale count these.
// frame is the game's frame number (-1 in the menus), so ticks per second can be told
// from frames drawn per second.
EM_JS(void, avara_frame_mark, (int frame), { if (typeof Module !== 'undefined' && Module.onAvaraFrame) Module.onAvaraFrame(frame); });
#endif /* __EMSCRIPTEN__ */

#ifdef __EMSCRIPTEN__
// How many sim ticks each requestAnimationFrame gets.
//
// The browser calls us once per display refresh, with some jitter in when. Avara draws a
// frame only when it simulates one (there is no interpolation), so how ticks line up with
// refreshes IS the smoothness. Two modes:
//
//  - Locked: when a whole number of refreshes is close to one tick (60, 120, 240 Hz
//    displays), tick once every n refreshes, counted, not timed. Jitter in the callback
//    time cannot move a tick to the wrong refresh, and a refresh the browser skipped is
//    made up with an extra tick so the game keeps its speed.
//  - Accumulated: other rates (75, 90, 144 Hz) and slow machines. Ticks come due from
//    elapsed time, up to kMaxTicks per refresh, so a machine that can only draw 25 frames
//    a second still plays at full speed instead of in slow motion.
//
// The tick period is the engine's frameTime stretched from 62.5 to 60 ticks a second, so
// that every browser in a networked game runs at the same rate and none of them has to
// stall for the others' frames (lockstep runs at the pace of the slowest peer).
struct WebPacer {
    static constexpr int kMaxTicks = 4;     // more than this per refresh and we are drowning
    double rafMs = 1000.0 / 60.0;           // smoothed time between refreshes
    double last = 0, acc = 0;
    int phase = 0;
    bool running = false;

    void Reset() { running = false; }

    int TicksDue(double now, double periodMs) {
        double dt = last > 0 ? now - last : rafMs;
        last = now;
        if (!running) {                     // first refresh of a game or resume: tick now
            running = true; phase = 0; acc = 0;
            return 1;
        }
        if (dt > 0 && dt < 50) rafMs += (dt - rafMs) * 0.05;
        int n = std::max(1, (int)std::lround(periodMs / rafMs));
        if (std::fabs(n * rafMs - periodMs) < 0.06 * periodMs) {
            int refreshes = std::max(1, (int)std::lround(dt / rafMs));
            phase += std::min(refreshes, kMaxTicks * n);
            int ticks = phase / n;
            phase %= n;
            return std::min(ticks, kMaxTicks);
        }
        acc += std::min(dt, kMaxTicks * periodMs);
        int ticks = std::min((int)(acc / periodMs), kMaxTicks);
        acc -= ticks * periodMs;
        return ticks;
    }

    // The game could not advance (waiting on a remote frame, or it stopped): drop the
    // debt rather than fast-forwarding through it afterwards.
    void Stalled() { acc = 0; phase = 0; }
};
static WebPacer gPacer;
static bool gWebHidden;   // set by avara_web_background

#endif /* __EMSCRIPTEN__ */
#include <chrono>
#include <cmath>
#include <json.hpp>

// included while we fake things out
#include "CPlayerManager.h"

std::mutex trackerLock;

#ifndef __EMSCRIPTEN__
void TrackerPinger(CAvaraAppImpl *app) {
    while (true) {
        if (app->Number(kTrackerRegister) == 1 && app->GetNet()->netStatus == kServerNet) {
            std::string payload = app->TrackerPayload();
            if (payload.size() > 0) {
                // Probably not thread-safe.
                std::string address = app->String(kTrackerRegisterAddress);
                DBG_Log("tracker", "Pinging %s", address.c_str());
                size_t sepIndex = address.find(":");
                if (sepIndex != std::string::npos) {
                    std::string host = address.substr(0, sepIndex);
                    int port = std::stoi(address.substr(sepIndex + 1));
                    httplib::Client client(host.c_str(), port);
                    client.Post("/api/v1/games/", payload, "application/json");
                } else {
                    httplib::Client client(address.c_str(), 80);
                    client.Post("/api/v1/games/", payload, "application/json");
                }
            }
        }
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}

#endif /* __EMSCRIPTEN__ */
SDL_GameController *FindGameController() {
    for (int i = 0; i < SDL_NumJoysticks(); i++) {
        if (SDL_IsGameController(i)) {
            return SDL_GameControllerOpen(i);
        }
    }

    return nullptr;
}

void InitAxis(ControllerAxis &axis) {
    axis.last = 0.0f;
    axis.value = 0.0f;
    axis.active = 0;
    axis.last_active = 0;
    axis.toggled = 0;
}

void InitStick(ControllerStick &stick, uint16_t clamp_low = 4000, uint16_t clamp_high = 28000) {
    stick.clamp_inner = clamp_low;
    stick.clamp_outer = clamp_high;
    stick.elapsed = 0;
    InitAxis(stick.x);
    InitAxis(stick.y);
}

void InitTrigger(ControllerTrigger &trigger) {
    trigger.clamp_low = 3000;
    trigger.clamp_high = 30000;
    trigger.elapsed = 0;
    InitAxis(trigger.t);
}

int UpdateAxis(ControllerAxis &axis, float value) {
    axis.last_active = axis.active;
    if (abs(value) < 0.0001f) {
        value = 0.0f;
        axis.active = 0;
    }
    else {
        axis.active = 1;
    }
    axis.last = axis.value;
    axis.value = value;
    axis.toggled = (axis.value <= 0) != (axis.last <= 0);
    // We want to send the an event if the axis is active *or* it just became inactive.
    return axis.active + axis.last_active + axis.toggled;
}

int UpdateStick(ControllerStick &stick, int32_t x, int32_t y, uint32_t elapsed) {
    int32_t magnitude = sqrt((x * x) + (y * y));
    float scale = float(magnitude - stick.clamp_inner) / float(stick.clamp_outer - stick.clamp_inner);
    scale = std::clamp(scale, 0.0f, 1.0f) / magnitude;
    if (UpdateAxis(stick.x, x * scale) + UpdateAxis(stick.y, y * scale)) {
        stick.elapsed += elapsed;
        return 1;
    }
    else {
        stick.elapsed = 0;
        return 0;
    }
}

int UpdateTrigger(ControllerTrigger &trigger, uint16_t t, uint32_t elapsed) {
    float scaled = float(t - trigger.clamp_low) / float(trigger.clamp_high - trigger.clamp_low);
    scaled = std::clamp(scaled, 0.0f, 1.0f) * t;
    if (UpdateAxis(trigger.t, scaled)) {
        trigger.elapsed += elapsed;
        return 1;
    }
    else {
        trigger.elapsed = 0;
        return 0;
    }
}

CAvaraAppImpl::CAvaraAppImpl() : CApplication("Avara") {
    AssetManager::Init();

    controllerBaseEvent = SDL_RegisterEvents(1);
    lastControllerEvent = 0;
    controller = FindGameController();
    controllerPollMillis = 1000 / Number(kControllerPollRate);

    InitStick(sticks.left);
    InitStick(sticks.right);
    InitTrigger(triggers.left);
    InitTrigger(triggers.right);
    
    itsGame = std::make_unique<CAvaraGame>(Get<FrameTime>(kFrameTimeTag));
    gCurrentGame = itsGame.get();
#ifdef __EMSCRIPTEN__
    itsGame->externalPacing = true;   // ticks are handed out by WebPacer in idle()
#endif /* __EMSCRIPTEN__ */

    // use sqlite to persist stuff
#ifndef __EMSCRIPTEN__
    itsAPI = std::make_unique<CRUDsqlite>();
#else /* __EMSCRIPTEN__ */
    itsAPI = std::make_unique<CRUDnull>();
#endif /* __EMSCRIPTEN__ */

    if (mNVGContext) {
        ui = std::make_unique<CHUD>(gCurrentGame);
        ui->LoadImages(mNVGContext);
    }

#if defined(AVARA_GLES)
    gRenderer = new LegacyOpenGLRenderer(mSDLWindow);
#else
    if (Get(kUseLegacyRenderer)) {
        gRenderer = new LegacyOpenGLRenderer(mSDLWindow);
    } else {
        gRenderer = new ModernOpenGLRenderer(mSDLWindow);
    }
#endif

    gRenderer->UpdateViewRect(mSize.x, mSize.y, mPixelRatio);
    gRenderer->SetFOV(Number(kFOV));
    gRenderer->ResetLights();

    itsGame->IAvaraGame(this);

    previewAngle = 0;
    previewRadius = 0;
    animatePreview = false;

    setLayout(new nanogui::FlowLayout(nanogui::Orientation::Vertical, true, 25, 25));

    itsGUIState = GUIState::title;

    mainMenu = new CMainMenu(this, mNVGContext);

    backButton = new nanogui::Button(this, "Back");
    backButton->setFixedWidth(50);
    backButton->setTextPosition(nanogui::Button::TextPosition::Left);
    backButton->setVisible(false);

    settingsWindow = new CSettingsWindow(this);

    playerWindow = new CPlayerWindow(this);
    playerWindow->setFixedWidth(200);

    levelWindow = new CLevelWindow(this);
    levelWindow->setFixedWidth(200);

    networkWindow = new CNetworkWindow(this);
    networkWindow->setFixedWidth(200);

    serverWindow = new CServerWindow(this);
    serverWindow->setFixedWidth(200);

    trackerWindow = new CTrackerWindow(this);
    trackerWindow->setFixedWidth(500);

    rosterWindow = new CRosterWindow(this);

    performLayout();

    for (auto win : windowList) {
        // win->restoreState();
        win->setVisible(false);
    }

    mainMenu->setVisible(true);

    nextTrackerUpdate = 0;
    trackerUpdatePending = false;
#ifndef __EMSCRIPTEN__
    trackerThread = new std::thread(TrackerPinger, this);
    trackerThread->detach();
#endif /* __EMSCRIPTEN__ */

    gameNet->ChangeNet(kNullNet, "");

    // register and handle text commands
    itsTui = new CommandManager(this);

    MessageLine(kmWelcome1, MsgAlignment::Center);
    AddMessageLine("Type /help and press return for a list of chat commands.", MsgAlignment::Center);

    // load up a random decent starting level

    if (this->Boolean(kPunchHoles)) {
        std::string host = String(kPunchServerAddress);
        uint16_t port = static_cast<uint16_t>(Number(kPunchServerPort));
        SDL_Log("Enabling UDP hole punching via %s:%d", host.c_str(), port);
        PunchSetup(host.c_str(), port);
    }
}

CAvaraAppImpl::~CAvaraAppImpl() {
    DeallocParser();
}

void CAvaraAppImpl::UpdateGUIState(GUIState g) {
#ifdef __EMSCRIPTEN__
    // The page has its own menus to host, join, find games and change settings, so in the
    // browser the canvas only ever shows the level, roster and player windows.
    g = GUIState::singlePlayer;
#endif /* __EMSCRIPTEN__ */
    auto oldState = itsGUIState;
    if (g != GUIState::title &&
        g != GUIState::hostServer &&
        g != GUIState::joinedServer) {
        backButton->setCallback([this, oldState] () {
            UpdateGUIState(oldState);
            backButton->setVisible(false);
        });
#ifndef __EMSCRIPTEN__
        backButton->setVisible(true);
#else /* __EMSCRIPTEN__ */
        backButton->setVisible(false);
#endif /* __EMSCRIPTEN__ */
        backButton->setNeedsLayout();
    }
    else backButton->setVisible(false);
    for (auto win : windowList) {
        win->setVisible(false);
    }
    mainMenu->setVisible(false);
    switch (g) {
        case GUIState::title:
            mainMenu->setVisible(true);
            break;
        case GUIState::hostSettings:
            serverWindow->setVisible(true);
            break;
        case GUIState::hostServer:
            serverWindow->setVisible(true);
            levelWindow->setVisible(true);
            playerWindow->setVisible(true);
            rosterWindow->setVisible(true);
            break;
        case GUIState::joinedServer:
            networkWindow->setVisible(true);
            levelWindow->setVisible(true);
            rosterWindow->setVisible(true);
            playerWindow->setVisible(true);
            break;
        case GUIState::tracker:
            trackerWindow->setVisible(true);
            networkWindow->setVisible(true);
            break;
        case GUIState::singlePlayer:
            levelWindow->setVisible(true);
            rosterWindow->setVisible(true);
            playerWindow->setVisible(true);
            break;
        case GUIState::settings:
            settingsWindow->setVisible(true);
            break;
        default:
            break;
    }
    setNeedsLayout();
    performLayout();
    itsGUIState = g;
}


void CAvaraAppImpl::Done() {
    // This will trigger a clean disconnect if connected.
    gameNet->ChangeNet(kNullNet, "");
    if (controller)
        SDL_GameControllerClose(controller);
    CApplication::Done();
}

void CAvaraAppImpl::idle() {
    static double avg = 0;
    FrameNumber curFrame = itsGame->frameNumber;
    uint32_t procTime = SDL_GetTicks();

    CheckSockets();
    TrackerUpdate();

    // Poll for controller axis value at kControllerPollRate
    uint32_t elapsed = procTime - lastControllerEvent;
    if (controller && elapsed > controllerPollMillis) {
        int controllerActive = 0;
        
        int16_t leftX = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_LEFTX);
        int16_t leftY = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_LEFTY);
        controllerActive += UpdateStick(sticks.left, leftX, leftY, elapsed);
        
        int16_t rightX = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_RIGHTX);
        int16_t rightY = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_RIGHTY);
        controllerActive += UpdateStick(sticks.right, rightX, rightY, elapsed);
        
        int16_t leftT = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_TRIGGERLEFT);
        controllerActive += UpdateTrigger(triggers.left, leftT, elapsed);

        int16_t rightT = SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_TRIGGERRIGHT);
        controllerActive += UpdateTrigger(triggers.right, rightT, elapsed);

        if (controllerActive) {
            SDL_Event controllerEvent;
            controllerEvent.type = controllerBaseEvent;
            controllerEvent.user.data1 = &sticks;
            controllerEvent.user.data2 = &triggers;
            SDL_PushEvent(&controllerEvent);
        }
        
        lastControllerEvent = procTime;
    }

#ifndef __EMSCRIPTEN__
    if (itsGame->GameTick()) {
        RenderContents();
#else /* __EMSCRIPTEN__ */
    if (!itsGame->IsPlaying()) {
        gPacer.Reset();
        itsGame->tickAllowed = false;
        itsGame->GameTick();                // network and pings only
        itsGame->tickAllowed = true;        // a game starting from here runs its first tick
    } else {
        int due = gPacer.TicksDue(emscripten_get_now(), itsGame->frameTime * (62.5 / 60.0));
        bool advanced = false;
        // Always call once, so packets are processed on every refresh even when no frame
        // is due.
        for (int i = 0; i < std::max(due, 1); i++) {
            itsGame->tickAllowed = i < due;
            if (!itsGame->GameTick()) {
                if (i < due) gPacer.Stalled();
                break;
            }
            advanced = true;
            if (!itsGame->IsPlaying()) break;
        }
        itsGame->tickAllowed = true;
        if (advanced) {
            if (!gWebHidden) RenderContents();
            avara_frame_mark(itsGame->frameNumber);
        }
#endif /* __EMSCRIPTEN__ */
    }
    // output a coarse estimate of cpu time & percent every second when enabled
    if (curFrame > 1 && curFrame != itsGame->frameNumber && Debug::IsEnabled("cpu")) {
        procTime = SDL_GetTicks() - procTime;
        avg = 0.99 * avg + 0.01 * procTime;
        if (curFrame % (1000 / itsGame->frameTime) == 0) {
            DBG_Log("cpu", "%.1fms (%.0f%%)\n", avg, 100.0 * avg / itsGame->frameTime);
        }
    }
}

void CAvaraAppImpl::drawContents() {
    if (animatePreview) {
        auto vp = gRenderer->viewParams;
        Fixed radius = 0.6*previewRadius + 0.4*FMul(previewRadius, FOneCos(previewAngle*0.7));
        Fixed x = itsGame->extentCenter[0] + FMul(radius, FOneCos(previewAngle));
        Fixed y = itsGame->extentCenter[1] + FMul(std::min(itsGame->extentCenter[1], FIX(100)), FOneSin(previewAngle) + FIX1);
        Fixed z = itsGame->extentCenter[2] + FMul(radius, FOneSin(previewAngle));
        vp->LookFrom(x, y, z);
        vp->LookAt(itsGame->extentCenter[0], itsGame->extentCenter[1], itsGame->extentCenter[2]);
        vp->PointCamera();
        previewAngle += FIX3(1);
    }
    itsGame->Render();
    if (ui) {
        if (itsGame->showNewHUD) {
            ui->RenderNewHUD(mNVGContext);
        } else {
            ui->Render(mNVGContext);
        }
    }
}

// display only the game screen, not the widgets
void CAvaraAppImpl::RenderContents() {
#ifdef __EMSCRIPTEN__
    // The page scales the drawing buffer (render scale, F9 and automatic) without resizing
    // the window, so no resize event says the ratio between them changed. The HUD lays
    // itself out in window units through this ratio; a stale one put it off-screen.
    {
        int ww = 0, wh = 0, dw = 0, dh = 0;
        SDL_GetWindowSize(mSDLWindow, &ww, &wh);
        AvaraDrawableSize(mSDLWindow, &dw, &dh);
        auto vp = gRenderer->viewParams;
        float ratio = ww > 0 ? (float)dw / (float)ww : 1.0f;
        if (ww > 0 && wh > 0 &&
            (vp->viewPixelDimensions.h != ww || vp->viewPixelDimensions.v != wh || std::fabs(vp->viewPixelRatio - ratio) > 0.001f)) {
            gRenderer->UpdateViewRect(ww, wh, ratio);
        }
        // Nothing else sets the viewport while a round is on (nanogui does, when it draws
        // the menus), so a buffer scaled mid-round needs it set here.
        glViewport(0, 0, dw, dh);
    }
#endif /* __EMSCRIPTEN__ */
    drawContents();
    gRenderer->RefreshWindow();
}

void CAvaraAppImpl::WindowResized(int width, int height) {
    // Only update if the resolution is actually changing
    if (gRenderer->viewParams->viewPixelDimensions.h != width || gRenderer->viewParams->viewPixelDimensions.v != height)
        gRenderer->UpdateViewRect(width, height, mPixelRatio);
    // performLayout();
    mainMenu->updateAspectRatio();
}

void CAvaraAppImpl::PrefChanged(std::string name) {
    CApplication::PrefChanged(name);
    if (itsGame) itsGame->ReadGamePrefs();
    if (gRenderer) gRenderer->ApplyPrefs(name);
}

bool CAvaraAppImpl::handleSDLEvent(SDL_Event &event) {
    switch (event.type) {
        case SDL_CONTROLLERDEVICEADDED:
            if (!controller) {
                controller = SDL_GameControllerOpen(event.cdevice.which);
            }
            break;
        case SDL_CONTROLLERDEVICEREMOVED:
            if (controller &&
                event.cdevice.which == SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(controller))) {
                SDL_GameControllerClose(controller);
                controller = FindGameController();
            }
            break;
    }

    if (itsGame->IsPlaying()) {
        itsGame->HandleEvent(event);
        return true;
    } else {
        if (settingsWindow->currentlyMapping()) {
            settingsWindow->getKeyMapWindow()->handleSDLEvent(event);
        }
        for (int i = 0; i < windowList.size(); i++) {
            if (windowList[i]->editing()) {
                if (CApplication::handleSDLEvent(event))
                return true;
            }
        }

        if (rosterWindow->handleSDLEvent(event))
            return true;

        return CApplication::handleSDLEvent(event);
    }
}

void CAvaraAppImpl::drawAll() {
    if (!itsGame->IsPlaying()) {
        rosterWindow->UpdateRoster();
        CApplication::drawAll();
#ifdef __EMSCRIPTEN__
        avara_frame_mark(-1);
#endif /* __EMSCRIPTEN__ */
    }
}


void CAvaraAppImpl::GameStarted(LevelInfo &loadedLevel) {
    auto vp = gRenderer->viewParams;
    animatePreview = false;
    vp->showTransparent = false;
    itsGame->IncrementGameCounter();
    MessageLine(kmStarted, MsgAlignment::Center);
    itsAPI->RecordGameStart(itsGame->currentGameId, loadedLevel);
    levelWindow->UpdateRecents();
    if (controller) {
        auto color = itsGame->GetLocalTeamColor();
        SDL_GameControllerSetLED(controller, color.GetR(), color.GetG(), color.GetB());
    }
}

void CAvaraAppImpl::Rumble(Fixed hitEnergy) {
    if (controller) {
        SDL_GameControllerRumble(controller, 0x00FF, 0xFF00, 250);
    }
}

bool CAvaraAppImpl::DoCommand(int theCommand) {
    std::string name = String(kPlayerNameTag);
    Str255 userName;
    userName[0] = name.length();
    BlockMoveData(name.c_str(), userName + 1, userName[0]);
    // SDL_Log("DoCommand %d\n", theCommand);
    switch (theCommand) {
        case kReportNameCmd:
            gameNet->NameChange(userName);
            return true;
            // break;
        case kStartGame:
        case kResumeGame:
            itsGame->SendStartCommand();
            return true;
            // break;
        case kGetReadyToStartCmd:
            break;
        case kNetChangedCmd: {
            switch(gameNet->netStatus) {
                case kNullNet:
                    UpdateGUIState(GUIState::title);
                    break;
                case kServerNet:
                    UpdateGUIState(GUIState::hostServer);
                    break;
                case kClientNet:
                    UpdateGUIState(GUIState::joinedServer);
                    break;
                default:
                    break;
            }
            break;
        }
        case kKeyboardMappingReset: {
            auto player = CPlayerManagerImpl::LocalPlayer();
            if (player) player->ResetKeyMap();
        }
        default:
            break;
    }
    return false;
    /*
        default:
            if(	theCommand >= kLatencyToleranceZero &&
                theCommand <= kLatencyToleranceMax)
            {	WriteShortPref(kLatencyToleranceTag, theCommand - kLatencyToleranceZero);
            }
            else
            if(	theCommand >= kRetransmitMin &&
                theCommand <= kRetransmitMax)
            {	WriteShortPref(kUDPResendPrefTag, theCommand - kRetransmitMin);

                if(gameNet->itsCommManager)
                {	gameNet->itsCommManager->OptionCommand(theCommand);
                }
            }
            if(	theCommand >= kSlowestConnectionCmd && theCommand <= kFastestConnectionCmd)
            {	WriteShortPref(kUDPConnectionSpeedTag, theCommand - kSlowestConnectionCmd);

                if(gameNet->itsCommManager)
                {	gameNet->itsCommManager->OptionCommand(theCommand);
                }
            }
            else
                inherited::DoCommand(theCommand);
            break;
    }
    */
}

OSErr CAvaraAppImpl::LoadLevel(std::string set, std::string levelTag, CPlayerManager *sendingPlayer) {
    SDL_Log("LOADING LEVEL %s FROM %s\n", levelTag.c_str(), set.c_str());
    itsGame->LevelReset(false);
    gCurrentGame = itsGame.get();

    ColorManager::resetOverrides();

    itsGame->loadedLevelInfo = std::make_unique<LevelInfo>(set, "loading...", levelTag);
    OSErr result = AssetManager::LoadLevel(set, levelTag, itsGame->loadedLevelInfo->levelName);

    if (result == noErr) {
        playerWindow->RepopulateHullOptions();

        std::string msgStr = "Loaded";
        if (sendingPlayer != NULL) {
            msgStr = sendingPlayer->GetPlayerName() + " loaded";
        }
        auto &level = itsGame->loadedLevelInfo->levelName;
        msgStr += " \"" + level + "\" from \"" + set + "\".";
        AddMessageLine(msgStr);

        levelWindow->SelectLevel(set, level);

        // calculate the extent of visible objects in the level (used for level previews and random incarnators)
        itsGame->CalculateExtent();

        auto vp = gRenderer->viewParams;
        vp->yonBound = FIX(10000);
        vp->showTransparent = true;

        previewAngle = 0;
        previewRadius = itsGame->extentRadius * 1.75;

        animatePreview = true;
    }

    return result;
}

void CAvaraAppImpl::NotifyUser() {
    // TODO: Bell sound(s)
    SDL_Log("BEEP!!!\n");
    Beep();
}

CAvaraGame *CAvaraAppImpl::GetGame() {
    return itsGame.get();
}

CNetManager *CAvaraAppImpl::GetNet() {
    return gameNet;
}

CommandManager *CAvaraAppImpl::GetTui() {
    return itsTui;
}

void CAvaraAppImpl::SetNet(CNetManager *theNet) {
    gameNet = theNet;
}

void CAvaraAppImpl::AddMessageLine(std::string lines, MsgAlignment align, MsgCategory category) {
    std::istringstream iss(lines);
    std::string line;
    MsgLine msg;

    msg.align = align;
    msg.category = category;
    msg.gameId = itsGame->currentGameId;

    // split string on newlines
    while (std::getline(iss, line)) {
        SDL_Log("Message: %s", line.c_str());
        msg.text = line;
        messageLines.push_back(msg);
        if (messageLines.size() > 500) {
            messageLines.pop_front();
        }
    }
}

void CAvaraAppImpl::MessageLine(short index, MsgAlignment align) {
    // SDL_Log("CAvaraAppImpl::MessageLine(%d)\n", index);
    switch (index) {
        case kmWelcome1:
        case kmWelcome2:
        case kmWelcome3:
        case kmWelcome4:
            AddMessageLine("Welcome to Avara.", align);
            break;
        case kmStarted:
            AddMessageLine("Starting new game.", align);
            break;
        case kmRestarted:
            AddMessageLine("Resuming game.", align);
            break;
        case kmAborted:
            AddMessageLine("Aborted.", align);
            break;
        case kmWin:
            AddMessageLine("Mission complete.", align);
            break;
        case kmGameOver:
            AddMessageLine("Game over.", align);
            break;
        case kmSelfDestruct:
            AddMessageLine("Self-destruct activated.", align);
            break;
        case kmFragmentAlert:
            AddMessageLine("ALERT: Reality fragmentation detected!", align, MsgCategory::Error);
            break;
        case kmRefusedLogin:
            AddMessageLine("Login refused.", align, MsgCategory::Error);
            break;
    }
}

std::deque<MsgLine> &CAvaraAppImpl::MessageLines() {
    return messageLines;
}
void CAvaraAppImpl::LevelReset() {}
void CAvaraAppImpl::ParamLine(short index, MsgAlignment align, StringPtr param1, StringPtr param2) {
    SDL_Log("CAvaraAppImpl::ParamLine(%d)\n", index);
    std::stringstream buffa;
    std::string a = ToString(param1);
    std::string b;
    MsgCategory category = MsgCategory::System;
    if (param2)
        b = ToString(param2);

    switch (index) {
        case kmPaused:
            buffa << "Game paused by " << a << ".";
            break;
        case kmWaitingForPlayer:
            buffa << "Waiting for " << a << "... (abort to exit)";
            category = MsgCategory::Error;
            break;
        case kmAKilledBPlayer:
            buffa << a << " killed " << b << ".";
            break;
        case kmKilledByCollision:
            buffa << a << " was killed by the world.";
            break;
        case kmUnavailableNote:
            buffa << a << " is busy.";
            category = MsgCategory::Error;
            break;
        case kmStartFailure:
            buffa << a << " wasn't ready.";
            category = MsgCategory::Error;
            break;
    }

    AddMessageLine(buffa.str(), align, category);
}
void CAvaraAppImpl::StartFrame(FrameNumber frameNum) {}

void CAvaraAppImpl::StringLine(std::string theString, MsgAlignment align) {
    AddMessageLine(theString.c_str(), align, MsgCategory::Level);
}

void CAvaraAppImpl::ComposeParamLine(StringPtr destStr, short index, StringPtr param1, StringPtr param2) {
    ParamLine(index, MsgAlignment::Left, param1, param2);
}

void CAvaraAppImpl::TrackerUpdate() {
    if (SDL_GetTicks() < nextTrackerUpdate)
        return;
    if (gameNet->netStatus != kServerNet)
        return;

    const std::lock_guard<std::mutex> lock(trackerLock);
    long freq = Number(kTrackerRegisterFrequency);

    trackerState.clear();

    for (int i = 0; i < kMaxAvaraPlayers; i++) {
        unsigned char *p = gameNet->playerTable[i]->PlayerName();
        std::string playerName((char *)p + 1, p[0]);
        if (playerName.size() > 0) {
            trackerState["players"].push_back(playerName);
        }
    }
    if (trackerState["players"].empty()) {
        trackerState["players"].push_back(String(kPlayerNameTag));
    }
    std::string gitv = std::string(GIT_VERSION);
    trackerState["version"]["git"] = gitv;
    trackerState["version"]["net"] = kAvaraNetVersion;
    trackerState["description"] = gitv.substr(0, 6) + (gitv.length() > 8 ? "\\*: " : ": ") + String(kServerDescription);
    trackerState["password"] = String(kServerPassword).length() > 0 ? true : false;

    DBG_Log("tracker", "%s", trackerState.dump().c_str());

    trackerUpdatePending = true;
    nextTrackerUpdate = SDL_GetTicks() + (freq * 1000);
}

std::string CAvaraAppImpl::TrackerPayload() {
    const std::lock_guard<std::mutex> lock(trackerLock);
    std::string payload = trackerUpdatePending && trackerState.size() > 0 ? trackerState.dump() : "";
    trackerUpdatePending = false;
    return payload;
}

void CAvaraAppImpl::SetIndicatorDisplay(short i, short v) {}
void CAvaraAppImpl::NumberLine(long theNum, short align) {}
void CAvaraAppImpl::DrawUserInfoPart(short i, short partList) {}
void CAvaraAppImpl::BrightBox(FrameNumber frameNum, short position) {}
#ifdef __EMSCRIPTEN__

// ---------------------------------------------------------------------------------------
// Called by the page (web/lobby.js) through Module.ccall. The lobby is HTML; these are the
// only ways it reaches into the game. Each returns at once: joining finishes later and is
// reported through WebEvent("net", ...).
// ---------------------------------------------------------------------------------------
static CAvaraAppImpl *WebApp() { return (CAvaraAppImpl *)gApplication; }

extern "C" {

// Host a game: this tab becomes slot 0, and others reach it through the page's mesh.
EMSCRIPTEN_KEEPALIVE void avara_web_host() {
    WebApp()->GetNet()->ChangeNet(kServerNet, "");
}

// Join the game whose host's mesh id is peer ("peer:<hex>", see AvaraTCP_web.cpp).
EMSCRIPTEN_KEEPALIVE void avara_web_join(const char *peer) {
    WebApp()->GetNet()->ChangeNet(kClientNet, peer);
}

// A hidden tab gets no requestAnimationFrame, and Chrome slows its timers to a crawl; in
// lockstep the others would all wait on us. So while hidden in a game with others, the
// page pauses the rAF loop and drives avara_web_tick from a Web Worker, whose timers keep
// time in a background tab. Nothing is drawn meanwhile (no one can see it).
EMSCRIPTEN_KEEPALIVE void avara_web_background(int hidden) {
    gWebHidden = hidden != 0;
    if (gWebHidden) emscripten_pause_main_loop();
    else emscripten_resume_main_loop();
}

// Back to playing alone: hosting stops, or the connection to the host closes.
EMSCRIPTEN_KEEPALIVE void avara_web_leave() {
    CNetManager *net = WebApp()->GetNet();
    net->CancelPendingConnect();
    if (net->netStatus != kNullNet) {
        net->ChangeNet(kNullNet, "");
    }
}

EMSCRIPTEN_KEEPALIVE void avara_web_set_name(const char *name) {
    std::string value(name);
    if (value.empty() || value.size() > 31) return;
    WebApp()->Set(kPlayerNameTag, value);
    Str255 theName;
    theName[0] = value.length();
    BlockMoveData(value.c_str(), theName + 1, theName[0]);
    WebApp()->GetNet()->NameChange(theName);
}

// The page finished downloading a level set (ok=0: it could not).
EMSCRIPTEN_KEEPALIVE void avara_web_set_ready(const char *set, int ok) {
    WebApp()->GetNet()->LevelSetFetched(set, ok != 0);
}

// Load a level by set and .alf, for everyone in the game (a client's request goes to
// the host, which sends it to all, as the Levels window's Load button does).
EMSCRIPTEN_KEEPALIVE void avara_web_load(const char *set, const char *alf) {
    WebApp()->GetNet()->SendLoadLevel(set, alf);
}

// Set a preference from the page's Settings screen: value is JSON of the same type as the
// preference has now (a mismatch is refused, as /pref refuses it). Applies it at once.
EMSCRIPTEN_KEEPALIVE int avara_web_set_pref(const char *name, const char *value) {
    std::string v(value);
    std::string n(name);
    json parsed;
    try { parsed = json::parse(v); } catch (...) { return 0; }
    if (parsed.is_string()) v = parsed.get<std::string>();   // Update() quotes strings itself
    if (!WebApp()->Update(n, v)) return 0;
    // new key bindings take effect at once, as after the Settings window's keyboard page
    if (n == kKeyboardMappingTag) WebApp()->DoCommand(kKeyboardMappingReset);
    return 1;
}

// Write the preferences file (the page keeps a copy in localStorage: the file system the
// engine sees is gone when the tab closes).
EMSCRIPTEN_KEEPALIVE void avara_web_save_prefs() {
    WebApp()->SavePrefs();
}

// For harnesses: where the local player is, and the sizes the view uses, as JSON.
EMSCRIPTEN_KEEPALIVE const char *avara_web_probe() {
    static std::string out;
    CAvaraGame *game = WebApp()->GetGame();
    CAbstractPlayer *p = game ? game->GetLocalPlayer() : nullptr;
    char buf[200];
    if (p) snprintf(buf, sizeof buf, "{\"playing\":%d,\"frame\":%d,\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"lives\":%d,\"out\":%d,\"freeView\":%d,\"spectating\":%d,\"limbo\":%d}",
                    game->IsPlaying() ? 1 : 0, game->frameNumber,
                    ToFloat(p->location[0]), ToFloat(p->location[1]), ToFloat(p->location[2]),
                    p->lives, p->isOut ? 1 : 0, p->freeView ? 1 : 0, game->GetSpectatePlayer() != nullptr ? 1 : 0,
                    p->isInLimbo ? (int)p->limboCount : -9999);
    else snprintf(buf, sizeof buf, "{\"playing\":%d,\"frame\":%d}", game && game->IsPlaying() ? 1 : 0, game ? game->frameNumber : -1);
    out = buf;
    // sizes, for chasing render-scale trouble: window, drawable, the view's idea, GL viewport
    int ww = 0, wh = 0, dw = 0, dh = 0;
    SDL_GetWindowSize(WebApp()->sdlWindow(), &ww, &wh);
    AvaraDrawableSize(WebApp()->sdlWindow(), &dw, &dh);
    GLint vpt[4] = {0, 0, 0, 0};
    glGetIntegerv(GL_VIEWPORT, vpt);
    auto vp = gRenderer->viewParams;
    char sz[200];
    snprintf(sz, sizeof sz, ",\"win\":[%d,%d],\"draw\":[%d,%d],\"view\":[%d,%d],\"ratio\":%.3f,\"glvp\":[%d,%d]}",
             ww, wh, dw, dh, (int)vp->viewPixelDimensions.h, (int)vp->viewPixelDimensions.v, vp->viewPixelRatio, vpt[2], vpt[3]);
    out.pop_back();
    out += sz;
    return out.c_str();
}

// A text command, as typed in the roster's chat line ("/load clock").
EMSCRIPTEN_KEEPALIVE void avara_web_command(const char *text) {
    WebApp()->GetTui()->ExecuteMatchingCommand(text, CPlayerManagerImpl::LocalPlayer());
}

// A line in the message area from the page (a rating saved, an invitation sent).
EMSCRIPTEN_KEEPALIVE void avara_web_message(const char *text) {
    WebApp()->AddMessageLine(text);
}

}
#endif /* __EMSCRIPTEN__ */
