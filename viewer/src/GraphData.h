#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

struct Node {
  std::string username;
  std::int64_t followerCount = 0;
  std::int64_t followingCount = 0;
  int cluster = 0;
  float radius = 2.5f;
  float x = 0.0f;
  float y = 0.0f;
  float vx = 0.0f;
  float vy = 0.0f;
};

struct Edge {
  std::uint32_t source = 0;
  std::uint32_t target = 0;
  bool mutual = false;
};

struct GraphData {
  std::vector<Node> nodes;
  std::vector<Edge> edges;
  std::unordered_map<std::string, std::uint32_t> indexByUsername;

  bool loadJson(const std::string& path, std::string& error);
  void seedPositions();
};
