#include <iostream>
#include <sstream>
#include <string>

namespace {

constexpr int kVision = 7;

std::string Line()
{
    std::string line;
    if (!std::getline(std::cin, line))
    {
        return {};
    }
    if (!line.empty() && line.back() == '\r')
    {
        line.pop_back();
    }
    return line;
}

int CountAfter(std::string const& line)
{
    std::istringstream in(line);
    std::string label;
    int count = 0;
    in >> label >> count;
    return count;
}

bool DrainTurn()
{
    std::string first;
    do
    {
        first = Line();
        if (!std::cin)
        {
            return false;
        }
    } while (first.empty());

    if (first.starts_with("ENDGAME"))
    {
        return false;
    }

    Line();                     // DIR
    Line();                     // LENGTH
    Line();                     // UNIT_COUNT
    int n = CountAfter(Line()); // NUM_MSGS
    for (int i = 0; i < n; i++)
    {
        Line();
    }
    for (int i = 0; i < kVision * kVision; i++)
    {
        Line();
    }
    n = CountAfter(Line()); // DRAGON_BODIES
    for (int i = 0; i < n; i++)
    {
        Line();
    }
    for (int i = 0; i < kVision + 1; i++)
    {
        Line();
    }
    for (int i = 0; i < kVision; i++)
    {
        Line();
    }
    return true;
}

} // namespace

int main()
{
    Line(); // ID
    Line(); // TEAM
    Line(); // MAP
    Line(); // UNIT_LIMIT

    while (DrainTurn())
    {
        std::cout << "MOVE N\nENDTURN" << std::endl;
    }
}
