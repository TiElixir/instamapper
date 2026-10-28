#include "GraphData.h"

#include <cmath>
#include <fstream>
#include <limits>

#include <nlohmann/json.hpp>

namespace {
std::int64_t jsonCount(const nlohmann::json& value, const char* key) {
  if (!value.contains(key) || value[key].is_null()) return 0;
  if (value[key].is_number_integer()) return value[key].get<std::int64_t>();
  return 0;
}

float radiusForFollowers(std::int64_t followers) {
  if (followers <= 0) return 2.5f;
  return 2.5f + std::min(8.0f, std::log10(static_cast<float>(followers) + 1.0f) * 1.6f);
}
}  // namespace

bool GraphData::loadJson(const std::string& path, std::string& error) {
  std::ifstream input(path);
  if (!input) {
    error = "could not open graph JSON: " + path;
    return false;
  }

  nlohmann::json payload;
  try {
    input >> payload;
  } catch (const std::exception& exc) {
    error = std::string("invalid graph JSON: ") + exc.what();
    return false;
  }

  nodes.clear();
  edges.clear();
  indexByUsername.clear();

  const auto& jsonNodes = payload.contains("nodes") ? payload["nodes"] : nlohmann::json::array();
  nodes.reserve(jsonNodes.size());
  for (const auto& item : jsonNodes) {
    Node node;
    node.username = item.value("username", item.value("id", std::string{}));
    if (node.username.empty()) continue;
    node.followerCount = jsonCount(item, "follower_count");
    node.followingCount = jsonCount(item, "following_count");
    node.radius = radiusForFollowers(node.followerCount);
    const auto index = static_cast<std::uint32_t>(nodes.size());
    indexByUsername[node.username] = index;
    nodes.push_back(std::move(node));
  }

  const auto& jsonEdges = payload.contains("edges") ? payload["edges"] : nlohmann::json::array();
  edges.reserve(jsonEdges.size());
  for (const auto& item : jsonEdges) {
    const auto sourceName = item.value("source", std::string{});
    const auto targetName = item.value("target", std::string{});
    auto source = indexByUsername.find(sourceName);
    auto target = indexByUsername.find(targetName);
    if (source == indexByUsername.end() || target == indexByUsername.end()) continue;
    edges.push_back(Edge{source->second, target->second, item.value("mutual", false)});
  }

  seedPositions();
  return true;
}

void GraphData::seedPositions() {
  if (nodes.empty()) return;
  const float golden = 2.3999632f;
  const float scale = std::sqrt(static_cast<float>(nodes.size())) * 6.0f;
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const float r = scale * std::sqrt((static_cast<float>(i) + 0.5f) / static_cast<float>(nodes.size()));
    const float a = golden * static_cast<float>(i);
    nodes[i].x = std::cos(a) * r;
    nodes[i].y = std::sin(a) * r;
    nodes[i].vx = 0.0f;
    nodes[i].vy = 0.0f;
  }
}
