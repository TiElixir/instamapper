#include "Renderer.h"

#include <algorithm>
#include <array>
#include <cmath>

#include <GLFW/glfw3.h>

namespace {
std::array<float, 3> colorForCluster(int cluster) {
  constexpr std::array<std::array<float, 3>, 12> palette{{
      {0.38f, 0.70f, 1.00f},
      {0.95f, 0.45f, 0.45f},
      {0.35f, 0.85f, 0.55f},
      {0.95f, 0.75f, 0.30f},
      {0.70f, 0.55f, 1.00f},
      {0.30f, 0.85f, 0.85f},
      {1.00f, 0.55f, 0.85f},
      {0.65f, 0.85f, 0.35f},
      {0.85f, 0.60f, 0.35f},
      {0.55f, 0.65f, 0.95f},
      {0.80f, 0.80f, 0.85f},
      {0.45f, 0.95f, 0.75f},
  }};
  return palette[static_cast<std::size_t>(std::abs(cluster)) % palette.size()];
}
}  // namespace

bool Renderer::initialize() {
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  glEnable(GL_POINT_SMOOTH);
  glHint(GL_POINT_SMOOTH_HINT, GL_NICEST);
  glClearColor(0.015f, 0.023f, 0.040f, 1.0f);
  return true;
}

void Renderer::render(const GraphData& graph, const GraphExplorer& explorer, const Camera& camera, int width, int height) {
  glViewport(0, 0, width, height);
  glClear(GL_COLOR_BUFFER_BIT);
  applyCamera(camera, width, height);

  const bool focused = explorer.hasFocus();
  glLineWidth(1.0f);
  glBegin(GL_LINES);
  for (const auto& edge : graph.edges) {
    const auto& source = graph.nodes[edge.source];
    const auto& target = graph.nodes[edge.target];
    if (explorer.isPathEdge(edge.source, edge.target)) {
      glColor4f(0.98f, 0.20f, 0.78f, 0.95f);
    } else if (explorer.isSelected(edge.source) || explorer.isSelected(edge.target) ||
               (explorer.isNeighbor(edge.source) && explorer.isNeighbor(edge.target))) {
      glColor4f(0.22f, 0.74f, 0.97f, 0.82f);
    } else if (edge.mutual) {
      glColor4f(0.13f, 0.77f, 0.37f, focused ? 0.20f : 0.62f);
    } else {
      glColor4f(0.45f, 0.50f, 0.60f, focused ? 0.08f : 0.26f);
    }
    glVertex2f(source.x, source.y);
    glVertex2f(target.x, target.y);
  }
  glEnd();

  glPointSize(std::clamp(3.0f * camera.zoom(), 1.0f, 12.0f));
  glBegin(GL_POINTS);
  for (std::uint32_t i = 0; i < graph.nodes.size(); ++i) {
    const auto& node = graph.nodes[i];
    if (explorer.isPathNode(i)) {
      glColor4f(0.98f, 0.20f, 0.78f, 1.0f);
    } else if (explorer.isSelected(i)) {
      glColor4f(0.98f, 0.80f, 0.08f, 1.0f);
    } else if (explorer.isNeighbor(i)) {
      glColor4f(0.22f, 0.74f, 0.97f, 0.96f);
    } else {
      const auto color = colorForCluster(node.cluster);
      glColor4f(color[0], color[1], color[2], focused ? 0.25f : 0.95f);
    }
    glVertex2f(node.x, node.y);
  }
  glEnd();

  glPointSize(std::clamp(6.0f * camera.zoom(), 3.0f, 20.0f));
  glBegin(GL_POINTS);
  for (std::uint32_t i = 0; i < graph.nodes.size(); ++i) {
    if (!explorer.isPathNode(i) && !explorer.isSelected(i)) continue;
    const auto& node = graph.nodes[i];
    glColor4f(explorer.isPathNode(i) ? 0.98f : 1.0f, explorer.isPathNode(i) ? 0.20f : 0.58f,
              explorer.isPathNode(i) ? 0.78f : 0.08f, 1.0f);
    glVertex2f(node.x, node.y);
  }
  glEnd();
}

void Renderer::applyCamera(const Camera& camera, int width, int height) {
  const float halfW = static_cast<float>(width) * 0.5f / camera.zoom();
  const float halfH = static_cast<float>(height) * 0.5f / camera.zoom();
  glMatrixMode(GL_PROJECTION);
  glLoadIdentity();
  glOrtho(camera.x() - halfW, camera.x() + halfW, camera.y() - halfH, camera.y() + halfH, -1.0, 1.0);
  glMatrixMode(GL_MODELVIEW);
  glLoadIdentity();
}
