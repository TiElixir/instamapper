#include "Camera.h"

#include <algorithm>

void Camera::pan(float dx, float dy) {
  x_ -= dx / zoom_;
  y_ += dy / zoom_;
  vx_ = -dx / zoom_;
  vy_ = dy / zoom_;
}

void Camera::zoomAt(float factor, float screenX, float screenY, int width, int height) {
  const float beforeX = screenToWorldX(screenX, width);
  const float beforeY = screenToWorldY(screenY, height);
  zoom_ = std::clamp(zoom_ * factor, 0.02f, 80.0f);
  const float afterX = screenToWorldX(screenX, width);
  const float afterY = screenToWorldY(screenY, height);
  x_ += beforeX - afterX;
  y_ += beforeY - afterY;
}

void Camera::centerOn(float x, float y) {
  x_ = x;
  y_ = y;
  vx_ = 0.0f;
  vy_ = 0.0f;
}

void Camera::fitBounds(float minX, float minY, float maxX, float maxY, int width, int height) {
  const float spanX = std::max(1.0f, maxX - minX);
  const float spanY = std::max(1.0f, maxY - minY);
  const float zoomX = static_cast<float>(width) / (spanX * 1.35f);
  const float zoomY = static_cast<float>(height) / (spanY * 1.35f);
  zoom_ = std::clamp(std::min(zoomX, zoomY), 0.02f, 80.0f);
  centerOn((minX + maxX) * 0.5f, (minY + maxY) * 0.5f);
}

void Camera::update(float dt) {
  x_ += vx_ * dt;
  y_ += vy_ * dt;
  vx_ *= 0.88f;
  vy_ *= 0.88f;
  if (vx_ > -0.001f && vx_ < 0.001f) vx_ = 0.0f;
  if (vy_ > -0.001f && vy_ < 0.001f) vy_ = 0.0f;
}

float Camera::screenToWorldX(float screenX, int width) const {
  return (screenX - static_cast<float>(width) * 0.5f) / zoom_ + x_;
}

float Camera::screenToWorldY(float screenY, int height) const {
  return (static_cast<float>(height) * 0.5f - screenY) / zoom_ + y_;
}
