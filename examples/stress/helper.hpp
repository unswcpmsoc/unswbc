#pragma once

#include <array>
#include <charconv>
#include <cstdint>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

namespace unswbc {

struct Constants
{
    static constexpr int MAX_ROUNDS = 500;
    static constexpr int VISION_RADIUS = 3;
    static constexpr int VISION_SIZE = 2 * VISION_RADIUS + 1;
    static constexpr int INITIAL_LENGTH = 3;
    static constexpr int MIN_SIZE = 2;
};

class Direction
{
  public:
    enum Value : char
    {
        NORTH = 'N',
        EAST = 'E',
        SOUTH = 'S',
        WEST = 'W'
    };
    Value value;

    Direction(Value value) : value(value)
    {
        if (value != NORTH && value != EAST && value != SOUTH && value != WEST)
        {
            throw std::invalid_argument("invalid direction");
        }
    }
    Direction(char value) : Direction(static_cast<Value>(value)) {}
    constexpr bool operator==(Direction const&) const = default;

    static std::array<Direction, 4> const& get_direction_list()
    {
        static std::array<Direction, 4> const direction_list{NORTH, EAST, SOUTH, WEST};
        return direction_list;
    }
    std::pair<int, int> get_offset() const
    {
        switch (value)
        {
        case NORTH:
            return {0, -1};
        case EAST:
            return {1, 0};
        case SOUTH:
            return {0, 1};
        default:
            return {-1, 0};
        }
    }

    Direction get_opposite() const
    {
        return value == NORTH   ? Direction(SOUTH)
               : value == EAST  ? Direction(WEST)
               : value == SOUTH ? Direction(NORTH)
                                : Direction(EAST);
    }
    Direction get_left() const
    {
        return value == NORTH   ? Direction(WEST)
               : value == EAST  ? Direction(NORTH)
               : value == SOUTH ? Direction(EAST)
                                : Direction(SOUTH);
    }
    Direction get_right() const
    {
        return value == NORTH   ? Direction(EAST)
               : value == EAST  ? Direction(SOUTH)
               : value == SOUTH ? Direction(WEST)
                                : Direction(NORTH);
    }
};

/*
example usage:
Direction dir = Direction::NORTH;
Direction dir2 = 'E'; // or Direction dir2 = Direction('E');

dir.get_offset(); // returns {0, -1}
dir.get_opposite(); // returns Direction::SOUTH

if (dir == Direction::NORTH) { ... }
*/

class Team
{
  public:
    enum Value : char
    {
        A = 'A',
        B = 'B'
    };
    Value value;

    Team(Value value) : value(value)
    {
        if (value != A && value != B)
        {
            throw std::invalid_argument("invalid team");
        }
    }
    Team(char value) : Team(static_cast<Value>(value)) {}
    constexpr bool operator==(Team const&) const = default;

    Team get_enemy_team() const
    {
        return value == B ? A : B;
    }
};

/*
example usage:
Team team = Team::A;
team.get_enemy_team(); // returns Team::B
if (team == Team::A) { ... }
*/

class Game;
class Controller;

inline Game* game = nullptr;
inline Controller* ct = nullptr;

struct Position
{
    int x = 0, y = 0;

    Position(int x, int y) : x(x), y(y) {}
    constexpr bool operator==(Position const&) const = default;

    Position const add_dir(Direction direction) const; // forward decl (dependent on Game)
};

struct PositionHash
{
    std::size_t operator()(Position const& position) const
    {
        auto const x = static_cast<std::uint32_t>(position.x);
        auto const y = static_cast<std::uint32_t>(position.y);
        return (static_cast<std::uint64_t>(x) << 32U) | y;
    }
};

class Game
{
  public:
    int round_num = 1;
    int width, height;
    int unit_limit;

    Game(int width, int height, int unit_limit) : width(width), height(height), unit_limit(unit_limit) {}

