#pragma once

#include "GraphData.h"

#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>

class GraphExplorer {
 public:
  void rebuild(const GraphData& graph);
  void setSearchQuery(const std::string& query);
  void selectNextMatch();
  void selectPreviousMatch();
  bool focusUsername(const std::string& username);
  bool findShortestPath(const std::string& source, const std::string& target);
  void clearPath();

  const std::string& searchQuery() const { return searchQuery_; }
  const std::vector<std::uint32_t>& matches() const { return matches_; }
  std::uint32_t selectedNode() const { return selectedNode_; }
  int selectedMatchOffset() const { return selectedMatchOffset_; }
  const std::vector<std::uint32_t>& pathNodes() const { return pathNodes_; }
  const std::string& pathMessage() const { return pathMessage_; }

  bool hasFocus() const { return selectedNode_ != kInvalid || !pathNodes_.empty(); }
  bool isSelected(std::uint32_t node) const { return node == selectedNode_; }
  bool isNeighbor(std::uint32_t node) const { return neighborNodes_.contains(node); }
  bool isPathNode(std::uint32_t node) const { return pathNodeSet_.contains(node); }
  bool isPathEdge(std::uint32_t source, std::uint32_t target) const;

  static constexpr std::uint32_t kInvalid = UINT32_MAX;

 private:
  const GraphData* graph_ = nullptr;
  std::vector<std::vector<std::uint32_t>> outgoing_;
  std::string searchQuery_;
  std::vector<std::uint32_t> matches_;
  std::uint32_t selectedNode_ = kInvalid;
  int selectedMatchOffset_ = -1;
  std::unordered_set<std::uint32_t> neighborNodes_;
  std::vector<std::uint32_t> pathNodes_;
  std::unordered_set<std::uint32_t> pathNodeSet_;
  std::unordered_set<std::uint64_t> pathEdges_;
  std::string pathMessage_;

  void rebuildMatches();
  void setSelected(std::uint32_t index);
  std::uint32_t lookupUsername(const std::string& username) const;
  static std::string lower(std::string value);
  static std::uint64_t edgeKey(std::uint32_t source, std::uint32_t target);
};
