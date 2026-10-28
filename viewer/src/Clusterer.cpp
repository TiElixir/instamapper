#include "Clusterer.h"

#include <algorithm>
#include <unordered_map>
#include <vector>

int Clusterer::labelPropagation(GraphData& graph, int iterations) {
  const auto n = graph.nodes.size();
  if (n == 0) return 0;

  std::vector<std::vector<std::uint32_t>> adjacency(n);
  for (const auto& edge : graph.edges) {
    adjacency[edge.source].push_back(edge.target);
    adjacency[edge.target].push_back(edge.source);
  }

  std::vector<int> labels(n);
  for (std::size_t i = 0; i < n; ++i) labels[i] = static_cast<int>(i);

  std::unordered_map<int, int> counts;
  for (int iter = 0; iter < iterations; ++iter) {
    bool changed = false;
    for (std::size_t i = 0; i < n; ++i) {
      counts.clear();
      for (auto neighbor : adjacency[i]) counts[labels[neighbor]] += 1;
      if (counts.empty()) continue;
      auto best = std::max_element(counts.begin(), counts.end(), [](const auto& left, const auto& right) {
        if (left.second == right.second) return left.first > right.first;
        return left.second < right.second;
      });
      if (best != counts.end() && labels[i] != best->first) {
        labels[i] = best->first;
        changed = true;
      }
    }
    if (!changed) break;
  }

  std::unordered_map<int, int> compact;
  int next = 0;
  for (std::size_t i = 0; i < n; ++i) {
    auto [it, inserted] = compact.emplace(labels[i], next);
    if (inserted) ++next;
    graph.nodes[i].cluster = it->second;
  }
  return next;
}