    int get_round_num() const
    {
        return round_num;
    }
    std::pair<int, int> get_map_size() const
    {
        return {width, height};
    }
    int get_unit_limit() const
    {
        return unit_limit;
    }
};

// hi remember me
inline Position const Position::add_dir(Direction direction) const
{
    if (!game)
    {
        throw std::runtime_error("game is not initialised");
    }
    auto const [dx, dy] = direction.get_offset();
    auto const wrap = [](int value, int size) { return (value % size + size) % size; };
    return {wrap(x + dx, game->width), wrap(y + dy, game->height)};
}

enum class EntityType
{
    DRAGON_PART,
    PEARL,
};

class Entity
{
  public:
    Position position;
    EntityType entity_type;

    Entity(Position position, EntityType entity_type) : position(position), entity_type(entity_type) {}
    virtual ~Entity() = default; // for dynamic dispatch (deconstructor)

    Position get_position() const
    {
        return position;
    }
    EntityType get_type() const
    {
        return entity_type;
    }
};

class DragonPart : public Entity
{
  public:
    int dragon_id;
    Team team;
    Direction dir;
    bool is_dragon_head;

    DragonPart(Position position, int dragon_id, Team team, Direction direction, bool is_dragon_head)
        : Entity(position, EntityType::DRAGON_PART), dragon_id(dragon_id), team(team), dir(direction), is_dragon_head(is_dragon_head)
    {
    }

    int get_id() const
    {
        return dragon_id;
    }
    Team get_team() const
    {
        return team;
    }
    Direction get_dir() const
    {
        return dir;
    }
    bool is_head() const
    {
        return is_dragon_head;
    }
};

class Pearl : public Entity
{
  public:
    Pearl(Position position) : Entity(position, EntityType::PEARL) {}
};

enum class EdgeType
{
    EMPTY,
    KELP,
    PORTAL,
};

class Edge
{
  public:
    bool is_horizontal;
    EdgeType edge_type;
    std::optional<int> portal_id;

    Edge(bool is_horizontal, EdgeType edge_type, std::optional<int> portal_id = std::nullopt)
        : is_horizontal(is_horizontal), edge_type(edge_type), portal_id(portal_id)
    {
    }

    bool is_passable() const
    {
        return edge_type != EdgeType::KELP;
    }
    bool is_portal() const
    {
        return edge_type == EdgeType::PORTAL;
    }
    int get_portal_id() const
    {
        // return is_portal() ? portal_id.value() : -1;
        return portal_id.value_or(-1);
    }
};

class Tile
{
  public:
    std::shared_ptr<Entity> entity;
    Position position;
    int pearl_time;
    std::array<std::shared_ptr<Edge>, 4> edges{}; // {NORTH, EAST, SOUTH, WEST}

    Tile(int x, int y, std::shared_ptr<Entity> entity, int pearl_time)
        : entity(std::move(entity)), position(x, y), pearl_time(pearl_time)
    {
    }

    Edge* get_edge(Direction direction) const
    {
        return edges[get_direction_index(direction)].get();
    }
    Entity* get_entity() const
    {
        return entity.get();
    }

  private:
    static std::size_t get_direction_index(Direction direction)
    {
        return direction == Direction::NORTH ? 0 : direction == Direction::EAST ? 1 : direction == Direction::SOUTH ? 2 : 3;
    }
};

class Controller
{
  public:
    int length = Constants::INITIAL_LENGTH;
    int unit_count = 1;
    int unit_limit;
    std::shared_ptr<DragonPart> head;
    std::vector<Tile> tiles;
    std::unordered_map<Position, std::size_t, PositionHash> tiles_by_position;
    std::vector<std::uint32_t> sonar_messages;

    Controller(int dragon_id, Team team, Direction direction, int unit_limit, std::vector<Tile> tiles = {},
               std::vector<std::uint32_t> sonar_messages = {})
        : unit_limit(unit_limit), head(std::make_shared<DragonPart>(Position(0, 0), dragon_id, team, direction, true)),
          tiles(std::move(tiles)), sonar_messages(std::move(sonar_messages))
    {
        // populate tiles_by_position
        for (std::size_t index = 0; index < this->tiles.size(); index++)
        {
            auto const& tile = this->tiles[index];
            if (tiles_by_position.contains(tile.position))
            {
                throw std::runtime_error("duplicate tile position");
            }
            tiles_by_position.emplace(tile.position, index);
        }
    }

