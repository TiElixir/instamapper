#include "GraphExplorer.h"

#include <algorithm>
#include <cctype>
#include <queue>

void GraphExplorer::rebuild(const GraphData& graph) {
  graph_ = &graph;
  outgoing_.assign(graph.nodes.size(), {});
  for (const auto& edge : graph.edges) {
    if (edge.source < outgoing_.size() && edge.target < outgoing_.size()) {
      outgoing_[edge.source].push_back(edge.target);
      outgoing_[edge.target].push_back(edge.source);
    }
  }
  selectedNode_ = kInvalid;
  selectedMatchOffset_ = -1;
  neighborNodes_.clear();
  clearPath();
  rebuildMatches();
}

void GraphExplorer::setSearchQuery(const std::string& query) {
  if (query == searchQuery_) return;
  searchQuery_ = query;
  clearPath();
  rebuildMatches();
}

void GraphExplorer::selectNextMatch() {
  if (matches_.empty()) return;
  selectedMatchOffset_ = (selectedMatchOffset_ + 1) % static_cast<int>(matches_.size());
  setSelected(matches_[static_cast<std::size_t>(selectedMatchOffset_)]);
}

void GraphExplorer::selectPreviousMatch() {
  if (matches_.empty()) return;
  selectedMatchOffset_ = selectedMatchOffset_ <= 0 ? static_cast<int>(matches_.size()) - 1 : selectedMatchOffset_ - 1;
  setSelected(matches_[static_cast<std::size_t>(selectedMatchOffset_)]);
}

bool GraphExplorer::focusUsername(const std::string& username) {
  const auto index = lookupUsername(username);
  if (index == kInvalid) return false;
  clearPath();
  setSelected(index);
  return true;
}

bool GraphExplorer::findShortestPath(const std::string& source, const std::string& target) {
  clearPath();
  if (!graph_) return false;
  const auto sourceIndex = lookupUsername(source);
  const auto targetIndex = lookupUsername(target);
  if (sourceIndex == kInvalid || targetIndex == kInvalid) {
    pathMessage_ = "source or target username not found";
    return false;
  }

  std::vector<std::uint32_t> parent(graph_->nodes.size(), kInvalid);
  std::queue<std::uint32_t> queue;
  parent[sourceIndex] = sourceIndex;
  queue.push(sourceIndex);

  while (!queue.empty()) {
    const auto current = queue.front();
    queue.pop();
    if (current == targetIndex) break;
    for (const auto next : outgoing_[current]) {
      if (parent[next] != kInvalid) continue;
      parent[next] = current;
      queue.push(next);
    }
  }

  if (parent[targetIndex] == kInvalid) {
    pathMessage_ = "no undirected path found";
    setSelected(sourceIndex);
    return false;
  }

  for (std::uint32_t at = targetIndex; at != sourceIndex; at = parent[at]) pathNodes_.push_back(at);
  pathNodes_.push_back(sourceIndex);
  std::reverse(pathNodes_.begin(), pathNodes_.end());

  for (const auto node : pathNodes_) pathNodeSet_.insert(node);
  for (std::size_t i = 1; i < pathNodes_.size(); ++i) {
    const auto a = pathNodes_[i - 1];
    const auto b = pathNodes_[i];
    pathEdges_.insert(edgeKey(a, b));
    pathEdges_.insert(edgeKey(b, a));
  }
  pathMessage_ = "undirected path length " + std::to_string(pathNodes_.size() - 1);
  setSelected(sourceIndex);
  return true;
}

void GraphExplorer::clearPath() {
  pathNodes_.clear();
  pathNodeSet_.clear();
  pathEdges_.clear();
  pathMessage_.clear();
}

bool GraphExplorer::isPathEdge(std::uint32_t source, std::uint32_t target) const {
  return pathEdges_.contains(edgeKey(source, target));
}

void GraphExplorer::rebuildMatches() {
  matches_.clear();
  selectedNode_ = kInvalid;
  selectedMatchOffset_ = -1;
  neighborNodes_.clear();
  if (!graph_) return;
  const auto query = lower(searchQuery_);
  if (query.empty()) return;
  for (std::uint32_t i = 0; i < graph_->nodes.size(); ++i) {
    if (lower(graph_->nodes[i].username).find(query) != std::string::npos) matches_.push_back(i);
  }
  if (!matches_.empty()) {
    selectedMatchOffset_ = 0;
    setSelected(matches_[0]);
  }
}

void GraphExplorer::setSelected(std::uint32_t index) {
  selectedNode_ = index;
  neighborNodes_.clear();
  if (!graph_ || index == kInvalid || index >= outgoing_.size()) return;
  for (const auto node : outgoing_[index]) neighborNodes_.insert(node);
  for (const auto& edge : graph_->edges) {
    if (edge.target == index) neighborNodes_.insert(edge.source);
  }
}

std::uint32_t GraphExplorer::lookupUsername(const std::string& username) const {
  if (!graph_) return kInvalid;
  const auto direct = graph_->indexByUsername.find(username);
  if (direct != graph_->indexByUsername.end()) return direct->second;
  const auto wanted = lower(username);
  auto exactLower = kInvalid;
  for (std::uint32_t i = 0; i < graph_->nodes.size(); ++i) {
    const auto nodeName = lower(graph_->nodes[i].username);
    if (nodeName == wanted) return i;
    if (exactLower == kInvalid && nodeName.find(wanted) != std::string::npos) exactLower = i;
  }
  return exactLower;
}

std::string GraphExplorer::lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::uint64_t GraphExplorer::edgeKey(std::uint32_t source, std::uint32_t target) {
  return (static_cast<std::uint64_t>(source) << 32U) | target;
}
