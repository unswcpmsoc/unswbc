#!/usr/bin/env python3

from collections import deque
import random

import helper as unswbc
from helper import Direction, Position

ct: unswbc.Controller
game: unswbc.Game
random.seed(0)

def execute_turn() -> None:
    if ct.can_split(8) and ct.can_split(6):
        ct.do_split(6)
        return
    dirs = list(Direction.get_direction_list())
    random.shuffle(dirs)
    for d in dirs:
        curr = ct.get_position()
        if not ct.get_vision().get_tile(curr).get_edge(d).is_passable(): continue
        if ct.get_vision().get_tile(curr.add_dir(d)).entity is not None:
            entity = ct.get_vision().get_tile(curr.add_dir(d)).entity
            if isinstance(entity, unswbc.DragonPart): continue
        ct.make_move(d)
        return
    
    # gonna run into wall, try split lol
    for i in range(ct.get_length() - 1, 2, -1):
        if ct.can_split(i):
            ct.do_split(i)
            return

    

def main() -> None:
    global ct, game
    ct, game = unswbc.init()

    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()

if __name__ == "__main__":
    main()
