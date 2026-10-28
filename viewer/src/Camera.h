#pragma once

class Camera {
 public:
  void pan(float dx, float dy);
  void zoomAt(float factor, float screenX, float screenY, int width, int height);
  void centerOn(float x, float y);
  void fitBounds(float minX, float minY, float maxX, float maxY, int width, int height);
  void update(float dt);

  float x() const { return x_; }
  float y() const { return y_; }
  float zoom() const { return zoom_; }

  float screenToWorldX(float screenX, int width) const;
  float screenToWorldY(float screenY, int height) const;

 private:
  float x_ = 0.0f;
  float y_ = 0.0f;
  float zoom_ = 1.0f;
  float vx_ = 0.0f;
  float vy_ = 0.0f;
};
