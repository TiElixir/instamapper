#pragma once

#include "GraphData.h"

class Clusterer {
 public:
  static int labelPropagation(GraphData& graph, int iterations = 8);
};
