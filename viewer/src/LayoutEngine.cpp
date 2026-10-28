#include "LayoutEngine.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <unordered_map>
#include <vector>

namespace {
struct CellKey {
  int x = 0;
  int y = 0;
  bool operator==(const CellKey& other) const { return x == other.x && y == other.y; }
};

struct CellHash {
  std::size_t operator()(const CellKey& key) const {
    return (static_cast<std::size_t>(static_cast<std::uint32_t>(key.x)) << 32U) ^
           static_cast<std::uint32_t>(key.y);
  }
};

float safeLength(float x, float y) {
  return std::sqrt(x * x + y * y + 0.01f);
}

float hash01(std::uint32_t value) {
  value ^= value >> 16U;
  value *= 0x7feb352dU;
  value ^= value >> 15U;
  value *= 0x846ca68bU;
  value ^= value >> 16U;
  return static_cast<float>(value & 0x00ffffffU) / static_cast<float>(0x01000000U);
}

float hashSigned(std::uint32_t value) {
  return hash01(value) * 2.0f - 1.0f;
}
}  // namespace

LayoutEngine::LayoutEngine(GraphData& graph) : graph_(graph) {
  rebuildTopology();
}

void LayoutEngine::rebuildTopology() {
  outDegree_.assign(graph_.nodes.size(), 0);
  edgeTopology_.assign(graph_.edges.size(), {});
  for (const auto& edge : graph_.edges) {
    if (edge.source < outDegree_.size()) outDegree_[edge.source] += 1;
  }

  std::vector<std::uint32_t> seenPerSource(graph_.nodes.size(), 0);
  for (std::size_t i = 0; i < graph_.edges.size(); ++i) {
    const auto& edge = graph_.edges[i];
    if (edge.source >= seenPerSource.size()) continue;
    edgeTopology_[i] = EdgeTopology{outDegree_[edge.source], seenPerSource[edge.source]++};
  }
}

void LayoutEngine::step(int iterations) {
  for (int i = 0; i < iterations; ++i) {
    tick_ += 1;
    applyGridRepulsion();
    applySprings();
    applyGravity();
    applyJitter();
    integrate();
    cooling_ = std::max(0.08f, cooling_ * 0.996f);
  }
}

void LayoutEngine::resetCooling() {
  cooling_ = 1.0f;
  averageSpeed_ = 0.0f;
}

void LayoutEngine::applyGridRepulsion() {
  const float cellSize = std::max(44.0f, settings_.springLength * 3.0f);
  std::unordered_map<CellKey, std::vector<std::uint32_t>, CellHash> grid;
  grid.reserve(graph_.nodes.size() * 2);

  for (std::uint32_t i = 0; i < graph_.nodes.size(); ++i) {
    const auto& node = graph_.nodes[i];
    CellKey key{static_cast<int>(std::floor(node.x / cellSize)), static_cast<int>(std::floor(node.y / cellSize))};
    grid[key].push_back(i);
  }

  for (std::uint32_t i = 0; i < graph_.nodes.size(); ++i) {
    auto& node = graph_.nodes[i];
    const int cx = static_cast<int>(std::floor(node.x / cellSize));
    const int cy = static_cast<int>(std::floor(node.y / cellSize));
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        auto it = grid.find(CellKey{cx + dx, cy + dy});
        if (it == grid.end()) continue;
        for (auto j : it->second) {
          if (j == i) continue;
          const auto& other = graph_.nodes[j];
          float rx = node.x - other.x;
          float ry = node.y - other.y;
          if (std::abs(rx) < 0.001f && std::abs(ry) < 0.001f) {
            const float angle = static_cast<float>((i * 73856093U) ^ (j * 19349663U)) * 0.000001f;
            rx = std::cos(angle) * 0.1f;
            ry = std::sin(angle) * 0.1f;
          }
          const float len = safeLength(rx, ry);
          const float force = std::min(1.20f, settings_.repulsion / (len * len + 120.0f)) * cooling_;
          node.vx += (rx / len) * force;
          node.vy += (ry / len) * force;
        }
      }
    }
  }
}

