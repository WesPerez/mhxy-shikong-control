use serde::{Deserialize, Serialize};

pub const SOURCE_BASELINE_WIDTH: f32 = 1280.0;
pub const SOURCE_BASELINE_HEIGHT: f32 = 720.0;
pub const SOURCE_VISIBLE_4X3_LEFT: f32 = 160.0;
pub const SOURCE_VISIBLE_4X3_WIDTH: f32 = 960.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoordinateMode {
    Stretch1280x720,
    CropCenter4x3,
}

impl Default for CoordinateMode {
    fn default() -> Self {
        Self::CropCenter4x3
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CoordinateMapper {
    target_width: u32,
    target_height: u32,
    mode: CoordinateMode,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2,
            y: self.y + self.height / 2,
        }
    }

    pub fn clamp_to(self, width: u32, height: u32) -> Option<Self> {
        let left = self.x.max(0);
        let top = self.y.max(0);
        let right = self.x.saturating_add(self.width.max(1)).min(width as i32);
        let bottom = self.y.saturating_add(self.height.max(1)).min(height as i32);
        (right > left && bottom > top).then_some(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }

    pub fn intersect(self, other: Self) -> Option<Self> {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = self
            .x
            .saturating_add(self.width.max(1))
            .min(other.x.saturating_add(other.width.max(1)));
        let bottom = self
            .y
            .saturating_add(self.height.max(1))
            .min(other.y.saturating_add(other.height.max(1)));
        (right > left && bottom > top).then_some(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

impl CoordinateMapper {
    pub fn new(target_width: u32, target_height: u32, mode: CoordinateMode) -> Self {
        Self {
            target_width,
            target_height,
            mode,
        }
    }

    pub fn scale_x(&self) -> f32 {
        match self.mode {
            CoordinateMode::Stretch1280x720 => self.target_width as f32 / SOURCE_BASELINE_WIDTH,
            CoordinateMode::CropCenter4x3 => self.target_width as f32 / SOURCE_VISIBLE_4X3_WIDTH,
        }
    }

    pub fn scale_y(&self) -> f32 {
        match self.mode {
            CoordinateMode::Stretch1280x720 => self.target_height as f32 / SOURCE_BASELINE_HEIGHT,
            CoordinateMode::CropCenter4x3 => self.target_height as f32 / SOURCE_BASELINE_HEIGHT,
        }
    }

    fn source_x(&self, x: i32) -> f32 {
        match self.mode {
            CoordinateMode::Stretch1280x720 => x as f32,
            CoordinateMode::CropCenter4x3 => x as f32 - SOURCE_VISIBLE_4X3_LEFT,
        }
    }

    pub fn rect(&self, roi: [i32; 4]) -> Rect {
        match self.mode {
            CoordinateMode::Stretch1280x720 => Rect {
                x: ((roi[0].max(0) as f32) * self.scale_x()).round() as i32,
                y: ((roi[1].max(0) as f32) * self.scale_y()).round() as i32,
                width: ((roi[2].max(1) as f32) * self.scale_x()).round().max(1.0) as i32,
                height: ((roi[3].max(1) as f32) * self.scale_y()).round().max(1.0) as i32,
            },
            CoordinateMode::CropCenter4x3 => {
                let left = self.source_x(roi[0]);
                let right = self.source_x(roi[0].saturating_add(roi[2].max(1)));
                Rect {
                    x: (left * self.scale_x()).round() as i32,
                    y: ((roi[1].max(0) as f32) * self.scale_y()).round() as i32,
                    width: ((right - left).max(1.0) * self.scale_x()).round().max(1.0) as i32,
                    height: ((roi[3].max(1) as f32) * self.scale_y()).round().max(1.0) as i32,
                }
            }
        }
    }

    pub fn point_from_rect(&self, value: [i32; 4]) -> Point {
        self.rect(value).center()
    }

    pub fn point_from_pair(&self, value: [i32; 2]) -> Point {
        Point {
            x: (self.source_x(value[0]) * self.scale_x()).round() as i32,
            y: ((value[1] as f32) * self.scale_y()).round() as i32,
        }
    }

    pub fn clamp_rect(&self, rect: Rect) -> Option<Rect> {
        rect.clamp_to(self.target_width, self.target_height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_center_4x3_maps_middle_baseline_to_full_client() {
        let mapper = CoordinateMapper::new(800, 600, CoordinateMode::CropCenter4x3);
        assert_eq!(mapper.rect([160, 0, 960, 720]), Rect::new(0, 0, 800, 600));
        assert_eq!(mapper.point_from_pair([160, 0]), Point { x: 0, y: 0 });
        assert_eq!(
            mapper.point_from_pair([1120, 720]),
            Point { x: 800, y: 600 }
        );
    }

    #[test]
    fn stretch_mode_keeps_original_1280x720_scaling() {
        let mapper = CoordinateMapper::new(640, 360, CoordinateMode::Stretch1280x720);
        assert_eq!(
            mapper.rect([320, 180, 640, 360]),
            Rect::new(160, 90, 320, 180)
        );
    }
}