    int get_length() const
    {
        return length;
    }
    int get_unit_count() const
    {
        return unit_count;
    }
    DragonPart& get_head()
    {
        return *head;
    }
    DragonPart const& get_head() const
    {
        return *head;
    }
    int get_id() const
    {
        return head->dragon_id;
    }
    Team get_team() const
    {
        return head->team;
    }
    Direction get_dir() const
    {
        return head->dir;
    }
    Position get_position() const
    {
        return head->get_position();
    }

    std::vector<Tile> const& get_tiles() const
    {
        return tiles;
    }
    Tile const* get_tile(Position position) const
    {
        auto const tile_index = tiles_by_position.find(position);
        if (tile_index == tiles_by_position.end())
        {
            return nullptr;
        }
        return &tiles[tile_index->second];
    }

    bool make_move(Direction direction)
    {
        std::cout << "MOVE " << direction.value << "\n";
        return true;
    }
    bool make_moves(std::vector<Direction> const& directions)
    {
        if (directions.empty() || directions.size() > static_cast<std::size_t>(length - 1))
        {
            return false;
        }
        std::cout << "MOVE ";
        for (Direction direction : directions)
        {
            std::cout << direction.value;
        }
        std::cout << "\n";
        return true;
    }
    bool can_split(int child_size) const
    {
        return Constants::MIN_SIZE <= child_size && length - child_size >= Constants::MIN_SIZE && unit_count < unit_limit;
    }
    bool do_split(int child_size)
    {
        if (!can_split(child_size))
        {
            return false;
        }
        std::cout << "SPLIT " << child_size << "\n";
        return true;
    }
    void output_log(std::string_view message)
    {
        std::cout << "LOG " << message << "\n";
    }
    void draw_indicator_dot(Position position, int r, int g, int b)
    {
        std::cout << "DOT " << position.x << " " << position.y << " " << r << " " << g << " " << b << "\n";
    }
    void draw_indicator_line(Position start, Position end, int r, int g, int b)
    {
        std::cout << "LINE " << start.x << " " << start.y << " " << end.x << " " << end.y << " " << r << " " << g << " " << b
                  << "\n";
    }
    void set_indicator_string(std::string_view message)
    {
        std::cout << "INDICATOR " << message << "\n";
    }
    std::vector<std::uint32_t> get_sonar_messages() const
    {
        return sonar_messages;
    }
    bool send_sonar(std::uint64_t message)
    {
        if (message > UINT32_MAX)
        {
            return false;
        }
        std::cout << "SONAR " << message << "\n";
        return true;
    }
};

namespace parse_util {

inline std::unique_ptr<Controller> controller_storage;
inline std::unique_ptr<Game> game_storage;

inline std::vector<std::string> read_data_line()
{
    for (std::string line; std::getline(std::cin, line);)
    {
        if (auto const comment = line.find('#'); comment != std::string::npos)
        {
            line.erase(comment); // i think this is what the line.partition("#")[0] thing does?
        }
        std::istringstream stream(line);
        std::vector<std::string> parts;
        for (std::string part; stream >> part;)
        {
            parts.push_back(std::move(part));
        }

        if (!parts.empty())
        {
            return parts;
        }
    }
    throw std::runtime_error("unexpected end of controller input");
}

inline std::vector<std::string> read_labelled(std::string_view label, std::size_t value_count = 1)
{
    auto parts = read_data_line();
    if (parts.front() != label)
    {
        throw std::runtime_error("expected " + std::string(label) + ", got " + parts.front());
    }
    if (parts.size() != value_count + 1)
    {
        throw std::runtime_error(std::string(label) + " requires " + std::to_string(value_count) + " value(s)");
    }
    parts.erase(parts.begin());
    return parts;
}

template <typename T> T parse_integer(std::string_view text)
{
    T value{};
    auto const [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size())
    {
        throw std::runtime_error("invalid integer: " + std::string(text));
    }
    return value;
}

inline std::shared_ptr<Edge> parse_edge(std::string_view value, bool is_horizontal)
{
    if (value == ".")
    {
        return std::make_shared<Edge>(is_horizontal, EdgeType::EMPTY);
    }
    if (value == "w")
    {
        return std::make_shared<Edge>(is_horizontal, EdgeType::KELP);
    }
    int const portal_id = parse_integer<int>(value);
    if (portal_id < 0)
    {
        throw std::runtime_error("portal IDs cannot be negative");
    }
    return std::make_shared<Edge>(is_horizontal, EdgeType::PORTAL, portal_id);
}

} // end namespace parse_util

inline std::tuple<Controller&, Game&> init()
{
    int const dragon_id = parse_util::parse_integer<int>(parse_util::read_labelled("ID").front());
    Team const team(parse_util::read_labelled("TEAM").front().front()); // um hopefully single char

    auto const dimensions = parse_util::read_labelled("MAP", 2);
    int const width = parse_util::parse_integer<int>(dimensions[0]);
    int const height = parse_util::parse_integer<int>(dimensions[1]);
    if (width <= 0 || height <= 0)
    {
        throw std::runtime_error("map dimensions must be positive");
    }
    int const unit_limit = parse_util::parse_integer<int>(parse_util::read_labelled("UNIT_LIMIT").front());
    if (unit_limit <= 0)
    {
        throw std::runtime_error("UNIT_LIMIT must be positive");
    }

    parse_util::controller_storage = std::make_unique<Controller>(dragon_id, team, Direction::NORTH, unit_limit);
    parse_util::game_storage = std::make_unique<Game>(width, height, unit_limit);
    ct = parse_util::controller_storage.get();
    game = parse_util::game_storage.get();
    return {*ct, *game};
}

inline bool update(Controller& controller, Game& game_state)
{
    auto const continue_flag = parse_util::read_data_line();
    if (continue_flag.front() == "ENDGAME")
    {
        return false;
    }
    if (continue_flag.size() != 2)
    {
        throw std::runtime_error("malformed: no round number");
    }

    game_state.round_num = parse_util::parse_integer<int>(continue_flag[1]);

    Direction const current_direction(parse_util::read_labelled("DIR").front().front());
    controller.head->dir = current_direction;
    controller.length = parse_util::parse_integer<int>(parse_util::read_labelled("LENGTH").front());
    controller.unit_count = parse_util::parse_integer<int>(parse_util::read_labelled("UNIT_COUNT").front());
    if (controller.unit_count <= 0 || controller.unit_count > controller.unit_limit)
    {
        throw std::runtime_error("UNIT_COUNT must be between 1 and UNIT_LIMIT");
    }

    int const num_sonar_msgs = parse_util::parse_integer<int>(parse_util::read_labelled("NUM_MSGS").front());
    if (num_sonar_msgs < 0)
    {
        throw std::runtime_error("NUM_MSGS cannot be negative");
    }
    controller.sonar_messages.clear();
    controller.sonar_messages.reserve(static_cast<std::size_t>(num_sonar_msgs));
    for (int index = 0; index < num_sonar_msgs; index++)
    {
        auto const line = parse_util::read_data_line();
        if (line.size() != 1)
        {
            throw std::runtime_error("missing sonar message value");
        }
        controller.sonar_messages.push_back(parse_util::parse_integer<std::uint32_t>(line.front()));
    }

    std::vector<Tile> tiles;
    std::unordered_map<Position, std::size_t, PositionHash> tile_indices;
    tiles.reserve(Constants::VISION_SIZE * Constants::VISION_SIZE);
    for (int index = 0; index < Constants::VISION_SIZE * Constants::VISION_SIZE; index++)
    {
        auto const values = parse_util::read_data_line();
        if (values.size() != 4)
        {
            throw std::runtime_error("each vision tile requires: x y hasPearl pearlIn");
        }

        int const x = parse_util::parse_integer<int>(values[0]);
        int const y = parse_util::parse_integer<int>(values[1]);
        int const has_pearl = parse_util::parse_integer<int>(values[2]);
        int const pearl_time = parse_util::parse_integer<int>(values[3]);
        if (has_pearl != 0 && has_pearl != 1)
        {
            throw std::runtime_error("hasPearl must be 0 or 1");
        }

        Position const position(x, y);
        if (tile_indices.contains(position))
        {
            throw std::runtime_error("duplicate vision tile");
        }

        std::shared_ptr<Entity> entity = has_pearl ? std::make_shared<Pearl>(position) : nullptr;
        tile_indices.emplace(position, tiles.size());
        tiles.emplace_back(x, y, std::move(entity), pearl_time); // saves a copy operation or smth
    }

    int const num_dragon_parts = parse_util::parse_integer<int>(parse_util::read_labelled("DRAGON_BODIES").front());
    if (num_dragon_parts < 0)
    {
        throw std::runtime_error("DRAGON_BODIES cannot be negative");
    }

    bool found_controller_head = false;
    for (int index = 0; index < num_dragon_parts; index++)
    {
        auto const values = parse_util::read_data_line();
        if (values.size() != 6)
        {
            throw std::runtime_error("each dragon part requires: team dragonId x y facing isHead");
        }

        Team const team(values[0].front());
        int const dragon_id = parse_util::parse_integer<int>(values[1]);
        Position const position(parse_util::parse_integer<int>(values[2]), parse_util::parse_integer<int>(values[3]));
        Direction const facing(values[4].front());

        int const head_flag = parse_util::parse_integer<int>(values[5]);
        if (head_flag != 0 && head_flag != 1)
        {
            throw std::runtime_error("isHead must be 0 or 1");
        }

        auto const tile = tile_indices.find(position);
        if (tile == tile_indices.end())
        {
            throw std::runtime_error("dragon part is outside the vision tiles");
        }

        std::shared_ptr<DragonPart> dragon_part;
        if (dragon_id == controller.get_id() && head_flag == 1)
        {
            dragon_part = controller.head;
            dragon_part->position = position;
            dragon_part->team = team;
            dragon_part->dir = current_direction;
            dragon_part->is_dragon_head = true;
            found_controller_head = true;
        }
        else
        {
            dragon_part = std::make_shared<DragonPart>(position, dragon_id, team, facing, head_flag == 1);
        }
        tiles[tile->second].entity = std::move(dragon_part);
    }
    if (!found_controller_head)
    {
        throw std::runtime_error("controller head is missing from DRAGON_BODIES");
    }

    Position const head_position = controller.get_position();
    auto const wrap = [](int value, int size) { return (value % size + size) % size; };
    auto const tile_at = [&](int local_x, int local_y) -> Tile& {
        Position const position(wrap(head_position.x + local_x - Constants::VISION_RADIUS, game_state.width),
                                wrap(head_position.y + local_y - Constants::VISION_RADIUS, game_state.height));
        auto const found = tile_indices.find(position);
        if (found == tile_indices.end())
        {
            throw std::runtime_error("vision is missing expected tile");
        }
        return tiles[found->second];
    };

    for (int y = 0; y < Constants::VISION_SIZE + 1; y++)
    {
        auto const line = parse_util::read_data_line();
        if (line.size() != Constants::VISION_SIZE)
        {
            throw std::runtime_error("horizontal edge row requires 7 values");
        }

        for (int x = 0; x < Constants::VISION_SIZE; x++)
        {
            auto edge = parse_util::parse_edge(line[x], true);
            if (y > 0)
            {
                tile_at(x, y - 1).edges[2] = edge;
            }
            if (y < Constants::VISION_SIZE)
            {
                tile_at(x, y).edges[0] = std::move(edge);
            }
        }
    }

    for (int y = 0; y < Constants::VISION_SIZE; y++)
    {
        auto const line = parse_util::read_data_line();
        if (line.size() != Constants::VISION_SIZE + 1)
        {
            throw std::runtime_error("vertical edge row requires 8 values");
        }

        for (int x = 0; x < Constants::VISION_SIZE + 1; x++)
        {
            auto edge = parse_util::parse_edge(line[x], false);
            if (x > 0)
            {
                tile_at(x - 1, y).edges[1] = edge;
            }
            if (x < Constants::VISION_SIZE)
            {
                tile_at(x, y).edges[3] = std::move(edge);
            }
        }
    }

    controller.tiles = std::move(tiles);
    controller.tiles_by_position = std::move(tile_indices);
    return true;
}

inline void end_turn()
{
    std::cout << "ENDTURN" << std::endl; // yay we can flush
}

} // end namespace unswbc
