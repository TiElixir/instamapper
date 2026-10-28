#pragma once

#include "GraphData.h"

#include <cstdint>
#include <vector>

struct LayoutSettings {
  float repulsion = 430.0f;
  float spring = 0.010f;
  float springLength = 34.0f;
  float damping = 0.62f;
  float centerGravity = 0.0014f;
  float clusterGravity = 0.0022f;
  float timeStep = 0.30f;
  float maxVelocity = 14.0f;
};

class LayoutEngine {
 public:
  explicit LayoutEngine(GraphData& graph);

  void step(int iterations = 1);
  void resetCooling();
  float averageSpeed() const { return averageSpeed_; }
  float cooling() const { return cooling_; }
  LayoutSettings& settings() { return settings_; }

 private:
  GraphData& graph_;
  LayoutSettings settings_;
  struct EdgeTopology {
    std::uint32_t sourceOut = 0;
    std::uint32_t siblingIndex = 0;
  };

  std::vector<std::uint32_t> outDegree_;
  std::vector<EdgeTopology> edgeTopology_;
  float cooling_ = 1.0f;
  float averageSpeed_ = 0.0f;
  std::uint32_t tick_ = 0;

  void rebuildTopology();
  void applyGridRepulsion();
  void applySprings();
  void applyGravity();
  void applyJitter();
  void integrate();
};
