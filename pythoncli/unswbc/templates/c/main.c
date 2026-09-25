#include "helper.h"

#include <stdio.h>
#include <stdlib.h>

static void Shuffle(UnswbcDirection* directions, int count)
{
    for (int i = count - 1; i > 0; i--)
    {
        int const j = rand() % (i + 1);
        UnswbcDirection const swap = directions[i];
        directions[i] = directions[j];
        directions[j] = swap;
    }
}

int main(void)
{
    UnswbcController* ct = NULL;
    UnswbcGame* game = NULL;
    unswbc_init(&ct, &game);

    /* Seed so we get the same random generator every time. */
    srand(0);

    while (unswbc_update(ct, game))
    {
        /* Step onto the first open neighbouring tile. */
        UnswbcPosition here = unswbc_position(ct);
        UnswbcTile const* here_tile = unswbc_tile(ct, here);
        UnswbcDirection directions[4];
        int moved = 0;

        for (int i = 0; i < 4; i++)
        {
            directions[i] = UNSWBC_DIRECTIONS[i];
        }
        Shuffle(directions, 4);

        for (int i = 0; i < 4; i++)
        {
            UnswbcDirection direction = directions[i];

            UnswbcEdge const* edge = here_tile ? unswbc_edge(here_tile, direction) : NULL;
            if (edge && !unswbc_passable(edge))
            {
                continue;
            }

            UnswbcTile const* ahead = unswbc_tile(ct, unswbc_add(here, direction));
            UnswbcEntity const* entity = unswbc_entity(ahead);
            if (entity && entity->type == UNSWBC_ENTITY_DRAGON)
            {
                continue;
            }

            char note[32];
            snprintf(note, sizeof note, "Moving in %c", (char)direction);
            unswbc_log(note);
            unswbc_move(direction);
            moved = 1;
            break;
        }

        if (!moved)
        {
            unswbc_move(UNSWBC_NORTH);
        }
        unswbc_end_turn();
    }
    return 0;
}
