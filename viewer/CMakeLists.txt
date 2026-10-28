cmake_minimum_required(VERSION 3.20)
project(instarl_viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(
  glfw
  GIT_REPOSITORY https://github.com/glfw/glfw.git
  GIT_TAG 3.4
)
set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(
  imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG v1.91.9b
)

FetchContent_MakeAvailable(glfw nlohmann_json imgui)
find_package(OpenGL REQUIRED)

add_library(imgui_glfw STATIC
  ${imgui_SOURCE_DIR}/imgui.cpp
  ${imgui_SOURCE_DIR}/imgui_draw.cpp
  ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl2.cpp
)
target_include_directories(imgui_glfw PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(imgui_glfw PUBLIC glfw OpenGL::GL)

add_executable(instarl-viewer
  src/main.cpp
  src/Camera.cpp
  src/Clusterer.cpp
  src/GraphData.cpp
  src/GraphExplorer.cpp
  src/LayoutEngine.cpp
  src/Renderer.cpp
)

target_include_directories(instarl-viewer PRIVATE src)
target_link_libraries(instarl-viewer PRIVATE glfw OpenGL::GL nlohmann_json::nlohmann_json imgui_glfw)

if (MSVC)
  target_compile_options(instarl-viewer PRIVATE /W4)
else()
  target_compile_options(instarl-viewer PRIVATE -Wall -Wextra -Wpedantic -O3)
endif()
