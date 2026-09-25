import helper as unswbc

ct: unswbc.Controller
game: unswbc.Game

def execute_turn():
    # do something
    ct.make_move(unswbc.Direction.NORTH)

    ct.get_vision().get_tile(ct.get_position()).get_edge(unswbc.Direction.NORTH)

    ct.get_vision().get_tiles()
    ct.output_log(f"Hello from the test bot on round {game.get_round_num()}!")

def main():
    global ct, game
    ct, game = unswbc.init()

    while unswbc.update(ct, game):
        execute_turn()
        unswbc.end_turn()

    print(f"Game over after {game.get_round_num()} turns!")

if __name__ == "__main__":
    main()