#include "Camera.h"
#include "Clusterer.h"
#include "GraphData.h"
#include "GraphExplorer.h"
#include "LayoutEngine.h"
#include "Renderer.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>

#include <GLFW/glfw3.h>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl2.h>

namespace {
struct AppState {
  GraphData* graph = nullptr;
  GraphExplorer explorer;
  std::unique_ptr<LayoutEngine> layout;
  std::string graphPath;
  Camera camera;
  std::array<char, 128> searchBuffer{};
  std::array<char, 128> pathSourceBuffer{};
  std::array<char, 128> pathTargetBuffer{};
  bool focusSearchRequested = false;
  bool dragging = false;
  bool paused = false;
  bool reloadRequested = false;
  bool importRequested = false;
  double lastMouseX = 0.0;
  double lastMouseY = 0.0;
};

bool loadGraph(AppState& state, const std::string& path, bool resetCamera) {
  std::string error;
  if (!state.graph->loadJson(path, error)) {
    std::cerr << error << '\n';
    return false;
  }
  const int clusters = Clusterer::labelPropagation(*state.graph);
  state.layout = std::make_unique<LayoutEngine>(*state.graph);
  state.layout->resetCooling();
  state.explorer.rebuild(*state.graph);
  state.graphPath = path;
  if (resetCamera) state.camera = Camera{};
  std::cout << "Loaded " << state.graph->nodes.size() << " nodes, " << state.graph->edges.size() << " edges, "
            << clusters << " clusters from " << path << '\n';
  return true;
}

void updateWindowTitle(GLFWwindow* window, const AppState& state) {
  std::string title = "InstaRL Native Graph Viewer - " + state.graphPath;
  glfwSetWindowTitle(window, title.c_str());
}

void centerOnSelected(AppState& state) {
  const auto selected = state.explorer.selectedNode();
  if (!state.graph || selected == GraphExplorer::kInvalid || selected >= state.graph->nodes.size()) return;
  const auto& node = state.graph->nodes[selected];
  state.camera.centerOn(node.x, node.y);
}

void fitPath(AppState& state, int width, int height) {
  if (!state.graph || state.explorer.pathNodes().empty()) return;
  float minX = state.graph->nodes[state.explorer.pathNodes()[0]].x;
  float maxX = minX;
  float minY = state.graph->nodes[state.explorer.pathNodes()[0]].y;
  float maxY = minY;
  for (const auto index : state.explorer.pathNodes()) {
    const auto& node = state.graph->nodes[index];
    minX = std::min(minX, node.x);
    maxX = std::max(maxX, node.x);
    minY = std::min(minY, node.y);
    maxY = std::max(maxY, node.y);
  }
  state.camera.fitBounds(minX, minY, maxX, maxY, width, height);
}

void scrollCallback(GLFWwindow* window, double xoffset, double yoffset) {
  ImGui_ImplGlfw_ScrollCallback(window, xoffset, yoffset);
  auto* state = static_cast<AppState*>(glfwGetWindowUserPointer(window));
  if (!state) return;
  if (ImGui::GetCurrentContext() && ImGui::GetIO().WantCaptureMouse) return;
  int width = 1;
  int height = 1;
  glfwGetFramebufferSize(window, &width, &height);
  double mx = 0.0;
  double my = 0.0;
  glfwGetCursorPos(window, &mx, &my);
  const float factor = yoffset > 0.0 ? 1.12f : 0.89f;
  state->camera.zoomAt(factor, static_cast<float>(mx), static_cast<float>(my), width, height);
}

void mouseButtonCallback(GLFWwindow* window, int button, int action, int mods) {
  ImGui_ImplGlfw_MouseButtonCallback(window, button, action, mods);
  auto* state = static_cast<AppState*>(glfwGetWindowUserPointer(window));
  if (!state || button != GLFW_MOUSE_BUTTON_LEFT) return;
  if (ImGui::GetCurrentContext() && ImGui::GetIO().WantCaptureMouse) return;
  state->dragging = action == GLFW_PRESS;
  glfwGetCursorPos(window, &state->lastMouseX, &state->lastMouseY);
}

void dropCallback(GLFWwindow* window, int count, const char** paths) {
  auto* state = static_cast<AppState*>(glfwGetWindowUserPointer(window));
  if (!state || count < 1 || !paths[0]) return;
  if (loadGraph(*state, paths[0], true)) updateWindowTitle(window, *state);
}

void keyCallback(GLFWwindow* window, int key, int scancode, int action, int mods) {
  ImGui_ImplGlfw_KeyCallback(window, key, scancode, action, mods);
  if (action != GLFW_PRESS) return;
  auto* state = static_cast<AppState*>(glfwGetWindowUserPointer(window));
  if (!state) return;
  if (ImGui::GetCurrentContext() && ImGui::GetIO().WantCaptureKeyboard) return;
  if (key == GLFW_KEY_ESCAPE) glfwSetWindowShouldClose(window, GLFW_TRUE);
  if (key == GLFW_KEY_SPACE) state->paused = !state->paused;
  if (key == GLFW_KEY_R) state->reloadRequested = true;
  if (key == GLFW_KEY_I) state->importRequested = true;
  if (key == GLFW_KEY_SLASH) state->focusSearchRequested = true;
  if (key == GLFW_KEY_N) {
    if ((mods & GLFW_MOD_SHIFT) != 0) state->explorer.selectPreviousMatch();
    else state->explorer.selectNextMatch();
    centerOnSelected(*state);
  }
}

void charCallback(GLFWwindow* window, unsigned int codepoint) {
  ImGui_ImplGlfw_CharCallback(window, codepoint);
}

ImVec2 worldToScreen(const Camera& camera, const Node& node, int width, int height) {
  return ImVec2((node.x - camera.x()) * camera.zoom() + static_cast<float>(width) * 0.5f,
                static_cast<float>(height) * 0.5f - (node.y - camera.y()) * camera.zoom());
}

void renderLabels(const AppState& state, int width, int height) {
  if (!state.graph) return;
  const bool focused = state.explorer.hasFocus();
  if (!focused && state.camera.zoom() < 4.0f) return;

  auto* drawList = ImGui::GetBackgroundDrawList();
  int labelsDrawn = 0;
  const int maxLabels = focused ? 260 : 900;
  for (std::uint32_t i = 0; i < state.graph->nodes.size(); ++i) {
    const bool important = state.explorer.isSelected(i) || state.explorer.isPathNode(i) || state.explorer.isNeighbor(i);
    if (!important && state.camera.zoom() < 7.0f) continue;
    if (!important && labelsDrawn >= maxLabels) break;
    const auto& node = state.graph->nodes[i];
    const ImVec2 pos = worldToScreen(state.camera, node, width, height);
    if (pos.x < -120.0f || pos.x > static_cast<float>(width) + 120.0f || pos.y < -30.0f ||
        pos.y > static_cast<float>(height) + 30.0f) {
      continue;
    }
    ImU32 color = IM_COL32(226, 232, 240, important ? 255 : 170);
    if (state.explorer.isPathNode(i)) color = IM_COL32(250, 120, 220, 255);
    else if (state.explorer.isSelected(i)) color = IM_COL32(255, 210, 70, 255);
    else if (state.explorer.isNeighbor(i)) color = IM_COL32(95, 210, 250, 240);
    drawList->AddText(ImVec2(pos.x + 6.0f, pos.y - 7.0f), color, node.username.c_str());
    labelsDrawn += 1;
  }
}

void renderUi(AppState& state, int width, int height) {
  ImGui::SetNextWindowPos(ImVec2(12, 12), ImGuiCond_FirstUseEver);
  ImGui::SetNextWindowSize(ImVec2(370, 330), ImGuiCond_FirstUseEver);
  ImGui::Begin("InstaRL Explorer");
  ImGui::Text("%zu nodes / %zu edges", state.graph ? state.graph->nodes.size() : 0, state.graph ? state.graph->edges.size() : 0);
  if (state.layout) ImGui::Text("avg speed %.3f / cooling %.2f", state.layout->averageSpeed(), state.layout->cooling());

  if (state.focusSearchRequested) {
    ImGui::SetKeyboardFocusHere();
    state.focusSearchRequested = false;
  }
  if (ImGui::InputText("Search", state.searchBuffer.data(), state.searchBuffer.size())) {
    state.explorer.setSearchQuery(state.searchBuffer.data());
  }
  ImGui::SameLine();
  if (ImGui::Button("Prev")) {
    state.explorer.selectPreviousMatch();
    centerOnSelected(state);
  }
  ImGui::SameLine();
  if (ImGui::Button("Next")) {
    state.explorer.selectNextMatch();
    centerOnSelected(state);
  }
  ImGui::Text("Matches: %zu", state.explorer.matches().size());
  const auto selected = state.explorer.selectedNode();
  if (state.graph && selected != GraphExplorer::kInvalid && selected < state.graph->nodes.size()) {
    const auto& node = state.graph->nodes[selected];
    ImGui::Text("Selected: %s", node.username.c_str());
    ImGui::Text("Followers: %lld  Following: %lld", static_cast<long long>(node.followerCount),
                static_cast<long long>(node.followingCount));
    if (ImGui::Button("Use selected as source")) {
      std::snprintf(state.pathSourceBuffer.data(), state.pathSourceBuffer.size(), "%s", node.username.c_str());
    }
    ImGui::SameLine();
    if (ImGui::Button("Use selected as target")) {
      std::snprintf(state.pathTargetBuffer.data(), state.pathTargetBuffer.size(), "%s", node.username.c_str());
    }
  }

  ImGui::Separator();
  ImGui::InputText("Path source", state.pathSourceBuffer.data(), state.pathSourceBuffer.size());
  ImGui::InputText("Path target", state.pathTargetBuffer.data(), state.pathTargetBuffer.size());
  if (ImGui::Button("Find shortest path")) {
    state.explorer.findShortestPath(state.pathSourceBuffer.data(), state.pathTargetBuffer.data());
    fitPath(state, width, height);
  }
  ImGui::SameLine();
  if (ImGui::Button("Clear path")) state.explorer.clearPath();
  if (!state.explorer.pathMessage().empty()) ImGui::TextWrapped("%s", state.explorer.pathMessage().c_str());

  ImGui::Separator();
  ImGui::Checkbox("Pause layout", &state.paused);
  if (state.layout) {
    auto& settings = state.layout->settings();
    ImGui::SliderFloat("Damping", &settings.damping, 0.45f, 0.92f);
    ImGui::SliderFloat("Repulsion", &settings.repulsion, 80.0f, 1200.0f);
    ImGui::SliderFloat("Spring", &settings.spring, 0.001f, 0.035f, "%.4f");
    ImGui::SliderFloat("Cluster gravity", &settings.clusterGravity, 0.0f, 0.02f, "%.4f");
    if (ImGui::Button("Reset layout")) {
      state.graph->seedPositions();
      state.layout->resetCooling();
    }
  }
  ImGui::TextWrapped("Shortcuts: / search, N next, Shift+N previous, Space pause, R reload, I import, drag/drop JSON.");
  ImGui::End();
}

void printUsage(const char* binary) {
  std::cerr << "Usage: " << binary << " <graph.json>\n"
            << "Controls: drag to pan, mouse wheel to zoom, / search, N/Shift+N result, space pause, R reload, I import, drag/drop JSON, escape quit.\n";
}
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    printUsage(argv[0]);
    return EXIT_FAILURE;
  }

  GraphData graph;
  AppState state;
  state.graph = &graph;
  if (!loadGraph(state, argv[1], true)) return EXIT_FAILURE;

  if (!glfwInit()) {
    std::cerr << "Failed to initialize GLFW\n";
    return EXIT_FAILURE;
  }

  GLFWwindow* window = glfwCreateWindow(1280, 800, "InstaRL Native Graph Viewer", nullptr, nullptr);
  if (!window) {
    std::cerr << "Failed to create GLFW window\n";
    glfwTerminate();
    return EXIT_FAILURE;
  }

  glfwSetWindowUserPointer(window, &state);
  updateWindowTitle(window, state);
  glfwMakeContextCurrent(window);
  glfwSwapInterval(1);

  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGui::StyleColorsDark();
  ImGui_ImplGlfw_InitForOpenGL(window, true);
  ImGui_ImplOpenGL2_Init();
  glfwSetWindowUserPointer(window, &state);
  glfwSetScrollCallback(window, scrollCallback);
  glfwSetMouseButtonCallback(window, mouseButtonCallback);
  glfwSetKeyCallback(window, keyCallback);
  glfwSetCharCallback(window, charCallback);
  glfwSetDropCallback(window, dropCallback);

  Renderer renderer;
  if (!renderer.initialize()) {
    std::cerr << "Failed to initialize renderer\n";
    glfwDestroyWindow(window);
    glfwTerminate();
    return EXIT_FAILURE;
  }

  double lastTime = glfwGetTime();
  while (!glfwWindowShouldClose(window)) {
    const double now = glfwGetTime();
    const float dt = static_cast<float>(now - lastTime);
    lastTime = now;

    if (state.reloadRequested) {
      state.reloadRequested = false;
      if (loadGraph(state, state.graphPath, false)) updateWindowTitle(window, state);
    }

    if (state.importRequested) {
      state.importRequested = false;
      std::cout << "Enter graph JSON path: " << std::flush;
      std::string path;
      if (std::getline(std::cin, path) && !path.empty()) {
        if (loadGraph(state, path, true)) updateWindowTitle(window, state);
      }
    }

    if (state.dragging) {
      double mx = 0.0;
      double my = 0.0;
      glfwGetCursorPos(window, &mx, &my);
      state.camera.pan(static_cast<float>(mx - state.lastMouseX), static_cast<float>(my - state.lastMouseY));
      state.lastMouseX = mx;
      state.lastMouseY = my;
    } else {
      state.camera.update(dt);
    }

    if (!state.paused && state.layout) {
      state.layout->step(graph.nodes.size() > 5000 ? 1 : 2);
    }

    int width = 1;
    int height = 1;
    glfwGetFramebufferSize(window, &width, &height);
    renderer.render(graph, state.explorer, state.camera, width, height);

    ImGui_ImplOpenGL2_NewFrame();
    ImGui_ImplGlfw_NewFrame();
    ImGui::NewFrame();
    renderLabels(state, width, height);
    renderUi(state, width, height);
    ImGui::Render();
    ImGui_ImplOpenGL2_RenderDrawData(ImGui::GetDrawData());

    glfwSwapBuffers(window);
    glfwPollEvents();
  }

  ImGui_ImplOpenGL2_Shutdown();
  ImGui_ImplGlfw_Shutdown();
  ImGui::DestroyContext();
  glfwDestroyWindow(window);
  glfwTerminate();
  return EXIT_SUCCESS;
}
