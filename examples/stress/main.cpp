#include "helper.hpp"

#include <algorithm>
#include <random>


#define arr array

using namespace std;
using unswbc::Constants, unswbc::EntityType;
using unswbc::Controller, unswbc::Game;
using unswbc::Position, unswbc::Direction, unswbc::Entity, unswbc::Tile;

mt19937 rng(0);

void execute_turn(Controller& ct)
{
    ct.output_log("yo c++ works");

    if (ct.can_split(6))
    {
        ct.do_split(6);
        return;
    }

    arr<Direction, 4> dirs = Direction::get_direction_list();
    shuffle(dirs.begin(), dirs.end(), rng);

    for (auto d : dirs)
    {
        Position curr = ct.get_position();
        if (ct.get_tile(curr) && ct.get_tile(curr)->get_edge(d) && !ct.get_tile(curr)->get_edge(d)->is_passable())
        {
            continue;
        }

        if (!ct.get_tile(curr.add_dir(d)))
        {
            continue;
        }

        Entity* e = ct.get_tile(curr.add_dir(d))->get_entity();
        if (e && e->entity_type == EntityType::DRAGON_PART)
        {
            continue;
        }

        ct.make_move(d);
        return;
    }

    for (int i = ct.get_length() - 2; i >= 2; i--)
    {
        if (ct.can_split(i))
        {
            return void(ct.do_split(i));
        }
    }
}

int main()
{
    auto [ct, game] = unswbc::init();

    while (unswbc::update(ct, game))
    {
        execute_turn(ct);
        unswbc::end_turn();
    }
}