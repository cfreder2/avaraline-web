//
//  CRUDnull.h
//  Avara (web build)
//
//  A no-op CRUD backend used for the Emscripten/browser build, where there is
//  no local sqlite database. "Recent levels" persistence is simply disabled;
//  everything else in the game works without it. A future web build can back
//  this with IndexedDB if persistence is wanted.
//

#pragma once

#include "CRUD.h"

class CRUDnull : public CRUD {
public:
    void RecordGameStart(int gameId, const LevelInfo &info) override {}
    RecentLevelsList GetRecentLevels(int limit = 50) override { return {}; }
};
