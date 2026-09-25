#include "engine/game.h"
#include "engine/protocol.h"

#include <capnp/message.h>
#include <capnp/serialize-packed.h>
#include <kj/io.h>

#include <cstdlib>
#include <memory>
#include <cstring>
#include <string>
#include <vector>

extern "C" {

__attribute__((import_module("unswbc"), import_name("bot_reply"))) int
HostBotReply(int dragonId, char const* block, int blockLen, char* out, int outCap);

__attribute__((import_module("unswbc"), import_name("log"))) void
HostLog(int dragonId, int round, int reason);

__attribute__((import_module("unswbc"), import_name("bot_spawn"))) void
HostBotSpawn(int dragonId, char const* init, int initLen);
}

namespace {

std::vector<char> gReply(1 << 16);
std::string gError;
std::string gMapText;
std::string gReplay;
std::unique_ptr<Game> gGame;

int TeamCode(std::optional<Team> team)
{
    if (!team)
    {
        return 0;
    }
    return *team == Team::A ? 1 : 2;
}

} // namespace

extern "C" {

void* ubc_alloc(int bytes)
{
    return std::malloc(static_cast<size_t>(bytes));
}

void ubc_free(void* p)
{
    std::free(p);
}

char const* ubc_error()
{
    return gError.c_str();
}

/// `debug` is the bot output to keep, as bits: LOG 1, INDICATOR 2, DOT and
/// LINE 4, unreadable-line complaints 8. Bit 16 holds it to the judge's limits.
int ubc_run(char const* mapPtr, int mapLen, int debug, int* out)
{
    gError.clear();
    try
    {
        DebugOutput const keep{.mLogs = (debug & 1) != 0,
                               .mIndicator = (debug & 2) != 0,
                               .mDraw = (debug & 4) != 0,
                               .mParse = (debug & 8) != 0,
                               .mLimits = (debug & 16) != 0};
        gMapText.assign(mapPtr, static_cast<size_t>(mapLen));
        gGame = std::make_unique<Game>(LoadMap(gMapText), keep);
        Game& game = *gGame;

        Game* gamePtr = &game;
        game.SpawnControllersWith([&gamePtr](Dragon const& dragon) -> DragonFn {
            int const id = dragon.mId;
            std::string const init = BuildInitBlock(gamePtr->State(), dragon);
            HostBotSpawn(id, init.data(), static_cast<int>(init.size()));
            return [id](std::string const& block) -> std::string {
                int n = HostBotReply(id, block.data(), static_cast<int>(block.size()), gReply.data(),
                                     static_cast<int>(gReply.size()));
                // A longer reply than fits comes back as its length, and is
                // handed over whole when asked again with room for it.
                if (n > static_cast<int>(gReply.size()))
                {
                    gReply.resize(static_cast<size_t>(n));
                    n = HostBotReply(id, block.data(), static_cast<int>(block.size()), gReply.data(), n);
                }
                if (n < 0)
                {
                    n = 0;
                }
                return std::string(gReply.data(), static_cast<size_t>(n));
            };
        });

        game.OnEvent([](Event const& event) {
            if (auto const* death = std::get_if<EventDragonDeath>(&event))
            {
                HostLog(death->mId, gGame->State().mRound, static_cast<int>(death->mReason));
            }
        });

        GameResult const result = game.Run();

        out[0] = game.State().mRound;
        out[1] = TeamCode(result.mWinner);
        out[2] = static_cast<int>(result.mEndReason);
        out[3] = result.mTeamA.mDragonCount;
        out[4] = result.mTeamB.mDragonCount;
        out[5] = result.mTeamA.mTotalLength;
        out[6] = result.mTeamB.mTotalLength;
        out[7] = static_cast<int>(game.Events().size());
        return 0;
    }
    catch (std::exception const& e)
    {
        gError = e.what();
        return 1;
    }
}

int ubc_replay(char const* aPtr, int aLen, char const* bPtr, int bLen)
{
    gError.clear();
    try
    {
        capnp::MallocMessageBuilder message;
        gGame->WriteReplay(message, gMapText,
                           {std::string(aPtr, static_cast<size_t>(aLen)), std::string(bPtr, static_cast<size_t>(bLen))});
        kj::VectorOutputStream stream;
        capnp::writePackedMessage(stream, message);
        auto const bytes = stream.getArray();
        gReplay.assign(reinterpret_cast<char const*>(bytes.begin()), bytes.size());
        return static_cast<int>(gReplay.size());
    }
    catch (std::exception const& e)
    {
        gError = e.what();
        return -1;
    }
}

char const* ubc_replay_ptr()
{
    return gReplay.data();
}
}
