#include <array>
#include <queue>
#include <random>
#include <algorithm>
#include <chrono>
#include "helper.hpp"
#define arr array

using namespace std;
using unswbc::Controller, unswbc::Game;
using unswbc::Position, unswbc::Direction, unswbc::Entity, unswbc::Tile;
using unswbc::Constants, unswbc::EntityType;

mt19937 rng(0);

arr<arr<bool, Constants::VISION_SIZE>, Constants::VISION_SIZE> vis;
arr<arr<Direction, Constants::VISION_SIZE>, Constants::VISION_SIZE> dir;
void bfs(Controller &ct) {
    queue<pair<Position, arr<int, 2>>> q;
    q.push({ct.get_position(), {Constants::VISION_RADIUS, Constants::VISION_RADIUS}});
    vis[Constants::VISION_RADIUS][Constants::VISION_RADIUS] = true;
    while (!q.empty()) {
        auto [p, loc] = q.front(); q.pop();
        for (Direction d : Direction::get_direction_list()) {
            Position nxt_p = p.add_dir(d);
            if (!ct.get_tile(nxt_p)) continue;
            if (ct.get_tile(nxt_p)->get_entity()
                && ct.get_tile(nxt_p)->get_entity()->get_type() == EntityType::DRAGON_PART
                && !ct.get_tile(nxt_p)->get_entity()->is_head()) continue; // um
            if (!ct.get_tile(p)->get_edge(d)->is_passable() || ct.get_tile(p)->get_edge(d)->is_portal()) continue; // wall or portal
            arr<int, 2> nxt_loc = {
                loc[0] + d.get_offset().first,
                loc[1] + d.get_offset().second
            };
            if (vis[nxt_loc[0]][nxt_loc[1]]) continue;
            vis[nxt_loc[0]][nxt_loc[1]] = true;
            dir[nxt_loc[0]][nxt_loc[1]] = d.get_opposite();
            q.push({nxt_p, nxt_loc});
        }
    }
}

int wrap(int loc, int org, int sz) {
    int del = (loc - org + sz) % sz;
    if (del > sz / 2) del -= sz;
    return del;
}
Direction dir_to_target(Position p, Controller &ct, Game &game) {
    if (p == ct.get_position()) return Direction::NONE;

    arr<int, 2> loc = {
        wrap(p.x, ct.get_position().x, game.width) + Constants::VISION_RADIUS,
        wrap(p.y, ct.get_position().y, game.height) + Constants::VISION_RADIUS
    };
    if (!vis[loc[0]][loc[1]]) return Direction::NONE; // unreachable
    
    while (true) {
        Direction d = dir[loc[0]][loc[1]];
        p = p.add_dir(d);
        if (p == ct.get_position()) break;
        loc = {
            loc[0] + d.get_offset().first,
            loc[1] + d.get_offset().second
        };
    }

    return dir[loc[0]][loc[1]].get_opposite();
}

void execute_turn(Controller &ct, Game &game) {
    if (ct.can_split(4)) return void(ct.do_split(4));

    fill(vis.begin(), vis.end(), arr<bool, Constants::VISION_SIZE>{});
    fill(dir.begin(), dir.end(), arr<Direction, Constants::VISION_SIZE>{});
    bfs(ct); // precomp bfs

    ct.output_log("hi bfs done");

    vector<Tile> tiles = ct.get_tiles();
    vector<Position> heads;
    for (Tile t : tiles) {
        Entity *e = t.get_entity();
        if (e && e->get_type() == EntityType::DRAGON_PART && e->is_head() && e->get_team() != ct.get_team()) {
            heads.push_back(t.position);
        }
    }
    sort(heads.begin(), heads.end(), [&](Position a, Position b) {
        return abs(a.x - ct.get_position().x) + abs(a.y - ct.get_position().y)
            < abs(b.x - ct.get_position().x) + abs(b.y - ct.get_position().y);
    });

    for (Position p : heads) {
        Direction d = dir_to_target(p, ct, game);
        if (d == Direction::NONE) continue;
        ct.draw_indicator_dot(p, 255, 0, 0);
        ct.make_move(d);
        return;
    }

    arr<Direction, 4> dirs = Direction::get_direction_list();
    shuffle(dirs.begin(), dirs.end(), rng);

    for (auto d : dirs) {
        Position curr = ct.get_position();
        if (ct.get_tile(curr)
            && ct.get_tile(curr)->get_edge(d)
            && !ct.get_tile(curr)->get_edge(d)->is_passable()) continue;
        
        if (!ct.get_tile(curr.add_dir(d))) continue;

        Entity *e = ct.get_tile(curr.add_dir(d))->get_entity();
        if (e && e->get_type() == EntityType::DRAGON_PART) continue;

        ct.make_move(d);
        return;
    }

    for (int i = ct.get_length() - 2; i >= 2; i--) {
        if (ct.can_split(i)) return void(ct.do_split(i));
    }
}

int main() {
    auto [ct, game] = unswbc::init();

    while (unswbc::update(ct, game)) {
        // auto start = chrono::high_resolution_clock::now();
        execute_turn(ct, game);
        // auto end = chrono::high_resolution_clock::now();
        // auto d = chrono::duration_cast<std::chrono::milliseconds>(end - start);
        // cerr << d << "\n";
        unswbc::end_turn();
    }
}