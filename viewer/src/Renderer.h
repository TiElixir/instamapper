#pragma once

#include "Camera.h"
#include "GraphData.h"
#include "GraphExplorer.h"

class Renderer {
 public:
  bool initialize();
  void render(const GraphData& graph, const GraphExplorer& explorer, const Camera& camera, int width, int height);

 private:
  void applyCamera(const Camera& camera, int width, int height);
};