void LayoutEngine::applySprings() {
  for (std::size_t i = 0; i < graph_.edges.size(); ++i) {
    const auto& edge = graph_.edges[i];
    auto& source = graph_.nodes[edge.source];
    auto& target = graph_.nodes[edge.target];
    const auto topology = i < edgeTopology_.size() ? edgeTopology_[i] : EdgeTopology{};
    const bool parentChildEdge = topology.sourceOut > 1;
    const float fanout = static_cast<float>(std::max<std::uint32_t>(1, topology.sourceOut));
    const float bond = parentChildEdge ? std::min(1.85f, 1.05f + std::log1p(fanout) * 0.18f) : 1.0f;
    const float force = settings_.spring * bond * cooling_;

    if (parentChildEdge) {
      // Radial fan layout: pull target toward an evenly-spaced angular slot
      // around the source at the desired rest length.
      const float phase = hash01(edge.source * 2246822519U + 0x9e3779b9U) * 2.0f * std::numbers::pi_v<float>;
      const float radialNoise = hashSigned(edge.target * 3266489917U + edge.source * 668265263U);
      const float desiredLength = settings_.springLength * (0.82f + radialNoise * 0.10f);
      const float angle = phase + (2.0f * std::numbers::pi_v<float> * static_cast<float>(topology.siblingIndex)) / fanout;
      const float wantedX = source.x + std::cos(angle) * desiredLength;
      const float wantedY = source.y + std::sin(angle) * desiredLength;
      const float dx = wantedX - target.x;
      const float dy = wantedY - target.y;
      target.vx += dx * force;
      target.vy += dy * force;
      source.vx -= dx * force * 0.06f;
      source.vy -= dy * force * 0.06f;
    } else {
      // Standard Hooke's law along the actual displacement axis.
      const float dx = target.x - source.x;
      const float dy = target.y - source.y;
      const float dist = safeLength(dx, dy);
      const float stretch = dist - settings_.springLength;   // +ve = too far, -ve = too close
      const float fx = (dx / dist) * stretch * force;
      const float fy = (dy / dist) * stretch * force;
      target.vx -= fx;
      target.vy -= fy;
      source.vx += fx * 0.06f;
      source.vy += fy * 0.06f;
    }
  }
}

void LayoutEngine::applyJitter() {
  if (graph_.nodes.empty()) return;
  const float coolingBlend = std::max(0.0f, cooling_ - 0.08f);
  const float baseStrength = 0.030f + coolingBlend * 0.115f;
  for (std::uint32_t i = 0; i < graph_.nodes.size(); ++i) {
    auto& node = graph_.nodes[i];
    const float speed = std::sqrt(node.vx * node.vx + node.vy * node.vy);
    const float stuckBoost = speed < 0.08f ? 2.3f : 1.0f;
    const auto seed = i * 747796405U + tick_ * 2891336453U + 0x85ebca6bU;
    const float angle = hash01(seed) * 2.0f * std::numbers::pi_v<float>;
    const float magnitude = baseStrength * stuckBoost * (0.35f + hash01(seed ^ 0xc2b2ae35U));
    node.vx += std::cos(angle) * magnitude;
    node.vy += std::sin(angle) * magnitude;
  }
}

void LayoutEngine::applyGravity() {
  struct Accum {
    float x = 0.0f;
    float y = 0.0f;
    int count = 0;
  };

  std::unordered_map<int, Accum> clusters;
  clusters.reserve(256);
  for (const auto& node : graph_.nodes) {
    auto& acc = clusters[node.cluster];
    acc.x += node.x;
    acc.y += node.y;
    acc.count += 1;
  }
  for (auto& [_, acc] : clusters) {
    if (acc.count > 0) {
      acc.x /= static_cast<float>(acc.count);
      acc.y /= static_cast<float>(acc.count);
    }
  }

  for (auto& node : graph_.nodes) {
    node.vx += -node.x * settings_.centerGravity * cooling_;
    node.vy += -node.y * settings_.centerGravity * cooling_;
    auto it = clusters.find(node.cluster);
    if (it != clusters.end()) {
      node.vx += (it->second.x - node.x) * settings_.clusterGravity * cooling_;
      node.vy += (it->second.y - node.y) * settings_.clusterGravity * cooling_;
    }
  }
}

void LayoutEngine::integrate() {
  float totalSpeed = 0.0f;
  for (auto& node : graph_.nodes) {
    node.vx = std::clamp(node.vx * settings_.damping, -settings_.maxVelocity, settings_.maxVelocity);
    node.vy = std::clamp(node.vy * settings_.damping, -settings_.maxVelocity, settings_.maxVelocity);
    node.x += node.vx * settings_.timeStep;
    node.y += node.vy * settings_.timeStep;
    totalSpeed += std::sqrt(node.vx * node.vx + node.vy * node.vy);
  }
  averageSpeed_ = graph_.nodes.empty() ? 0.0f : totalSpeed / static_cast<float>(graph_.nodes.size());
}
